// wqpFilters.test.mjs — WQP 虚拟列筛选全矩阵
// 切 background.js 真实源码 + new Function 沙箱 + 内存 localStorage, 沿用既有测试写法。
// 覆盖: URL 解析剥离 / 取值 / 比较操作符 / 组合筛选与排序 / corr 未查询语义 / 多选值。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(root, 'src/background/background.js'), 'utf8');

function slice(startMark, endMark) {
    const a = src.indexOf(startMark);
    const b = src.indexOf(endMark, a);
    if (a < 0 || b < 0) throw new Error(`切片失败: ${startMark} / ${endMark}`);
    return src.slice(a, b);
}

// 常量 + 取值 + 比较 + URL 解析(wqpConstrain 的 RA 子代逻辑不在此测)
const coreBlock = slice('const WQP_CLIENT_FIELDS = ', '// type 和 dateCreated 是服务端参数');
// 虚拟列筛选/排序
const applyBlock = slice('function wqpApply(rows, parsed) {', 'function wqpPage(rows, parsed) {');

let pass = 0, fail = 0;
function check(name, cond, info = '') {
    if (cond) { pass += 1; console.log('  ok ', name); }
    else { fail += 1; console.log('  FAIL', name, info); }
}

function makeSandbox(memo) {
    const store = new Map([['WQP_ProdMemoCache', JSON.stringify(memo || {})]]);
    const localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
    };
    const logs = [];
    const sandbox = `
      const console = { log: (...a) => __logs.push(a.join(' ')), debug: () => {}, warn: () => {}, error: () => {} };
      const localStorage = __ls;
${coreBlock}
${applyBlock}
      return { wqpParseUrl, wqpValueOf, wqpCompare, wqpApply };
    `;
    const api = new Function('__ls', '__logs', sandbox)(localStorage, logs);
    return { api, store, logs };
}

// 行构造: 与列表 API 的真实形状一致
function row(id, is = {}, regular = {}, memo = {}) {
    return {
        id, type: 'REGULAR', hidden: false, color: null,
        dateCreated: '2026-10-01T00:00:00-04:00',
        is: { sharpe: 1.25, ...is },
        regular: { ...regular },
        settings: { region: 'USA', universe: 'TOP3000' },
        ...(Object.keys(memo).length ? {} : {}),
    };
}

console.log('\n== 1. URL 解析: 虚拟列参数被识别并从服务端 URL 剥离 ==');
{
    const { api } = makeSandbox();
    const CASES = [
        ['is.failedNumRA<3', 'is.failedNumRA', '<', '3'],
        ['failedNumRA<=2', 'is.failedNumRA', '<=', '2'],
        ['is.failedNumPPA>=1', 'is.failedNumPPA', '>=', '1'],
        ['failedNumPPA!=0', 'is.failedNumPPA', '!=', '0'],
        ['is.WQPPYS=MEV', 'is.WQPPYS', '=', 'MEV'],
        ['WQPPYS=MEV', 'is.WQPPYS', '=', 'MEV'],
        ['maxProdCorr<0.7', 'maxProdCorr', '<', '0.7'],
        ['maxPoolProdCorr<=0.6', 'maxPoolProdCorr', '<=', '0.6'],
        ['maxSelfCorr>0.5', 'maxSelfCorr', '>', '0.5'],
        ['regular.operatorCount>10', 'operatorCount', '>', '10'],
        ['operatorCount>10', 'operatorCount', '>', '10'],
        ['is.newFieldCount>0', 'is.newFieldCount', '>', '0'],
        ['newFieldCount>0', 'is.newFieldCount', '>', '0'],
    ];
    for (const [param, field, op, value] of CASES) {
        const url = `https://api.worldquantbrain.com/users/SY86571/alphas?status=UNSUBMITTED&order=-dateCreated&${encodeURIComponent(param)}&limit=10&offset=20`;
        const p = api.wqpParseUrl(url);
        check(`${param} 被识别`, p.active === true && p.clientFilters.length === 1, JSON.stringify(p.clientFilters));
        check(`${param} 取值正确`, p.clientFilters[0].field === field && p.clientFilters[0].op === op && p.clientFilters[0].value === value, JSON.stringify(p.clientFilters[0]));
        check(`${param} 已从服务端 URL 剥离`, !p.serverUrl.includes(param.split(/[<>!=]+/)[0]) && p.serverUrl.includes('status=UNSUBMITTED') && p.serverUrl.includes('order=-dateCreated'), p.serverUrl);
        check('limit/offset 保留', p.limit === 10 && p.offset === 20);
    }
}

console.log('\n== 2. URL 解析: 本地排序 order= 识别 ==');
{
    const { api } = makeSandbox();
    for (const [order, field, desc] of [
        ['is.newFieldCount', 'is.newFieldCount', false],
        ['-is.newFieldCount', 'is.newFieldCount', true],
        ['-maxProdCorr', 'maxProdCorr', true],
        ['-operatorCount', 'operatorCount', true],
        ['-is.failedNumRA', 'is.failedNumRA', true],
    ]) {
        const url = `https://api.worldquantbrain.com/users/SY86571/alphas?status=UNSUBMITTED&order=${encodeURIComponent(order)}`;
        const p = api.wqpParseUrl(url);
        check(`order=${order} 走本地排序`, p.clientOrder && p.clientOrder.field === field && p.clientOrder.desc === desc, JSON.stringify(p.clientOrder));
        check(`order=${order} 不留在服务端 URL`, !p.serverUrl.includes('order='));
    }
}

console.log('\n== 3. URL 解析: 服务端参数原样保留 ==');
{
    const { api } = makeSandbox();
    const url = 'https://api.worldquantbrain.com/users/SY86571/alphas?status=UNSUBMITTED&is.sharpe>1&limit=10';
    const p = api.wqpParseUrl(url);
    check('无虚拟列参数 → 不走本地路径', p.active === false);
    check('sharpe(服务端认识)留在服务端 URL', p.serverUrl.includes('is.sharpe%3E1') || p.serverUrl.includes('is.sharpe>1'), p.serverUrl);
}

console.log('\n== 4. wqpValueOf: 行内取值与缺失回落 ==');
{
    const memo = { abc123: { prod: { max: 0.55 }, pool: { max: 0.31 }, self: { max: 0.2 } } };
    const { api } = makeSandbox(memo);
    const r = row('abc123', { failedNumRA: 2, failedNumPPA: 5, newFieldCount: 3, WQPPYS: 'MEV' }, { operatorCount: 12 });
    const empty = row('nomemo', {}, {});
    check('failedNumRA', api.wqpValueOf(r, 'is.failedNumRA') === 2);
    check('failedNumRA 缺失 → 0', api.wqpValueOf(empty, 'is.failedNumRA') === 0);
    check('failedNumPPA', api.wqpValueOf(r, 'is.failedNumPPA') === 5);
    check('WQPPYS 字符串', api.wqpValueOf(r, 'is.WQPPYS') === 'MEV');
    check('WQPPYS 缺失 → 空串', api.wqpValueOf(empty, 'is.WQPPYS') === '');
    check('maxProdCorr ← 本地备忘', api.wqpValueOf(r, 'maxProdCorr') === 0.55);
    check('maxPoolProdCorr', api.wqpValueOf(r, 'maxPoolProdCorr') === 0.31);
    check('maxSelfCorr', api.wqpValueOf(r, 'maxSelfCorr') === 0.2);
    check('corr 没查过 → NaN', !Number.isFinite(api.wqpValueOf(empty, 'maxProdCorr')));
    check('operatorCount', api.wqpValueOf(r, 'operatorCount') === 12);
    check('operatorCount 缺失 → NaN', !Number.isFinite(api.wqpValueOf(empty, 'operatorCount')));
    check('newFieldCount', api.wqpValueOf(r, 'is.newFieldCount') === 3);
    check('newFieldCount 缺失 → 0', api.wqpValueOf(empty, 'is.newFieldCount') === 0);
    check('短别名 failedNumRA 走 canonical', api.wqpValueOf(r, 'failedNumRA') === 2);
    check('短别名 newFieldCount 走 canonical', api.wqpValueOf(r, 'newFieldCount') === 3);
    check('短别名 operatorCount 走 canonical', api.wqpValueOf(r, 'operatorCount') === 12);
}

console.log('\n== 5. wqpCompare: 六种操作符语义 ==');
{
    const { api } = makeSandbox();
    const C = api.wqpCompare;
    check('< 真', C('<', 2, 3) === true); check('< 边界假', C('<', 3, 3) === false);
    check('<= 边界真', C('<=', 3, 3) === true); check('<= 假', C('<=', 3.1, 3) === false);
    check('> 真', C('>', 3, 2) === true); check('> 边界假', C('>', 3, 3) === false);
    check('>= 边界真', C('>=', 3, 3) === true); check('>= 假', C('>=', 2.9, 3) === false);
    check('= 数值真', C('=', 3, '3') === true); check('= 数值假', C('=', 3, '4') === false);
    check('!= 真', C('!=', 3, 4) === true); check('!= 假', C('!=', 3, 3) === false);
    check('字符串 = 精确', C('=', 'MEV', 'MEV') === true && C('=', 'MEV', 'LOW') === false);
    check('字符串 != 精确', C('!=', 'MEV', 'LOW') === true && C('!=', 'MEV', 'MEV') === false);
    check('右值字符串数值可比', C('<=', 0.55, '0.7') === true);
    check('NaN 对 < 不命中(无 corrNa 特判时)', C('<', NaN, 5) === false);
}

console.log('\n== 6. wqpCompare: 多选值(␟ 分隔)按集合语义 ==');
{
    const { api } = makeSandbox();
    const C = api.wqpCompare;
    const multi = 'MEV\u001fLOW';
    check('= 命中第一个', C('=', 'MEV', multi) === true);
    check('= 命中第二个', C('=', 'LOW', multi) === true);
    check('= 都不匹配', C('=', 'SEASONAL', multi) === false);
    check('!= 不在集合', C('!=', 'SEASONAL', multi) === true);
    check('!= 在集合', C('!=', 'MEV', multi) === false);
    check('单值行为不变', C('=', 'MEV', 'MEV') === true && C('!=', 'MEV', 'MEV') === false);
}

console.log('\n== 7. wqpApply: 真实池子上组合筛选与排序 ==');
{
    const memo = {
        A: { prod: { max: 0.55 }, pool: { max: 0.31 } },
        B: { prod: { max: 0.85 } },
        D: { prod: { max: 0.10 } },
    };
    const { api } = makeSandbox(memo);
    const rows = [
        row('A', { failedNumRA: 2, failedNumPPA: 5, newFieldCount: 3, WQPPYS: 'MEV' }, { operatorCount: 12 }),
        row('B', { failedNumRA: 9, failedNumPPA: 1, newFieldCount: 0, WQPPYS: 'LOW' }, { operatorCount: 30 }),
        row('C', {}, {}),
        row('D', { failedNumRA: 3, failedNumPPA: 2, newFieldCount: 1, WQPPYS: 'MEV' }, { operatorCount: 8 }),
        row('E', { failedNumRA: 0, failedNumPPA: 0, newFieldCount: 7, WQPPYS: 'SEASONAL' }, { operatorCount: 5 }),
    ];
    const apply = (q) => api.wqpApply(rows, api.wqpParseUrl(`https://api.worldquantbrain.com/users/X/alphas?status=UNSUBMITTED&${q}`));
    const ids = (arr) => arr.map((r) => r.id).join(',');
    check('is.newFieldCount>0 → A,D,E', ids(apply(encodeURIComponent('is.newFieldCount>0'))) === 'A,D,E', ids(apply(encodeURIComponent('is.newFieldCount>0'))));
    check('is.failedNumRA<5 → A,C,D,E', ids(apply(encodeURIComponent('is.failedNumRA<5'))) === 'A,C,D,E', ids(apply(encodeURIComponent('is.failedNumRA<5'))));
    check('maxProdCorr<0.7 → A,C,D,E(过滤保序)', ids(apply(encodeURIComponent('maxProdCorr<0.7'))) === 'A,C,D,E', ids(apply(encodeURIComponent('maxProdCorr<0.7'))));
    check('maxPoolProdCorr<=0.5 → 全部(B 的 pool 没查过也过)', ids(apply(encodeURIComponent('maxPoolProdCorr<=0.5'))) === 'A,B,C,D,E', ids(apply(encodeURIComponent('maxPoolProdCorr<=0.5'))));
    check('regular.operatorCount>=10 → A,B', ids(apply(encodeURIComponent('regular.operatorCount>=10'))) === 'A,B', ids(apply(encodeURIComponent('regular.operatorCount>=10'))));
    check('is.WQPPYS=MEV → A,D', ids(apply(encodeURIComponent('is.WQPPYS=MEV'))) === 'A,D');
    check('is.WQPPYS!=MEV → B,C,E', ids(apply(encodeURIComponent('is.WQPPYS!=MEV'))) === 'B,C,E', ids(apply(encodeURIComponent('is.WQPPYS!=MEV'))));
    check('组合: newFieldCount>0 且 maxProdCorr<0.7 → A,D,E', ids(apply(encodeURIComponent('is.newFieldCount>0') + '&' + encodeURIComponent('maxProdCorr<0.7'))) === 'A,D,E');
    const sorted = apply('order=' + encodeURIComponent('-is.newFieldCount'));
    check('排序 -is.newFieldCount → E,A,D 在前', ids(sorted).startsWith('E,A,D'), ids(sorted));
    const sortedCorr = apply('order=' + encodeURIComponent('maxProdCorr'));
    check('排序 maxProdCorr 升序 → D,A 在前', ids(sortedCorr).startsWith('D,A'), ids(sortedCorr));
    check('Pyramid 多选筛选 → A,B,D', ids(apply(encodeURIComponent('is.WQPPYS=') + 'MEV%1FLOW')) === 'A,B,D', ids(apply(encodeURIComponent('is.WQPPYS=') + 'MEV%1FLOW')));
}

console.log('\n== 8. 缓存键修复: status!= 与 status= 走不同池(回归) ==');
{
    const { api } = makeSandbox();
    // wqpPoolUrl 在另一个切片里测过, 这里确认解析器对 status!= 参数不误当筛选
    const p = api.wqpParseUrl('https://api.worldquantbrain.com/users/X/alphas?status!=UNSUBMITTED%1FIS-FAIL&limit=10');
    check('status!= 不进 clientFilters', p.clientFilters.length === 0);
}

console.log(`\n通过 ${pass}, 失败 ${fail}`);
process.exit(fail ? 1 : 0);
