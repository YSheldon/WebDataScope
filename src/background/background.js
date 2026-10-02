// background.js: 后台脚本，用于监听浏览器事件，如标签页更新、插件安装等，以及与content scripts和popup交互
console.log('Background script is running.');
import '../shared/dataStore.js';
import { ensureDefaultSettings } from './services/settingsService.js';
import './services/sidebarMessageRouter.js';
import { initSessionKeeperService } from './services/sessionKeeperService.js';
// import { initTelemetryService } from './services/telemetryService.js';

const DATA_SET_LIST_PATH = 'dataSetList.json';
const PATHS = {
    vendorJs: 'src/vendor/js',
    vendorCss: 'src/vendor/css',
    sharedContent: 'src/content/shared',
    platformCommon: 'src/content/platform/common',
    platformAlpha: 'src/content/platform/alpha',
    platformData: 'src/content/platform/data',
    platformDistribution: 'src/content/platform/distribution',
    platformGenius: 'src/content/platform/genius',
    platformSimulate: 'src/content/platform/simulate',
    platformStyles: 'src/content/platform/styles',
};
let dataSetList = null; // 定义全局变量
const REPO_OWNER = "zhangkaihua88";
const REPO_NAME = "WebDataScope";
const CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 24小时检查一次


// 内存中仅会话级别缓存，不做长期持久化
let recentApiRequests = [];
const MAX_RECENT = 200;
// 在此处直接维护需要排除的前缀列表
const EXCLUDED_PREFIXES = [
    'https://api.worldquantbrain.com/errors/api/2/envelope/'

];

async function configureSidePanel() {
    try {
        if (chrome.sidePanel?.setPanelBehavior) {
            await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
        }
    } catch (error) {
        console.warn('Side panel setup failed:', error);
    }
}

function getExtensionDataStore() {
    if (!globalThis.WQPDataStore) {
        throw new Error('WQPDataStore is not available');
    }
    return globalThis.WQPDataStore;
}

async function getJsonDataFile(path) {
    const data = await getExtensionDataStore().getJson(path);
    if (data === null) {
        throw new Error(`Data file not found in IndexedDB: ${path}`);
    }
    return data;
}

async function getRegionInfoData(key) {
    const data = await getExtensionDataStore().getInfoData(key);
    if (!data) {
        throw new Error(`Info data shard not found for ${key}. Please re-import the data zip.`);
    }
    return data;
}

function pickInfoRecords(source, ids) {
    const result = {};
    if (!source || !Array.isArray(ids)) return result;

    for (const id of ids) {
        if (Object.prototype.hasOwnProperty.call(source, id)) {
            result[id] = source[id];
        }
    }

    return result;
}

async function getInfoDataSubset(msg) {
    const { region, delay, datasetIds = [], datafieldIds = [] } = msg;
    if (!region || !delay) {
        throw new Error('region and delay are required');
    }

    const key = `${region}_${delay}`;
    const regionData = await getRegionInfoData(key);
    const isos = regionData.isos || {};
    const neutralization = regionData.neutralization || {};

    return {
        [key]: {
            sub_end_time: regionData.sub_end_time,
            isos: {
                mean: isos.mean,
                total_count: isos.total_count,
                dataset: pickInfoRecords(isos.dataset, datasetIds),
                datafield: pickInfoRecords(isos.datafield, datafieldIds),
            },
            neutralization: {
                dataset: pickInfoRecords(neutralization.dataset, datasetIds),
                datafield: pickInfoRecords(neutralization.datafield, datafieldIds),
            },
        },
    };
}

function arrayBufferToBase64(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const chunkSize = 0x8000;
    let binary = '';

    for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, i + chunkSize);
        binary += String.fromCharCode(...chunk);
    }

    return btoa(binary);
}

async function getCompressedBase64DataFile(path) {
    const normalizedPath = getExtensionDataStore().normalizeDataPath(path);
    const arrayBuffer = await getExtensionDataStore().getFileArrayBuffer(normalizedPath);
    if (!arrayBuffer) {
        throw new Error(`Data file not found in IndexedDB: ${normalizedPath}`);
    }
    return arrayBufferToBase64(arrayBuffer);
}

async function handleIndexedDbDataRequest(msg) {
    if (msg.responseType === 'json') {
        return getJsonDataFile(msg.path);
    }
    if (msg.responseType === 'compressed-base64') {
        return getCompressedBase64DataFile(msg.path);
    }
    if (msg.responseType === 'meta') {
        return getExtensionDataStore().getMeta();
    }
    throw new Error(`Unsupported data response type: ${msg.responseType}`);
}

function resetIndexedDbDataCache() {
    dataSetList = null;
}


// 初始化设置
chrome.runtime.onInstalled.addListener(async () => {
    configureSidePanel();
    const WQP_Settings = await ensureDefaultSettings();
    console.log('Current settings:', WQP_Settings);
    // 获取数据集列表
    try {
        dataSetList = await getDataSetList();
    } catch (error) {
        console.warn('Data zip has not been imported into IndexedDB yet.', error);
        dataSetList = null;
    }
    checkUpdate();
});

// 设置定时器，每天检查一次更新
chrome.runtime.onStartup.addListener(() => {
    configureSidePanel();
    checkUpdate();
});

configureSidePanel();
initSessionKeeperService();
// initTelemetryService(); // 已禁用:不向 webdatascope-telemetry.zkhweb.workers.dev 上报任何数据



// 监听标签页更新事件
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const currentUrl = changeInfo.url || tab.url || '';
    if ((changeInfo.url || changeInfo.status === 'complete') && isAlphaAssistantUrl(currentUrl)) {
        injectionAlphaDescriptionAssistant(tabId);
    }

    if (changeInfo.status === 'complete' && tab.url) {
        const url = tab.url

        const distributionFlag = url == "https://platform.worldquantbrain.com/alphas/distribution"
        const geniusFlag = url.startsWith("https://platform.worldquantbrain.com/genius")
        const dataFlag = (
            url.includes("data/data-sets") ||
            url.includes("data/search/data-fields") ||
            url.includes("data/data-fields")
        )
        const simulateFlag = url.startsWith("https://platform.worldquantbrain.com/simulate")

        if (distributionFlag) {
            injectionDistributionScript(tabId);
        } else if (geniusFlag) {
            injectionGeniusScript(tabId);
        } else if (dataFlag) {
            injectionDataFlagScript(tabId, tab);
        } else if (simulateFlag) {
            injectionSimulateScript(tabId);
        }
    }
});

// 用 webNavigation.onCommitted 在导航提交时（DOM 为空、JS 尚未插入）立即注入到 MAIN world
// 比 tabs.onUpdated 的 'loading' 更早，确保 MutationObserver 在 WQ 第一个 <script> 插入前就已就位
chrome.webNavigation.onCommitted.addListener((details) => {
    // 只处理顶层主框架，忽略 iframe
    if (details.frameId !== 0) return;
    if (!details.url || !details.url.includes('platform.worldquantbrain.com')) return;
    injectFetchInterceptor(details.tabId);
    if (isAlphaAssistantUrl(details.url)) injectionAlphaDescriptionAssistant(details.tabId);
}, { url: [{ hostContains: 'platform.worldquantbrain.com' }] });

// WorldQuant Platform 是 SPA；仅改变 history 时，Manifest content_scripts 不会重新匹配并注入。
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
    if (details.frameId !== 0 || !isAlphaAssistantUrl(details.url)) return;
    injectionAlphaDescriptionAssistant(details.tabId);
}, { url: [{ hostContains: 'platform.worldquantbrain.com' }] });

// 注入 Fetch 拦截器到页面的 MAIN 环境中
function injectFetchInterceptor(tabId) {
    const extBase = chrome.runtime.getURL('');
    chrome.scripting.executeScript({
        target: { tabId: tabId },
        world: "MAIN",
        files: ['src/content/shared/wqpClientQuery.js'],
    }).catch((error) => console.error('[WQP] wqpClientQuery 注入失败:', error)).finally(() => chrome.scripting.executeScript({
        target: { tabId: tabId },
        world: "MAIN", // 必须指定 MAIN，否则无法覆盖页面本身的 window.fetch
        args: [extBase],
        func: (extBase) => {

            function postCapturedSessionToken(value) {
                const text = String(value || '');
                const match = text.match(/Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?)/i);
                if (!match?.[1]) return;
                window.postMessage({
                    type: 'WQP_SESSION_TOKEN_CAPTURED',
                    token: match[1],
                }, '*');
            }

            function scanHeadersForSessionToken(headers) {
                if (!headers) return;
                try {
                    if (headers instanceof Headers) {
                        postCapturedSessionToken(headers.get('Authorization') || headers.get('authorization'));
                        return;
                    }
                } catch (_) {
                    // Fall through to structural checks.
                }

                if (Array.isArray(headers)) {
                    headers.forEach(([key, value]) => {
                        if (String(key || '').toLowerCase() === 'authorization') {
                            postCapturedSessionToken(value);
                        }
                    });
                    return;
                }

                if (typeof headers === 'object') {
                    Object.keys(headers).forEach((key) => {
                        if (key.toLowerCase() === 'authorization') {
                            postCapturedSessionToken(headers[key]);
                        }
                    });
                }
            }

            function captureSessionTokenFromFetchArgs(resource, config) {
                try {
                    scanHeadersForSessionToken(config?.headers);
                    if (resource instanceof Request) {
                        scanHeadersForSessionToken(resource.headers);
                    }
                } catch (_) {
                    // Token sniffing must never affect page requests.
                }
            }

            // 将辅助函数定义在注入的内容脚本内
            // WQP 注入列: serverSortable=false 的是插件在响应里注入的虚拟字段,
            // 服务端不认识,排序/筛选参数必须在请求发出前剥离,否则 API 返回 400 "Invalid query"
            const WQP_COLUMN_REGISTRY = {
                'id': { serverSortable: true },
                'is.failedNumRA': { serverSortable: false },
                'is.failedNumPPA': { serverSortable: false },
                'is.WQPPYS': { serverSortable: false },
                'maxSelfCorr': { serverSortable: false },
                'maxPoolProdCorr': { serverSortable: false },
                'maxProdCorr': { serverSortable: false },
                'regular.operatorCount': { serverSortable: true },
            };
            function getAlphaCheckStates(originalData) {
                function readProdMemoCache() {
                    try {
                        return JSON.parse(localStorage.getItem('WQP_ProdMemoCache') || '{}') || {};
                    } catch (e) {
                        console.warn('[WQP] ProdMemo cache parse failed:', e);
                        return {};
                    }
                }

                function formatMemoValue(metric) {
                    if (typeof metric?.display === 'string') return metric.display;
                    const numeric = Number(metric?.max);
                    if (!Number.isFinite(numeric)) return '';
                    const prefix = metric?.lowerBound ? '≥' : '';
                    const icon = metric?.source === 'local' ? 'Ⓛ' : 'Ⓟ';
                    return `${prefix}${numeric.toFixed(4)} ${icon}`;
                }

                function getMaxProdCorr(cache, alphaId) {
                    const memo = cache?.[alphaId];
                    return formatMemoValue(memo?.prod);
                }

                function getMaxPoolProdCorr(cache, alphaId) {
                    const memo = cache?.[alphaId];
                    return formatMemoValue(memo?.pool);
                }

                function getMaxSelfCorr(cache, alphaId) {
                    const memo = cache?.[alphaId];
                    return formatMemoValue(memo?.self);
                }

                // 1. 定义需要校验的RA检查项名称（自动去重，避免重复统计）
                const RA_CHECK_NAMES = Array.from(new Set([
                    "HIGH_TURNOVER", "LOW_TURNOVER",
                    "LOW_FITNESS", "LOW_RETURNS", "LOW_SHARPE", 

                    'LOW_GLB_AMER_SHARPE', 'LOW_GLB_APAC_SHARPE', 'LOW_GLB_EMEA_SHARPE', 'LOW_ASI_JPN_SHARPE',

                    "IS_LADDER_SHARPE", // ATOM豁免 
                    "LOW_2Y_SHARPE",  "LOW_SUB_UNIVERSE_SHARPE",  "LOW_ROBUST_UNIVERSE_SHARPE", 
                    "LOW_AFTER_COST_ILLIQUID_UNIVERSE_SHARPE", 'LOW_INVESTABILITY_CONSTRAINED_SHARPE',

                    "LOW_ROBUST_UNIVERSE_RETURNS", 
                    "CONCENTRATED_WEIGHT",  
                    
                ]));
                const PPA_CHECK_NAMES = Array.from(new Set([
                    'LOW_TURNOVER',
                    'HIGH_TURNOVER',
                    'LOW_SUB_UNIVERSE_SHARPE', 
                    'LOW_ROBUST_UNIVERSE_SHARPE', 
                    'LOW_ROBUST_UNIVERSE_SHARPE.WITH_RATIO',
                    "LOW_ROBUST_UNIVERSE_RETURNS",
                    'LOW_INVESTABILITY_CONSTRAINED_SHARPE'
                ]));

                // 2. 核心逻辑：遍历数据，统计不合格数量并新增字段
                // 
                // 比如sub-univers ,robust 其实能不能把那些fail的具体值做出来，比如robust 那些的值
                // 能不能加个显示负的alpha的功能，比如当sharp为负的时候，如果测试值的绝对值都能通过平台标准就显示’-0‘
                // risk neut那个就是用传统neut跑的时候 会有个risk neut的线 大概sharpe 和 fit都更高的话 就需要遍历risk neut
                // 按照具体的pyramid筛选
                if (!Array.isArray(originalData?.results)) return originalData;
                const prodMemoCache = readProdMemoCache();
                originalData.results.forEach(item => {
                    item.maxProdCorr = getMaxProdCorr(prodMemoCache, item?.id);
                    item.maxPoolProdCorr = getMaxPoolProdCorr(prodMemoCache, item?.id);
                    item.maxSelfCorr = getMaxSelfCorr(prodMemoCache, item?.id);
                    // 容错处理：如果is/checks不存在，直接赋值0
                    if (!item?.is?.checks || !Array.isArray(item.is.checks)) {
                        item.is = item.is || {};
                        item.is.failedNumRA = 0;
                        item.is.failedNumPPA = 0;
                        return;
                    }
                    item.is.failedNumRA = item.is.checks.filter(check => 
                        RA_CHECK_NAMES.includes(check.name) && check.result !== 'PASS' && check.result !== 'PENDING'
                    ).length;
                    
                    item.is.failedNumPPA = item.is.checks.filter(check => 
                        (PPA_CHECK_NAMES.includes(check.name) && check.result !== 'PASS' && check.result !== 'PENDING') || (check.name === "LOW_SHARPE" && check.value < 1)
                    ).length;
                    
                    item.is.WQPPYS = item.is.checks
                        .find(check => check.name === "MATCHES_PYRAMID")?.pyramids
                        ?.map(pyramid => (pyramid.name?.split('/').pop() || '').toLowerCase())
                        ?.join('/') || '';

                    
                });
                return originalData;
            }

            if (window.__wq_fetch_intercepted) return;
            window.__wq_fetch_intercepted = true;

            const originalFetch = window.fetch;
            const clientAlphaCache = new Map();

            async function fetchAlphasPage(pageUrl) {
                const backoffs = [0, 800, 2000];
                let lastErr = '';
                for (let attempt = 0; attempt < backoffs.length; attempt += 1) {
                    if (backoffs[attempt]) await new Promise((r) => setTimeout(r, backoffs[attempt]));
                    let response;
                    const d429 = [1000, 2000, 3000, 5000, 8000, 12000, 20000, 30000];
                    for (let a = 0; a < d429.length; a += 1) {
                        response = await originalFetch(pageUrl, { credentials: 'include' });
                        if (response.status !== 429) break;
                        await new Promise((r) => setTimeout(r, d429[a]));
                    }
                    if (response?.ok) {
                        try {
                            const modified = getAlphaCheckStates(await response.json());
                            const page = Array.isArray(modified?.results) ? modified.results : [];
                            return { page, total: Number(modified?.count ?? 0) };
                        } catch (err) { lastErr = 'parse error'; }
                    } else lastErr = `HTTP ${response?.status}`;
                }
                throw new Error(lastErr || 'fetch failed');
            }

            async function loadAlphasForClientQuery(serverUrl) {
                const cached = clientAlphaCache.get(serverUrl);
                if (cached && Date.now() - cached.at < 120000) return cached.rows;
                const rows = [];
                const seenIds = new Set();
                let cursor = null;              // dateCreated<= 游标(最新优先): 绕过 API 的深分页 offset 上限
                const joiner = serverUrl.includes('?') ? '&' : '?';
                let failedPages = 0;
                const PULL_CAP = 3000;          // 最新优先拉取上限: 覆盖近期挖矿, 避免全池长等
                for (let guard = 0; guard < 300 && rows.length < PULL_CAP; guard += 1) {
                    let pageUrl = `${serverUrl}${joiner}limit=100&order=-dateCreated`;
                    if (cursor) pageUrl += `&dateCreated<=${encodeURIComponent(cursor)}`;
                    let res;
                    try {
                        res = await fetchAlphasPage(pageUrl);
                    } catch (err) {
                        failedPages += 1;
                        console.warn(`[WQP] 全库拉取页失败(${err.message}), 重试 ${failedPages}/3`);
                        if (failedPages >= 3) throw new Error(`虚拟列全库拉取失败: ${err.message}`);
                        await new Promise((r) => setTimeout(r, 2000));
                        continue;
                    }
                    failedPages = 0;
                    const page = res.page || [];
                    if (!page.length) break;
                    let oldest = null;
                    let fresh = 0;
                    for (const row of page) {
                        if (row.id && seenIds.has(row.id)) continue;
                        if (row.id) seenIds.add(row.id);
                        rows.push(row);
                        fresh += 1;
                        const ts = row.dateCreated;
                        if (ts && (!oldest || ts < oldest)) oldest = ts;
                    }
                    console.log(`[WQP] 虚拟列全库拉取(最新优先) 已取 ${rows.length} 行${rows.length >= PULL_CAP ? '(达上限)' : ''}`);
                    if (!fresh) break;              // 游标无进展(整页同一时间戳), 防死循环
                    if (page.length < 100) break;   // 不足一页 = 到底
                    cursor = oldest;
                }
                clientAlphaCache.set(serverUrl, { at: Date.now(), rows });
                return rows;
            }

            function requestMethod(resource, config) {
                const method = config?.method || (resource instanceof Request ? resource.method : 'GET');
                return String(method || 'GET').toUpperCase();
            }

            // ---- 虚拟列查询: 内联实现(不再依赖 wqpClientQuery.js 注入是否成功) ----
            const WQP_CLIENT_FIELDS = ['is.failedNumRA', 'failedNumRA', 'is.failedNumPPA', 'failedNumPPA', 'is.WQPPYS', 'WQPPYS', 'maxSelfCorr', 'maxPoolProdCorr', 'maxProdCorr'];
            const WQP_FIELD_CANONICAL = { failedNumRA: 'is.failedNumRA', failedNumPPA: 'is.failedNumPPA', WQPPYS: 'is.WQPPYS' };
            const WQP_SERVER_REWRITES = { operatorCount: 'regular.operatorCount' };
            const WQP_OPS = ['<=', '>=', '!=', '<', '>', '='];

            function wqpValueOf(row, field) {
                const canonical = WQP_FIELD_CANONICAL[field] || field;
                if (canonical === 'is.failedNumRA') return Number(row.is?.failedNumRA ?? 0);
                if (canonical === 'is.failedNumPPA') return Number(row.is?.failedNumPPA ?? 0);
                if (canonical === 'is.WQPPYS') return String(row.is?.WQPPYS ?? '');
                return row[canonical];
            }
            function wqpNumericOf(value) {
                if (typeof value === 'number' && Number.isFinite(value)) return value;
                const m = String(value ?? '').match(/-?\d+(?:\.\d+)?/);
                return m ? Number(m[0]) : NaN;
            }
            function wqpCompare(op, actual, raw) {
                const left = wqpNumericOf(actual);
                const right = Number(raw);
                if (Number.isFinite(left) && Number.isFinite(right)) {
                    if (op === '<') return left < right;
                    if (op === '>') return left > right;
                    if (op === '<=') return left <= right;
                    if (op === '>=') return left >= right;
                    if (op === '=') return left === right;
                    if (op === '!=') return left !== right;
                }
                const text = String(actual ?? '');
                const expect = String(raw ?? '');
                if (op === '=') return text === expect;
                if (op === '!=') return text !== expect;
                return text.includes(expect);
            }
            function wqpMatchFilter(token) {
                const fields = WQP_CLIENT_FIELDS.slice().sort((a, b) => b.length - a.length);
                for (const field of fields) {
                    if (!token.startsWith(field)) continue;
                    const rest = token.slice(field.length);
                    for (const op of WQP_OPS) {
                        if (rest.startsWith(op)) return { field: WQP_FIELD_CANONICAL[field] || field, op, value: rest.slice(op.length) };
                    }
                }
                return null;
            }
            function wqpRewriteServerFilter(token) {
                for (const field of Object.keys(WQP_SERVER_REWRITES).sort((a, b) => b.length - a.length)) {
                    if (!token.startsWith(field)) continue;
                    const rest = token.slice(field.length);
                    if (WQP_OPS.some((op) => rest.startsWith(op))) return `${WQP_SERVER_REWRITES[field]}${rest}`;
                }
                return null;
            }
            function wqpParseUrl(rawUrl) {
                let url;
                try { url = new URL(rawUrl, 'https://api.worldquantbrain.com'); } catch (_) { return null; }
                if (!/\/users\/[^/]+\/alphas$/.test(url.pathname)) return null;
                const parts = url.search.replace(/^\?/, '').split('&').filter(Boolean);
                let limit = 10, offset = 0, clientOrder = null;
                const clientFilters = [], serverParts = [];
                for (const part of parts) {
                    const decoded = decodeURIComponent(part.replace(/\+/g, ' '));
                    if (decoded.startsWith('limit=')) { limit = Number(decoded.slice(6)) || 10; continue; }
                    if (decoded.startsWith('offset=')) { offset = Number(decoded.slice(7)) || 0; continue; }
                    if (decoded.startsWith('order=')) {
                        const order = decoded.slice(6);
                        const field = order.startsWith('-') ? order.slice(1) : order;
                        if (WQP_CLIENT_FIELDS.includes(field)) { clientOrder = { field: WQP_FIELD_CANONICAL[field] || field, desc: order.startsWith('-') }; continue; }
                        if (WQP_SERVER_REWRITES[field]) { serverParts.push(`order=${order.startsWith('-') ? '-' : ''}${WQP_SERVER_REWRITES[field]}`); continue; }
                        serverParts.push(part); continue;
                    }
                    const rewritten = wqpRewriteServerFilter(decoded);
                    if (rewritten) { serverParts.push(rewritten); continue; }
                    const filter = wqpMatchFilter(decoded);
                    if (filter) { clientFilters.push(filter); continue; }
                    serverParts.push(part);
                }
                const serverUrl = `${url.origin}${url.pathname}${serverParts.length ? `?${serverParts.join('&')}` : ''}`;
                return { limit, offset, clientOrder, clientFilters, serverUrl, active: Boolean(clientOrder || clientFilters.length) };
            }
            function wqpApply(rows, parsed) {
                let out = Array.isArray(rows) ? rows.slice() : [];
                for (const filter of parsed.clientFilters || []) {
                    out = out.filter((row) => wqpCompare(filter.op, wqpValueOf(row, filter.field), filter.value));
                }
                if (parsed.clientOrder) {
                    const { field, desc } = parsed.clientOrder;
                    out.sort((a, b) => {
                        const av = wqpValueOf(a, field), bv = wqpValueOf(b, field);
                        const an = wqpNumericOf(av), bn = wqpNumericOf(bv);
                        const cmp = Number.isFinite(an) && Number.isFinite(bn) ? an - bn : String(av ?? '').localeCompare(String(bv ?? ''));
                        return desc ? -cmp : cmp;
                    });
                }
                return out;
            }
            function wqpPage(rows, parsed) {
                const start = Math.max(0, parsed.offset || 0);
                const size = Math.max(1, parsed.limit || 10);
                return { count: rows.length, results: rows.slice(start, start + size) };
            }
            function wqpEnsureOption(node, key, spec) {
                if (!node || typeof node !== 'object') return;
                node.children = node.children && typeof node.children === 'object' ? node.children : {};
                if (!node.children[key]) node.children[key] = spec;
            }
            function wqpInjectAlphaOptions(root, seen = new Set()) {
                if (!root || typeof root !== 'object' || seen.has(root)) return root;
                seen.add(root);
                if (root.is && typeof root.is === 'object') {
                    wqpEnsureOption(root.is, 'failedNumRA', { type: 'integer', required: false, readOnly: true });
                    wqpEnsureOption(root.is, 'failedNumPPA', { type: 'integer', required: false, readOnly: true });
                    wqpEnsureOption(root.is, 'WQPPYS', { type: 'string', required: false, readOnly: true });
                }
                if (root.regular && typeof root.regular === 'object') {
                    wqpEnsureOption(root.regular, 'operatorCount', { type: 'integer', required: false, readOnly: true });
                }
                for (const key of ['maxProdCorr', 'maxPoolProdCorr', 'maxSelfCorr']) {
                    if (root.is && root.is[key] === undefined) root.is[key] = { type: 'string', required: false, readOnly: true };
                }
                const values = Array.isArray(root) ? root : Object.values(root);
                values.forEach((value) => { if (value && typeof value === 'object') wqpInjectAlphaOptions(value, seen); });
                return root;
            }

            window.fetch = async function (...args) {
                let url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
                const method = requestMethod(args[0], args[1]);
                captureSessionTokenFromFetchArgs(args[0], args[1]);

                const clientQuery = wqpParseUrl(url);
                console.debug('[WQP] alphas query:', url.slice(0, 130), '| client path:', clientQuery?.active || false);
                if (clientQuery?.active) {
                    try {
                        const rows = await loadAlphasForClientQuery(clientQuery.serverUrl);
                        const filtered = wqpApply(rows, clientQuery);
                        const page = wqpPage(filtered, clientQuery);
                        console.log(`[WQP] 虚拟列本地筛选/排序 ${page.results.length}/${page.count}`);
                        return new Response(JSON.stringify(page), {
                            status: 200,
                            headers: { 'Content-Type': 'application/json' },
                        });
                    } catch (error) {
                        console.error('[WQP] 虚拟列全库筛选失败，回退服务端结果', error);
                    }
                    // 回退: 剥离虚拟列参数后再发服务端请求,否则服务器拒绝 → 空列表
                    if (clientQuery.serverUrl !== url) {
                        if (typeof args[0] === 'string') {
                            args[0] = clientQuery.serverUrl;
                        } else if (args[0] instanceof Request) {
                            args[0] = new Request(clientQuery.serverUrl, args[0]);
                        }
                        url = clientQuery.serverUrl;
                    }
                }

                // 执行原始请求
                const response = await originalFetch.apply(this, args);

                // OPTIONS 字段表里补上虚拟列，否则筛选框会报
                // "The filter failedNumPPA is invalid. Try a different syntax"
                if (method === 'OPTIONS' && /\/users\/[^/]+\/alphas\/?$/.test(url.split('?')[0])) {
                    try {
                        const schema = wqpInjectAlphaOptions(await response.clone().json());
                        return new Response(JSON.stringify(schema), {
                            status: response.status,
                            statusText: response.statusText,
                            headers: response.headers,
                        });
                    } catch (error) {
                        console.error('[WQP] 补虚拟列字段表失败', error);
                    }
                }

                // 拦截并修改目标接口的响应
                if (url && url.includes('/users/') && url.includes('/alphas?')) {
                    try {
                        const clone = response.clone();
                        let originalData = await clone.json();

                        // 👉 自定义你的修改逻辑
                        const modifiedData = getAlphaCheckStates(originalData);
                        console.log('拦截并修改了 alphas 响应：', modifiedData);
                        
                        // 构造新 Response 返回给前端
                        return new Response(JSON.stringify(modifiedData), {
                            status: response.status,
                            statusText: response.statusText,
                            headers: response.headers
                        });
                    } catch (e) {
                        console.error("修改响应提取失败：", e);
                    }
                }
                return response;
            };

            const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
            XMLHttpRequest.prototype.setRequestHeader = function (header, value) {
                if (String(header || '').toLowerCase() === 'authorization') {
                    postCapturedSessionToken(value);
                }
                return originalSetRequestHeader.apply(this, arguments);
            };
        }
    }).catch(err => console.error("注入 Fetch 拦截器失败：", err)));
}

// alphaPath: ["is", "sharpe"]， 从select performence开始搜索， activeTabsWithoutParent: ["unsubmitted", "submitted"],
// ############################## 以下为辅助函数 #################################


// 监听 api.worldquantbrain.com 的网络请求并广播到页面用于展示
try {
    chrome.webRequest.onBeforeRequest.addListener(
        (details) => {
            const url = details.url || '';
            if (!url.includes('api.worldquantbrain.com')) return;
            if (isExcluded(url)) return;
            let body = '';
            if ((details.method || '').toUpperCase() === 'POST' && details.requestBody) {
                body = extractRequestBody(details.requestBody);
            }
            const rec = {
                id: details.requestId,
                time: Date.now(),
                type: 'before',
                method: details.method,
                url,
                body,
                tabId: details.tabId,
            };
            recentApiRequests.push(rec);
            if (recentApiRequests.length > MAX_RECENT) recentApiRequests.shift();
            broadcastRequest(rec);
        },
        { urls: ["https://api.worldquantbrain.com/*"] },
        ["requestBody"]
    );

    chrome.webRequest.onCompleted.addListener(
        (details) => {
            const url = details.url || '';
            if (!url.includes('api.worldquantbrain.com')) return;
            if (isExcluded(url)) return;
            const rec = {
                id: details.requestId,
                time: Date.now(),
                type: 'completed',
                method: details.method,
                url,
                statusCode: details.statusCode,
                tabId: details.tabId,
                responseHeaders: details.responseHeaders || [],
            };
            recentApiRequests.push(rec);
            if (recentApiRequests.length > MAX_RECENT) recentApiRequests.shift();
            broadcastRequest(rec);
        },
        { urls: ["https://api.worldquantbrain.com/*"] },
        ["responseHeaders"]
    );
} catch (e) {
    console.warn('webRequest listeners failed to register', e);
}

// 内容脚本可主动请求最近 N 条记录
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'WQP_INDEXED_DATA_GET') {
        handleIndexedDbDataRequest(msg).then((data) => {
            sendResponse({ ok: true, data });
        }).catch((error) => {
            console.error('IndexedDB data request failed:', error);
            sendResponse({ ok: false, error: error.message });
        });
        return true;
    } else if (msg && msg.type === 'WQP_INFO_DATA_SUBSET') {
        getInfoDataSubset(msg).then((data) => {
            sendResponse({ ok: true, data });
        }).catch((error) => {
            console.error('Info data subset request failed:', error);
            sendResponse({ ok: false, error: error.message });
        });
        return true;
    } else if (msg && msg.type === 'WQP_INDEXED_DATA_UPDATED') {
        resetIndexedDbDataCache();
        sendResponse({ ok: true });
        return true;
    }

    if (msg && msg.type === 'REQ_MONITOR_GET_RECENT') {
        // 仅返回最近 100 条，且过滤 tabId 匹配或为 -1 的(无法关联标签的)记录
        const tabId = sender?.tab?.id;
        const list = recentApiRequests
            .filter(r => r.tabId === tabId || r.tabId === -1)
            .slice(-100);
        sendResponse({ ok: true, data: list });
        return true;
    } else if (msg && msg.type === 'REQ_MONITOR_GET_EXCLUDED') {
        sendResponse({ ok: true, data: EXCLUDED_PREFIXES });
        return true;
    } else if (msg && msg.type === 'WQ_MANAGER_LOGIN_AND_OPEN') {
        // 处理WQ Manager登录并打开页面
        console.log(msg.id)
        loginAndOpenWqManager(msg.wq_id, sender.tab.id).then(() => {
            sendResponse({ ok: true });
        }).catch(error => {
            sendResponse({ ok: false, error: error.message });
        });
        return true;
    }
});

async function loginAndOpenWqManager(wqId, currentTabId) {
    // 在当前标签页打开登录页面
    currentTabId = await new Promise((resolve, reject) => {
        chrome.tabs.create({ url: 'https://wqmanager.icu/login', active: true }, (tab) => {
            if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
            resolve(tab.id);
        });
    });


    
    

    // 等待页面加载完成后，填充wq_id并自动提交
    return new Promise((resolve, reject) => {
        const listener = (tabId, changeInfo) => {
            if (tabId === currentTabId && changeInfo.status === 'complete') {
                chrome.tabs.onUpdated.removeListener(listener);

                // 在页面中自动填充wq_id并提交登录表单
                chrome.scripting.executeScript({
                    target: { tabId: currentTabId },
                    func: async (wq_id) => {
                        // 查找wq_id输入框
                        const wqIdInput = document.querySelector('input[type="text"]') ||
                                         document.querySelector('input[name="wq_id"]') ||
                                         document.querySelector('input[placeholder*="WQ"]');

                        if (wqIdInput) {
                            // 填充wq_id
                            wqIdInput.value = wq_id;
                            wqIdInput.dispatchEvent(new Event('input', { bubbles: true }));
                            wqIdInput.dispatchEvent(new Event('change', { bubbles: true }));

                            // 等待一下，然后查找并点击登录按钮
                            setTimeout(() => {
                                const loginButton = document.querySelector('button[type="submit"]') ||
                                                   document.querySelector('button');
                                if (loginButton) {
                                    loginButton.click();
                                }
                            }, 100);
                        }
                    },
                    args: [wqId]
                }).then(() => {
                    resolve();
                }).catch((error) => {
                    reject(error);
                });
            }
        };

        // 导航到 Profile 页面以触发 onUpdated 事件
        chrome.tabs.update(currentTabId, {
            url: 'https://wqmanager.icu/Profile'
        });

        chrome.tabs.onUpdated.addListener(listener);

        setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
            reject(new Error('页面加载超时'));
        }, 10000);
    });
}

function broadcastRequest(rec) {
    // 仅向 platform.worldquantbrain.com 的标签分发
    chrome.tabs.query({ url: '*://platform.worldquantbrain.com/*' }, (tabs) => {
        for (const t of tabs) {
            chrome.tabs.sendMessage(t.id, { type: 'REQ_MONITOR_NEW', data: rec });
        }
    });
}

// 版本比较函数
function compareVersions(v1, v2) {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);
    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
        const num1 = parts1[i] || 0;
        const num2 = parts2[i] || 0;
        if (num1 !== num2) return num1 - num2;
    }
    return 0;
}

// 获取最新版本
async function checkUpdate() {
    try {
        const today = new Date().toISOString().split('T')[0]; // 获取当前日期 (YYYY-MM-DD)

        // 读取存储的上次提醒日期
        chrome.storage.local.get('WQP_LastNotifyDate', async ({ WQP_LastNotifyDate }) => {
            console.log('上次提醒日期:', WQP_LastNotifyDate);
            if (WQP_LastNotifyDate === today) {
                console.log('今天已经提醒过，无需重复提醒');
                return;
            }
            console.log('今天尚未提醒过，开始检查更新');

            // 获取 GitHub 上的最新版本
            const response = await fetch(
                `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`
            );
            const data = await response.json();
            const latestVersion = data.tag_name.replace(/^v/, ''); // 去除可能的v前缀
            const currentVersion = chrome.runtime.getManifest().version;
            console.log('最新版本:', latestVersion, '当前版本:', currentVersion);

            // 版本对比
            if (compareVersions(latestVersion, currentVersion) > 0) {
                showNotification(latestVersion, `https://github.com/${REPO_OWNER}/${REPO_NAME}/archive/refs/tags/${latestVersion}.zip`);

                // 记录今天已经提醒过
                chrome.storage.local.set({ WQP_LastNotifyDate: today });
            }
        });

    } catch (error) {
        console.error('检查更新失败:', error);
    }
}

// 显示通知
function showNotification(version, url) {
    chrome.notifications.create({
        type: 'basic',
        iconUrl: chrome.runtime.getURL('img/logo-128.png'), // 使用插件内的图片
        title: '发现新版本(WorldQuant Scope插件)',
        message: `点击下载 ${version}`,
    }, () => {
        chrome.notifications.onClicked.addListener(() => {
            chrome.tabs.create({ url });
        });
    });
}



// 获取数据集列表
async function getDataSetList() {
    const data = await getJsonDataFile(DATA_SET_LIST_PATH);
    if (!Array.isArray(data)) {
        throw new Error(`${DATA_SET_LIST_PATH} is not a valid data set list`);
    }
    return data;
}

// 注入分布图脚本
function injectionDistributionScript(tabId) {
    try {
        chrome.scripting.insertCSS({
            target: { tabId: tabId },
            files: [`${PATHS.platformDistribution}/distribution.css`],
        });
        chrome.scripting.executeScript({
            target: { tabId: tabId },
            files: [
                `${PATHS.sharedContent}/utils.js`,
                `${PATHS.platformDistribution}/distribution.js`,
            ],
        });
    } catch (error) {
        console.error('Script injection failed: ', error);
    }
}
// 注入数据标记脚本
async function injectionDataFlagScript(tabId, tab) {
    if (dataSetList === null) {
        try {
            dataSetList = await getDataSetList();
        } catch (error) {
            console.warn('Unable to load dataSetList from IndexedDB.', error);
            dataSetList = [];
        }
    }
    try {
        // 注入数据标记脚本
        chrome.scripting.executeScript({
            target: { tabId: tabId },
            files: [
                `${PATHS.sharedContent}/utils.js`,
                `${PATHS.platformData}/dataFlag.js`,
            ],
        }, () => {
            chrome.scripting.executeScript({
                target: { tabId },
                // 仅传递必要的元数据，不传递巨大的 dataInfo 对象
                args: [dataSetList, tab.url],
                func: (...args) => dataFlagFunc(...args),
            });
        });

    }
    catch (error) {
        console.error('Script injection failed: ', error);
    }
}

// 注入 Genius 脚本
function injectionGeniusScript(tabId) {
    try {
        // 注入 CSS 文件
        chrome.scripting.insertCSS({
            target: { tabId: tabId },
            files: [
                `${PATHS.platformGenius}/genius.css`,
                `${PATHS.platformStyles}/idcard.css`,
                `${PATHS.vendorCss}/dataTables.dataTables.css`,
                `${PATHS.vendorCss}/columnControl.dataTables.min.css`,
                `${PATHS.vendorCss}/responsive.dataTables.min.css`,
                `${PATHS.vendorCss}/buttons.dataTables.min.css`,
            ],
        }, () => {
            if (chrome.runtime.lastError) {
                console.error("CSS注入失败", chrome.runtime.lastError.message);
            } else {
                console.log("CSS注入成功");
            }
        });

        // 检查是否已经注入了js脚本
        chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: () => {
                return typeof OptUrl !== 'undefined';
            },
        }, (results) => {
            if (!results || !results[0].result) {
                // 如果 OptUrl 未定义，则注入脚本
                chrome.scripting.executeScript({
                    target: { tabId: tabId },
                    files: [
                        `${PATHS.sharedContent}/requestMonitorUI.js`,
                        `${PATHS.vendorJs}/jquery-3.7.0.min.js`,
                        `${PATHS.vendorJs}/jquery.dataTables.min.js`,
                        `${PATHS.vendorJs}/dataTables.columnControl.min.js`,
                        `${PATHS.vendorJs}/columnControl.dataTables.min.js`,
                        `${PATHS.vendorJs}/dataTables.responsive.min.js`,
                        `${PATHS.vendorJs}/responsive.dataTables.min.js`,
                        `${PATHS.vendorJs}/dataTables.buttons.min.js`,
                        `${PATHS.vendorJs}/buttons.colVis.min.js`,
                        `${PATHS.vendorJs}/buttons.html5.min.js`,
                        `${PATHS.sharedContent}/utils.js`,
                        `${PATHS.sharedContent}/uiCard.js`,
                        `${PATHS.platformGenius}/sixDimRank.js`,
                        `${PATHS.platformGenius}/genius.js`,
                    ],
                });
            }
            else {
                // 如果 OptUrl 已定义，则直接注入数据
                chrome.scripting.executeScript({
                    target: { tabId: tabId },
                    args: [],
                    func: (...args) => watchForElementAndInsertButton(...args),
                });
                // 同时确保请求监视器 UI 注入
                chrome.scripting.executeScript({
                    target: { tabId: tabId },
                    files: [`${PATHS.sharedContent}/requestMonitorUI.js`],
                });
            }
        });
        console.log(tabId.url);
    } catch (error) {
        console.error('Script injection failed: ', error);
    }
}

function injectionSimulateScript(tabId) {
    try {
        chrome.scripting.insertCSS({
            target: { tabId: tabId },
            files: [
                `${PATHS.platformSimulate}/simulate.css`,
            ],
        });
        chrome.scripting.executeScript({
            target: { tabId: tabId },
            files: [
                `${PATHS.platformSimulate}/simulate.js`,
            ],
        });
    } catch (error) {
        console.error('Script injection failed: ', error);
    }
}

function isAlphaAssistantUrl(value) {
    try {
        const url = new URL(String(value || ''));
        if (url.hostname !== 'platform.worldquantbrain.com') return false;
        if (/^\/alphas\/unsubmitted(?:\/|$)/i.test(url.pathname)) return true;
        if (/^\/simulate(?:\/|$)/i.test(url.pathname)) return true;
        const alphaPath = url.pathname.match(/^\/alphas?\/([^/]+)/i);
        const alphaId = String(alphaPath?.[1] || '').toLowerCase();
        return Boolean(alphaId && !['unsubmitted', 'submitted', 'distribution'].includes(alphaId));
    } catch (_) {
        return false;
    }
}

const alphaAssistantInjectionTasks = new Map();

function injectionAlphaDescriptionAssistant(tabId) {
    if (alphaAssistantInjectionTasks.has(tabId)) return alphaAssistantInjectionTasks.get(tabId);

    const task = chrome.scripting.executeScript({
        target: { tabId },
        func: () => Boolean(window.__WQP_ALPHA_DESCRIPTION_ASSISTANT__),
    }).then((results) => {
        if (results?.[0]?.result) return;
        return Promise.all([
            chrome.scripting.insertCSS({
                target: { tabId },
                files: [`${PATHS.platformAlpha}/alphaDescriptionAssistant.css`],
            }),
            chrome.scripting.executeScript({
                target: { tabId },
                files: [`${PATHS.platformAlpha}/alphaDescriptionAssistant.js`],
            }),
        ]);
    }).catch((error) => {
        console.warn('AI Alpha 描述助手注入失败：', error);
    }).finally(() => {
        alphaAssistantInjectionTasks.delete(tabId);
    });

    alphaAssistantInjectionTasks.set(tabId, task);
    return task;
}

function isExcluded(url) {
    if (!url) return false;
    if (!Array.isArray(EXCLUDED_PREFIXES) || EXCLUDED_PREFIXES.length === 0) return false;
    return EXCLUDED_PREFIXES.some(p => typeof p === 'string' && url.startsWith(p));
}

const MAX_BODY_LEN = 2000;
function extractRequestBody(requestBody) {
    try {
        if (!requestBody) return '';
        if (requestBody.formData) {
            const parts = [];
            for (const k of Object.keys(requestBody.formData)) {
                const vals = requestBody.formData[k];
                if (Array.isArray(vals)) {
                    for (const v of vals) parts.push(`${k}=${String(v)}`);
                } else {
                    parts.push(`${k}=${String(vals)}`);
                }
            }
            return parts.join('&').slice(0, MAX_BODY_LEN);
        }
        if (requestBody.raw && Array.isArray(requestBody.raw) && requestBody.raw.length > 0) {
            const chunk = requestBody.raw[0];
            const bytes = chunk.bytes;
            if (bytes) {
                const u8 = new Uint8Array(bytes);
                const txt = new TextDecoder('utf-8').decode(u8);
                return txt.slice(0, MAX_BODY_LEN);
            }
        }
    } catch (e) {
        console.warn('extractRequestBody failed', e);
    }
    return '';
}
