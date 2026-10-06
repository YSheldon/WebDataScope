// wqpCacheMerge.test.mjs — 平台用户列缓存合并(patchColumns.js 的 wqpMergeCachedColumns)
// 切源码 + new Function 沙箱 + 内存 Map 冒充 localStorage, 沿用 wqpPoolRefresh 的写法。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(root, 'src/content/platform/common/patchColumns.js'), 'utf8');

function slice(startMark, endMark) {
    const a = src.indexOf(startMark);
    const b = src.indexOf(endMark, a);
    if (a < 0 || b < 0) throw new Error(`切片失败: ${startMark} / ${endMark}`);
    return src.slice(a, b);
}

// EXTRA_COLUMNS 定义 + 合并函数(注意把最后的调用语句带上, 否则沙箱里只定义不执行)
const colsBlock = slice('const EXTRA_COLUMNS = [', 'function buildReplacement');
const mergeBlock = slice('function wqpMergeCachedColumns() {', 'wqpMergeCachedColumns();') + '\nwqpMergeCachedColumns();';

let pass = 0, fail = 0;
function check(name, cond, info = '') {
    if (cond) { pass += 1; console.log('  ok ', name); }
    else { fail += 1; console.log('  FAIL', name, info); }
}

function makeStore(entries) {
    const m = new Map(Object.entries(entries));
    return {
        m,
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k),
        key: (i) => [...m.keys()][i] ?? null,
        get length() { return m.size; },
    };
}

function runSandbox(store) {
    const logs = [];
    const sandbox = `
      const console = { log: (...a) => __logs.push(a.join(' ')), warn: (...a) => __logs.push('WARN ' + a.join(' ')) };
      const localStorage = __store;
${colsBlock}
${mergeBlock}
    `;
    new Function('__store', '__logs', sandbox)(store, logs);
    return logs;
}

console.log('\n== 1. 旧缓存缺 新字段数 → 合并进每个 tab ==');
{
    const baseCol = { id: 'x', name: 'X', active: true, category: 'Summary', display: true, type: 'string' };
    const tabs = ['unsubmitted', 'submitted'];
    const userKey = { themeColor: 'vs-dark', userUxSettings: { alphasTableColumns: {} } };
    for (const t of tabs) userKey.userUxSettings.alphasTableColumns[t] = [JSON.parse(JSON.stringify(baseCol))];
    userKey.userUxSettings.alphasTableColumns.version = '1.0.11';
    const store = makeStore({ SY86571: JSON.stringify(userKey), WQP_ProdMemoCache: '{}' });
    const logs = runSandbox(store);
    const saved = JSON.parse(store.getItem('SY86571'));
    const atc = saved.userUxSettings.alphasTableColumns;
    check('unsubmitted 补入 9 列', atc.unsubmitted.length === 1 + 9, String(atc.unsubmitted.length));
    check('submitted 补入 9 列', atc.submitted.length === 1 + 9, String(atc.submitted.length));
    check('新字段数 进了缓存', atc.unsubmitted.some(c => c.id === 'newFieldCount'));
    check('原列的 active 保留', atc.unsubmitted[0].id === 'x' && atc.unsubmitted[0].active === true);
    check('平台 version 子键不动', atc.version === '1.0.11');
    check('打印了合并日志', logs.some(l => l.includes('用户列缓存缺')));
    check('其它键不碰', store.getItem('WQP_ProdMemoCache') === '{}');
}

console.log('\n== 2. 缓存已是最新 → 不写不刷 ==');
{
    const colsBlockOnly = slice('const EXTRA_COLUMNS = [', 'function buildReplacement');
    const ids = [...colsBlockOnly.matchAll(/id: '([^']+)'/g)].map(m => m[1]);
    const mk = (id) => ({ id, name: id, active: false, category: 'WQP', display: true, type: 'string' });
    const userKey = { userUxSettings: { alphasTableColumns: { unsubmitted: ids.map(mk), version: '1.0.11' } } };
    const store = makeStore({ U1: JSON.stringify(userKey) });
    const logs = runSandbox(store);
    check('无新增不重写', store.getItem('U1') === JSON.stringify(userKey));
    check('无合并日志', !logs.some(l => l.includes('用户列缓存缺')));
}

console.log('\n== 3. 脏数据不炸 ==');
{
    const store = makeStore({
        broken: '{not json',
        noUx: JSON.stringify({ foo: 1 }),
        uxNoCols: JSON.stringify({ userUxSettings: {} }),
        colsNotArray: JSON.stringify({ userUxSettings: { alphasTableColumns: { unsubmitted: 'oops' } } }),
        good: JSON.stringify({ userUxSettings: { alphasTableColumns: { unsubmitted: [] } } }),
    });
    let threw = false;
    try { runSandbox(store); } catch (_) { threw = true; }
    check('非 JSON/缺结构键全部安全跳过', !threw);
    check('好的键仍被合并', JSON.parse(store.getItem('good')).userUxSettings.alphasTableColumns.unsubmitted.length === 9);
}

console.log('\n== 4. 多账户键都合并 ==');
{
    const mk = () => JSON.stringify({ userUxSettings: { alphasTableColumns: { unsubmitted: [] } } });
    const store = makeStore({ AAA111: mk(), BBB222: mk() });
    runSandbox(store);
    check('AAA111 补齐', JSON.parse(store.getItem('AAA111')).userUxSettings.alphasTableColumns.unsubmitted.length === 9);
    check('BBB222 补齐', JSON.parse(store.getItem('BBB222')).userUxSettings.alphasTableColumns.unsubmitted.length === 9);
}

console.log(`\n通过 ${pass}, 失败 ${fail}`);
process.exit(fail ? 1 : 0);
