import { readFileSync } from 'fs';

const src = readFileSync(new URL('../src/content/shared/utils.js', import.meta.url), 'utf8');
const fnBodies = {};
for (const name of ['removeComments', 'escapeRegExp', 'findSingleOps']) {
    const m = src.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`, 'm'));
    if (!m) throw new Error('not found: ' + name);
    fnBodies[name] = m[0];
}
const findSingleOpsRef = fnBodies.findSingleOps.replace('function findSingleOps', 'var findSingleOps');

function run(code) {
    return eval(`(function(){
        ${fnBodies.escapeRegExp}
        ${fnBodies.removeComments}
        ${fnBodies.findSingleOps}
        return findSingleOps(removeComments(${JSON.stringify(code)}));
    })()`);
}

const cases = [
    ['rank(x) /* 主因子 */ + ts_rank(close, 5)', ['+']],
    ['/* 头部注释\n   第二行 close/open */ ts_mean(volume, 20)', []],
    ['x + 1 # 行注释 y-z', ['+']],
    ['a /* c1 */ - /* c2 */ b', ['-']],
    ['ts_rank(close/*内联*/,5) * 2', ['*']],
    ['a / b /* note: x*y/z */ * c', ['*', '/']],
];
let fail = 0;
for (const [code, expected] of cases) {
    const got = run(code);
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    if (!ok) fail++;
    console.log((ok ? 'PASS' : 'FAIL'), JSON.stringify(code), '=>', JSON.stringify(got), ok ? '' : `expected ${JSON.stringify(expected)}`);
}
process.exit(fail ? 1 : 0);
