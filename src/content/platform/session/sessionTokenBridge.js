(function () {
    'use strict';

    // 后台读完本地库后经这里转进页面 MAIN world(MAIN world 没有 chrome.storage / chrome.tabs)
    chrome.runtime.onMessage.addListener((msg) => {
        if (!msg) return;
        if (msg.type === 'WQP_POOL_DATA') {
            window.postMessage({ type: 'WQP_POOL_DATA', reqId: msg.reqId, data: msg.data, keySummary: msg.keySummary }, '*');
            return;
        }
        // 侧边栏点「重建本地库」: 本地库在页面源 IndexedDB, 只有 MAIN world 动得了, 这里只做中转
        if (msg.type === 'WQP_POOL_REBUILD') {
            window.postMessage({ type: 'WQP_POOL_REBUILD', reqId: msg.reqId }, '*');
        }
    });

    window.addEventListener('message', (event) => {
        if (event.source !== window || !event.data) return;
        // MAIN world 清完本地库后的回执, 转回 service worker 再回给侧边栏
        if (event.data.type === 'WQP_POOL_REBUILD_DONE') {
            try {
                chrome.runtime.sendMessage({
                    type: 'WQP_POOL_REBUILD_RESULT',
                    reqId: event.data.reqId,
                    result: event.data.result,
                }, () => {
                    void chrome.runtime.lastError;
                });
            } catch (_) {
                // Navigation can invalidate the extension context.
            }
            return;
        }
        if (event.data.type !== 'WQP_SESSION_TOKEN_CAPTURED') return;
        const token = String(event.data.token || '').trim();
        if (!token) return;
        try {
            chrome.runtime.sendMessage({
                type: 'WQP_SESSION_TOKEN_CAPTURED',
                token,
            }, () => {
                // Ignore disconnected extension contexts while pages are navigating.
                void chrome.runtime.lastError;
            });
        } catch (_) {
            // Navigation can invalidate the extension context.
        }
    });
})();
