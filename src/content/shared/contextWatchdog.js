// contextWatchdog.js — 扩展上下文失效的统一兜底
//
// 扩展更新/重载之后, 已经打开的页面里残留的旧 content script 仍在跑, 但它们的
// 扩展绑定已经失效: `chrome.runtime` 可能整个变成 undefined(读 .sendMessage 抛
// TypeError), 也可能还在但一调用就回 lastError "Extension context invalidated."。
//
// 这两种形态取决于失效时机, 而且只修某一个功能没用 —— 页面上每个注入脚本都会各自
// 弹一条用户看不懂的报错。所以这里放一个常驻的看门狗: 一旦发现上下文没了, 就统一
// 挂一条横幅, 提示刷新页面。各功能自己的报错逻辑不用改。
(function () {
    'use strict';

    if (window.__WQP_CONTEXT_WATCHDOG__) return;
    window.__WQP_CONTEXT_WATCHDOG__ = true;

    const BANNER_ID = 'wqp-context-lost-banner';
    const CHECK_INTERVAL_MS = 1500;

    // chrome.runtime.id 在上下文失效后为 undefined; 这是唯一在两种失效形态下都可靠的探针
    function isContextAlive() {
        return Boolean(globalThis.chrome?.runtime?.id);
    }

    function buildBanner() {
        const banner = document.createElement('div');
        banner.id = BANNER_ID;
        banner.setAttribute('role', 'alert');
        banner.style.cssText = [
            'position:fixed', 'top:16px', 'right:16px', 'z-index:2147483647',
            'max-width:340px', 'padding:14px 16px', 'border:1px solid #b91c1c',
            'border-left-width:4px', 'border-radius:6px', 'background:#fff',
            'box-shadow:0 6px 20px rgba(0,0,0,.18)', 'color:#333',
            'font:14px/1.6 "Segoe UI",Tahoma,Geneva,Verdana,sans-serif',
        ].join(';');

        const text = document.createElement('div');
        text.style.cssText = 'margin-bottom:10px';
        text.textContent = '扩展已更新或重载，本页面的功能已失效。刷新一次页面即可恢复。';

        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;align-items:center';

        const reload = document.createElement('button');
        reload.type = 'button';
        reload.textContent = '刷新页面';
        reload.style.cssText = [
            'padding:6px 14px', 'border:1px solid #b91c1c', 'border-radius:4px',
            'background:#b91c1c', 'color:#fff', 'cursor:pointer',
            'font:inherit', 'font-weight:700', 'line-height:1.3',
        ].join(';');

        const dismiss = document.createElement('button');
        dismiss.type = 'button';
        dismiss.textContent = '忽略';
        dismiss.style.cssText = [
            'padding:6px 10px', 'border:1px solid #d1d5db', 'border-radius:4px',
            'background:#fff', 'color:#6b7280', 'cursor:pointer',
            'font:inherit', 'line-height:1.3',
        ].join(';');

        reload.addEventListener('click', () => location.reload());
        dismiss.addEventListener('click', () => banner.remove());

        actions.append(dismiss, reload);
        banner.append(text, actions);
        return banner;
    }

    function showBanner() {
        if (document.getElementById(BANNER_ID)) return;
        const mount = () => {
            if (document.getElementById(BANNER_ID)) return;
            document.body.appendChild(buildBanner());
        };
        if (document.body) mount();
        else document.addEventListener('DOMContentLoaded', mount, { once: true });
    }

    function start() {
        // 页面刚注入时上下文一定是好的, 真正会失效的是"注入之后用户又重载了扩展"
        const timer = setInterval(() => {
            if (isContextAlive()) return;
            clearInterval(timer);
            showBanner();
        }, CHECK_INTERVAL_MS);
    }

    if (document.documentElement) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
})();