// dsh-auto-shutdown (Client) — composer dock 里的电源开关 + 可取消倒计时条。
//
// 兼容性取舍：
//   - 只 inject ['slots']，不使用 ctx.remote（未声明为 external 的隐式命名空间）。
//   - HTTP 一律走**相对路径** fetch('/api/...')：
//       * 桌面端渲染页 Origin 是 dsh-app://app，对 http://127.0.0.1 的跨域请求
//         会被浏览器拦（我们的路由没设 CORS），这正是"不可用"闪烁的根因；
//       * dsh-app:// 会把 /api/* 原样代理到本机 Host 并带上认证 cookie；
//       * Web 端同源直连，同样无跨域问题。
//   - 快照缓存在模块级 SINGLETON，UI 组件重挂（切窗口/换会话）不会闪烁。

window.__ModuleLoader__.load({
  id: "dsh-auto-shutdown",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");

    var API = "/api/dsh-auto-shutdown";
    var POLL_MS = 1000;

    // ── 模块级共享状态：重挂组件直接渲染上次已知值，不再经历"不可用→已关闭" ──
    var STORE = {
      snap: null,          // 最近一次权威状态
      error: null,         // 持续失败才置位（含 HTTP/CORS 错误）
      loading: true,       // 尚未拿到第一份权威状态
      listeners: new Set(),
      poller: null,        // 单例轮询句柄
      connOK: true,        // 最近一次请求是否成功（用于"连接中"提示而非改状态）
    };
    function publish(patch) {
      for (var k in patch) STORE[k] = patch[k];
      STORE.listeners.forEach(function (l) { try { l(); } catch (_e) {} });
    }

    async function fetchState() {
      // 相对路径：桌面端走 dsh-app:// 代理，Web 端同源。
      var r = await fetch(API + "/state", { cache: "no-store", credentials: "include" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      var body = await r.json();
      if (!body || body.ok !== true || !body.state) throw new Error("Host 返回无效状态");
      return body.state;
    }
    async function postAction(action) {
      var r = await fetch(API + action, {
        method: "POST",
        cache: "no-store",
        credentials: "include",
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      var body = await r.json();
      if (!body || body.ok !== true || !body.state) throw new Error("Host 返回无效状态");
      return body.state;
    }

    // 单例轮询：不因组件重挂而重启，只在全部订阅者退订时停。
    var failCount = 0;
    function tick() {
      fetchState().then(
        function (state) {
          failCount = 0;
          publish({ snap: state, loading: false, connOK: true, error: null });
        },
        function (err) {
          failCount += 1;
          // 前几次失败保留上次快照（connOK=false 仅作小字提示），
          // 连续 ≥5 次且**从未成功过**才认为是真·不可用。
          var stale = STORE.snap !== null;
          publish({
            connOK: false,
            error: !stale && failCount >= 5 ? String(err && err.message ? err.message : err) : null,
            loading: false,
          });
        },
      );
    }
    function ensurePolling() {
      if (STORE.poller) return;
      tick();
      STORE.poller = setInterval(tick, POLL_MS);
    }
    function maybeStop() {
      if (STORE.listeners.size === 0 && STORE.poller) {
        clearInterval(STORE.poller);
        STORE.poller = null;
      }
    }

    // ── 样式：幂等注入，颜色只用主题 token ──────────────────────────────
    if (typeof document !== "undefined" && !document.getElementById("dsh-auto-shutdown-style")) {
      var style = document.createElement("style");
      style.id = "dsh-auto-shutdown-style";
      style.textContent = [
        ".dsh-as-bar{display:flex;align-items:center;gap:8px;padding:2px 0;min-height:28px;font:12px/1.4 system-ui,'Segoe UI','Microsoft YaHei',sans-serif;color:var(--dsw-alias-label-secondary,#666);}",
        ".dsh-as-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;flex:none;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#666);cursor:pointer;padding:0;}",
        ".dsh-as-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,0.06));}",
        ".dsh-as-btn:disabled{opacity:.45;cursor:default;}",
        ".dsh-as-btn.is-on{color:var(--dsw-alias-state-warning-primary,#c07000);}",
        ".dsh-as-state{white-space:nowrap;font-weight:600;}",
        ".dsh-as-state.is-on{color:var(--dsw-alias-state-warning-primary,#c07000);}",
        ".dsh-as-hint{white-space:nowrap;color:var(--dsw-alias-label-tertiary,#999);}",
        ".dsh-as-offline{white-space:nowrap;color:var(--dsw-alias-label-tertiary,#999);font-size:11px;}",
        ".dsh-as-countdown{display:inline-flex;align-items:center;gap:8px;padding:2px 8px;border-radius:999px;background:var(--dsw-alias-bg-warning,rgba(255,209,102,.18));color:var(--dsw-alias-label-primary,inherit);}",
        ".dsh-as-cancel{display:inline-flex;align-items:center;border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.4));border-radius:999px;background:transparent;color:inherit;cursor:pointer;padding:1px 10px;font:inherit;}",
        ".dsh-as-cancel:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,0.06));}",
        ".dsh-as-cancel:disabled{opacity:.5;cursor:default;}",
      ].join("\n");
      document.head.appendChild(style);
    }

    function PowerIcon() {
      return react.createElement(
        "svg",
        {
          width: 14,
          height: 14,
          viewBox: "0 0 16 16",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.5,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          style: { flex: "none", display: "block" },
          "aria-hidden": true,
        },
        react.createElement("path", { d: "M8 2v5" }),
        react.createElement("path", { d: "M5 4.5a5 5 0 1 0 6 0" }),
      );
    }

    function useStore() {
      var [version, setVersion] = react.useState(0);
      react.useEffect(function () {
        var l = function () { setVersion(function (n) { return n + 1; }); };
        STORE.listeners.add(l);
        ensurePolling();
        return function () {
          STORE.listeners.delete(l);
          maybeStop();
        };
      }, []);
      void version;
      return STORE;
    }

    function AutoShutdownToggle() {
      var s = useStore();
      var [busy, setBusy] = react.useState(false);
      var [tickN, setTickN] = react.useState(0);

      // 本地 1s 心跳只刷新倒计时数字。
      react.useEffect(function () {
        var id = setInterval(function () { setTickN(function (n) { return n + 1; }); }, POLL_MS);
        return function () { clearInterval(id); };
      }, []);
      void tickN;

      var snap = s.snap;
      var error = s.error;
      var loading = s.loading;
      var connected = s.connOK;

      var phase = snap && snap.phase ? snap.phase : "idle";
      var enabled = !!(snap && snap.enabled);
      var counting = phase === "countdown" || phase === "fired";
      var remaining =
        counting && snap && snap.deadline
          ? Math.max(0, Math.ceil((snap.deadline - Date.now()) / 1000))
          : 0;
      var cancellable = !!(snap && snap.cancellable);
      var cmd = (snap && snap.command) || "当前平台不支持";

      function applyState(st) {
        publish({ snap: st, loading: false, connOK: true, error: null });
      }
      function onToggle() {
        if (busy || loading) return;
        var next = !enabled;
        setBusy(true);
        postAction(next ? "/arm" : "/cancel").then(applyState, function (err) {
          publish({ error: String(err && err.message ? err.message : err) });
        }).then(function () { setBusy(false); });
      }
      function onCancel() {
        if (busy || loading) return;
        setBusy(true);
        postAction("/cancel").then(applyState, function (err) {
          publish({ error: String(err && err.message ? err.message : err) });
        }).then(function () { setBusy(false); });
      }

      // ── 文案：主状态一句话说清"开/关"；仅在出错时才追加说明 ─────────
      var mainText, hintText = null;
      if (loading && !snap) {
        mainText = "自动关机…";
      } else if (counting) {
        mainText = remaining > 0 ? ("自动关机：" + remaining + " 秒后关机") : "自动关机：正在关机";
      } else if (enabled) {
        mainText = "自动关机：已开启";
      } else {
        mainText = "自动关机：已关闭";
      }
      // 仅在真正的连接失败（从未拿到过状态）时覆盖主文案；瞬时断线用灰字提示。
      if (error && !snap) {
        mainText = "自动关机：不可用";
        hintText = error;
      }

      var title = counting
        ? (cancellable ? remaining + " 秒后关机（" + cmd + "），可取消" : "即将关机：" + cmd)
        : enabled
          ? "已开启：所有工作区的所有对话结束后，" + (snap ? snap.countdownSec : 60) + " 秒倒计时关机（" + cmd + "）。点击关闭。"
          : "点击开启：所有工作区的所有对话任务全部结束后自动关机（" + cmd + "）";

      var children = [
        react.createElement(
          "button",
          {
            type: "button",
            key: "btn",
            className: "dsh-as-btn" + (enabled ? " is-on" : ""),
            onClick: onToggle,
            disabled: busy || loading || (error && !snap),
            title: title,
            "aria-label": title,
            "aria-pressed": enabled,
          },
          react.createElement(PowerIcon, null),
        ),
        react.createElement(
          "span",
          { key: "state", className: "dsh-as-state" + (enabled ? " is-on" : "") },
          mainText,
        ),
      ];
      if (hintText) {
        children.push(react.createElement("span", { key: "hint", className: "dsh-as-hint" }, hintText));
      }

      if (!connected && snap) {
        children.push(react.createElement("span", { key: "off", className: "dsh-as-offline" }, "（连接重试中…）"));
      }
      if (counting && cancellable) {
        children.push(
          react.createElement(
            "button",
            {
              key: "cancel",
              type: "button",
              className: "dsh-as-cancel",
              onClick: onCancel,
              disabled: busy,
              title: "取消关机并关闭开关（" + cmd + "）",
            },
            "取消关机",
          ),
        );
      }

      return react.createElement("div", { className: "dsh-as-bar" }, children);
    }

    // ── 注册到 composer dock（官方推荐的装饰位，replaceRisk: none）──────
    var SLOT = "conversation.composer.dock";

    function apply(ctx) {
      if (!ctx || !ctx.slots || typeof ctx.slots.inject !== "function") return;
      ctx.slots.inject(SLOT, function () {
        return ctx.slots.register(
          { name: SLOT, id: "dsh-auto-shutdown", order: 50, label: "Auto Shutdown" },
          AutoShutdownToggle,
        );
      });
    }

    exports.inject = ["slots"];
    exports.apply = apply;
    return module.exports;
  },
});
