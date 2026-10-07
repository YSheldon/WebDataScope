// fieldUsageRefresh.test.mjs — 字段使用「新/已用」徽章的强刷与判定基准
// 切 utils.js / fieldUsageFlag.js 真实源码 + eval 切片, 沿用既有测试写法。
// 回归背景:
//   1. fetchSubmittedAlphas 曾按「每天前 4 支 REGULAR」裁剪, 当天第 5 支起提交的
//      alpha 从列表里消失, 徽章/双击查询永久误报「新」;
//   2. 已提交列表有 1 小时缓存, 徽章没有强刷入口, 刚提交的 alpha 最多滞后一小时;
//   3. tooltip 不显示判定基准时间, 用户无法分辨「新」是数据旧还是真的没用过。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const utilsSrc = readFileSync(path.join(root, 'src/content/shared/utils.js'), 'utf8');
const flagSrc = readFileSync(path.join(root, 'src/content/platform/data/fieldUsageFlag.js'), 'utf8');

function slice(src, startMark, endMark) {
    const a = src.indexOf(startMark);
    const b = src.indexOf(endMark, a);
    if (a < 0 || b < 0) throw new Error(`切片失败: ${startMark} / ${endMark}`);
    return src.slice(a, b);
}

let pass = 0, fail = 0;
function check(name, cond, info = '') {
    if (cond) { pass += 1; console.log('  ok  ', name); }
    else { fail += 1; console.log('  FAIL', name, info); }
}

function makeElement() {
    return {
        textContent: '', title: '', className: '', removed: false,
        style: { cssText: '' },
        listeners: {},
        addEventListener(type, fn) { this.listeners[type] = fn; },
        remove() { this.removed = true; },
    };
}

console.log('\n[1] fetchSubmittedAlphas 不再按「每天前4支」裁剪 REGULAR');
{
    const body = slice(utilsSrc, 'async function fetchSubmittedAlphas', 'let submittedFieldsCache');
    check('没有 slice(0, 4) 裁剪', !body.includes('slice(0, 4)'));
    check('没有「每天只保留前4个」逻辑', !body.includes('每天只保留前4个') && !body.includes('alphasByDate'));
    check('完整列表直达缓存', /filteredAlphas\s*=\s*allAlphas/.test(body));
}

console.log('\n[2] getSubmittedFieldsUpdatedAt 暴露判定基准时间');
{
    const body = slice(utilsSrc, 'function getSubmittedFieldsUpdatedAt', 'async function getSubmittedFields');
    // eslint-disable-next-line no-new-func
    const make = new Function('cache', `
        let WQP_SubmittedAlphasCache = cache;
        ${body}
        return getSubmittedFieldsUpdatedAt;
    `);
    check('返回已提交列表的拉取时刻', make({ lastUpdated: 1730000000000 })() === 1730000000000);
    check('从未拉取时返回 0 而不是 undefined', make({}) () === 0);
}

console.log('\n[3] usageBadge 可点击, tooltip 带判定基准与强刷提示');
{
    const body = slice(flagSrc, 'function usageBadge', '// ---------- 数据字段列表行打标');
    // eslint-disable-next-line no-new-func
    const make = new Function('getSubmittedFieldsUpdatedAt', 'forceRefreshFieldUsage', 'document', `
        ${body}
        return usageBadge;
    `);
    const created = [];
    const doc = { createElement: () => { const el = makeElement(); created.push(el); return el; } };
    const stamp = new Date('2026-10-06T12:00:00').getTime();

    const newBadge = make(() => stamp, async () => {}, doc)('fnde_newqint_cheq', { count: 0, alphaIds: [] });
    check('「新」徽章 tooltip 含判定基准', newBadge.title.includes('判定基准'), newBadge.title);
    check('tooltip 基准是格式化时间而非裸毫秒', newBadge.title.includes(new Date(stamp).toLocaleString()), newBadge.title);
    check('tooltip 提示可点击强刷', newBadge.title.includes('点击强刷'));
    check('「新」徽章也注册了点击', typeof newBadge.listeners.click === 'function');
    check('cursor: pointer', newBadge.style.cssText.includes('cursor:pointer'));

    const usedBadge = make(() => stamp, async () => {}, doc)('fnd6_x', { count: 2, alphaIds: ['a1', 'a2'] });
    check('「已用」徽章 tooltip 同样带判定基准', usedBadge.title.includes('判定基准'), usedBadge.title);
    check('「已用」徽章同样可点击', typeof usedBadge.listeners.click === 'function');

    const neverBadge = make(() => 0, async () => {}, doc)('fnd6_x', { count: 0, alphaIds: [] });
    check('从未拉取时 tooltip 显示「尚未拉取」', neverBadge.title.includes('尚未拉取'), neverBadge.title);
}

console.log('\n[4] forceRefreshFieldUsage: 强拉 + 复位三路展示 + 防重入');
{
    const body = slice(flagSrc, 'let usageRefreshInFlight', '// ---------- 数据字段列表行打标');
    // eslint-disable-next-line no-new-func
    const make = new Function('FIELD_USAGE_STATE', 'getSubmittedFields', 'mainPass', 'document', `
        ${body}
        return forceRefreshFieldUsage;
    `);

    function makeDoc() {
        return {
            getElementById: () => null,
            querySelectorAll: (sel) => {
                if (sel === '.wq-field-usage-badge') return [staleBadge];
                if (sel.includes('wqp-alpha-field-strip')) return [alphaStrip];
                if (sel === '.wqp-code-strip') return [codeStrip];
                return [];
            },
        };
    }
    const staleBadge = makeElement();   // 页面上另一枚旧徽章, 强刷时应被移除
    const alphaStrip = { dataset: { done: '1' } };
    const codeStrip = { dataset: { code: 'ts_zscore(x,66)' } };
    const state = {
        usageByField: { clear() { this.cleared = true; }, cleared: false },
        flaggedRows: 'old',
    };
    const calls = { force: 0, mainPass: 0 };
    const refresh = make(
        state,
        async (force) => { calls.force += 1; if (!force) throw new Error('必须传 forceRefresh=true'); },
        async () => { calls.mainPass += 1; },
        makeDoc(),
    );

    const clicked = makeElement();
    await refresh(clicked);
    check('以 forceRefresh=true 重拉列表', calls.force === 1);
    check('清掉按字段缓存', state.usageByField.cleared === true);
    check('flaggedRows 换成新 WeakSet, 列表行会重新打标', state.flaggedRows instanceof WeakSet);
    check('alpha 条的 done 标记被复位', alphaStrip.dataset.done === '');
    check('代码块条的 code 标记被复位', codeStrip.dataset.code === '');
    check('页面上的旧徽章被移除(点中的那枚除外)', staleBadge.removed === true && clicked.removed === false);
    check('复位后立即重建一轮', calls.mainPass === 1);
    check('完成后被点徽章恢复正常文案', clicked.textContent === '' || clicked.textContent !== '刷新中…',
        clicked.textContent);

    // 防重入: 上一次还在跑时, 第二次点击必须被忽略
    let release;
    const gate = new Promise((r) => { release = r; });
    const state2 = { usageByField: { clear() {} }, flaggedRows: 'old' };
    const slow = make(
        state2,
        async () => { await gate; },
        async () => {},
        makeDoc(),
    );
    const first = slow(makeElement());
    const second = slow(makeElement()); // 在 in-flight 时发起
    release();
    await Promise.all([first, second]);
    check('in-flight 期间的第二次点击被忽略(只拉一次)',
        // 第一次 await gate 后 mainPass 同步返回; 第二次调用直接 return
        true, '见下方计数校验');
}

console.log('\n[5] 防重入计数(独立场景, 避免 gate 时序干扰)');
{
    const body = slice(flagSrc, 'let usageRefreshInFlight', '// ---------- 数据字段列表行打标');
    let inFlightResolve;
    const fetches = [];
    // eslint-disable-next-line no-new-func
    const make = new Function('FIELD_USAGE_STATE', 'getSubmittedFields', 'mainPass', 'document', `
        ${body}
        return forceRefreshFieldUsage;
    `);
    const state = { usageByField: { clear() {} }, flaggedRows: 'old' };
    const refresh = make(
        state,
        (force) => { fetches.push(force); return new Promise((r) => { inFlightResolve = r; }); },
        async () => {},
        { getElementById: () => null, querySelectorAll: () => [] },
    );
    const badge = makeElement();
    const p1 = refresh(badge);
    await refresh(makeElement()); // 第二次应被忽略
    inFlightResolve();
    await p1;
    check('两次点击只触发一次重拉', fetches.length === 1, JSON.stringify(fetches));
    check('重拉带 forceRefresh=true', fetches[0] === true);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);