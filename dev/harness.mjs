// dsh-auto-shutdown 验证脚手架（沙箱化）—— 只驱动 Host 半边的状态机。
//
// SAFETY：
//   1. subprocess 被完整 mock（spawn 只记录 argv，绝不真正执行关机命令）；
//   2. os.homedir() 指向临时沙箱目录，绝不写真实 ~/.dsh；
//   3. 末尾自检 "production log untouched"。
//
// 覆盖四组：
//   A. 正常时序（服务在 apply 前就绪）—— 状态机语义
//   B. 冷启动竞态（apply 时服务全缺，之后才注入）—— 2026-10-01 客户端 404 的回归
//   C. 调用 ctx.setTimeout 抛错（timer fiber 失效）—— 2026-10-08「状态正常但不关机」的回归
//   D. **读取** ctx.setTimeout 就抛错 —— 2026-10-09「UI 显示不可用 HTTP 404」的回归
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REAL_HOME = os.homedir();
const SANDBOX = path.join(os.tmpdir(), 'dsh-auto-shutdown-harness', String(process.pid));
if (!SANDBOX.toLowerCase().includes('temp')) {
  throw new Error('refusing to run: sandbox path is not under a temp directory: ' + SANDBOX);
}
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(path.join(SANDBOX, '.dsh'), { recursive: true });
os.homedir = () => SANDBOX; // 插件运行时才解析状态/日志路径

const STATE = path.join(SANDBOX, '.dsh', 'auto-shutdown-state.json');
const SANDBOX_LOG = path.join(SANDBOX, '.dsh', 'dsh-auto-shutdown.log');
const PROD_LOG = path.join(REAL_HOME, '.dsh', 'dsh-auto-shutdown.log');
const prodLogBefore = fs.existsSync(PROD_LOG) ? fs.readFileSync(PROD_LOG, 'utf8') : '';

// ── 虚拟时钟：Date.now 可控，timer 按延迟推进时间后触发 ──────────────────
const realNow = Date.now.bind(Date);
let vnow = realNow();
Date.now = () => vnow;
const advance = (ms) => { vnow += ms; };

// ── 一个"世界" = 一套 mock ctx + 可控服务注册表 ─────────────────────────
// opts.brokenTimer: 让**调用** ctx.setTimeout 抛错，复现 2026-10-08 线上宿主故障
// （timer fiber 已失效，CordisError: cannot create effect on inactive context）。
// opts.poisonTimerAccessor: 让**读取** ctx.setTimeout 就抛错（getter 抛），
//   复现 2026-10-09 故障：插件在启动自检里裸写 `typeof ctx.setTimeout`，
//   apply() 当场抛出 → 只留下"插件已挂载"一行，命令/路由全没注册 → UI 报 HTTP 404。
function createWorld(opts = {}) {
  const brokenTimer = opts.brokenTimer === true;
  const poisonTimerAccessor = opts.poisonTimerAccessor === true;
  const services = new Map();      // name -> impl
  const pendingInjects = [];       // 尚未满足的 ctx.inject 请求
  const timers = [];
  const agentListeners = { status: [], error: [] };
  const jobListeners = [];
  const routes = [];
  const commands = [];
  const spawns = [];
  const liveAgents = new Map();
  const liveJobs = new Map();

  function childCtx(deps) {
    return {
      get: (n) => (deps.includes(n) ? services.get(n) : undefined),
      on: (...a) => ctx.on(...a),
      setTimeout: (...a) => ctx.setTimeout(...a),
    };
  }

  const ctx = {
    get: (name) => services.get(name),
    // Cordis 4 的 ctx.inject(deps, cb)：服务就绪后回调（服务被替换时重载）。
    inject(deps, cb) {
      const arr = Array.isArray(deps) ? deps : [deps];
      if (arr.every((d) => services.has(d))) {
        cb(childCtx(arr));
        return () => {};
      }
      pendingInjects.push({ deps: arr, cb });
      return () => {};
    },
    on(name, fn) {
      if (name === 'agent/status') agentListeners.status.push(fn);
      else if (name === 'agent/error') agentListeners.error.push(fn);
      return () => {};
    },
    setTimeout(fn, ms) {
      if (brokenTimer) throw new Error('CordisError: cannot create effect on inactive context');
      const t = { fn, ms, dead: false };
      timers.push(t);
      return () => { t.dead = true; };
    },
  };

  // 读取即抛的 ctx.setTimeout（覆盖对象字面量上那个正常实现）。
  if (poisonTimerAccessor) {
    Object.defineProperty(ctx, 'setTimeout', {
      configurable: true,
      get() { throw new Error('CordisError: cannot create effect on inactive context'); },
    });
  }

  /** 注册一个服务；顺便唤醒等待它的 ctx.inject 回调。 */
  function provide(name, impl) {
    services.set(name, impl);
    for (let i = pendingInjects.length - 1; i >= 0; i--) {
      const p = pendingInjects[i];
      if (p.deps.every((d) => services.has(d))) {
        pendingInjects.splice(i, 1);
        p.cb(childCtx(p.deps));
      }
    }
  }

  // ── 服务实现 ─────────────────────────────────────────────────────────
  const mkCommands = () => ({ register: (d) => { commands.push(d); return () => {}; } });
  const mkAgents = () => ({
    list: () => [...liveAgents.values()],
    roots: () => [...liveAgents.values()].filter((a) => a.root),
    get: (id) => liveAgents.get(String(id)),
  });
  const mkJobs = () => ({
    list(caller) {
      const arr = [...liveJobs.values()];
      return caller ? arr.filter((j) => j.owner === caller) : arr;
    },
    events: { subscribe: (_filter, fn) => { jobListeners.push(fn); return () => {}; } },
  });
  const mkWebServer = () => ({
    register: (r) => { routes.push(r); return () => {}; },
    port: 1,
  });
  const mkSubprocess = () => ({
    resolveExecutable: async (c) => c,
    spawn: (spec) => { spawns.push(spec.argv); return { done: Promise.resolve({ exitCode: 0, signal: null }) }; },
  });

  function provideAll() {
    provide('commands', mkCommands());
    provide('agents', mkAgents());
    provide('jobs', mkJobs());
    provide('webServer', mkWebServer());
    provide('subprocess', mkSubprocess());
  }

  // ── 事件推进 ─────────────────────────────────────────────────────────
  function agentStatus(id, status, root = true) {
    liveAgents.set(String(id), { id: String(id), status, root });
    agentListeners.status.forEach((l) => l({ agent: { id: String(id) }, status }));
  }
  function agentError(id) {
    agentListeners.error.forEach((l) => l({ agent: { id: String(id) }, error: new Error('boom') }));
  }
  function jobEvent(type, job) {
    liveJobs.set(String(job.id), job);
    jobListeners.forEach((l) => l({ type, job }));
  }

  function runTimers() {
    let guard = 0;
    while (timers.length > 0 && guard++ < 60) {
      const batch = timers.splice(0).filter((x) => !x.dead);
      for (const x of batch) {
        advance(Math.max(0, x.ms || 0)); // 先走时间，保证 quietSince/cooldown 判定正确
        if (!x.dead) x.fn();
      }
    }
  }
  const flush = () => new Promise((r) => setTimeout(r, 10));
  async function pump() { await flush(); runTimers(); await flush(); }
  async function pumpLong() { for (let i = 0; i < 5; i++) await pump(); }

  function hit(method, suffix) {
    const route = routes.find((r) => r.path === '/api/dsh-auto-shutdown' + suffix);
    if (!route) throw new Error('route missing: ' + suffix);
    let out = null;
    route.handler({ method, headers: {} }, { writeHead() {}, end(b) { out = JSON.parse(b); } });
    return out;
  }
  const state = () => hit('GET', '/state').state;

  return {
    ctx, provide, provideAll, pendingInjects,
    routes, commands, spawns, liveAgents, liveJobs,
    agentStatus, agentError, jobEvent, pump, pumpLong, hit, state,
    mkCommands, mkAgents, mkJobs, mkWebServer, mkSubprocess,
  };
}

const { apply } = await import('../lib/index.js');

const results = [];
const check = (label, cond, extra) =>
  results.push(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra === undefined ? '' : '  :: ' + extra}`);
const readSandboxLog = () => (fs.existsSync(SANDBOX_LOG) ? fs.readFileSync(SANDBOX_LOG, 'utf8') : '');

// ══════════════════════════════════════════════════════════════════════
// A. 正常时序：服务在 apply 前就绪
// ══════════════════════════════════════════════════════════════════════
const W = createWorld();
W.provideAll();
const dispose = apply(W.ctx, {});

console.log('A: commands =', W.commands.map((c) => c.name), '| routes =', W.routes.map((r) => r.path));
check('A1 command /shutdown-auto registered', W.commands.some((c) => c.name === 'shutdown-auto'));
check('A2 three HTTP routes registered', W.routes.length === 3,
  W.routes.map((r) => r.path).join(','));

// 开关 + 持久化
const onRes = W.commands[0].handler({ rawInput: 'on' });
check('A3 cmd on → enabled', onRes.kind === 'success' && /开启/.test(onRes.text), onRes.text);
check('A4 state file enabled=true', JSON.parse(fs.readFileSync(STATE, 'utf8')).enabled === true);
const offRes = W.commands[0].handler({ rawInput: 'off' });
check('A5 cmd off → disabled', offRes.kind === 'success' && /关闭/.test(offRes.text), offRes.text);
check('A6 state file enabled=false', JSON.parse(fs.readFileSync(STATE, 'utf8')).enabled === false);

// HTTP arm/cancel
W.hit('POST', '/arm');
check('A7 http arm → enabled', W.state().enabled === true);
const cancelSt = W.hit('POST', '/cancel').state;
check('A8 http cancel → disabled', cancelSt.enabled === false);
check('A9 http cancel → idle', cancelSt.phase === 'idle');
check('A10 cancel logged', cancelSt.recent.some((l) => /已取消|已关闭/.test(l)));

// 核心语义：所有会话都 idle 才触发
W.hit('POST', '/arm');
W.agentStatus('A', 'running');
W.agentStatus('B', 'running');
await W.pump();
W.agentStatus('A', 'idle');
await W.pump();
check('A11 one still running → not armed', W.state().phase === 'idle', W.state().phase);
check('A12 no /s yet', !W.spawns.some((a) => a.includes('/s')));
W.agentStatus('B', 'idle');
await W.pumpLong();
let snap = W.state();
check('A13 all idle → countdown armed', ['countdown', 'fired'].includes(snap.phase), snap.phase);
check('A14 issued shutdown /s', W.spawns.some((a) => a.includes('/s')), JSON.stringify(W.spawns));

// 倒计时期间新会话 → 自动 /a，开关保留
W.agentStatus('C', 'running');
await W.pump();
snap = W.state();
check('A15 new task during countdown → idle', snap.phase === 'idle', snap.phase);
check('A16 auto /a issued', W.spawns.some((a) => a.includes('/a')));
check('A17 mode stays enabled', snap.enabled === true);

// 子会话也计入
W.agentStatus('C', 'idle');
await W.pumpLong();
W.agentStatus('D', 'running', false);
await W.pumpLong();
check('A18 child still running → not armed', W.state().phase === 'idle', W.state().phase);
W.agentStatus('D', 'idle', false);
await W.pumpLong();
check('A19 child done + all idle → armed', ['countdown', 'fired'].includes(W.state().phase), W.state().phase);

// 后台任务计入
W.hit('POST', '/cancel');
W.hit('POST', '/arm');
W.liveJobs.clear();
W.jobEvent('registered', { id: 'job-1', status: 'running', owner: 'A' });
for (const id of W.liveAgents.keys()) W.agentStatus(id, 'idle');
await W.pumpLong();
check('A20 job running → not armed', W.state().phase === 'idle', W.state().phase);
W.jobEvent('settled', { id: 'job-1', status: 'completed', owner: 'A' });
await W.pumpLong();
check('A21 job settled → armed', ['countdown', 'fired'].includes(W.state().phase), W.state().phase);
W.hit('POST', '/cancel');

// 报错批次跳过
W.hit('POST', '/cancel');
W.hit('POST', '/arm');
W.agentStatus('E', 'running');
await W.pump();
W.agentError('E');
await W.pump();
const before8 = W.spawns.length;
W.agentStatus('E', 'idle');
await W.pumpLong();
snap = W.state();
check('A22 errored batch → no new /s', W.spawns.length === before8,
  `phase=${snap.phase} spawns=${W.spawns.length} before=${before8}`);
check('A23 skip reason recorded', snap.lastSkip && /出错/.test(snap.lastSkip.reason),
  snap.lastSkip ? snap.lastSkip.reason : 'none');
check('A24 mode still enabled after skip', snap.enabled === true);

// 卸载时取消倒计时
W.hit('POST', '/arm');
W.agentStatus('F', 'running');
await W.pump();
W.agentStatus('F', 'idle');
await W.pumpLong();
check('A25 re-armed before unload → countdown', ['countdown', 'fired'].includes(W.state().phase), W.state().phase);
const beforeUnload = W.spawns.length;
dispose();
await W.pump();
check('A26 unload during countdown issues /a',
  W.spawns.length > beforeUnload && W.spawns[W.spawns.length - 1].includes('/a'),
  JSON.stringify(W.spawns.slice(beforeUnload)));

// ══════════════════════════════════════════════════════════════════════
// B. 冷启动竞态：apply 时服务全缺，之后才注入（2026-10-01 404 回归）
// ══════════════════════════════════════════════════════════════════════
fs.rmSync(STATE, { force: true }); // 干净起点：开关默认关闭
const C = createWorld();
const disposeCold = apply(C.ctx, {}); // ← 此刻没有任何服务

check('B1 pending injects queued (no service yet)', C.pendingInjects.length >= 2,
  'pending=' + C.pendingInjects.length);
check('B2 no route registered at cold apply', C.routes.length === 0, 'routes=' + C.routes.length);
check('B3 no command registered at cold apply', C.commands.length === 0, 'commands=' + C.commands.length);

const coldLog = readSandboxLog();
check('B4 self-check line logged', /启动自检/.test(coldLog));
// 取**最后一条**自检（A 世界的自检在前，冷启动世界的在后）
const selfChecks = coldLog.split('\n').filter((l) => l.includes('启动自检'));
const coldSelfCheck = selfChecks[selfChecks.length - 1] || '';
check('B5 cold self-check lists webServer as pending', /待命\[[^\]]*webServer/.test(coldSelfCheck),
  coldSelfCheck.trim());

// 服务稍后才出现 —— 正是 dsh-host-webserver 的真实时序
C.provide('webServer', C.mkWebServer());
check('B6 routes registered once webServer appears', C.routes.length === 3,
  C.routes.map((r) => r.path).join(','));
C.provide('commands', C.mkCommands());
check('B7 command registered once commands appears', C.commands.length === 1,
  C.commands.map((c) => c.name).join(','));

// 关键回归：subprocess 在 apply 之后才就绪，倒计时走完必须真的能执行关机
// （旧实现把它在 apply 时捕获成 undefined，会永久静默失效）
C.provide('agents', C.mkAgents());
C.provide('jobs', C.mkJobs());
C.provide('subprocess', C.mkSubprocess()); // ← 迟到就绪，这才是被测点
C.hit('POST', '/arm');
C.agentStatus('X', 'running');
await C.pump();
C.agentStatus('X', 'idle');
await C.pumpLong();
const coldSpawns = C.spawns.filter((a) => a.includes('/s'));
check('B8 late subprocess → shutdown actually spawns', coldSpawns.length === 1,
  JSON.stringify(C.spawns));
check('B9 late agents service → phase armed', ['countdown', 'fired'].includes(C.state().phase),
  C.state().phase);

// 后台任务在冷启动路径下也计入
C.hit('POST', '/cancel');
C.hit('POST', '/arm');
C.jobEvent('registered', { id: 'job-cold', status: 'running', owner: 'X' });
for (const id of C.liveAgents.keys()) C.agentStatus(id, 'idle');
await C.pumpLong();
check('B10 late jobs service → job blocks trigger', C.state().phase === 'idle', C.state().phase);
C.jobEvent('settled', { id: 'job-cold', status: 'completed', owner: 'X' });
await C.pumpLong();
check('B11 job settled → armed (cold path)', ['countdown', 'fired'].includes(C.state().phase),
  C.state().phase);

const coldLog2 = readSandboxLog();
check('B12 capability-ready lines logged',
  /能力就绪: webServer/.test(coldLog2) && /能力就绪: commands/.test(coldLog2));

disposeCold();
await C.pump();

// ══════════════════════════════════════════════════════════════════════
// C. ctx.setTimeout 抛错（2026-10-08 线上故障回归：timer fiber 已失效）
//   旧实现不捕获 → scheduleEvaluate 抛出 → evaluate 永不排程 → 任务跑完不关机，
//   而 enabled 已经落盘，UI 轮询看到的仍是"已开启"（表现：状态切换正常但不关机）。
//   本组用真实定时器（ctx 后端坏掉后插件会退回全局 setTimeout），故用 sleep 推进。
// ══════════════════════════════════════════════════════════════════════
fs.rmSync(STATE, { force: true });
const logBeforeC = readSandboxLog().length;
const T = createWorld({ brokenTimer: true });
T.provideAll();
const disposeBroken = apply(T.ctx, { idleGraceSec: 0, countdownSec: 10 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 先让一个会话跑起来，再开开关 —— 复现"任务执行中"的真实场景。
T.agentStatus('G', 'running');
await sleep(20);
let armResult = null;
let armThrew = null;
try {
  armResult = T.hit('POST', '/arm');
} catch (err) {
  armThrew = String(err && err.message || err);
}
check('C1 arm never throws (no more HTTP 400)', armThrew === null && !!armResult, armThrew || 'no result');
check('C2 arm really enabled the mode', !!(armResult && armResult.state && armResult.state.enabled === true));
const logDeltaC = readSandboxLog().slice(logBeforeC);
check('C3 fallback logged with the real error', /ctx\.setTimeout 不可用\(.*退回全局定时器/.test(logDeltaC),
  logDeltaC.trim().split('\n').slice(-3).join(' | '));
check('C4 audit line 已开启 still written', /已开启：任务完成后自动关机/.test(logDeltaC));
await sleep(60);
check('C5 task still running → no countdown yet', T.state().phase === 'idle', T.state().phase);

T.agentStatus('G', 'idle');
await sleep(300); // 全局定时器兜底：真实 0ms 延迟的 evaluate
const snapC = T.state();
check('C6 fallback timer still arms countdown', ['countdown', 'fired'].includes(snapC.phase), snapC.phase);
check('C7 shutdown argv actually spawned', T.spawns.some((a) => a.includes('/s')), JSON.stringify(T.spawns));
disposeBroken();
await sleep(20);

// ══════════════════════════════════════════════════════════════════════
// D. **读取** ctx.setTimeout 就抛错（2026-10-09 线上故障回归：挂载即断）
//   旧实现把 `typeof ctx.setTimeout` 裸写进启动自检 → apply() 当场抛出 →
//   日志只剩"插件已挂载"一行，命令/路由一个都没注册 → 宿主 fallback 接管，
//   UI 显示"不可用 HTTP 404"（直接 curl 是 401 unauthorized）。
// ══════════════════════════════════════════════════════════════════════
fs.rmSync(STATE, { force: true });
const logBeforeD = readSandboxLog().length;
const P = createWorld({ poisonTimerAccessor: true });
P.provideAll();
let applyThrew = null;
let disposePoison = null;
try {
  disposePoison = apply(P.ctx, { idleGraceSec: 0, countdownSec: 10 });
} catch (err) {
  applyThrew = String((err && err.message) || err);
}
check('D1 apply survives poisoned ctx.setTimeout accessor', applyThrew === null && typeof disposePoison === 'function',
  applyThrew || 'apply() returned a disposer');
const logDeltaD = readSandboxLog().slice(logBeforeD);
check('D2 mount reached the self-check line', /启动自检/.test(logDeltaD),
  logDeltaD.trim().split('\n').slice(-2).join(' | '));
check('D3 self-check reports timer backend as unavailable', /定时器\[不可用/.test(logDeltaD),
  logDeltaD.trim().split('\n').slice(-2).join(' | '));
check('D4 all three capabilities came up', (logDeltaD.match(/能力就绪:/g) || []).length === 3,
  String((logDeltaD.match(/能力就绪:/g) || []).length));
check('D5 three HTTP routes registered', P.routes.length === 3, P.routes.map((r) => r.path).join(','));

P.agentStatus('H', 'running');
await sleep(20);
const armD = P.hit('POST', '/arm');
check('D6 arm ok (still no HTTP 400)', armD.state && armD.state.enabled === true);
await sleep(60);
check('D7 task running → no countdown yet', P.state().phase === 'idle', P.state().phase);
P.agentStatus('H', 'idle');
await sleep(300);
check('D8 fallback timer arms countdown', ['countdown', 'fired'].includes(P.state().phase), P.state().phase);
check('D9 shutdown argv spawned', P.spawns.some((a) => a.includes('/s')), JSON.stringify(P.spawns));
const logDeltaD2 = readSandboxLog().slice(logBeforeD);
check('D10 one-shot fallback logged with real error',
  /ctx\.setTimeout 不可用\(/.test(logDeltaD2), logDeltaD2.trim().split('\n').slice(-3).join(' | '));
if (disposePoison) disposePoison();
await sleep(20);

// ══════════════════════════════════════════════════════════════════════
// 收尾自检
// ══════════════════════════════════════════════════════════════════════
const prodLogAfter = fs.existsSync(PROD_LOG) ? fs.readFileSync(PROD_LOG, 'utf8') : '';
check('S1 production log untouched', prodLogAfter === prodLogBefore);
check('S2 no real shutdown invoked',
  W.spawns.every(Array.isArray) && C.spawns.every(Array.isArray)
  && T.spawns.every(Array.isArray) && P.spawns.every(Array.isArray));

console.log('\n' + results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
fs.rmSync(SANDBOX, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
