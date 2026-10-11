// pyramidChoice.test.mjs — Pyramid 列的下拉勾选筛选
// 切 background.js 注入函数里的 OPTIONS 注入与比较源码, 沿用既有测试写法。
// 背景: WQPPYS 原来注入 type:'string' → 筛选行是文本框; 现在注入 type:'choice'
// (choices 从本地池的实测段值收集) → 平台渲染 Region 同款下拉勾选;
// 比较语义从「整串相等」改为「段命中」(选 model 能命中 model/pv)。
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

const choiceBlock = slice('let wqpPyramidChoicesPromise = null;', 'async function wqpInjectAlphaOptions');
const injectBlock = slice('async function wqpInjectAlphaOptions', '\n            window.fetch = async function');
const compareBlock = slice('function wqpCompare(op, actual, raw, field) {', 'function wqpMatchFilter(token) {');
const ensureBlock = slice('function wqpEnsureOption(node, key, spec) {', 'let wqpPyramidChoicesPromise');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
    if (cond) { pass += 1; console.log(`  ok  ${name}`); }
    else { fail += 1; console.log(`FAIL  ${name} ${extra}`); }
};

function makeApi(poolRows) {
    const sandbox = `
      const wqpPoolDb = async () => ({
        transaction: (name) => ({
          objectStore: (name2) => ({
            openCursor: () => {
              const req = {};
              queueMicrotask(() => {
                // 第一次回调给数据, continue() 后第二次回调给 null(游标耗尽) —— 源码靠这个收尾
                req.result = { value: { rows: __poolRows }, continue: () => { req.result = null; req.onsuccess(); } };
                if (req.onsuccess) req.onsuccess();
              });
              return req;
            },
          }),
        }),
        close: () => {},
      });
      const localStorage = { getItem: () => null, setItem: () => {} };
      const WQP_FIELD_CANONICAL = { failedNumRA: 'is.failedNumRA', failedNumPPA: 'is.failedNumPPA', WQPPYS: 'is.WQPPYS', 'regular.operatorCount': 'operatorCount', newFieldCount: 'is.newFieldCount' };
      const WQP_COLUMN_REGISTRY = {};
      function wqpPath(obj, path) { return String(path || '').split('.').reduce((o, k) => (o == null ? o : o[k]), obj); }
      function wqpNumericOf(value) {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        const m = String(value ?? '').match(/-?\\d+(?:\\.\\d+)?/);
        return m ? Number(m[0]) : NaN;
      }
${ensureBlock}
${choiceBlock}
${injectBlock}
${compareBlock}
      return { wqpInjectAlphaOptions, wqpPyramidChoices, wqpCompare };
    `;
    // eslint-disable-next-line no-new-func
    return new Function('__poolRows', sandbox)(poolRows);
}

const POOL = [
  { id: 'p1', is: { WQPPYS: 'model' } },
  { id: 'p2', is: { WQPPYS: 'model/pv' } },
  { id: 'p3', is: { WQPPYS: 'fundamental' } },
  { id: 'p4', is: {} },
];

console.log('\n[1] choices 从本地池段值收集(去重/排序)');
{
    const api = makeApi(POOL);
    const choices = await api.wqpPyramidChoices();
    check('三段全部收集且排序', JSON.stringify(choices.map((c) => c.value)) === '["fundamental","model","pv"]',
        JSON.stringify(choices));
    check('choice 形态 {value,label}', choices.every((c) => c.value === c.label && typeof c.value === 'string'));
}

console.log('\n[2] OPTIONS 注入: 有池数据 → choice, 空池 → 回退 string');
{
    const api = makeApi(POOL);
    const schema = await api.wqpInjectAlphaOptions({ is: {}, regular: {} });
    check('is.WQPPYS 注入为 choice', schema.is.children.WQPPYS.type === 'choice', JSON.stringify(schema.is.children.WQPPYS));
    check('choices 与池段值一致', JSON.stringify(schema.is.children.WQPPYS.choices.map((c) => c.value)) === '["fundamental","model","pv"]');
    check('顶层挂了 WQPPYS choice(平台筛下拉只扫顶层+settings.children)',
        schema.WQPPYS?.type === 'choice' && JSON.stringify(schema.WQPPYS.choices.map((c) => c.value)) === '["fundamental","model","pv"]',
        JSON.stringify(schema.WQPPYS));
    check('is.failedNumRA 照旧注入 integer', schema.is.children.failedNumRA.type === 'integer');
    check('regular.operatorCount 照旧注入', schema.regular.children.operatorCount.type === 'integer');

    const empty = makeApi([]);
    const schema2 = await empty.wqpInjectAlphaOptions({ is: {}, regular: {} });
    check('空池回退 string(原文本框)', schema2.is.children.WQPPYS.type === 'string', JSON.stringify(schema2.is.children.WQPPYS));
    check('空池不挂顶层 WQPPYS', schema2.WQPPYS === undefined);
}

console.log('\n[3] 比较语义: Pyramid 按段命中, 多选 ␟');
{
    const api = makeApi(POOL);
    const c = api.wqpCompare;
    check('= 单选命中单段', c('=', 'model', 'model', 'is.WQPPYS') === true);
    check('= 单选命中多段行的其中一段(model vs model/pv)', c('=', 'model/pv', 'model', 'is.WQPPYS') === true);
    check('= 未选中的段不命中(pv vs model)', c('=', 'model', 'pv', 'is.WQPPYS') === false);
    check('= 多选 ␟ 拼接任一命中', c('=', 'fundamental', 'model\u001fpv\u001ffundamental', 'is.WQPPYS') === true);
    check('!= 为取反', c('!=', 'model', 'pv', 'is.WQPPYS') === true && c('!=', 'model', 'model', 'is.WQPPYS') === false);
    check('行值为空(无金字塔)不命中', c('=', 'model', 'model', 'is.WQPPYS') === true && c('=', '', 'model', 'is.WQPPYS') === false);
    // 短名归一
    check('短名 WQPPYS 同样按段命中', c('=', 'model/pv', 'pv', 'WQPPYS') === true);
}

console.log('\n[4] 其它字段的比较行为不被误伤');
{
    const api = makeApi(POOL);
    const c = api.wqpCompare;
    check('数值 < 照旧', c('<', 0.5, 1, 'is.failedNumRA') === true);
    check('数值 = 照旧', c('=', 3, 3, 'regular.operatorCount') === true);
    check('字符串多选 ␟ 照旧(status 场景)', c('=', 'UNSUBMITTED', 'UNSUBMITTED\u001fIS-FAIL', 'status') === true);
    check('普通字符串 includes 照旧', c('includes', 'abc', 'b', 'name') === true);
    // 之前 = 强制字符串比较的调用点, 数值相等能力反而更好
    check('数值 = 字符串形式(3.0 vs 3)现在也算相等', c('=', '3.0', '3', 'is.failedNumRA') === true);
}

console.log('\n[5] 自绘 Pyramid 下拉 UI: 按钮/勾选/写回 ␟ 拼接');
{
    // 切自绘 UI 源码
    const a = src.indexOf('// ---- Pyramid 筛选下拉:');
    const b = src.indexOf('\n    }).catch(', a);
    if (a < 0 || b < 0) throw new Error('UI 源码切片失败');
    const uiBlock = src.slice(a, b).replace(/\n\s*}\s*$/, ''); // 去掉注入函数的收尾大括号

    function makeCell2(text) {
      const cell = {
        _text: text,
        get textContent() { return cell._text; },
        set textContent(v) { cell._text = v; },
        _children: [], appendChild(c) { cell._children.push(c); },
        _qs: null,
        _listeners: {},
        style: { cssText: '' },
        className: '', type: '', title: '', checked: false,
        querySelector: (sel) => {
          if (cell._qs && cell._qs[sel]) return cell._qs[sel];
          if (sel.startsWith('.')) {
            const cls = sel.slice(1);
            return cell._children.find((c) => c.className === cls) || null; // 真 DOM 能查到 append 的子节点
          }
          return null;
        },
        querySelectorAll: () => [],
        addEventListener(type, fn) { cell._listeners[type] = fn; },
        getBoundingClientRect: () => ({ left: 10, bottom: 20 }),
        contains: () => false,
        remove() {},
      };
      return cell;
    }
    function makeInput(value) {
      return { value, events: [], dispatchEvent(e) { this.events.push(e); } };
    }

    // 假 HTMLInputElement: 原型 value 存取器记录 set 调用
    class HTMLInputElement {}
    Object.defineProperty(HTMLInputElement.prototype, 'value', {
      get() { return this._native; },
      set(v) { HTMLInputElement._lastSet = v; this._native = v; },
    });
    class FakeEvent { constructor(type, opts) { this.type = type; this.bubbles = !!(opts && opts.bubbles); } }

    const headCells = [makeCell2('ID'), makeCell2('Pyramid')];
    const head = { querySelectorAll: (s) => (s === '.rt-th' ? headCells : []) };
    const filterInput = makeInput('');
    const pyrCell = makeCell2('');
    pyrCell._qs = { input: filterInput };
    const filterCells = [makeCell2('ID'), pyrCell];
    const filterHead = { querySelectorAll: (s) => (s === '.rt-th' ? filterCells : []) };
    const document2 = {
      querySelectorAll: (s) => (s === '.rt-thead.-header' ? [head] : s === '.rt-thead.-filters' ? [filterHead] : []),
      body: { appendChild: (n) => appended.push(n) },
      addEventListener() {}, removeEventListener() {},
      createElement: () => makeCell2(''),
    };
    const appended = [];
    const POOL_ROWS = [{ is: { WQPPYS: 'model/pv' } }, { is: { WQPPYS: 'fundamental' } }];

    const sandbox = `
      const wqpPoolDb = async () => ({
        transaction: () => ({ objectStore: () => ({ openCursor: () => {
          const req = {};
          queueMicrotask(() => {
            req.result = { value: { rows: __poolRows }, continue: () => { req.result = null; req.onsuccess(); } };
            if (req.onsuccess) req.onsuccess();
          });
          return req;
        } }) }),
        close: () => {},
      });
      const localStorage = { getItem: () => null, setItem: () => {} };
      const document = __document;
${ensureBlock}
${choiceBlock}
${uiBlock}
      return { ensurePyramidFilterUi, pyramidSelectedFromInput, writePyramidSelection };
    `;
    // eslint-disable-next-line no-new-func
    const ui = new Function('__poolRows', '__document', 'HTMLInputElement', 'Event', sandbox)(POOL_ROWS, document2, HTMLInputElement, FakeEvent);

    // [5a] 筛选格里出现 ▾ 按钮
    await ui.ensurePyramidFilterUi();
    check('筛选格补了 ▾ 按钮', filterCells[1]._children.some((c) => c.className === 'wqp-pyramid-filter-btn'));
    const before = filterCells[1]._children.length;
    await ui.ensurePyramidFilterUi();
    check('重复调度不会堆按钮(幂等)', filterCells[1]._children.length === before);

    // [5b] 勾选写回: 走原型 setter + 派发 input 事件
    const selected = ui.pyramidSelectedFromInput(filterInput);
    selected.add('model'); selected.add('pv');
    ui.writePyramidSelection(filterInput, selected);
    check('写回走原型 setter(绕过 React 值追踪)', HTMLInputElement._lastSet === 'model\u001fpv', String(HTMLInputElement._lastSet));
    check('派发了 input 事件', filterInput.events.some((e) => e.type === 'input' && e.bubbles));
    check('读回: 输入框当前值解析出两个段', (() => {
      const s2 = ui.pyramidSelectedFromInput({ value: 'model\u001fpv' });
      return s2.has('model') && s2.has('pv') && s2.size === 2;
    })());
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
