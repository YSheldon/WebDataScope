import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    parseAlphasListUrl,
    applyClientQuery,
    pageResult,
    compare,
    injectAlphaOptions,
} = require('../src/content/shared/wqpClientQuery.js');

function row(ra, ppa, pyramid = '') {
    return { id: `${ra}-${ppa}`, is: { failedNumRA: ra, failedNumPPA: ppa, WQPPYS: pyramid } };
}

test('parse keeps server filters and lifts virtual column constraints', () => {
    const parsed = parseAlphasListUrl(
        'https://api.worldquantbrain.com/users/self/alphas?limit=25&offset=50&stage=IS&is.sharpe>1.25&is.failedNumRA<1&order=-is.failedNumPPA',
    );
    assert.equal(parsed.active, true);
    assert.equal(parsed.limit, 25);
    assert.equal(parsed.offset, 50);
    assert.deepEqual(parsed.clientOrder, { field: 'is.failedNumPPA', desc: true });
    assert.equal(parsed.clientFilters.length, 1);
    assert.equal(parsed.clientFilters[0].field, 'is.failedNumRA');
    assert.equal(parsed.clientFilters[0].op, '<');
    assert.equal(parsed.clientFilters[0].value, '1');
    assert.match(decodeURIComponent(parsed.serverUrl), /is\.sharpe>1\.25/);
    assert.doesNotMatch(decodeURIComponent(parsed.serverUrl), /failedNum/);
    assert.doesNotMatch(parsed.serverUrl, /order=/);
    assert.doesNotMatch(parsed.serverUrl, /limit=/);
});

test('server-only query is not intercepted', () => {
    const parsed = parseAlphasListUrl(
        'https://api.worldquantbrain.com/users/self/alphas?limit=10&offset=0&order=-regular.operatorCount',
    );
    assert.equal(parsed.active, false);
    assert.match(parsed.serverUrl, /order=-regular\.operatorCount/);
});

test('filter <1 and sort by failed PPA across the whole pool', () => {
    const rows = [row(0, 3), row(2, 0), row(0, 1), row(1, 4)];
    const parsed = parseAlphasListUrl(
        'https://api.worldquantbrain.com/users/self/alphas?limit=10&offset=0&is.failedNumRA<1&order=-is.failedNumPPA',
    );
    const filtered = applyClientQuery(rows, parsed);
    assert.deepEqual(filtered.map((item) => item.is.failedNumPPA), [3, 1]);
    const page = pageResult(filtered, { ...parsed, limit: 1, offset: 1 });
    assert.equal(page.count, 2);
    assert.equal(page.results[0].is.failedNumPPA, 1);
});

test('unprefixed failedNumPPA is a client filter and operatorCount stays on the server', () => {
    const parsed = parseAlphasListUrl(
        'https://api.worldquantbrain.com/users/self/alphas?limit=10&offset=0&failedNumPPA<1&operatorCount<6&order=operatorCount',
    );
    assert.equal(parsed.active, true);
    assert.equal(parsed.clientFilters[0].field, 'is.failedNumPPA');
    assert.equal(parsed.clientFilters[0].op, '<');
    const server = decodeURIComponent(parsed.serverUrl);
    assert.match(server, /regular\.operatorCount<6/);
    assert.match(server, /order=regular\.operatorCount/);
    assert.doesNotMatch(server, /failedNumPPA/);
});

test('OPTIONS schema gains the virtual integer fields', () => {
    const schema = {
        is: { children: { sharpe: { type: 'decimal' } } },
        regular: { children: { code: { type: 'string' } } },
    };
    injectAlphaOptions(schema);
    assert.equal(schema.is.children.failedNumPPA.type, 'integer');
    assert.equal(schema.is.children.failedNumRA.type, 'integer');
    assert.equal(schema.regular.children.operatorCount.type, 'integer');
    assert.equal(schema.is.children.sharpe.type, 'decimal');
});

test('numeric compare treats zero as less than one', () => {
    assert.equal(compare('<', 0, '1'), true);
    assert.equal(compare('<', 1, '1'), false);
    assert.equal(compare('>=', 2, '1'), true);
});
