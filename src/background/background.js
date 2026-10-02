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

                // Operator Count 重算: 平台把表达式开头的负号算作一个算子(实测平台数 = 算子数 + 前导负号),
                // 负号按用户口径计入; ts_backfill / group_backfill 是豁免壳, 不计入
                const WQP_OPERATOR_NAMES = new Set(`add multiply sign subtract pasteurize log max abs divide min signed_power
                    inverse sqrt reverse power densify or and not is_nan less equal greater if_else not_equal less_equal
                    greater_equal ts_corr ts_zscore ts_returns ts_product ts_std_dev ts_backfill days_from_last_change
                    last_diff_value ts_scale ts_step ts_sum ts_av_diff ts_kurtosis ts_mean ts_arg_max ts_rank ts_ir ts_delay
                    ts_quantile ts_count_nans ts_covariance ts_decay_linear ts_arg_min ts_regression ts_max_diff
                    kth_element hump ts_delta ts_target_tvr_decay ts_target_tvr_hump winsorize rank vector_neut zscore
                    scale normalize quantile vec_min vec_count vec_sum vec_max vec_avg vec_stddev vec_range bucket tail
                    trade_when group_mean group_rank group_backfill group_scale group_count group_zscore group_std_dev
                    group_sum group_neutralize`.split(/\s+/).filter(Boolean));
                const WQP_FREE_OPERATORS = new Set(['ts_backfill', 'group_backfill']);
                function wqpOperatorTokens(code) {
                    const tokens = String(code || '').match(/[A-Za-z_][A-Za-z0-9_]*/g) || [];
                    return tokens.filter((t) => WQP_OPERATOR_NAMES.has(t));
                }
                function wqpRewriteOperatorCount(regular) {
                    if (!regular?.code) return;
                    const platform = Number(regular.operatorCount);
                    regular.operatorCountPlatform = Number.isFinite(platform) ? platform : null;
                    const ops = wqpOperatorTokens(regular.code);
                    const noShell = ops.filter((t) => !WQP_FREE_OPERATORS.has(t)).length;
                    const sign = /^\s*-/.test(regular.code) ? 1 : 0; // 前导负号也算一个算子
                    regular.operatorCount = noShell + sign;
                    regular.operatorCountNoShell = noShell;
                }

                // 2. 核心逻辑：遍历数据，统计不合格数量并新增字段
                // 
                // 比如sub-univers ,robust 其实能不能把那些fail的具体值做出来，比如robust 那些的值
                // 能不能加个显示负的alpha的功能，比如当sharp为负的时候，如果测试值的绝对值都能通过平台标准就显示’-0‘
                // risk neut那个就是用传统neut跑的时候 会有个risk neut的线 大概sharpe 和 fit都更高的话 就需要遍历risk neut
                // 按照具体的pyramid筛选
                if (!Array.isArray(originalData?.results)) return originalData;
                const prodMemoCache = readProdMemoCache();
                originalData.results.forEach(item => {
                    wqpRewriteOperatorCount(item?.regular);
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
            const clientAlphaInflight = new Map();

            // 全库存在页面自己的 IndexedDB(同站点所有标签页共享, 1.10.25 拉的那批也在这里): 直接读写, 不经过后台消息
            function wqpPoolDb() {
                return new Promise((resolve, reject) => {
                    const req = indexedDB.open('WQP_AlphaPool', 1);
                    req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains('pools')) db.createObjectStore('pools'); };
                    req.onsuccess = () => resolve(req.result);
                    req.onerror = () => reject(req.error);
                });
            }
            async function wqpPoolGet(key) {
                try {
                    const db = await wqpPoolDb();
                    const rec = await new Promise((resolve) => {
                        const req = db.transaction('pools', 'readonly').objectStore('pools').get(key);
                        req.onsuccess = () => resolve(req.result || null);
                        req.onerror = () => resolve(null);
                    });
                    db.close();
                    return rec;
                } catch (_) { return null; }
            }
            async function wqpPoolSet(key, value) {
                try {
                    const db = await wqpPoolDb();
                    await new Promise((resolve) => {
                        const tx = db.transaction('pools', 'readwrite');
                        tx.objectStore('pools').put(value, key);
                        tx.oncomplete = () => resolve();
                        tx.onerror = () => resolve();
                    });
                    db.close();
                } catch (_) { /* 写入失败不影响本次筛选 */ }
            }

            // 一次性迁移: 1.10.25 把库存在页面源 IndexedDB, 1.10.26 起改存扩展源。
            // 这里把旧库分批拷进扩展源, 这样升级后不用重新全量下载。
            let wqpMigrateStarted = false;
            async function wqpMigratePoolOnce() {
                if (wqpMigrateStarted) return;
                wqpMigrateStarted = true;
                const FLAG = 'WQP_PoolMigrated_v26';
                try {
                    if (localStorage.getItem(FLAG) === '1') return;
                    const dbs = (await indexedDB.databases?.()) || [];
                    if (!dbs.some((d) => d.name === 'WQP_AlphaPool')) { localStorage.setItem(FLAG, '1'); return; }
                    const db = await new Promise((resolve, reject) => {
                        const req = indexedDB.open('WQP_AlphaPool');
                        req.onsuccess = () => resolve(req.result);
                        req.onerror = () => reject(req.error);
                    });
                    if (!db.objectStoreNames.contains('pools')) { db.close(); localStorage.setItem(FLAG, '1'); return; }
                    const entries = await new Promise((resolve) => {
                        const out = [];
                        const req = db.transaction('pools', 'readonly').objectStore('pools').openCursor();
                        req.onsuccess = () => {
                            const c = req.result;
                            if (c) { out.push([c.key, c.value]); c.continue(); } else resolve(out);
                        };
                        req.onerror = () => resolve(out);
                    });
                    db.close();
                    const BATCH = 2000;
                    for (const [key, rec] of entries) {
                        const rows = rec?.rows || [];
                        if (!rows.length) continue;
                        for (let off = 0; off < rows.length; off += BATCH) {
                            const batch = rows.slice(off, off + BATCH);
                            await new Promise((resolve) => {
                                try {
                                    chrome.runtime.sendMessage({ type: 'WQP_POOL_IMPORT', key, rows: batch, newest: rec.newest || '' }, () => resolve());
                                } catch (_) { resolve(); }
                            });
                        }
                        console.log(`[WQP] 已迁移本地库: ${rows.length} 行`);
                    }
                    localStorage.setItem(FLAG, '1');
                } catch (e) {
                    console.warn('[WQP] 本地库迁移失败(将重新全量拉取)', e);
                }
            }

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

            // 本地库按 status 共用一份(未提交池只有一份): type / dateCreated / hidden 全部在本地过滤,
            // 页面同时发的 REGULAR、RA、不同日期窗口查询都命中同一份库, 全量只拉一次
            function wqpPoolUrl(serverUrl) {
                const u = new URL(serverUrl);
                const status = u.searchParams.get('status') || 'UNSUBMITTED';
                return `${u.origin}${u.pathname}?status=${encodeURIComponent(status)}`;
            }

            async function loadAlphasForClientQuery(serverUrl) {
                serverUrl = wqpPoolUrl(serverUrl);
                // 缓存键归一化: 去掉 order/limit/offset, 同一筛选集共用一份本地库
                const cacheKey = serverUrl.replace(/([?&])(order|limit|offset)=[^&]*/g, '$1').replace(/[?&]+$/, '');
                const mem = clientAlphaCache.get(cacheKey);
                if (mem && Date.now() - mem.at < 60000) return mem.rows; // 1 分钟内的重复请求(应用重试)直接用内存
                if (clientAlphaInflight.has(cacheKey)) return clientAlphaInflight.get(cacheKey); // 同一个拉取不并发重入
                const task = (async () => {
                    const stored = await wqpPoolGet(cacheKey); // { rows, newest } 或 null
                    console.log(`[WQP] 本地库读取 key=${cacheKey} 已有 ${stored?.rows?.length || 0} 行`);
                    const have = new Set((stored?.rows || []).map((r) => r.id));
                    const watermark = stored?.newest || '';
                    const fresh = [];
                    const seenIds = new Set();
                    let cursor = null;
                    const joiner = serverUrl.includes('?') ? '&' : '?';
                    let failedPages = 0;
                    for (let guard = 0; guard < 500; guard += 1) {
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
                        let newOnPage = 0;
                        for (const row of page) {
                            if (row.id && seenIds.has(row.id)) continue;
                            if (row.id) seenIds.add(row.id);
                            const ts = row.dateCreated;
                            if (ts && (!oldest || ts < oldest)) oldest = ts;
                            if (row.id && have.has(row.id)) continue; // 本地已有
                            fresh.push(row);
                            newOnPage += 1;
                        }
                        console.log(`[WQP] 虚拟列拉取${watermark ? '(增量)' : '(全量)'} 新增 ${fresh.length} 行`);
                        if (page.length < 100) break; // 不足一页 = 到底
                        // 增量模式: 翻到已存储的水位以下且本页无新增, 说明追平了
                        if (watermark && oldest && oldest <= watermark && newOnPage === 0) break;
                        if (!oldest || oldest === cursor) break; // 游标无进展, 防死循环
                        cursor = oldest;
                    }
                    const rows = fresh.concat(stored?.rows || []);
                    // 老库里存的是平台口径的 operatorCount, 读出来统一按用户口径重算
                    for (const row of rows) wqpRewriteOperatorCount(row?.regular);
                    let newest = watermark;
                    for (const row of fresh) if (row.dateCreated && row.dateCreated > newest) newest = row.dateCreated;
                    await wqpPoolSet(cacheKey, { rows, newest });
                    clientAlphaCache.set(cacheKey, { at: Date.now(), rows });
                    console.log(`[WQP] 本地库已更新: 共 ${rows.length} 行(本次新增 ${fresh.length})`);
                    return rows;
                })();
                clientAlphaInflight.set(cacheKey, task);
                try { return await task; } finally { clientAlphaInflight.delete(cacheKey); }
            }

            function requestMethod(resource, config) {
                const method = config?.method || (resource instanceof Request ? resource.method : 'GET');
                return String(method || 'GET').toUpperCase();
            }

            // ---- 虚拟列查询: 内联实现(不再依赖 wqpClientQuery.js 注入是否成功) ----
            const WQP_CLIENT_FIELDS = ['is.failedNumRA', 'failedNumRA', 'is.failedNumPPA', 'failedNumPPA', 'is.WQPPYS', 'WQPPYS', 'maxSelfCorr', 'maxPoolProdCorr', 'maxProdCorr', 'regular.operatorCount', 'operatorCount'];
            const WQP_FIELD_CANONICAL = { failedNumRA: 'is.failedNumRA', failedNumPPA: 'is.failedNumPPA', WQPPYS: 'is.WQPPYS', 'regular.operatorCount': 'operatorCount' };
            const WQP_SERVER_REWRITES = {};
            const WQP_OPS = ['<=', '>=', '!=', '<', '>', '='];
            // 列定义名(filters.maxProdCorr)与 Unicode 运算符(≥1)在请求里也可能原样出现, 统一成 field<op>value
            const WQP_UNICODE_OPS = { '\u2265': '>=', '\u2264': '<=', '\u2260': '!=' };
            function wqpNormalizeToken(token) {
                let t = String(token).replace(/^(?:filters|filter)\./i, '');
                t = t.replace(/[\u2265\u2264\u2260]/g, (ch) => WQP_UNICODE_OPS[ch]);
                const m = t.match(/^([A-Za-z0-9_.]+):(.+)$/); // 只在冒号前全是字段名字符时才拆, 免得砍掉 ISO 时间里的冒号
                if (!m) return t;
                const [, head, tail] = m;
                if (/^(?:>=|<=|!=|=|<|>)/.test(tail)) return head + tail;
                return `${head}=${tail}`;
            }
            // 最近一次虚拟列查询, 供控制台自查命令复算
            let wqpLastQuery = null;
            window.WQP_DEBUG_ALPHA = async (alphaId) => {
                if (!wqpLastQuery) return { error: '还没有记录到虚拟列查询, 先在列表上点一次筛选' };
                const { url, parsed } = wqpLastQuery;
                const rows = await loadAlphasForClientQuery(parsed.serverUrl);
                const row = rows.find((r) => r.id === alphaId);
                if (!row) return { found: false, poolRows: rows.length, url, hint: '该 alpha 不在本地库里' };
                const details = (parsed.clientFilters || []).map((f) => {
                    const value = wqpValueOf(row, f.field);
                    const corrNa = ['maxProdCorr', 'maxPoolProdCorr', 'maxSelfCorr'].includes(f.field)
                        && !Number.isFinite(value) && (f.op === '<' || f.op === '<=');
                    return `${f.field} ${f.op} ${f.value} | 值=${Number.isNaN(value) ? 'NaN(没查过)' : value} | ${corrNa || wqpCompare(f.op, value, f.value) ? '通过' : '被筛掉'}`;
                });
                const kept = wqpApply(wqpConstrain(rows, url), parsed);
                return {
                    found: true, poolRows: rows.length, url, details,
                    surviveConstrain: wqpConstrain(rows, url).some((r) => r.id === alphaId),
                    surviveFilter: kept.some((r) => r.id === alphaId),
                    keptTotal: kept.length,
                    values: {
                        type: row.type, region: row.settings?.region, universe: row.settings?.universe,
                        sharpe: row.is?.sharpe, failedNumRA: row.is?.failedNumRA, failedNumPPA: row.is?.failedNumPPA,
                        operatorCount: row.regular?.operatorCount, operatorCountPlatform: row.regular?.operatorCountPlatform,
                        operatorCountNoShell: row.regular?.operatorCountNoShell,
                        maxProdCorr: row.maxProdCorr, dateCreated: row.dateCreated,
                    },
                };
            };

            // Prod/Pool/Self Corr 的值不在列表 API 里, 来自插件查过的本地记录(localStorage)
            let wqpMemoCache = null;
            function wqpMemo() {
                if (wqpMemoCache) return wqpMemoCache;
                try { wqpMemoCache = JSON.parse(localStorage.getItem('WQP_ProdMemoCache') || '{}') || {}; }
                catch (_) { wqpMemoCache = {}; }
                return wqpMemoCache;
            }
            function wqpMemoNumeric(alphaId, kind) {
                const metric = wqpMemo()[alphaId]?.[kind];
                const numeric = Number(metric?.max);
                return Number.isFinite(numeric) ? numeric : NaN; // 没查过 = NaN, 数值比较不命中
            }

            function wqpValueOf(row, field) {
                const canonical = WQP_FIELD_CANONICAL[field] || field;
                if (canonical === 'is.failedNumRA') return Number(row.is?.failedNumRA ?? 0);
                if (canonical === 'is.failedNumPPA') return Number(row.is?.failedNumPPA ?? 0);
                if (canonical === 'is.WQPPYS') return String(row.is?.WQPPYS ?? '');
                if (canonical === 'maxProdCorr') return wqpMemoNumeric(row.id, 'prod');
                if (canonical === 'maxPoolProdCorr') return wqpMemoNumeric(row.id, 'pool');
                if (canonical === 'maxSelfCorr') return wqpMemoNumeric(row.id, 'self');
                if (canonical === 'operatorCount') return Number(row.regular?.operatorCount ?? NaN);
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
                    const decoded = wqpNormalizeToken(decodeURIComponent(part.replace(/\+/g, ' ')));
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
            // 服务端筛选参数在本地库上补做: 库只按 status 存整池, 这些条件不补就会被丢掉
            const WQP_LOCAL_SKIP = new Set(['limit', 'offset', 'order', 'type', 'hidden', 'status']);
            function wqpPath(row, path) {
                return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), row);
            }
            // 前端有时用短名(region)有时用全路径(settings.region), 两边都试
            function wqpResolve(row, field) {
                const direct = wqpPath(row, field);
                if (direct !== undefined) return direct;
                if (String(field).includes('.')) return undefined;
                return row.settings?.[field] ?? row.is?.[field];
            }
            function wqpConstrain(rows, rawUrl) {
                let types = null;
                let hidden = null;
                let min = null;
                let max = null;
                let minInc = true;
                let maxInc = false;
                const generic = [];
                const q = String(rawUrl).split('?')[1] || '';
                for (const part of q.split('&')) {
                    let d;
                    try { d = wqpNormalizeToken(decodeURIComponent(part.replace(/\+/g, ' '))); } catch (_) { continue; }
                    if (d.startsWith('type=')) { types = d.slice(5).split('\u001f').filter(Boolean); continue; }
                    if (d.startsWith('hidden=')) { hidden = d.slice(7) === 'true'; continue; }
                    const dm = d.match(/^dateCreated(>=|<=|>|<)(.+)$/);
                    if (dm) {
                        if (dm[1] === '>=' || dm[1] === '>') { min = dm[2]; minInc = dm[1] === '>='; }
                        else { max = dm[2]; maxInc = dm[1] === '<='; }
                        continue;
                    }
                    const gm = d.match(/^([A-Za-z0-9_.]+)(>=|<=|!=|>|<|=)(.*)$/);
                    if (!gm || WQP_LOCAL_SKIP.has(gm[1]) || WQP_CLIENT_FIELDS.includes(gm[1])) continue;
                    generic.push({ field: gm[1], op: gm[2], value: gm[3] });
                }
                if (!types && hidden === null && !min && !max && !generic.length) return rows;
                // 字段名对不上时(取不到值)宁可不过滤, 也不要把整池清空
                for (const g of generic) {
                    if (!rows.some((r) => wqpResolve(r, g.field) !== undefined)) {
                        console.log(`[WQP] 本地补过滤跳过 ${g.field}${g.op}${g.value}: 行内无此字段`);
                        g.skip = true;
                    }
                }
                return rows.filter((r) => {
                    if (types && !types.includes(r.type)) return false;
                    if (hidden !== null && Boolean(r.hidden) !== hidden) return false;
                    const ts = r.dateCreated || '';
                    if (min && (minInc ? ts < min : ts <= min)) return false;
                    if (max && (maxInc ? ts > max : ts >= max)) return false;
                    for (const g of generic) {
                        if (g.skip) continue;
                        const actual = wqpResolve(r, g.field);
                        if (g.op === '=') {
                            if (!g.value.split('\u001f').includes(String(actual ?? ''))) return false;
                        } else if (!wqpCompare(g.op, actual, g.value)) return false;
                    }
                    return true;
                });
            }

            function wqpApply(rows, parsed) {
                let out = Array.isArray(rows) ? rows.slice() : [];
                const CORR_FIELDS = ['maxProdCorr', 'maxPoolProdCorr', 'maxSelfCorr'];
                for (const filter of parsed.clientFilters || []) {
                    out = out.filter((row) => {
                        const value = wqpValueOf(row, filter.field);
                        // 没查过 corr 的(值为 NaN)按用户口径视为满足 < 阈值
                        if (CORR_FIELDS.includes(filter.field) && !Number.isFinite(value) && (filter.op === '<' || filter.op === '<=')) {
                            return true;
                        }
                        return wqpCompare(filter.op, value, filter.value);
                    });
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
                if (clientQuery?.active) wqpLastQuery = { url, parsed: clientQuery };
                console.debug('[WQP] alphas query:', url.slice(0, 130), '| client path:', clientQuery?.active || false);
                if (clientQuery?.active) {
                    try {
                        const rows = wqpConstrain(await loadAlphasForClientQuery(clientQuery.serverUrl), url);
                        const filtered = wqpApply(rows, clientQuery);
                        const page = wqpPage(filtered, clientQuery);
                        const start = Math.max(0, clientQuery.offset || 0);
                        const size = Math.max(1, clientQuery.limit || 10);
                        // 信封按真实 API 形状补全(id/name/count/next/previous): 应用解码器缺字段就丢弃响应并重试
                        page.id = 'wqp-client-page';
                        page.name = 'wqp-client-page';
                        page.next = start + size < filtered.length ? 'https://api.worldquantbrain.com/wqp/next' : null;
                        page.previous = start > 0 ? 'https://api.worldquantbrain.com/wqp/prev' : null;
                        const withProd = rows.filter((r) => Number.isFinite(wqpMemoNumeric(r.id, 'prod'))).length;
                        console.log(`[WQP] 虚拟列本地筛选/排序 ${page.results.length}/${page.count}（拉取 ${rows.length} 行, 其中有 prod corr 记录 ${withProd} 行）`);
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

// 未提交池本地库(扩展源 IndexedDB, 所有标签页共享): 首次全量, 之后增量
const WQP_POOL_DB = 'WQP_AlphaPool';
function wqpPoolOpen() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(WQP_POOL_DB, 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('pools')) db.createObjectStore('pools');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}
async function wqpPoolGet(key) {
    const db = await wqpPoolOpen();
    const all = await new Promise((resolve) => {
        const out = [];
        const req = db.transaction('pools', 'readonly').objectStore('pools').openCursor();
        req.onsuccess = () => { const c = req.result; if (c) { out.push([c.key, c.value]); c.continue(); } else resolve(out); };
        req.onerror = () => resolve(out);
    });
    const keySummary = all.map(([k, v]) => `${k} => ${v?.rows?.length || 0}行`).join(' | ') || '(空)';
    // 精确键命中优先; 没命中就取行数最多的那份(库里本来就只有一份未提交池, 避免键有细微差异时读成空)
    const hit = all.find(([k]) => k === key)
        || all.slice().sort((a, b) => (b[1]?.rows?.length || 0) - (a[1]?.rows?.length || 0))[0];
    return { data: hit ? hit[1] : null, keySummary };
}
async function wqpPoolSet(key, value) {
    const db = await wqpPoolOpen();
    return new Promise((resolve) => {
        const tx = db.transaction('pools', 'readwrite');
        tx.objectStore('pools').put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
    });
}

// 内容脚本可主动请求最近 N 条记录
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'WQP_POOL_GET') {
        // 读完再发一条消息回页面(由 ISOLATED 内容脚本转发进 MAIN world):
        // MV3 service worker 里异步 sendResponse 会丢, 页面 MAIN world 又没有 chrome.storage
        const tabId = sender.tab?.id;
        wqpPoolGet(msg.key).then((res) => {
            if (tabId) chrome.tabs.sendMessage(tabId, { type: 'WQP_POOL_DATA', reqId: msg.reqId, data: res?.data || null, keySummary: res?.keySummary || '(空)' }).catch(() => {});
        }).catch(() => {
            if (tabId) chrome.tabs.sendMessage(tabId, { type: 'WQP_POOL_DATA', reqId: msg.reqId, data: null, keySummary: '读取异常' }).catch(() => {});
        });
        return false;
    }
    if (msg && msg.type === 'WQP_POOL_SET') {
        wqpPoolSet(msg.key, msg.value).then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: String(e) }));
        return true;
    }
    if (msg && msg.type === 'WQP_POOL_IMPORT') {
        // 迁移: 把 1.10.25 存在页面源 IndexedDB 的库分批并入扩展源库(按 id 去重)
        (async () => {
            const cur = (await wqpPoolGet(msg.key))?.data || { rows: [], newest: '' };
            const have = new Set((cur.rows || []).map((r) => r.id));
            for (const row of msg.rows || []) {
                if (row?.id && have.has(row.id)) continue;
                if (row?.id) have.add(row.id);
                cur.rows.push(row);
            }
            if (msg.newest && msg.newest > (cur.newest || '')) cur.newest = msg.newest;
            await wqpPoolSet(msg.key, cur);
            sendResponse({ ok: true, count: cur.rows.length });
        })().catch((e) => sendResponse({ ok: false, error: String(e) }));
        return true;
    }
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
