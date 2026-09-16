import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('../src/content/platform/genius/sixDimRank.js', import.meta.url), 'utf8');
const sandbox = { globalThis: {} };
vm.runInNewContext(`${code}\nthis.api = globalThis.WQPSixDimRank;`, sandbox);
const { applySixDimRanks, buildMasterStrengthPool, getMasterQuota } = sandbox.api;

function consultant(overrides) {
    return {
        user: 'U',
        alphaCount: 40,
        pyramidCount: 15,
        operatorCount: 40,
        fieldCount: 20,
        communityActivity: 10,
        completedReferrals: 0,
        maxSimulationStreak: 20,
        operatorAvg: 6,
        fieldAvg: 2,
        ...overrides,
    };
}

test('getMasterQuota is 8% capped at 250', () => {
    assert.equal(getMasterQuota(1000), 80);
    assert.equal(getMasterQuota(10000), 250);
});

test('strength pool takes Master quota by six-dim from Expert-eligible, not Master eligibility', () => {
    const data = [
        consultant({
            user: 'weak-master',
            alphaCount: 130,
            pyramidCount: 32,
            operatorCount: 10,
            fieldCount: 5,
            communityActivity: 0,
            maxSimulationStreak: 1,
            operatorAvg: 12,
            fieldAvg: 6,
        }),
        consultant({
            user: 'strong-expert',
            alphaCount: 50,
            pyramidCount: 16,
            operatorCount: 80,
            fieldCount: 60,
            communityActivity: 90,
            maxSimulationStreak: 400,
            operatorAvg: 3,
            fieldAvg: 1,
        }),
        consultant({
            user: 'mid-expert',
            alphaCount: 40,
            pyramidCount: 12,
            operatorCount: 30,
            fieldCount: 20,
            communityActivity: 20,
            maxSimulationStreak: 50,
            operatorAvg: 7,
            fieldAvg: 3,
        }),
    ];
    const pool = buildMasterStrengthPool(data, {
        geniusAlphaCount: 40,
        quota: 1,
    });
    assert.equal(pool.sourceCount, 3);
    assert.equal(pool.quota, 1);
    assert.deepEqual(pool.pool.map((item) => item.user), ['strong-expert']);
    assert.equal(pool.pool.some((item) => item.user === 'weak-master'), false);
});

test('user below quota is injected for comparison and marked injected', () => {
    const data = [
        consultant({ user: 'elite-1', operatorCount: 90, fieldCount: 70, maxSimulationStreak: 400, operatorAvg: 2, fieldAvg: 1 }),
        consultant({ user: 'elite-2', operatorCount: 85, fieldCount: 65, maxSimulationStreak: 350, operatorAvg: 2.2, fieldAvg: 1.1 }),
        consultant({ user: 'self', operatorCount: 15, fieldCount: 8, maxSimulationStreak: 10, operatorAvg: 10, fieldAvg: 4 }),
    ];
    const pool = buildMasterStrengthPool(data, {
        userId: 'self',
        geniusAlphaCount: 40,
        quota: 2,
    });
    assert.equal(pool.injected, true);
    assert.equal(pool.inQuota, false);
    assert.equal(pool.poolCount, 3);
    assert.equal(pool.userRank, 3);
});

test('strong six-dim user already in quota is not injected', () => {
    const data = [
        consultant({ user: 'self', operatorCount: 90, fieldCount: 70, maxSimulationStreak: 400, operatorAvg: 2, fieldAvg: 1 }),
        consultant({ user: 'other', operatorCount: 20, fieldCount: 10, maxSimulationStreak: 10, operatorAvg: 9, fieldAvg: 4 }),
    ];
    const pool = buildMasterStrengthPool(data, {
        userId: 'self',
        geniusAlphaCount: 40,
        quota: 1,
    });
    assert.equal(pool.injected, false);
    assert.equal(pool.inQuota, true);
    assert.equal(pool.userRank, 1);
    assert.equal(pool.poolCount, 1);
});

test('applySixDimRanks rewards high counts and low averages', () => {
    const ranked = applySixDimRanks([
        consultant({ user: 'a', operatorCount: 10, fieldCount: 10, communityActivity: 1, completedReferrals: 0, maxSimulationStreak: 1, operatorAvg: 10, fieldAvg: 5 }),
        consultant({ user: 'b', operatorCount: 80, fieldCount: 80, communityActivity: 80, completedReferrals: 5, maxSimulationStreak: 80, operatorAvg: 3, fieldAvg: 1 }),
    ]);
    const byUser = Object.fromEntries(ranked.map((item) => [item.user, item]));
    assert.ok(byUser.b.totalRank < byUser.a.totalRank);
});
