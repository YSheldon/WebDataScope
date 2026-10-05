(function () {
    'use strict';
    // 通过 manifest content_scripts 的 world: "MAIN" + run_at: "document_start" 注入，
    // 在 MAIN world 中同步启动，保证在页面任何 <script> 执行之前就已就位。
    // 这与油猴的效果完全等价。

    const SEARCH = 'SUBMITTED?[s]:[r],...c?[o]:[],{';
    // 平台的列注册表会缓存在 localStorage, 缓存键里带 bundle 版本号, 所以想让新列生效必须改版本串。
    // 这里刻意不写死 1.0.6: 平台哪天把 bundle 版本 bump 上去, 写死的正则就会静默失配(原代码没有 else,
    // 失配后什么都不打印), 结果是老列照常显示、新列永远不出现。改成匹配任意 1.x 版本, 保留原版本号只加后缀。
    const VERSION_REGEX = /version:\s*"(1\.\d+\.\d+)"/;
    const VERSION_SUFFIX = '-wqp15';

    const EXTRA_COLUMNS = [
        {
            id: 'id',
            name: 'Alpha ID',
            active: false,
            category: 'WQP',
            activeTabsWithoutParent: ['unsubmitted', 'submitted'],
            display: true,
            type: 'string',
            width: 100,
            serverSortable: true
        },
        {
            id: 'failedNumRA',
            parent: 'is',
            name: 'Failed RA',
            active: true,
            category: 'WQP',
            activeTabsWithoutParent: ['unsubmitted', 'submitted'],
            display: true,
            type: 'integer',
            width: 80,
            // 插件在响应里注入的虚拟字段,服务端不认识,排序/筛选只能在当前页内做
            serverSortable: false
        },
        {
            id: 'failedNumPPA',
            parent: 'is',
            name: 'Failed PPA',
            active: true,
            category: 'WQP',
            activeTabsWithoutParent: ['unsubmitted', 'submitted'],
            display: true,
            type: 'integer',
            width: 80,
            serverSortable: false
        },
        {
            id: 'WQPPYS',
            parent: 'is',
            name: 'Pyramid',
            active: false,
            category: 'WQP',
            activeTabsWithoutParent: ['unsubmitted', 'submitted'],
            display: true,
            type: 'string',
            serverSortable: false
        },
        {
            id: 'maxSelfCorr',
            name: 'Self Corr',
            active: false,
            category: 'WQP',
            activeTabsWithoutParent: ['unsubmitted', 'submitted'],
            display: true,
            type: 'string',
            width: 115,
            serverSortable: false
        },
        {
            id: 'maxPoolProdCorr',
            name: 'Pool Corr',
            active: false,
            category: 'WQP',
            activeTabsWithoutParent: ['unsubmitted', 'submitted'],
            display: true,
            type: 'string',
            width: 115,
            serverSortable: false
        },
        {
            id: 'maxProdCorr',
            name: 'Prod Corr',
            active: true,
            category: 'WQP',
            activeTabsWithoutParent: ['unsubmitted', 'submitted'],
            display: true,
            type: 'string',
            width: 115,
            serverSortable: false
        },
        {
            id: 'operatorCount',
            parent: 'regular',
            name: 'Operator Count',
            active: false,
            category: 'WQP',
            activeTabsWithoutParent: ['unsubmitted', 'submitted'],
            display: true,
            type: 'integer',
            width: 80,
            // API 实测支持 order=regular.operatorCount 与 regular.operatorCount<N 筛选
            serverSortable: true
        },
        {
            id: 'newFieldCount',
            parent: 'is',
            name: '新字段数',
            active: true,
            category: 'WQP',
            activeTabsWithoutParent: ['unsubmitted', 'submitted'],
            display: true,
            type: 'integer',
            width: 90,
            // 值是插件按「本赛季未提交过 + 该 region 下 active」本地算的, 服务端不认识, 只能当前页内算
            serverSortable: false
        },
    ];
    function buildReplacement() {
        const colsJson = EXTRA_COLUMNS.map(col => JSON.stringify(col)).join(',');
        return `SUBMITTED?[s]:[r],...c?[o]:[],${colsJson},{`;
    }

    async function fetchPatchAndRun(src) {
        try {
            let code = await (await fetch(src)).text();
            let patched = false;
            if (code.includes(SEARCH)) {
                code = code.replace(SEARCH, buildReplacement());
                code = code.replace('readOnly:!0,display:!0,', 'readOnly:!1,display:!0,');
                console.log('[WQP] patchColumns: 成功注入列定义', src);
                patched = true;
            } else {
                console.warn('[WQP] patchColumns: 未找到列特征串，直接执行原始代码', src);
            }
            const vm = patched ? code.match(VERSION_REGEX) : null;
            if (vm) {
                code = code.replace(VERSION_REGEX, `version:"${vm[1]}${VERSION_SUFFIX}"`);
                console.log(`[WQP] patchColumns: version ${vm[1]} → ${vm[1]}${VERSION_SUFFIX}，强制刷新 localStorage 列缓存`, src);
            } else if (patched) {
                // 原来这里是裸 if, 失配就悄无声息地什么都不做, 排查时看不出列为什么不生效
                console.error('[WQP] patchColumns: 列定义已注入, 但没匹配到 version 串 → localStorage 列缓存不会失效, 新增的列可能不显示', src);
            }
            const s = document.createElement('script');
            s.textContent = code;
            document.head.appendChild(s);
            s.remove();
        } catch (e) {
            console.error('[WQP] patchColumns: 失败，回退原始加载', e, src);
            const s = document.createElement('script');
            s.src = src;
            document.head.appendChild(s);
        }
    }

    new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (
                    node.nodeName === 'SCRIPT' &&
                    node.src &&
                    node.src.startsWith('https://platform.worldquantbrain.com/static/js/') &&
                    node.src.endsWith('.js') &&
                    !node.__wqp_done
                ) {
                    node.__wqp_done = true;
                    node.remove();
                    fetchPatchAndRun(node.src);
                }
            }
        }
    }).observe(document, { childList: true, subtree: true });

    console.log('[WQP] patchColumns: MutationObserver 已在 MAIN world 启动');
})();

