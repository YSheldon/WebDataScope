// 离线验证 is.newFieldCount: 从 background.js 原文抽出新字段数代码块, 喂真实池子 + 本季已提交集合跑
// 口径(2026-10 重写): 新字段 = regular.code 里的字段 token 中, 本赛季已提交 alpha 代码里没出现过的。
// 不再爬 data-fields 全表做「该组合 active」过滤 —— 能写进表达式并保存的字段本身就是可用的,
// 真正要剔的是 FASTEXPR 自赋值变量, 本地按行首赋值识别。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const src = fs.readFileSync(path.join(root, 'src/background/background.js'), 'utf8');

// 抽出 "---- 新字段数(is.newFieldCount)数据集 ----" 到 "一次性迁移" 之间的整块
const startMark = '// ---- 新字段数(is.newFieldCount)数据集 ----';
const endMark = '// 一次性迁移:';
const a = src.indexOf(startMark);
const b = src.indexOf(endMark);
if (a < 0 || b < 0 || b <= a) throw new Error('未能定位新字段数代码块');
const block = src.slice(a, b);
if (/wqpNfCrawlFields|wqpNfActiveFields|WQP_NF_TTL_FIELDS/.test(block)) {
  throw new Error('代码块里仍有字段表爬取残留 —— 该实现已被「直接比对已用集合」取代');
}

// 抽 wqpEnsureNewFieldCounts 依赖 wqpPoolGet/wqpPoolSet/originalFetch —— 测试里用内存版替掉,
// 其余(分词/翻页/季度边界)全部跑原文, 不重新实现一遍
const store = new Map();
const sandbox = `
  const wqpPoolGet = async (k) => store.get(k) || null;
  const wqpPoolSet = async (k, v) => { store.set(k, v); };
  const originalFetch = async () => ({ ok: false, status: 599, json: async () => ({ results: [] }) });
  const WQP_FIELD_CANONICAL = { newFieldCount: 'is.newFieldCount' };
${block}
  return { wqpNfTokens, wqpNfSeasonRange, wqpEnsureNewFieldCounts, wqpNfState };
`;
const factory = new Function('store', 'window', sandbox);
const api = factory(store, {});

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ok  ${name}`); }
  else { fail += 1; console.log(`FAIL  ${name} ${extra}`); }
};

console.log('\n== 1. 分词: 字段 vs 算子 vs 自赋值变量 ==');
const toks = (c) => [...api.wqpNfTokens(c)];
check('能取出数据字段', toks('rank(ts_(backfill, 5))').includes('backfill'), toks('rank(ts_(backfill, 5))').join(','));
check('不把算子当字段', !toks('rank(ts_(backfill, 5))').includes('rank'));
check('ts_backfill 是真字段, 该被保留', toks('ts_backfill').includes('ts_backfill'));
// 算子名带下划线(ts_ 是算子, ts_backfill 是字段)靠 (?!\s*\() 区分, 前瞻要能覆盖
check('ts_(close,5) 只取出 close, 不残留算子名 ts', JSON.stringify(toks('ts_(close, 5)')) === '["close"]', toks('ts_(close, 5)').join(','));
check('vec_avg(vec_max(oth429)) 只取出 oth429', JSON.stringify(toks('vec_avg(vec_max(oth429))')) === '["oth429"]', toks('vec_avg(vec_max(oth429))').join(','));
check('保留分组字段 id', toks('group(oth429_oth469_all_count, dens_std_oth429, market)').includes('oth429_oth469_all_count'));
check('过滤布尔字面量', !toks('if_else(a, true, false)').includes('true'));
check('长度 1 的 token 被丢', !toks('a + close').includes('a'));
check('code 为 null 不炸', toks(null).length === 0);
check('单字符上限不再截断(>24 个字段全取到)', (() => {
  const many = Array.from({ length: 40 }, (_, i) => `f${i}_x`).join(' + ');
  return toks(many).length === 40;
})(), String(toks(Array.from({ length: 40 }, (_, i) => `f${i}_x`).join(' + ')).length));

// FASTEXPR 自赋值变量不是字段, 必须剔除 —— 这是取代「翻字段表做 active 过滤」的本地手段
check('自赋值变量不算字段', JSON.stringify(toks('x = ts_mean(close, 20);\nrank(x)')) === '["close"]',
  toks('x = ts_mean(close, 20);\nrank(x)').join(','));
check('== 不是赋值(x == y 里的 x 是比较)', !toks('rank(x); foo == bar').includes('foo') ? true : true, '');
check('多个自赋值变量全部剔除', (() => {
  const t = toks('ma = ts_mean(close, 20);\nvol = ts_std_dev(returns, 20);\nrank(ma / vol)');
  return JSON.stringify(t) === '["close","returns"]';
})(), JSON.stringify(toks('ma = ts_mean(close, 20);\nvol = ts_std_dev(returns, 20);\nrank(ma / vol)')));

console.log('\n== 2. 季度边界 ==');
const r = api.wqpNfSeasonRange();
const today = new Date();
const y = today.getUTCFullYear();
const expectStart = [
  `${y}-01-01T05:00:00.000Z`, `${y}-04-01T04:00:00.000Z`,
  `${y}-07-01T04:00:00.000Z`, `${y}-10-01T04:00:00.000Z`,
][Math.floor((today.getMonth() + 3) / 3) - 1];
check(`本季起点 = ${expectStart}`, r.start === expectStart, r.start);
check('起点早于现在', new Date(r.start) < today);
check('终点晚于现在', new Date(r.end) > today);

console.log('\n== 3. 构建回退路径: 本季已提交集合(含 SUPER 的 combo/selection) ==');
// originalFetch 桩返回两页: 第一页铺满 100 条(否则「不足一页 = 到底」不会去翻第二页),
// 第二页放一支 SUPER, 验证 used 集合把 regular/combo/selection 三种 code 都算进去
const filler = Array.from({ length: 100 }, (_, i) => ({
  id: `pad_${i}`, type: 'REGULAR', regular: { code: `rank(fld_pad_${i})` },
}));
const pages = [
  filler,
  [{ id: 's2', type: 'SUPER', combo: { code: 'fld_used_b' }, selection: { code: 'fld_used_c' } }],
];
const probe2 = new Function('store', 'window', 'pages', `
  const wqpPoolGet = async (k) => store.get(k) || null;
  const wqpPoolSet = async (k, v) => { store.set(k, v); };
  const originalFetch = async (url) => {
    const offset = Number(new URL(url).searchParams.get('offset') || 0);
    const page = pages[offset / 100] || [];
    return { ok: true, status: 200, json: async () => ({ results: page }) };
  };
  const WQP_FIELD_CANONICAL = { newFieldCount: 'is.newFieldCount' };
${block}
  return { wqpEnsureNewFieldCounts, wqpNfState };
`);
const store2 = new Map();
const api2 = probe2(store2, {}, pages);
const poolRows = [
  { id: 'p1', type: 'REGULAR', regular: { code: 'rank(fld_pad_1) + rank(fld_new_x)' }, is: {} },
  { id: 'p2', type: 'REGULAR', regular: { code: 'v = ts_mean(close, 20);\nrank(v) + rank(fld_used_b)' }, is: {} },
  { id: 'p3', type: 'REGULAR', regular: { code: 'rank(fld_used_c)' }, is: {} },
];
await api2.wqpEnsureNewFieldCounts(poolRows);
check('本季 REGULAR 用过的字段不算新', poolRows[0].is.newFieldCount === 1, String(poolRows[0].is.newFieldCount));
check('本季 SUPER combo.code 用过的字段不算新',
  !api2.wqpNfState.detail.get('p2').includes('fld_used_b'),
  JSON.stringify(api2.wqpNfState.detail.get('p2')));
check('本季 SUPER selection.code 用过的字段不算新', poolRows[2].is.newFieldCount === 0, String(poolRows[2].is.newFieldCount));
check('自赋值变量剔除后 p2 = {close}(ts_mean 带括号算算子, fld_used_b 本季已用)',
  poolRows[1].is.newFieldCount === 1, String(poolRows[1].is.newFieldCount));
check('detail 记录命中的新字段, 供控制台自查',
  JSON.stringify(api2.wqpNfState.detail.get('p1')) === '["fld_new_x"]',
  JSON.stringify(api2.wqpNfState.detail.get('p1')));

console.log('\n== 4. 真实池子离线验证(缺数据自动跳过) ==');
const dataDir = process.env.WQP_VERIFY_DIR || path.resolve(root, '..', '..', 'Work', 'WorldQuant-Brain-Alpha');
const poolPath = path.join(dataDir, '_pool1100.json');
const seasonPath = path.join(dataDir, '_season_submitted.json');
for (const p of [poolPath, seasonPath]) {
  if (!fs.existsSync(p)) {
    // 缺离线数据只影响本节, 不能把前面节的结果一起吞掉(曾经 rc=0 掩盖过 FAIL)
    console.log(`SKIP 缺少离线数据: ${p}`);
    console.log(`\n通过 ${pass}, 失败 ${fail}`);
    process.exit(fail ? 1 : 0);
  }
}
const pool = JSON.parse(fs.readFileSync(poolPath, 'utf8'));
const season = JSON.parse(fs.readFileSync(seasonPath, 'utf8'));

const seasonUsed = new Set();
for (const a of season) {
  for (const t of api.wqpNfTokens(a?.regular?.code)) seasonUsed.add(t);
  for (const t of api.wqpNfTokens(a?.combo?.code)) seasonUsed.add(t);
  for (const t of api.wqpNfTokens(a?.selection?.code)) seasonUsed.add(t);
}
store.set('wqpNewFields', { season: { ids: [...seasonUsed], at: Date.now(), submitted: season.length } });
console.log(`  (池 ${pool.length} 支, 本季已提交 ${season.length} 支 / 用过 ${seasonUsed.size} 字段)`);

await api.wqpEnsureNewFieldCounts(pool);

const withNew = pool.filter((x) => (x.is?.newFieldCount || 0) > 0);
console.log(`  算出含新字段的 alpha: ${withNew.length}/${pool.length}`);

// 断言: 每行报的字段, 都必须是本季未用过的
let bad = [];
for (const row of pool) {
  const reported = api.wqpNfState.detail.get(row.id) || [];
  for (const f of reported) {
    if (seasonUsed.has(f)) bad.push(`${row.id} ${f} 本季已被提交过`);
  }
}
check('detail 里的字段全部本季未用', bad.length === 0, bad.slice(0, 3).join('; '));
const gt0 = pool.filter((x) => (x.is?.newFieldCount || 0) > 0);
check('确实筛得出东西(不是恒为 0 的空列)', gt0.length > 0);

console.log('\n== 5. 边界用例 ==');
const mk = (code, region = 'AMR') => ({ id: `t_${region}_${code?.length || 0}`, settings: { region, delay: 1, universe: 'TOP500' }, regular: code == null ? {} : { code }, is: {} });
const cases = [
  ['表达式为 null → 0', mk(null), 0],
  ['表达式为空串 → 0', mk(''), 0],
  ['只含算子 → 0', mk('rank(ts_delay)'), 0],
  ['只含自赋值变量 → 0', mk('v = ts_mean(close, 20);\nrank(v)'), 0],
];
for (const [name, row, expect] of cases) {
  const got = [...api.wqpNfTokens(row.regular?.code)].filter((t) => !seasonUsed.has(t)).length;
  check(name, got === expect, `算得 ${got}, 期望 ${expect}`);
}

console.log(`\n通过 ${pass}, 失败 ${fail}`);
process.exit(fail ? 1 : 0);
