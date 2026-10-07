// 离线验证 is.newFieldCount: 从 background.js 原文抽出新字段数代码块, 喂真实池子 + 真实 active 字段表跑
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
let block = src.slice(a, b);

// 抽 wqpEnsureNewFieldCounts 依赖 wqpPoolGet/wqpPoolSet/originalFetch —— 测试里用内存版替掉,
// 其余(分词/翻页/季度边界)全部跑原文, 不重新实现一遍
const store = new Map();
const sandbox = `
  const wqpPoolGet = async (k) => store.get(k) || null;
  const wqpPoolSet = async (k, v) => { store.set(k, v); };
  const originalFetch = async () => ({ ok: false, status: 599, json: async () => ({ results: [] }) });
  const WQP_FIELD_CANONICAL = { newFieldCount: 'is.newFieldCount' };
${block}
  return { wqpNfTokens, wqpNfSeasonRange, wqpEnsureNewFieldCounts, wqpQueryUsesNewFieldCount, wqpNfCachesWarm, wqpNfState };
`;
const factory = new Function('store', 'window', sandbox);
const api = factory(store, {});

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ok  ${name}`); }
  else { fail += 1; console.log(`FAIL  ${name} ${extra}`); }
};

console.log('\n== 1. 分词: 字段 vs 算子 ==');
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

console.log('\n== 3. await 门控: 只在用到该列时才构建 ==');
const uses = api.wqpQueryUsesNewFieldCount;
check('筛选 is.newFieldCount → true', uses({ clientFilters: [{ field: 'is.newFieldCount' }], clientOrder: null }) === true);
check('筛选 newFieldCount(短名) → true', uses({ clientFilters: [{ field: 'newFieldCount' }], clientOrder: null }) === true);
check('排序 is.newFieldCount → true', uses({ clientFilters: [], clientOrder: { field: 'is.newFieldCount' } }) === true);
check('筛选 failedNumRA → false(不白付翻表代价)', uses({ clientFilters: [{ field: 'is.failedNumRA' }], clientOrder: null }) === false);
check('无筛选无排序 → false', uses({ clientFilters: [], clientOrder: null }) === false);
check('无参数 → false', uses(undefined) === false);

// ---- wqpNfCachesWarm: 纯显示的查询只有在数据集缓存全热时才值得构建 ----
// (放在 section 4 之前: 那节缺离线数据会 process.exit(0), 排在它后面的用例永远跑不到)
const now = Date.now();
const warmProbe = (storeMap) => {
  const probe = new Function('store', 'window',
    sandbox.slice(0, sandbox.lastIndexOf('  return {')) + '\n  return { wqpNfCachesWarm };');
  return probe(storeMap, {}).wqpNfCachesWarm;
};
const warmStoreWith = (mutate) => {
  const m = new Map([['wqpNewFields', {
    season: { ids: ['f_used'], at: now, submitted: 3 },
    combos: { AMR_1_TOP500: { ids: ['f_a', 'f_b'], at: now } },
  }]]);
  mutate(m.get('wqpNewFields'));
  return m;
};
const rowAmr = { id: 'x1', settings: { region: 'AMR', delay: 1, universe: 'TOP500' }, regular: { code: 'rank(f_a)' }, is: {} };
check('wqpNfCachesWarm: season+combo 都在有效期内 → 热', await warmProbe(warmStoreWith(() => {}))([rowAmr]) === true);
check('wqpNfCachesWarm: season 过期 → 冷', await warmProbe(warmStoreWith((s) => { s.season.at = now - 2 * 60 * 60 * 1000; }))([rowAmr]) === false);
check('wqpNfCachesWarm: combo 字段表过期 → 冷', await warmProbe(warmStoreWith((s) => { s.combos.AMR_1_TOP500.at = now - 13 * 60 * 60 * 1000; }))([rowAmr]) === false);
check('wqpNfCachesWarm: season 空 ids → 冷', await warmProbe(warmStoreWith((s) => { s.season.ids = []; }))([rowAmr]) === false);
check('wqpNfCachesWarm: 行的 combo 没进过缓存 → 冷', await warmProbe(warmStoreWith(() => {}))([{ id: 'x2', settings: { region: 'EUR', delay: 1, universe: 'TOP2500' }, regular: { code: 'x' }, is: {} }]) === false);
check('wqpNfCachesWarm: 无 region 的行不产生 combo, 仅 season 热 → 热', await warmProbe(warmStoreWith(() => {}))([{ id: 'x3', settings: {}, regular: { code: 'x' }, is: {} }]) === true);


console.log('\n== 4. 真实池子离线验证 ==');
const dataDir = process.env.WQP_VERIFY_DIR || path.resolve(root, '..', '..', 'Work', 'WorldQuant-Brain-Alpha');
const poolPath = path.join(dataDir, '_pool1100.json');
const activePath = path.join(dataDir, '_active_by_region.json');
const seasonPath = path.join(dataDir, '_season_submitted.json');
const usFieldsPath = path.join(dataDir, '_us_d1_fields.json');
for (const p of [poolPath, activePath, seasonPath, usFieldsPath]) {
  if (!fs.existsSync(p)) { console.log(`SKIP 缺少离线数据: ${p}`); process.exit(0); }
}
const pool = JSON.parse(fs.readFileSync(poolPath, 'utf8'));
const activeByRegion = JSON.parse(fs.readFileSync(activePath, 'utf8'));
const season = JSON.parse(fs.readFileSync(seasonPath, 'utf8'));
const usFields = JSON.parse(fs.readFileSync(usFieldsPath, 'utf8'));

// 用抓到的真实集合预置缓存, 让 wqpEnsureNewFieldCounts 走「缓存命中」这条路
const seasonUsed = new Set();
for (const a of season) for (const t of api.wqpNfTokens(a?.regular?.code)) seasonUsed.add(t);
const combos = {};
for (const [region, ids] of Object.entries(activeByRegion)) combos[`${region}_1_TOP500`] = { ids, at: Date.now() };
store.set('wqpNewFields', { combos: { ...combos, 'USA_1_TOP3000': { ids: usFields, at: Date.now() } }, season: { ids: [...seasonUsed], at: Date.now(), submitted: season.length } });
console.log(`  (池 ${pool.length} 支, 本季已提交 ${season.length} 支 / 用过 ${seasonUsed.size} 字段, active 字段表 ${Object.entries(activeByRegion).map(([k, v]) => k + ':' + v.length).join(' ')})`);

// 池子里真实的 region/universe 组合, 用真实 combo 键
const realCombos = new Set();
for (const row of pool) {
  const s = row.settings || {};
  if (s.region) realCombos.add(`${s.region}_${s.delay ?? 1}_${s.universe || 'TOP3000'}`);
}
const comboMap = {};
for (const [region, ids] of Object.entries(activeByRegion)) {
  for (const c of realCombos) if (c.startsWith(`${region}_`)) comboMap[c] = { ids, at: Date.now() };
}
if (realCombos.has('USA_1_TOP3000')) comboMap['USA_1_TOP3000'] = { ids: usFields, at: Date.now() };
store.set('wqpNewFields', { combos: comboMap, season: { ids: [...seasonUsed], at: Date.now(), submitted: season.length } });

await api.wqpEnsureNewFieldCounts(pool);

const withNew = pool.filter((x) => (x.is?.newFieldCount || 0) > 0);
console.log(`  算出含新字段的 alpha: ${withNew.length}/${pool.length}`);

// 断言 1: 每行报的字段, 都必须既 active 又本季未用过
let bad = [];
for (const row of pool) {
  const s = row.settings || {};
  const active = new Set(activeByRegion[s.region] || []);
  const reported = api.wqpNfState.detail.get(row.id) || [];
  for (const f of reported) {
    if (!active.has(f)) bad.push(`${row.id} ${f} 不在 ${s.region} 的 active 表里`);
    if (seasonUsed.has(f)) bad.push(`${row.id} ${f} 本季已被提交过`);
  }
  if (reported.length !== (row.is?.newFieldCount ?? 0)) bad.push(`${row.id} 计数 ${row.is?.newFieldCount} 与明细 ${reported.length} 不一致`);
  if (reported.length !== new Set(reported).size) bad.push(`${row.id} 明细里有重复`);
}
check('每个计入的字段都 active 且本季未提交过, 计数与明细一致', bad.length === 0, bad.slice(0, 5).join(' | '));

// 断言 2: 漏算的行数必须为 0 —— 独立重算一遍 active ∩ ¬used
let missed = 0;
for (const row of pool) {
  const s = row.settings || {};
  const active = new Set(activeByRegion[s.region] || []);
  const expect = [...api.wqpNfTokens(row.regular?.code)].filter((t) => active.has(t) && !seasonUsed.has(t)).length;
  if (expect !== (row.is?.newFieldCount ?? 0)) missed += 1;
}
check('逐行重算结果与实现一致(无漏算/多算)', missed === 0, `不一致 ${missed} 行`);

// 断言 3: 筛 >0 的命中集合恰好等于独立重算的集合
const gt0 = pool.filter((x) => (x.is?.newFieldCount || 0) > 0).map((x) => x.id).sort();
const expectGt0 = pool.filter((row) => {
  const s = row.settings || {};
  const active = new Set(activeByRegion[s.region] || []);
  return [...api.wqpNfTokens(row.regular?.code)].some((t) => active.has(t) && !seasonUsed.has(t));
}).map((x) => x.id).sort();
check(`筛 newFieldCount>0 命中 ${gt0.length} 支, 与定义一致`, JSON.stringify(gt0) === JSON.stringify(expectGt0));
check('确实筛得出东西(不是恒为 0 的空列)', gt0.length > 0);

console.log('\n== 5. 边界用例 ==');
const mk = (code, region = 'AMR') => ({ id: `t_${region}_${code?.length || 0}`, settings: { region, delay: 1, universe: 'TOP500' }, regular: code == null ? {} : { code }, is: {} });
const activeAMR = new Set(activeByRegion.AMR);
// 边界用例固定用 AMR, 所以新字段样本必须取自 AMR 的行, 否则字段不在 AMR 的 active 表里(是我取样取错了 region)
const amrFresh = pool
  .filter((x) => x.settings?.region === 'AMR')
  .flatMap((x) => (api.wqpNfState.detail.get(x.id) || []).map((f) => [f, x.id]));
const freshA = amrFresh[0]?.[0] || 'zzz_nope';
const freshB = amrFresh[1]?.[0] || 'zzz_nope';
const usedSample = [...seasonUsed].find((t) => activeAMR.has(t));
const cases = [
  ['表达式为 null → 0', mk(null), 0],
  ['表达式为空串 → 0', mk(''), 0],
  ['只含算子 → 0', mk('rank(ts_delay)'), 0],
  ['只含本季已用字段 → 0', mk(usedSample ? `rank(${usedSample})` : 'zzz_nope'), 0],
  ['含 1 个新字段 → 1', mk(`rank(${freshA})`), 1],
  ['含 2 个新字段 → 2', mk(`rank(${freshA}) + rank(${freshB})`), 2],
  ['同一字段写两次只算 1 个', mk(`rank(${freshA}) + rank(${freshA})`), 1],
  ['新字段 + 已用字段混用 → 只数新字段', mk(usedSample ? `rank(${freshA}) + rank(${usedSample})` : `rank(${freshA})`), 1],
];
for (const [name, row, expect] of cases) {
  const got = (() => {
    const active = activeAMR;
    return [...api.wqpNfTokens(row.regular?.code)].filter((t) => active.has(t) && !seasonUsed.has(t)).length;
  })();
  check(name, got === expect, `算得 ${got}, 期望 ${expect}`);
}

// RA_CHILD / RA_PARENT 都有 regular.code? 没有的记 0
const raNoCode = { id: 'ra_x', type: 'RA_PARENT', settings: { region: 'AMR', delay: 1, universe: 'TOP500' }, regular: null, is: {} };
check('RA_PARENT 无 regular.code → 记 0', [...api.wqpNfTokens(raNoCode.regular?.code)].length === 0);

console.log(`\n通过 ${pass}, 失败 ${fail}`);
process.exit(fail ? 1 : 0);
