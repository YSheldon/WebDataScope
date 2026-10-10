// prodCorrCellPatch.test.mjs — Prod/Pool/Self Corr 查完立刻反映到已渲染表格
// 切 background.js 注入函数里的直写器源码 + 假 DOM, 沿用既有测试写法。
// 回归背景: 单元格的值是「取列表那一刻」从 localStorage 抄进行的, 查完 corr 平台不会
// 自己重取(react-query 的 focus/reconnect 重取都被关了), 已渲染的单元格只能等翻页/F5。
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

const block = slice(
    '// ---- Prod/Pool/Self Corr 查完立刻反映到已渲染的表格 ----',
    "window.addEventListener('message', (event) => {\n                // prodmemo.js(ISOLATED)",
);

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
    if (cond) { pass += 1; console.log(`  ok  ${name}`); }
    else { fail += 1; console.log(`FAIL  ${name} ${extra}`); }
};

// ---- 假 DOM: 一个表(表头 ID/Type/Pool Corr/Prod Corr/Self Corr) + 数据行 ----
function makeCell(text = '') {
    return { _text: text, get textContent() { return this._text; }, set textContent(v) { this._text = v; } };
}
function makeRow(cells, href = null) {
    return {
        _cells: cells,
        querySelectorAll: (sel) => (sel === '.rt-td' ? cells : []),
        querySelector: (sel) => (sel === 'a[href*="/alpha/"]' && href ? { getAttribute: () => href } : null),
    };
}
function makeDom({ headers, rows }) {
    const thead = {
        querySelectorAll: (sel) => (sel === '.rt-th' ? headers : []),
        closest: () => null,
        parentElement: null,
    };
    const table = { querySelectorAll: (sel) => (sel === '.rt-tr-group' ? rows : []) };
    thead.closest = () => table;
    const groups = rows.map((r) => ({ querySelectorAll: () => r._cells, querySelector: r.querySelector }));
    table.querySelectorAll = () => groups;
    return {
        theads: [thead],
        querySelectorAll: (sel) => (sel === '.rt-thead.-header' ? [thead] : []),
    };
}

async function makePatcher(memoData) {
    const storageData = JSON.stringify(memoData);
    const sandbox = `
      const localStorage = { getItem: (k) => (k === 'WQP_ProdMemoCache' ? __storage : null) };
      const setTimeout = (fn) => { fn(); return 1; };
${block}
      return { patchCorrCells, corrCellText };
    `;
    // eslint-disable-next-line no-new-func
    return new Function('__storage', sandbox)(storageData);
}

const HEADERS = ['ID', 'Type', 'Pool Corr', 'Prod Corr', 'Self Corr'].map((t) => makeCell(t));

console.log('\n[1] 平台值 Ⓟ: 查完即写入对应单元格');
{
    const memo = { aaaa111: { prod: { max: 0.7123, source: 'platform' }, pool: null, self: null } };
    const patcher = await makePatcher(memo);
    const cells = [makeCell('aaaa111'), makeCell('REGULAR'), makeCell(''), makeCell(''), makeCell('')];
    const dom = makeDom({ headers: HEADERS, rows: [makeRow(cells)] });
    const patchCorrCells = new Function('document', `
        const localStorage = { getItem: () => ${JSON.stringify(JSON.stringify(memo))} };
        const setTimeout = (fn) => { fn(); return 1; };
${block}
        return patchCorrCells;
    `)(dom);
    patchCorrCells();
    check('Prod Corr 单元格 = 0.7123 Ⓟ', cells[3]._text === '0.7123 Ⓟ', cells[3]._text);
    check('Pool Corr 无记录则不动', cells[2]._text === '', cells[2]._text);
    check('Self Corr 无记录则不动', cells[4]._text === '', cells[4]._text);
    check('ID 单元格不被改动', cells[0]._text === 'aaaa111');
}

console.log('\n[2] 本地下限 Ⓛ: display 字符串优先');
{
    const memo = { bbbb222: { prod: { max: 0.6543, lowerBound: true, source: 'local', display: '≥0.6543 Ⓛ' } } };
    const cells = [makeCell('bbbb222'), makeCell(''), makeCell(''), makeCell(''), makeCell('')];
    const dom = makeDom({ headers: HEADERS, rows: [makeRow(cells)] });
    const patchCorrCells = new Function('document', `
        const localStorage = { getItem: () => ${JSON.stringify(JSON.stringify(memo))} };
        const setTimeout = (fn) => { fn(); return 1; };
${block}
        return patchCorrCells;
    `)(dom);
    patchCorrCells();
    check('写入卡片同款的 ≥ 前缀文本', cells[3]._text === '≥0.6543 Ⓛ', cells[3]._text);
}

console.log('\n[3] 行的 alpha id 优先取 /alpha/ 链接(ID 列不在首位也能对上)');
{
    const memo = { cccc333: { prod: { max: 0.5, source: 'platform' } } };
    const headers = ['Type', 'Prod Corr', 'ID'].map((t) => makeCell(t));
    const cells = [makeCell('REGULAR'), makeCell(''), makeCell('cccc333')];
    const row = makeRow(cells, 'https://platform.worldquantbrain.com/alpha/cccc333');
    const dom = makeDom({ headers, rows: [row] });
    const patchCorrCells = new Function('document', `
        const localStorage = { getItem: () => ${JSON.stringify(JSON.stringify(memo))} };
        const setTimeout = (fn) => { fn(); return 1; };
${block}
        return patchCorrCells;
    `)(dom);
    patchCorrCells();
    check('按链接里的 alpha id 写入 Prod Corr 列', cells[1]._text === '0.5000 Ⓟ', cells[1]._text);
}

console.log('\n[4] 缓存里没有的 alpha 不动; 展示文本相同则不重复写(避免变更循环)');
{
    const memo = { dddd444: { prod: { max: 0.3, source: 'platform' } } };
    const cellsUnknown = [makeCell('eeee555'), makeCell(''), makeCell(''), makeCell(''), makeCell('')];
    const dom = makeDom({ headers: HEADERS, rows: [makeRow(cellsUnknown)] });
    const patchCorrCells = new Function('document', `
        const localStorage = { getItem: () => ${JSON.stringify(JSON.stringify(memo))} };
        const setTimeout = (fn) => { fn(); return 1; };
${block}
        return patchCorrCells;
    `)(dom);
    patchCorrCells();
    check('缓存无记录的行保持原样', cellsUnknown[3]._text === '');

    const same = [makeCell('dddd444'), makeCell(''), makeCell(''), makeCell('0.3000 Ⓟ'), makeCell('')];
    const dom2 = makeDom({ headers: HEADERS, rows: [makeRow(same)] });
    let writes = 0;
    const patched = new Function('document', `
        const localStorage = { getItem: () => ${JSON.stringify(JSON.stringify(memo))} };
        const setTimeout = (fn) => { fn(); return 1; };
${block}
        return patchCorrCells;
    `);
    // 统计 setter 触发次数: 文本相同不应再写
    const cellProxy = same[3];
    Object.defineProperty(cellProxy, 'textContent', {
        get() { return this._text; },
        set(v) { writes += 1; this._text = v; },
    });
    patched(dom2);
    check('文本相同时不再写入(幂等, 不和 MutationObserver 打架)', writes === 0, String(writes));
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
