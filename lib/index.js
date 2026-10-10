// dsh-auto-shutdown (Host) — 对话回合结束后按平台自动关机，倒计时可取消。
//
// 设计约束（为兼容后续 DSH 版本刻意保持"减依赖"）：
//   - 清单里没有任何 @deepseek-ai/dsh* peer 依赖：dsh-app-boot 的
//     evaluatePluginCompatibility 只对 dsh 前缀的 peer 做 semver 校验，不写就不会
//     因为版本范围不匹配而被整体 skip。
//   - 所有可选服务都走 ctx.get(name) + undefined 检查，缺服务只降级不抛。
//   - Host 侧只用 Inspect 确认过的一等公民：commands.register / agent/status /
//     agent/error / subprocess.spawn / webServer.register / ctx.setTimeout。
//     其中 ctx.setTimeout **不可信**（2026-10-08 起在宿主里会抛错，见 setPluginTimer）：
//     必须包 try/catch 并退回全局 setTimeout，否则整条触发链会静默失效。
//   - 不用 ctx.remote：桌面端渲染页走 dsh-app://app，客户端从
//     globalThis.__DSH_TRANSPORT__.streamBaseUrl 取 Host origin 走普通 /api 路由。
//
// 触发语义：
//   - 全局开关 enabled，持久化在 ~/.dsh/auto-shutdown-state.json。
//   - 仅根会话参与判定（agents.roots()），子代理/工作流子会话结束不会误触发。
//   - 一批次内所有根会话都 idle 且本批次无 agent/error 时进入倒计时。
//   - 倒计时期间有新任务开始 → shutdown /a 取消，开关保持开启。
//
// 命令契约（Service.listService: key "commands"）：handler 收一个
// CommandInvocation，返回 {kind:'success',text?} | {kind:'error',text}。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROUTE_BASE = '/api/dsh-auto-shutdown';

/** 归一化配置；非法值一律回落到默认值，绝不抛。 */
function normalizeConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const clampInt = (value, fallback, min, max) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(n)));
  };
  return {
    /** GUI 倒计时秒数（可取消窗口）。 */
    countdownSec: clampInt(c.countdownSec, 60, 10, 600),
    /** 附加到平台关机命令上的余量秒数，给 GUI 留出发出指令后仍可反应的窗口。 */
    marginSec: clampInt(c.marginSec, 5, 0, 60),
    /** 仅在本批次无 agent/error 时才关机。 */
    onlyOnSuccess: c.onlyOnSuccess !== false,
    /**
     * "全部对话结束"的确认窗口（秒）：最后一个会话转 idle 后需持续空闲这么久
     * 才进入倒计时，吸收多会话/父子会话收尾时的衔接抖动。
     */
    idleGraceSec: clampInt(c.idleGraceSec, 3, 0, 120),
    /** 后台任务（bash/subagent job）也算"任务未完成"：等待其结束再关机。 */
    countBackgroundJobs: c.countBackgroundJobs !== false,
  };
}

function resolveStatePath() {
  try {
    const home =
      typeof os !== 'undefined' && os && typeof os.homedir === 'function'
        ? os.homedir()
        : (typeof process !== 'undefined' && process.env && process.env.DSH_HOME) || null;
    if (!home) return null;
    return path.join(home, '.dsh', 'auto-shutdown-state.json');
  } catch (_e) {
    return null;
  }
}

/** 平台 → 关机命令；不支持的平台返回 null（插件保持惰性）。 */
function shutdownArgv(platform, spec) {
  if (platform === 'win32') {
    return {
      argv: ['shutdown.exe', '/s', '/t', String(spec.countdownSec + spec.marginSec)],
      note: `shutdown.exe /s /t ${spec.countdownSec + spec.marginSec}`,
      cancellable: true,
    };
  }
  if (platform === 'darwin' || platform === 'linux') {
    return { argv: ['/sbin/shutdown', '-h', 'now'], note: '/sbin/shutdown -h now', cancellable: false };
  }
  return null;
}

function ok(text) {
  return { kind: 'success', text };
}

export function apply(ctx, rawConfig) {
  const spec = normalizeConfig(rawConfig);
  const platform =
    (typeof process !== 'undefined' && process && process.platform) || 'unknown';
  const command = shutdownArgv(platform, spec);

  // ── 日志：best-effort 追加，失败绝不影响功能 ───────────────────────────
  const statePath = resolveStatePath();
  const logPath =
    typeof os !== 'undefined' && os && typeof os.homedir === 'function'
      ? path.join(os.homedir(), '.dsh', 'dsh-auto-shutdown.log')
      : null;
  const recent = [];
  function log(...args) {
    const line = `[${new Date().toISOString()}] ${args.map(String).join(' ')}`;
    recent.push(line);
    if (recent.length > 30) recent.splice(0, recent.length - 30);
    try {
      if (typeof console !== 'undefined' && console) console.log('[dsh-auto-shutdown]', ...args);
    } catch (_e) {
      /* ignore */
    }
    try {
      if (logPath) fs.appendFileSync(logPath, line + '\n', 'utf8');
    } catch (_e) {
      /* best-effort */
    }
  }

  // ── 全局状态 ──────────────────────────────────────────────────────────
  const state = {
    enabled: false,
    phase: 'idle', // idle | countdown | fired
    deadline: 0,
    lastSkip: null, // { at, reason }
  };
  let firedTimer = null;
  let lastTriggerAt = 0;

  function loadState() {
    if (!statePath) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (parsed && typeof parsed.enabled === 'boolean') state.enabled = parsed.enabled;
    } catch (_e) {
      // 缺文件 / 解析失败：保持默认 false。
    }
  }

  function saveState() {
    if (!statePath) return;
    try {
      fs.writeFileSync(statePath, JSON.stringify({ enabled: state.enabled }, null, 2), 'utf8');
    } catch (err) {
      log('持久化开关状态失败:', err && err.message ? err.message : err);
    }
  }

  loadState();

  // ── 服务依赖：**调用时惰性解析**，不在 apply 时捕获 ────────────────────
  // 关键教训（2026-10-01 冷启动 404）：Cordis 4 里"没有声明 inject 的插件立即启动"，
  // 而 dsh-host-webserver / commands 等服务要等各自 fiber 起来才注册。若在 apply()
  // 时用 ctx.get() 一次性捕获，拿到的是 undefined，并且会被闭包**永久记住** ——
  // 后果不只是路由没注册（客户端 404），更危险的是 subprocess 捕获成 undefined 后
  // 倒计时走完也不会真的关机。所以除注册点用 ctx.inject 等待外，其余一律现取现用。
  function svc(name) {
    try {
      const value = ctx.get(name);
      return value === undefined ? undefined : value;
    } catch (_e) {
      return undefined; // 服务不存在/上下文未激活：按缺失处理。
    }
  }

  /** 启动自检：把"此刻已就绪 / 待命"的能力写进日志，便于排障。 */
  function selfCheckLine() {
    const names = ['webServer', 'commands', 'agents', 'jobs', 'subprocess'];
    const ready = [];
    const pending = [];
    for (const n of names) (svc(n) === undefined ? pending : ready).push(n);
    return `启动自检: 就绪[${ready.join(',') || '无'}] 待命[${pending.join(',') || '无'}] 定时器[${timerBackendLabel()}]`;
  }

  /**
   * 定时器后端探测。
   * 2026-10-09 教训：这台宿主上**连读取 `ctx.setTimeout` 都会抛**
   * （CordisError: cannot create effect on inactive context），而这个探测原来
   * 裸写在启动自检里 → apply() 当场抛出 → 只留下"插件已挂载"一行，
   * 命令与 HTTP 路由全没注册 → UI 显示"不可用 HTTP 404"。
   * 任何触碰 ctx.setTimeout 的地方都必须自吞异常。
   */
  function timerBackendLabel() {
    try {
      return typeof ctx.setTimeout === 'function' ? 'Cordis ctx.setTimeout' : '全局 setTimeout';
    } catch (err) {
      return `不可用(${err && err.message ? err.message : err}) → 全局 setTimeout`;
    }
  }

  // ── 定时器：先试 Cordis timer 服务，任何异常都退回全局定时器 ──────────
  // 2026-10-08 线上故障：宿主里 `ctx.setTimeout` 一调就抛（timer fiber 已失效）。
  // 旧写法不捕获，于是 scheduleEvaluate() 抛出 → evaluate() 从未被排程 →
  // 倒计时永远不启动，而 enabled 已写进内存与状态文件，UI 轮询看到的仍是
  // "已开启"，表现为「状态正常切换了，但任务跑完不关机」。
  // 2026-10-09 追加：**读取**也会抛，所以 typeof 判断必须放进 try 里面。
  // 注：若 ctx.setTimeout 返回值不是函数，无法确认它是否已排程，仍退回全局定时器；
  // 极端情况下会重复触发一次 evaluate，但 phase 守卫使重复触发无副作用。
  let timerBackend = 'ctx'; // 'ctx' | 'global'：退回只记一次日志，避免刷屏。
  function setPluginTimer(fn, delayMs, label) {
    if (timerBackend === 'ctx') {
      try {
        if (typeof ctx.setTimeout !== 'function') {
          timerBackend = 'global';
          log(`${label}: ctx 未提供 setTimeout，使用全局定时器`);
        } else {
          const handle = ctx.setTimeout(fn, delayMs);
          if (typeof handle === 'function') return handle;
          timerBackend = 'global';
          log(`${label}: ctx.setTimeout 未返回 disposer，退回全局定时器`);
        }
      } catch (err) {
        timerBackend = 'global';
        log(`${label}: ctx.setTimeout 不可用(${err && err.message ? err.message : err})，退回全局定时器`);
      }
    }
    const timer = setTimeout(fn, delayMs);
    return () => clearTimeout(timer);
  }

  // ── 关机命令派发 ──────────────────────────────────────────────────────
  function spawnShutdown(argv, label) {
    const subprocess = svc('subprocess'); // 现取：服务可能在 apply 之后才就绪。
    if (!subprocess || typeof subprocess.spawn !== 'function') {
      log('subprocess 服务不可用，无法执行:', argv.join(' '));
      return;
    }
    const run = async () => {
      let finalArgv = argv;
      try {
        const exe = await subprocess.resolveExecutable(argv[0]);
        if (typeof exe === 'string' && exe.length > 0) finalArgv = [exe, ...argv.slice(1)];
      } catch (_e) {
        // 回退到裸命令名（System32 在 PATH 上）。
      }
      try {
        const cwd =
          typeof process !== 'undefined' && process && typeof process.cwd === 'function'
            ? process.cwd()
            : '/';
        const handle = subprocess.spawn({
          argv: finalArgv,
          cwd,
          stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: 4096 },
            stderr: { maxBytes: 4096 },
          },
          graceMs: 15000,
        });
        log(`${label}: ${finalArgv.join(' ')}`);
        // SubprocessHandle 没有 pid 字段（0.4.0 曾误读），只观察 done。
        if (handle && handle.done && typeof handle.done.then === 'function') {
          handle.done
            .then((outcome) => log(`${label} 进程退出:`, JSON.stringify(outcome)))
            .catch((err) => log(`${label} 进程失败:`, err && err.message ? err.message : err));
        }
      } catch (err) {
        log(`spawn 失败(${label}):`, err && err.message ? err.message : err);
      }
    };
    void run();
  }

  // ── 倒计时状态机 ──────────────────────────────────────────────────────
  function clearFiredTimer() {
    if (firedTimer !== null) {
      try {
        firedTimer();
      } catch (_e) {
        /* ignore */
      }
      firedTimer = null;
    }
  }

  function armCountdown() {
    if (state.phase !== 'idle' || !state.enabled || !command) return;
    state.phase = 'countdown';
    state.deadline = Date.now() + spec.countdownSec * 1000;
    lastTriggerAt = Date.now();
    log(
      `★ 任务完成 → ${spec.countdownSec} 秒后关机（${command.note}${
        command.cancellable ? '，可用 /shutdown-auto cancel 或界面取消' : '，不可取消'
      }）`,
    );
    spawnShutdown(command.argv, 'shutdown');
    clearFiredTimer();
    const delayMs = (spec.countdownSec + spec.marginSec + 5) * 1000;
    // 优先用 Cordis timer 服务（随插件卸载自动清理），不可用时由 setPluginTimer
    // 退回全局定时器 —— 卸载路径本插件自己 clearFiredTimer/clearEvalTimer 兜底。
    firedTimer = setPluginTimer(onFired, delayMs, '关机倒计时');
  }

  function onFired() {
    firedTimer = null;
    state.phase = 'fired';
    log('关机指令已生效');
  }

  /**
   * 取消挂起的关机。
   * @param disarm 用户点"取消关机"时为 true（同时关闭开关）；自动取消（倒计时期间开新任务）为 false。
   */
  function cancelCountdown(disarm) {
    let cancelled = false;
    if (state.phase === 'countdown' || state.phase === 'fired') {
      if (command && command.cancellable) spawnShutdown(['shutdown.exe', '/a'], 'cancel');
      clearFiredTimer();
      clearEvalTimer();
      state.phase = 'idle';
      state.deadline = 0;
      cancelled = true;
      log(disarm ? '已取消关机（模式已关闭）' : '已取消关机（模式保持开启）');
    }
    if (disarm && state.enabled) {
      state.enabled = false;
      saveState();
      // 没有进行中的倒计时时，这条路是 UI"点击关闭"的唯一落点（/cancel → disarm）。
      // 旧版此处完全静默：状态文件被写成 false 却一行日志都没有，排障时像没发生过。
      if (!cancelled) log('已关闭：任务完成后自动关机（无进行中的倒计时）');
    }
    return cancelled;
  }

  function setEnabled(next) {
    if (state.enabled === next) return state.enabled;
    state.enabled = next;
    saveState();
    // 审计行紧跟状态变更：即使后面的排程环节再出错，日志里也一定留痕，
    // 不会再出现"文件已写 true、日志却一片空白"的排查盲区。
    log(next ? '已开启：任务完成后自动关机' : '已关闭：任务完成后自动关机');
    if (!next) {
      cancelCountdown(false);
      clearEvalTimer();
    } else {
      // 新的 arm 是一次全新的批次起点：清掉旧冷却/旧批次错误，
      // 若上一次还在 countdown/fired 状态也归位，便于重新触发。
      lastTriggerAt = 0;
      errored.clear();
      if (state.phase !== 'idle') { state.phase = 'idle'; state.deadline = 0; clearFiredTimer(); }
      scheduleEvaluate(spec.idleGraceSec * 1000);
    }
    return state.enabled;
  }

  // ── "所有工作区的所有对话是否都结束" 的判定 ─────────────────────────
  // Cordis 把派发 agent 挂在事件上（一等消费者都解构 {agent,status}），
  // 且未加 {global:true} 的 ctx.on 默认能看到进程内各 scope 的事件，
  // 所以这里按事件逐会话跟踪 busy 状态，天然覆盖所有 workspace 的根会话与子会话。
  // agents.list() 返回**全部** live agent（含子会话），`roots()` 仅顶层；
  // 两者结合即可区分"还有没有别的会话在跑"。
  const busyAgents = new Set(); // 仍在运行的会话 id（根/子都算）
  const busyJobs = new Set();   // 仍在运行的后台任务 id（kind-N）

  function listAgents() {
    const agents = svc('agents'); // 现取现用，避免捕获 undefined。
    if (!agents || typeof agents.list !== 'function') return [];
    try {
      const all = agents.list();
      return Array.isArray(all) ? all : [];
    } catch (_e) {
      return [];
    }
  }

  function listJobs() {
    const jobs = svc('jobs');
    if (!spec.countBackgroundJobs || !jobs || typeof jobs.list !== 'function') return [];
    const out = [];
    const seen = new Set();
    const collect = (arr) => {
      if (!Array.isArray(arr)) return;
      for (const j of arr) {
        if (j && !seen.has(j.id)) { seen.add(j.id); out.push(j); }
      }
    };
    try {
      collect(jobs.list()); // 未属主任务
    } catch (_e) { /* ignore */ }
    // jobs.list(caller) 只返回该 caller 拥有 + 未属主的任务，需逐个会话取并集。
    for (const a of listAgents()) {
      if (!a || a.id === undefined) continue;
      try {
        collect(jobs.list(a.id));
      } catch (_e) { /* 某个会话读不出任务时忽略，不阻断其余 */ }
    }
    return out;
  }

  /**
   * "全部结束"的静态快照（只在确实空闲时才可信）：
   * - 事件流里没有任何会话仍标记 busy；
   * - 进程里没有任何 live agent 处于非 idle 的权威状态；
   * - 没有任何 running/stopping 的后台任务。
   * 三者都满足才算"所有工作区的所有对话任务全部完成"。
   */
  function quietness() {
    // 权威侧：list() 里还活着且状态明确的 agent。
    const live = listAgents();
    const runningLive = [];
    for (const a of live) {
      if (!a) continue;
      // Agent 只暴露 {id}；status 是事件里的瞬态。能读到就用，读不到看 busyAgents。
      if (a.status === 'running') runningLive.push(a.id);
    }
    const runningJobs = listJobs().filter(
      (j) => j && (j.status === 'running' || j.status === 'stopping'),
    );
    return {
      // 综合判断：既看事件累积的 busy，也看权威侧抓到的 running。
      agentsBusy: busyAgents.size > 0 || runningLive.length > 0,
      jobsBusy: runningJobs.length > 0,
      detail: {
        busyAgents: busyAgents.size,
        liveRunning: runningLive.length,
        runningJobs: runningJobs.length,
        liveAgents: live.length,
      },
    };
  }

  function allQuiet() {
    const q = quietness();
    return !q.agentsBusy && !q.jobsBusy;
  }

  // ── 触发评估（防抖）：状态变化后稍等一拍再复核，吸收收尾抖动 ──────────
  let evalTimer = null;
  function clearEvalTimer() {
    if (evalTimer !== null) {
      try { evalTimer(); } catch (_e) { /* ignore */ }
      evalTimer = null;
    }
  }
  function scheduleEvaluate(delayMs) {
    clearEvalTimer();
    evalTimer = setPluginTimer(evaluate, delayMs, '触发评估');
  }

  /**
   * 核心评估：当"所有工作区的所有对话都结束"且已静默足够久时进入倒计时。
   * 采用"最早静默起点 quietSince"模型：每次从 busy 变安静时记录时间戳，
   * 之后只要保持安静到 quietSince + idleGraceSec 就触发；中间再来新任务会重置。
   */
  let quietSince = 0;   // 最近一次"全部转闲"的时间戳；0 = 尚未观测到空闲
  function evaluate() {
    evalTimer = null;
    if (!state.enabled || state.phase !== 'idle' || !command) return;

    const q = quietness();
    const now = Date.now();
    if (q.agentsBusy || q.jobsBusy) {
      quietSince = 0; // 又忙起来了，静默期清零。
      return;         // 由下一个 idle/settled 事件再触发评估。
    }
    if (quietSince === 0) quietSince = now;
    const wait = spec.idleGraceSec * 1000 - (now - quietSince);
    if (wait > 0) {
      scheduleEvaluate(wait); // 静默期未满，到点再复核。
      return;
    }
    if (now - lastTriggerAt < 5000) {
      scheduleEvaluate(5200 - (now - lastTriggerAt)); // 冷却期顺延，不丢本次评估。
      return;
    }
    if (spec.onlyOnSuccess && errored.size > 0) {
      lastTriggerAt = now;
      state.lastSkip = {
        at: now,
        reason: `本批次有 ${errored.size} 个会话出错，仅成功时关机（模式保持开启）`,
      };
      log(state.lastSkip.reason);
      errored.clear();
      return;
    }
    armCountdown();
  }

  // ── 触发点 ────────────────────────────────────────────────────────────
  const errored = new Set();

  function onStatus(payload) {
    const agent = payload && payload.agent;
    const status = payload && payload.status;
    const id = agent && agent.id;
    if (status === 'running') {
      if (id !== undefined) busyAgents.add(String(id));
      errored.clear(); // 新活动：开启新的错误窗口。
      if (state.phase === 'countdown' || state.phase === 'fired') {
        log('倒计时期间新任务开始，取消关机（模式保持开启）');
        cancelCountdown(false);
      }
      return;
    }
    if (status === 'idle') {
      if (id !== undefined) busyAgents.delete(String(id));
    } else if (status !== 'running') {
      // 其他状态（stopped/terminated 等）同样视作"不再占用"，
      // 否则一个跑过的会话会把 busyAgents 卡死，永远无法触发关机。
      if (id !== undefined) busyAgents.delete(String(id));
    }
    if (state.phase === 'countdown' || state.phase === 'fired') {
      // 已在倒计时：这节拍只用于刷新 busyAgents，不重复评估。
      return;
    }
    // 有新会话转 idle 才重新评估"是否全部结束"。
    if (status === 'idle') scheduleEvaluate(spec.idleGraceSec * 1000);
  }

  function onError(payload) {
    const agent = payload && payload.agent;
    errored.add(String((agent && agent.id) || 'unknown'));
    log('会话出错:', String((agent && agent.id) || 'unknown'));
  }

  // 后台任务开始/结束也纳入"未完成"集合（缺 jobs 服务则跳过）。
  function onJobEvent(ev) {
    if (!ev) return;
    const job = ev.job;
    if (ev.type === 'settled') {
      if (job && job.id !== undefined) busyJobs.delete(String(job.id));
      if (!allQuiet()) return;
      if (state.phase === 'idle') scheduleEvaluate(spec.idleGraceSec * 1000);
      return;
    }
    if (job && job.id !== undefined) {
      if (job.status === 'running' || job.status === 'stopping') busyJobs.add(String(job.id));
      else busyJobs.delete(String(job.id));
    }
    // 新任务开始：若正倒计时则取消。
    if (ev.type === 'registered' && (state.phase === 'countdown' || state.phase === 'fired')) {
      log('倒计时期间新后台任务开始，取消关机（模式保持开启）');
      cancelCountdown(false);
    }
  }

  // 事件订阅同样按"宿主 API 可能被污染"对待（2026-10-09 教训：apply() 半途抛出
  // 就等于命令与路由全没注册，UI 只剩"不可用"）。订阅失败必须降级成 no-op 并留痕，
  // 绝不能让异常冒泡把整个插件挂载打断。
  let offStatus = () => {};
  let offError = () => {};
  try {
    offStatus = ctx.on('agent/status', onStatus) || (() => {});
    offError = ctx.on('agent/error', onError) || (() => {});
  } catch (err) {
    log('事件订阅失败(触发将只能依赖后台任务事件):', err && err.message ? err.message : err);
  }

  // 后台任务事件走 jobs.events.subscribe(filter, listener)，与 ctx.on 不同；
  // 必须等 jobs 服务就绪（冷启动时它可能还没注册），所以放进 ctx.inject。
  if (spec.countBackgroundJobs) {
    try {
      if (typeof ctx.inject === 'function') {
        ctx.inject(['jobs'], (jobsCtx) => {
          const jobs = jobsCtx.get('jobs');
          if (!jobs || !jobs.events || typeof jobs.events.subscribe !== 'function') return undefined;
          try {
            const off = jobs.events.subscribe({ owners: 'all' }, onJobEvent);
            log('能力就绪: jobs（后台任务已计入等待）');
            return () => {
              try { off(); } catch (_e) { /* ignore */ }
            };
          } catch (err) {
            log('订阅 jobs 事件失败:', err && err.message ? err.message : err);
            return undefined;
          }
        });
      }
    } catch (err) {
      log('订阅 jobs 事件失败（ctx.inject 抛错）:', err && err.message ? err.message : err);
    }
  }

  // ── 状态快照（命令 / HTTP / UI 三个调用方共用一份数据）──────────────
  function snapshot() {
    const q = quietness();
    return {
      enabled: state.enabled,
      phase: state.phase,
      deadline: state.deadline,
      countdownSec: spec.countdownSec,
      marginSec: spec.marginSec,
      idleGraceSec: spec.idleGraceSec,
      onlyOnSuccess: spec.onlyOnSuccess,
      cancellable: command ? command.cancellable : false,
      platform,
      command: command ? command.note : null,
      erroredCount: errored.size,
      lastSkip: state.lastSkip,
      // 供 UI 展示"还差什么没结束"。
      busy: q.detail,
      allQuiet: !q.agentsBusy && !q.jobsBusy,
      recent,
    };
  }

  /** 一次操作两个调用方共用：/shutdown-auto 命令与 /api/dsh-auto-shutdown/* 路由。 */
  function applyAction(action) {
    try {
      if (action === 'on' || action === 'off') {
        setEnabled(action === 'on');
      } else if (action === 'cancel') {
        cancelCountdown(true);
      }
    } catch (err) {
      // 任何内部异常都不允许冒泡到 HTTP 层变成 400/500：开关状态已经落盘，
      // 返回快照能让 UI 与真实状态对齐，同时把真实堆栈留在日志里。
      log(
        `操作失败: ${action}`,
        err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : String(err),
      );
    }
    return snapshot();
  }

  if (command === null) {
    log(`当前平台 ${platform} 不受支持（需要 Windows shutdown.exe 或 POSIX /sbin/shutdown），插件保持惰性`);
  }

  /**
   * 注册一个"依赖某个服务"的能力：等该服务就绪后再执行 setup。
   * 冷启动时 dsh-host-webserver / commands 往往比本插件晚注册，apply() 时直接
   * ctx.get() 必然拿到 undefined —— 这正是 2026-10-01 客户端 404 的根因。
   * ctx.inject 让 Cordis 在服务出现后回调（服务被替换时会重载），
   * 缺失时本插件其余部分照常工作，只降级这一项能力。
   * @returns setup 的返回值（disposer），或 undefined。
   */
  function withService(name, setup) {
    const guarded = (service) => {
      try {
        return setup(service);
      } catch (err) {
        log(`能力初始化失败: ${name}`, err && err.message ? err.message : err);
        return undefined;
      }
    };
    // ctx.inject 本身也要防：它和 ctx.setTimeout 一样是宿主入口，
    // 一旦在挂载阶段抛出，后面的 mount 日志/其余能力就全没了。
    try {
      if (typeof ctx.inject === 'function') {
        // 注意：回调内的 ctx 才持有该服务；主 ctx 上仍是 undefined。
        ctx.inject([name], (serviceCtx) => guarded(serviceCtx.get(name)));
        return undefined;
      }
    } catch (err) {
      log(`ctx.inject 抛错(${err && err.message ? err.message : err})，能力 ${name} 退回即时解析`);
    }
    // 退化路径（未来 Cordis 若移除 ctx.inject / 注入抛错）：此刻有就直接用，没有就记一笔。
    const now = svc(name);
    if (now !== undefined) return guarded(now);
    log(`能力缺失: ${name}（无法等待其就绪）`);
    return undefined;
  }

  // ── 人体命令 ──────────────────────────────────────────────────────────
  withService('commands', (commands) => {
    if (!commands || typeof commands.register !== 'function') {
      log('能力缺失: commands（/shutdown-auto 未注册）');
      return undefined;
    }
    const off = commands.register({
      name: 'shutdown-auto',
      description:
        `查询或设置全局自动关机开关。用法: /shutdown-auto on|off|cancel|status。`
        + `开启后所有工作区的所有对话任务全部结束进入 ${spec.countdownSec} 秒可取消倒计时，随后执行 `
        + (command ? command.note : '（当前平台不支持）')
        + (command && command.cancellable ? '，倒计时期间可用 /shutdown-auto cancel 取消。' : '。'),
      handler(invocation) {
        const raw =
          invocation && typeof invocation.rawInput === 'string'
            ? invocation.rawInput.trim().toLowerCase()
            : 'status';
        if (!command) return ok(`当前平台 ${platform} 不支持自动关机。`);
        if (raw === 'on' || raw === 'off' || raw === 'cancel') {
          const snap = applyAction(raw);
          return ok(
            `全局自动关机: ${snap.enabled ? '开启' : '关闭'}`
              + `（阶段 ${snap.phase}）。命令: ${snap.command}`,
          );
        }
        const snap = snapshot();
        return ok(
          `全局自动关机: ${snap.enabled ? '开启' : '关闭'}，阶段 ${snap.phase}`
            + `，命令: ${snap.command}`
            + (snap.lastSkip ? `；上次跳过原因: ${snap.lastSkip.reason}` : ''),
        );
      },
    });
    log('能力就绪: commands（/shutdown-auto 已注册）');
    return () => {
      try { off(); } catch (_e) { /* ignore */ }
    };
  });

  // ── HTTP 路由：客户端 UI 的唯一通道 ──────────────────────────────────
  withService('webServer', (webServer) => {
    if (!webServer || typeof webServer.register !== 'function') {
      log('能力缺失: webServer（UI 通道未注册）');
      return undefined;
    }
    const json = (res, status, body) => {
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify(body));
    };
    // 桌面端渲染页的 Origin 是 dsh-app://app，不是 loopback；只做最薄的放行判断，
    // 真正的访问控制由本地 Host 的 authenticatedUrl / cookie 承担。
    const originAllowed = (req) => {
      const origin = req.headers && req.headers.origin;
      if (origin === undefined || origin === null || origin === '') return true;
      return /^dsh-app:\/\//i.test(origin) || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin);
    };
    const guard = (req, res) => {
      if (originAllowed(req)) return true;
      json(res, 403, { ok: false, error: 'origin rejected' });
      return false;
    };
    const route = (pathname, handler) =>
      webServer.register({
        kind: 'exact',
        path: ROUTE_BASE + pathname,
        handler: (req, res) => {
          if (!guard(req, res)) return;
          handler(req, res);
        },
      });

    const disposers = [
      route('/state', (_req, res) => json(res, 200, { ok: true, state: snapshot() })),
      route('/arm', (_req, res) => json(res, 200, { ok: true, state: applyAction('on') })),
      route('/cancel', (_req, res) => json(res, 200, { ok: true, state: applyAction('cancel') })),
    ];
    log('能力就绪: webServer（HTTP 路由已注册 ' + ROUTE_BASE + '/{state,arm,cancel}）');
    return () => {
      for (const dispose of disposers) {
        try { if (typeof dispose === 'function') dispose(); } catch (_e) { /* ignore */ }
      }
    };
  });

  log(
    `插件已挂载：平台 ${platform}，开关默认${state.enabled ? '开启' : '关闭'}`
      + `，命令 ${command ? command.note : '不支持'}`
      + `，等待所有工作区所有对话结束（含后台任务 ${spec.countBackgroundJobs ? '计入' : '不计入'}）`,
  );
  // 启动自检：冷启动竞态排障用（UI 不显示这些，只写日志）。
  log(selfCheckLine());

  return () => {
    clearFiredTimer();
    clearEvalTimer();
    for (const off of [offStatus, offError]) {
      try {
        if (typeof off === 'function') off();
      } catch (_e) {
        /* ignore */
      }
    }
    // 命令与 HTTP 路由由 ctx.inject 的子 fiber 随本插件卸载自动清理。
    if (state.phase !== 'idle' && command && command.cancellable) {
      spawnShutdown(['shutdown.exe', '/a'], 'unload-cancel');
      log('插件卸载：已请求取消挂起的关机');
    }
  };
}
