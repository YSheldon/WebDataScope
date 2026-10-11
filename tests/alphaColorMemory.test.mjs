// alphaColorMemory.test.mjs — alpha 颜色本地记忆
// 切 background.js 注入函数里的颜色块源码 + 假 localStorage, 沿用既有测试写法。
// 回归背景: 平台的颜色本身会持久化, 但虚拟列视图的行来自本地池, 池行的 color 是
// 建池那一刻的旧值 —— 上色之后一刷新就被旧值盖掉。
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

const block = slice('// ---- alpha 颜色本地记忆 ----', 'function getAlphaCheckStates(originalData) {');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
    if (cond) { pass += 1; console.log(`  ok  ${name}`); }
    else { fail += 1; console.log(`FAIL  ${name} ${extra}`); }
};

function makeSandbox() {
    const store = new Map([['WQP_AlphaColorOverrides', '{}']]);
    const saved = [];
    const sandbox = `
      const localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { saved.push([k, v]); store.set(k, String(v)); },
      };
      // 让 wqpColors 的缓存失效可测: 每次外部改 store 后调一次
      const __invalidate = () => { wqpColorCache = null; };
${block}
      return { wqpColors, wqpRecordColor, wqpApplyLocalColor, wqpCaptureColorMutation, __invalidate };
    `;
    // eslint-disable-next-line no-new-func
    return new Function('store', 'saved', sandbox)(store, saved);
}

console.log('\n[1] 学习: 新鲜 API 行上的颜色回填到本地记录');
{
    const api = makeSandbox();
    const item = { id: 'GrON16OP', color: 'RED' };
    api.wqpApplyLocalColor(item);
    check('行上有颜色且未记录 → 记下', api.wqpColors().GrON16OP === 'RED');
    check('行本身不变', item.color === 'RED');
}

console.log('\n[2] 覆盖: 本地记录优先于行上的旧值(池行 stale 的场景)');
{
    const api = makeSandbox();
    api.wqpRecordColor('aabb22', 'RED');
    const stale = { id: 'aabb22', color: null }; // 池行: 建池时还没上色
    api.wqpApplyLocalColor(stale);
    check('池行 color=null 也被本地 RED 覆盖', stale.color === 'RED', String(stale.color));
    // 学习方向确认: 覆盖时不再反向学习, 不会把 stale 的 null 写回记录
    check('覆盖路径不反向学习', api.wqpColors().aabb22 === 'RED');
}

console.log('\n[3] 清除: 本地记录 null 表示「已去色」, 同样优先生效');
{
    const api = makeSandbox();
    api.wqpRecordColor('cc33', 'GREEN');
    api.wqpRecordColor('cc33', null); // 平台发 color=null = 去色
    const item = { id: 'cc33', color: 'GREEN' };
    api.wqpApplyLocalColor(item);
    check('去色后行上的旧颜色被清掉', item.color === null, String(item.color));
}

console.log('\n[4] 捕获: PUT/PATCH /users/self/alphas/{id} 的 body 带 color 时记下');
{
    const api = makeSandbox();
    api.wqpCaptureColorMutation('PUT', 'https://api.worldquantbrain.com/users/self/alphas/dd44?x=1', JSON.stringify({ color: 'BLUE', name: 'x' }));
    check('PUT + color → 记录', api.wqpColors().dd44 === 'BLUE');
    api.wqpCaptureColorMutation('PATCH', 'https://api.worldquantbrain.com/users/self/alphas/ee55', JSON.stringify({ color: null }));
    check('PATCH color=null → 记录为去色', api.wqpColors().ee55 === null);
    api.wqpCaptureColorMutation('GET', 'https://api.worldquantbrain.com/users/self/alphas/ff66', JSON.stringify({ color: 'RED' }));
    check('GET 不算变更', api.wqpColors().ff66 === undefined);
    api.wqpCaptureColorMutation('PUT', 'https://api.worldquantbrain.com/users/self/alphas/gg77', JSON.stringify({ name: '只改名' }));
    check('body 不带 color 不记录', api.wqpColors().gg77 === undefined);
    api.wqpCaptureColorMutation('PUT', 'https://api.worldquantbrain.com/users/self/alphas?q=1', '{}');
    check('列表 URL(无 id)不记录', Object.keys(api.wqpColors()).every((k) => !['', 'q=1'].includes(k)));
}

console.log('\n[5] 持久化: 记录写进 localStorage, 新沙箱能读回');
{
    const api = makeSandbox();
    api.wqpRecordColor('hh88', 'PURPLE');
    const raw = JSON.stringify(api.wqpColors());
    const api2 = makeSandbox();
    // 模拟跨刷新: 把写盘内容放进新沙箱的 localStorage
    api2.wqpColors(); // 先触发一次空读
    const store = { 'WQP_AlphaColorOverrides': raw };
    const sandbox = `
      const localStorage = { getItem: (k) => (store[k] ?? null), setItem: () => {} };
${block}
      return wqpColors;
    `;
    // eslint-disable-next-line no-new-func
    const colors = new Function('store', sandbox)(store)();
    check('刷新后从 localStorage 读回颜色', colors.hh88 === 'PURPLE');
    check('序列化往返无损', JSON.parse(raw).hh88 === 'PURPLE');
    void api2;
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
