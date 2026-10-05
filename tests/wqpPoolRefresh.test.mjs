// 验证虚拟列本地库的刷新/重建行为。
// 沿用 wqpNewFieldCount.test.mjs 的写法: 按标记注释切 background.js 原文, new Function 沙箱里跑,
// 依赖(wqpPoolGet/wqpPoolSet/fetchAlphasPage/…)用替身注入, 不重新实现被测逻辑。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const src = fs.readFileSync(path.join(root, 'src/background/background.js'), 'utf8');

// ---- 切出被测代码块 ----
// wqpPoolUrl 在上, 中间只隔着刷新常量的注释, 所以以那条注释为界切开两段, 避免重复声明
const REFRESH_MARK = '// 每次加载都重拉最近这么多页';
const END_MARK = 'function requestMethod(resource, config) {';
function sliceBetween(startMark, endMark) {
    const a = src.indexOf(startMark);
    const b = src.indexOf(endMark, a);
    if (a < 0 || b < 0 || b <= a) throw new Error(`未能定位代码块: ${startMark} → ${endMark}`);
    return src.slice(a, b);
}
const poolUrlBlock = sliceBetween('function wqpPoolUrl(serverUrl) {', REFRESH_MARK);
const loaderBlock = sliceBetween(REFRESH_MARK, END_MARK);

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
    if (cond) { pass += 1; console.log(`  ok  ${name}`); }
    else { fail += 1; console.log(`FAIL  ${name} ${extra}`); }
};

// ---- 沙箱: 内存版 IndexedDB 冒充 pool ----
const store = new Map();
// 记录每次 fetchAlphasPage 被调用时用的 URL, 用来数页数
let fetchLog = [];
let pagePlan = []; // 每次调用取一个 plan: { rows: [...] }

function makeApi({ store: st, plan } = {}) {
    const s = st || new Map();
    const calls = [];
    const p = plan || [];
    const sandbox = `
      const clientAlphaCache = new Map();
      const clientAlphaInflight = new Map();
      const wqpNfState = { building: null, detail: new Map() };
      const WQP_NF_KEY = 'wqpNewFields';
      const wqpPoolDb = async () => ({ /* 重建路径用不到 */ });
      const wqpPoolGet = async (k) => s.get(k) || null;
      const wqpPoolSet = async (k, v) => { s.set(k, v); };
      const fetchAlphasPage = async (url) => { calls.push(url); return nextPage(); };
      // 重建消息监听挂在 window 上, 这里只要一个能吃 addEventListener 的壳
      const window = { addEventListener() {} };
      let pageIdx = 0;
      function nextPage() {
        const step = plan[pageIdx];
        pageIdx += 1;
        if (!step) return { page: [], total: 0 };
        if (step.throw) throw new Error(step.throw);
        return { page: step.rows || [], total: step.total || 0 };
      }
${poolUrlBlock}
${loaderBlock}
      return { wqpPoolUrl, loadAlphasForClientQuery, __calls: calls, __pageIdx: () => pageIdx };
    `;
    const factory = new Function('s', 'plan', 'calls', sandbox);
    const api = factory(s, p, calls);
    api.__store = s;
    return api;
}

// 造一行 alpha。dateCreated 要各不相同: 加载器靠 dateCreated<=游标 往回翻,
// 全表同一个时间戳会让「游标无进展」的防死循环判断提前收工, 测不出翻页数。
let seq = 0;
const row = (id, extra = {}) => {
    seq += 1;
    const d = new Date(Date.UTC(2026, 0, 1) + seq * 3600 * 1000);
    return {
        id, dateCreated: d.toISOString().replace('.000Z', 'Z'),
        settings: { region: 'USA' }, is: {}, color: null, ...extra,
    };
};
const page = (n, opts = {}) => Array.from({ length: n }, (_, i) => row(`a${String(i).padStart(3, '0')}`, opts));

console.log('\n== 1. 缓存键: status 与 status! 必须分开 ==');
{
    const api = makeApi();
    const unsub = api.wqpPoolUrl('https://api.worldquantbrain.com/users/self/alphas?limit=50&status=UNSUBMITTED&order=-dateCreated');
    const sub = api.wqpPoolUrl('https://api.worldquantbrain.com/users/self/alphas?limit=50&status!=UNSUBMITTED%1FIS-FAIL&order=-dateCreated');
    check('未提交页键里是 status=UNSUBMITTED', unsub.endsWith('?status=UNSUBMITTED'), unsub);
    check('已提交页不再退回未提交键(这条锁住 status! 回归)', sub !== unsub, sub);
    check('已提交页键保留 != 语义', sub.includes('status!='), sub);
    check('两个键再次归一化后仍不同', api.wqpPoolUrl(sub) === sub);
    const bare = api.wqpPoolUrl('https://api.worldquantbrain.com/users/self/alphas?limit=50');
    check('没带 status 时仍回退未提交', bare.endsWith('?status=UNSUBMITTED'), bare);
    // 历史键(修 bug 前生成的)是 status=UNSUBMITTED 形式, 新键不能再撞回去
    check('已提交键不与历史未提交键相同', sub !== unsub);
}

console.log('\n== 2. 核心: 已有行被覆盖而不是跳过 ==');
{
    // 库里已有 1 行, 颜色是旧的 red; 服务端这次返回同 id, 颜色改成 blue
    const key = 'https://api.worldquantbrain.com/users/self/alphas?status=UNSUBMITTED';
    const st = new Map();
    st.set(key, { rows: [row('a000', { color: 'red' })], newest: '2026-01-10T00:00:00Z' });
    const api = makeApi({ store: st, plan: [{ rows: [row('a000', { color: 'blue' })] }] });
    const rows = await api.loadAlphasForClientQuery(`${key}&limit=10`);
    const got = rows.find((r) => r.id === 'a000');
    check('同 id 的行没有变成两行', rows.filter((r) => r.id === 'a000').length === 1, JSON.stringify(rows.map((r) => r.id)));
    check('颜色被服务端的新值覆盖(不是沿用旧值)', got?.color === 'blue', `拿到 color=${got?.color}`);
}

console.log('\n== 3. 派生列随刷新重算 ==');
{
    // 模拟 failedNumPPA: 库里冻着 0, 服务端这份 checks 变了(经 getAlphaCheckStates 算出的新值)
    const key = 'https://api.worldquantbrain.com/users/self/alphas?status=UNSUBMITTED';
    const st = new Map();
    st.set(key, {
        rows: [row('a000', { is: { failedNumPPA: 0, failedNumRA: 0 } })],
        newest: '2026-01-10T00:00:00Z',
    });
    const api = makeApi({
        store: st,
        plan: [{ rows: [row('a000', { is: { failedNumPPA: 3, failedNumRA: 1 } })] }],
    });
    const rows = await api.loadAlphasForClientQuery(`${key}&limit=10`);
    check('failedNumPPA 不再冻结在旧值', rows[0]?.is?.failedNumPPA === 3, `拿到 ${rows[0]?.is?.failedNumPPA}`);
    check('failedNumRA 一并更新', rows[0]?.is?.failedNumRA === 1, `拿到 ${rows[0]?.is?.failedNumRA}`);
}

console.log('\n== 4. 稳态下只翻固定几页, 不无限翻 ==');
{
    // 库里已满, 服务端每页返回的都是库里已有的行(全都没有新增) → 应在 REFRESH_PAGES 页后收工。
    // 每页 id 必须各不相同: 若各页 id 一样, 第二页起会被同页去重全跳过, oldest 变 null,
    // 「游标无进展」的防死循环判断会提前收工, 就测不出真实翻页数了。
    const key = 'https://api.worldquantbrain.com/users/self/alphas?status=UNSUBMITTED';
    const TOTAL = 3000;
    const mkRow = (i) => {
        const d = new Date(Date.UTC(2026, 0, 1) + i * 3600 * 1000);
        return { id: `x${String(i).padStart(5, '0')}`, dateCreated: d.toISOString().replace('.000Z', 'Z'), settings: { region: 'USA' }, is: {} };
    };
    const existing = Array.from({ length: TOTAL }, (_, i) => mkRow(i));
    const st = new Map();
    // 水位 = 最新的一行。接口按 -dateCreated 排序, 所以第 1 页给最新的, 往后每页越来越旧。
    st.set(key, { rows: existing, newest: existing[TOTAL - 1].dateCreated });
    const plan = Array.from({ length: 30 }, (_, p) => {
        const start = TOTAL - (p + 1) * 100;
        return { rows: Array.from({ length: 100 }, (_, i) => mkRow(start + i)) };
    });
    const api = makeApi({ store: st, plan });
    const rows = await api.loadAlphasForClientQuery(`${key}&limit=10`);
    check(`稳态只翻 3 页而不是 30 页(实际 ${api.__calls.length})`, api.__calls.length === 3, String(api.__calls.length));
    check('这 3 页的行都被刷新过(共 300 支)', api.__calls.length === 3 && rows.length === TOTAL, `${api.__calls.length} 页 / ${rows.length} 行`);
    check('没有误删任何行', rows.length === TOTAL, String(rows.length));
}

console.log('\n== 5. 新行仍然新增, 且排在前面 ==');
{
    const key = 'https://api.worldquantbrain.com/users/self/alphas?status=UNSUBMITTED';
    const st = new Map();
    st.set(key, { rows: [row('old1'), row('old2')], newest: '2026-01-10T00:00:00Z' });
    // 最新页里既有库里没有的 new1, 也有库里的 old2(要被刷新)
    const fresh = [row('new1', { dateCreated: '2026-02-01T00:00:00Z' }), row('old2', { color: 'green' })];
    const api = makeApi({ store: st, plan: [{ rows: fresh }, { rows: [] }] });
    const rows = await api.loadAlphasForClientQuery(`${key}&limit=10`);
    check('新行进来了', rows.some((r) => r.id === 'new1'));
    check('老行也还在(没被冲掉)', rows.some((r) => r.id === 'old1'));
    check('老行被刷新成新值', rows.find((r) => r.id === 'old2')?.color === 'green');
    check('总行数 = 2 旧 + 1 新', rows.length === 3, String(rows.length));
    check('新行排在最前', rows[0]?.id === 'new1', rows[0]?.id);
}

console.log('\n== 6. 行序稳定: 已有行之间不因刷新而跳动 ==');
{
    const key = 'https://api.worldquantbrain.com/users/self/alphas?status=UNSUBMITTED';
    const stored = [row('a'), row('b'), row('c')];
    const st = new Map();
    st.set(key, { rows: stored, newest: '2026-01-10T00:00:00Z' });
    // 服务端这次乱序返回 a/c/b, 且值都变了
    const api = makeApi({
        store: st,
        plan: [{ rows: [row('c', { color: 'x' }), row('a', { color: 'y' }), row('b', { color: 'z' })] }, { rows: [] }],
    });
    const rows = await api.loadAlphasForClientQuery(`${key}&limit=10`);
    check('行序仍是 a,b,c(覆盖不重排)', rows.map((r) => r.id).join(',') === 'a,b,c', rows.map((r) => r.id).join(','));
    check('但每行的值都换成了服务端最新的', rows.map((r) => r.color).join(',') === 'y,z,x', rows.map((r) => r.color).join(','));
}

console.log('\n== 7. 同一页里重复 id 只留一份 ==');
{
    const key = 'https://api.worldquantbrain.com/users/self/alphas?status=UNSUBMITTED';
    const st = new Map();
    st.set(key, { rows: [], newest: '' });
    const api = makeApi({
        store: st,
        plan: [{ rows: [row('dup', { color: 'first' }), row('dup', { color: 'second' }), row('other')] }, { rows: [] }],
    });
    const rows = await api.loadAlphasForClientQuery(`${key}&limit=10`);
    check('重复 id 只有一行', rows.filter((r) => r.id === 'dup').length === 1, String(rows.filter((r) => r.id === 'dup').length));
    check('同页首次出现的版本胜出', rows.find((r) => r.id === 'dup')?.color === 'first', rows.find((r) => r.id === 'dup')?.color);
}

console.log('\n== 8. 边界: 空库 / 空页 / 不足一页 ==');
{
    const key = 'https://api.worldquantbrain.com/users/self/alphas?status=UNSUBMITTED';
    const st = new Map();
    const api = makeApi({ store: st, plan: [{ rows: [] }] });
    const rows = await api.loadAlphasForClientQuery(`${key}&limit=10`);
    check('空库 + 空页 → 空数组, 不炸', Array.isArray(rows) && rows.length === 0);
    const st2 = new Map();
    const api2 = makeApi({ store: st2, plan: [{ rows: page(7) }] });
    const rows2 = await api2.loadAlphasForClientQuery(`${key}&limit=10`);
    check('不足一页(7 行)也照样入库', rows2.length === 7, String(rows2.length));
    check('不足一页时只翻 1 页就收工', api2.__calls.length === 1, String(api2.__calls.length));
}

console.log('\n== 9. 水位 newest 只增不减 ==');
{
    const key = 'https://api.worldquantbrain.com/users/self/alphas?status=UNSUBMITTED';
    const st = new Map();
    st.set(key, { rows: [row('a', { dateCreated: '2026-05-01T00:00:00Z' })], newest: '2026-05-01T00:00:00Z' });
    const api = makeApi({ store: st, plan: [{ rows: [row('a', { dateCreated: '2026-01-01T00:00:00Z' })] }, { rows: [] }] });
    await api.loadAlphasForClientQuery(`${key}&limit=10`);
    const rec = st.get(key);
    check('newest 不会被更旧的行拉低', rec.newest === '2026-05-01T00:00:00Z', rec.newest);
}

console.log('\n== 10. 重建: 只删 alphas 池, 绝不动 wqpNewFields ==');
{
    // 重建函数在 loaderBlock 里, 这里连它带上一块切出来跑
    const rebuildBlock = sliceBetween('async function wqpRebuildAlphasPool() {', 'function requestMethod(resource, config) {');
    const st = new Map();
    st.set('https://api.worldquantbrain.com/users/self/alphas?status=UNSUBMITTED', { rows: [row('a')], newest: '' });
    st.set('https://api.worldquantbrain.com/users/self/alphas?status!=UNSUBMITTED%E2%90%9FIS-FAIL', { rows: [row('b')], newest: '' });
    st.set('wqpNewFields', { combos: { USA_1_TOP3000: { ids: ['x'], at: 1 } }, season: { ids: ['y'], at: 1 } });
    st.set('WQP_ProdMemoCache_SOMETHING', { keep: true });
    const deleted = [];
    // 假 IndexedDB。cursor 靠 continue() 前进; transaction 完成后回调 oncomplete(源码里 await 的就是它)。
    // 这里不用属性 setter 绑 onsuccess —— 赋值时立刻回调会早于赋值完成, 拿不到 handler;
    // 改成 cursor 自己持有 result, 由 step() 推进后主动调 onsuccess。
    const fakeDb = {
        close: () => {},
        transaction: () => {
            const tx = {
                oncomplete: null, onerror: null, onabort: null,
                objectStore: () => ({
                    openCursor: () => {
                        const ks = [...st.keys()];
                        let i = 0;
                        let started = false;
                        const req = { onsuccess: null, onerror: null, result: null };
                        // 真 IDB 是绑好 onsuccess 之后才开始回调, 所以首步由赋值触发
                        Object.defineProperty(req, 'onsuccess', {
                            set(handler) {
                                req._onSuccess = handler;
                                if (!started) { started = true; step(); }
                            },
                            get() { return req._onSuccess; },
                        });
                        const step = () => {
                            if (i < ks.length) {
                                req.result = { key: ks[i], continue: step };
                                i += 1;
                            } else {
                                req.result = null;
                            }
                            req._onSuccess();
                        };
                        return req;
                    },
                    // 真 IDB 的事务完成是异步的。源码的写法是「先 delete, 再挂 tx.oncomplete」,
                    // 同步回调会发生在赋值之前, 那个 await 就永远不 settle。延到微任务里再触发。
                    delete: (k) => {
                        deleted.push(k);
                        st.delete(k);
                        queueMicrotask(() => {
                            if (tx.oncomplete) tx.oncomplete();
                            else if (tx.onerror) tx.onerror();
                        });
                    },
                }),
            };
            return tx;
        },
    };
    const sandbox = `
      const clientAlphaCache = new Map([['k', {}]]);
      const clientAlphaInflight = new Map();
      const wqpNfState = { detail: new Map([['x', ['y']]]) };
      const WQP_NF_KEY = 'wqpNewFields';
      const WQP_POOL_SUFFIX = '/alphas';
      const wqpPoolDb = async () => fakeDb;
      const console = { log(){}, warn(){} };
      const window = { addEventListener() {} };
${rebuildBlock}
      return { wqpRebuildAlphasPool, __cache: clientAlphaCache };
    `;
    const factory = new Function('st', 'fakeDb', 'deleted', sandbox);
    const api = factory(st, fakeDb, deleted);
    check('重建前内存缓存里有东西(证明下面清空有得可清)', api.__cache.size === 1, String(api.__cache.size));
    const res = await api.wqpRebuildAlphasPool();
    check('重建返回 ok', res.ok === true, JSON.stringify(res));
    check('两个 alphas 池键都被删了', res.dropped === 2, String(res.dropped));
    check('内存缓存被清空(否则 1 分钟内还在用旧行)', api.__cache.size === 0, String(api.__cache.size));
    check('wqpNewFields 还在(误删会白等 6 分钟重翻字段表)', st.has('wqpNewFields'), String([...st.keys()]));
    check('wqpNewFields 的字段表内容没被动', (st.get('wqpNewFields')?.combos?.USA_1_TOP3000?.ids || []).join(',') === 'x');
    check('无关的键也没被删', st.has('WQP_ProdMemoCache_SOMETHING'));
    check('没有误删 wqpNewFields', !deleted.includes('wqpNewFields'), deleted.join(','));
}

console.log(`\n通过 ${pass}, 失败 ${fail}`);
process.exit(fail ? 1 : 0);
