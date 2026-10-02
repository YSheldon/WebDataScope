(function () {
    'use strict';

    // 后台读完本地库后经这里转进页面 MAIN world(MAIN world 没有 chrome.storage / chrome.tabs)
    chrome.runtime.onMessage.addListener((msg) => {
        if (!msg || msg.type !== 'WQP_POOL_DATA') return;
        window.postMessage({ type: 'WQP_POOL_DATA', reqId: msg.reqId, data: msg.data }, '*');
    });

    window.addEventListener('message', (event) => {
        if (event.source !== window || !event.data || event.data.type !== 'WQP_SESSION_TOKEN_CAPTURED') return;
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
