import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('../src/content/platform/genius/sixDimRank.js', import.meta.url), 'utf8');
const sandbox = { globalThis: {} };
vm.runInNewContext(`${code}\nthis.api = globalThis.WQPSixDimRank;`, sandbox);
const {
    applySixDimRanks,
    buildMasterStrengthPool,
    getMasterQuota,
    isMasterContender,
    nearMasterThresholds,
} = sandbox.api;

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

test('near Master thresholds are 80% of 120/30', () => {
    const near = nearMasterThresholds({ alphaCount: 120, pyramidCount: 30 });
    assert.equal(near.alphaCount, 96);
    assert.equal(near.pyramidCount, 24);
});

test('contender includes near-Master (126/28) and full Master, excludes ordinary Expert', () => {
    const master = { alphaCount: 120, pyramidCount: 30, combinedAlphaPerformance: 1, combinedSelectedAlphaPerformance: 1, combinedPowerPoolAlphaPerformance: 1, combinedOsmosisPerformance: 1 };
    assert.equal(isMasterContender(consultant({ alphaCount: 126, pyramidCount: 28 }), master, false), true);
    assert.equal(isMasterContender(consultant({ alphaCount: 130, pyramidCount: 32 }), master, false), true);
    assert.equal(isMasterContender(consultant({ alphaCount: 50, pyramidCount: 16 }), master, false), false);
    assert.equal(isMasterContender(consultant({ alphaCount: 200, pyramidCount: 10 }), master, false), false);
});

test('strength pool is near-Master plus passed-Master, not all Experts, not sliced to quota', () => {
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
            user: 'close-master',
            alphaCount: 126,
            pyramidCount: 28,
            operatorCount: 80,
            fieldCount: 60,
            communityActivity: 90,
            maxSimulationStreak: 400,
            operatorAvg: 3,
            fieldAvg: 1,
        }),
        consultant({
            user: 'ordinary-expert',
            alphaCount: 50,
            pyramidCount: 16,
            operatorCount: 99,
            fieldCount: 99,
            communityActivity: 99,
            maxSimulationStreak: 99,
            operatorAvg: 1,
            fieldAvg: 1,
        }),
    ];
    const pool = buildMasterStrengthPool(data, {
        geniusAlphaCount: 40,
        quota: 1,
    });
    assert.equal(pool.sourceCount, 2);
    assert.equal(pool.poolCount, 2);
    const users = pool.pool.map((item) => item.user).sort();
    assert.deepEqual(users, ['close-master', 'weak-master']);
    const ordered = [...pool.pool].sort((a, b) => a.totalRank - b.totalRank).map((item) => item.user);
    assert.equal(ordered[0], 'close-master');
    assert.equal(pool.near.alphaCount, 96);
    assert.equal(pool.near.pyramidCount, 24);
});

test('ordinary Expert user is injected only for comparison', () => {
    const data = [
        consultant({ user: 'close', alphaCount: 126, pyramidCount: 28, operatorCount: 90, fieldCount: 70, maxSimulationStreak: 400, operatorAvg: 2, fieldAvg: 1 }),
        consultant({ user: 'self', alphaCount: 50, pyramidCount: 16, operatorCount: 15, fieldCount: 8, maxSimulationStreak: 10, operatorAvg: 10, fieldAvg: 4 }),
    ];
    const pool = buildMasterStrengthPool(data, {
        userId: 'self',
        geniusAlphaCount: 40,
        quota: 1,
    });
    assert.equal(pool.injected, true);
    assert.equal(pool.sourceCount, 1);
    assert.equal(pool.poolCount, 2);
});

test('near-Master user is in the full pool even if outside Master quota', () => {
    const data = [
        consultant({ user: 'elite-1', alphaCount: 140, pyramidCount: 35, operatorCount: 90, fieldCount: 70, maxSimulationStreak: 400, operatorAvg: 2, fieldAvg: 1 }),
        consultant({ user: 'self', alphaCount: 126, pyramidCount: 28, operatorCount: 15, fieldCount: 8, maxSimulationStreak: 10, operatorAvg: 10, fieldAvg: 4 }),
    ];
    const pool = buildMasterStrengthPool(data, {
        userId: 'self',
        geniusAlphaCount: 40,
        quota: 1,
    });
    assert.equal(pool.injected, false);
    assert.equal(pool.inQuota, false);
    assert.equal(pool.poolCount, 2);
    assert.equal(pool.userRank, 2);
});

test('applySixDimRanks rewards high counts and low averages', () => {
    const ranked = applySixDimRanks([
        consultant({ user: 'a', operatorCount: 10, fieldCount: 10, communityActivity: 1, completedReferrals: 0, maxSimulationStreak: 1, operatorAvg: 10, fieldAvg: 5 }),
        consultant({ user: 'b', operatorCount: 80, fieldCount: 80, communityActivity: 80, completedReferrals: 5, maxSimulationStreak: 80, operatorAvg: 3, fieldAvg: 1 }),
    ]);
    const byUser = Object.fromEntries(ranked.map((item) => [item.user, item]));
    assert.ok(byUser.b.totalRank < byUser.a.totalRank);
});
