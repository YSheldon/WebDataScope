import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/content/platform/data/fieldUsageFlag.js', import.meta.url), 'utf8');
const calls = [...new Set(
    [...src.matchAll(/(?<![.\w])([a-zA-Z_][A-Za-z0-9_]*)\s*\(/g)].map((m) => m[1]),
)];
const defs = new Set([...src.matchAll(/\bfunction\s+([A-Za-z0-9_]+)/g)].map((m) => m[1]));
const knownExternal = new Set([
    'getSubmittedFields', 'fetch', 'setTimeout', 'setInterval', 'clearTimeout',
    'console', 'document', 'window', 'location', 'URL', 'Request', 'Response',
    'AbortSignal', 'Date', 'Number', 'String', 'Boolean', 'Math', 'Promise',
    'decodeURIComponent', 'encodeURIComponent', 'Error', 'MutationObserver',
    'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'new',
    'typeof', 'await', 'else', 'do',
    'Map', 'Set', 'WeakMap', 'WeakSet', 'Array', 'Object', 'JSON',
    'Monaco', 'rgba', 'b',
]);
let bad = 0;
for (const fn of calls) {
    if (defs.has(fn) || knownExternal.has(fn)) continue;
    if (new RegExp(`\\b(const|let|var)\\s+${fn}\\s*=`).test(src)) continue;
    console.log('UNRESOLVED:', fn);
    bad += 1;
}
console.log(bad ? `${bad} unresolved refs` : 'ALL RESOLVED');
process.exit(bad ? 1 : 0);
