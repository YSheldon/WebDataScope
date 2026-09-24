import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('../src/content/platform/genius/sixDimRank.js', import.meta.url), 'utf8');
const sandbox = { globalThis: {} };
vm.runInNewContext(`${code}\nthis.api = globalThis.WQPSixDimRank;`, sandbox);
const { applySixDimRanks, buildMasterStrengthPool, getMasterQuota, splitGmSeats } = sandbox.api;

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

test('pool = all qualified (even weak six-dim) + top-quota challengers by six-dim', () => {
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
            user: 'strong-challenger',
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
            user: 'mid-challenger',
            alphaCount: 100,
            pyramidCount: 26,
            operatorCount: 30,
            fieldCount: 20,
            communityActivity: 20,
            maxSimulationStreak: 50,
            operatorAvg: 7,
            fieldAvg: 3,
        }),
        consultant({
            user: 'far-challenger',
            alphaCount: 110,
            pyramidCount: 22,
            operatorCount: 15,
            fieldCount: 8,
            communityActivity: 0,
            maxSimulationStreak: 2,
            operatorAvg: 11,
            fieldAvg: 5,
        }),
        consultant({
            user: 'gold-high-sixdim',
            alphaCount: 5,
            pyramidCount: 2,
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
        quota: 2,
    });
    assert.equal(pool.qualifiedCount, 1);
    assert.equal(pool.challengerCount, 2);
    assert.equal(pool.sourceCount, 3);
    assert.equal(pool.poolCount, 3);
    const users = [...pool.pool].map((item) => item.user).sort();
    assert.deepEqual(users, ['mid-challenger', 'strong-challenger', 'weak-master']);
    // 六维弱的已过门槛者也在池内,但排最后
    const ordered = [...pool.pool].sort((a, b) => a.totalRank - b.totalRank).map((item) => item.user);
    assert.deepEqual(ordered, ['strong-challenger', 'mid-challenger', 'weak-master']);
});

test('non-qualified user outside top quota is injected for comparison', () => {
    const data = [
        consultant({ user: 'elite', alphaCount: 130, pyramidCount: 32, operatorCount: 90, fieldCount: 70, maxSimulationStreak: 400, operatorAvg: 2, fieldAvg: 1 }),
        consultant({ user: 'strong2', alphaCount: 60, pyramidCount: 18, operatorCount: 70, fieldCount: 50, maxSimulationStreak: 300, operatorAvg: 4, fieldAvg: 2 }),
        consultant({ user: 'self', alphaCount: 50, pyramidCount: 16, operatorCount: 15, fieldCount: 8, maxSimulationStreak: 10, operatorAvg: 10, fieldAvg: 4 }),
    ];
    const pool = buildMasterStrengthPool(data, {
        userId: 'self',
        geniusAlphaCount: 40,
        quota: 1,
    });
    assert.equal(pool.injected, true);
    assert.equal(pool.qualifiedCount, 1);
    assert.equal(pool.sourceCount, 2);
    assert.equal(pool.poolCount, 3);
    assert.equal(pool.userRank, 3);
    assert.equal(pool.inQuota, false);
});

test('qualified user is always in the pool even with weak six-dim', () => {
    const data = [
        consultant({ user: 'self', alphaCount: 130, pyramidCount: 32, operatorCount: 10, fieldCount: 5, maxSimulationStreak: 1, operatorAvg: 12, fieldAvg: 6 }),
        consultant({ user: 'other', alphaCount: 50, pyramidCount: 16, operatorCount: 80, fieldCount: 60, maxSimulationStreak: 400, operatorAvg: 3, fieldAvg: 1 }),
    ];
    const pool = buildMasterStrengthPool(data, {
        userId: 'self',
        geniusAlphaCount: 40,
        quota: 1,
    });
    assert.equal(pool.injected, false);
    assert.equal(pool.poolCount, 2);
    assert.equal(pool.userRank, 2);
});

test('only GM-eligible people ahead in the Master pool who also win a GM seat are removed', () => {
    const masterRanks = [
        { user: 'self', totalRank: 100 },
        { user: 'gm-ahead-wins', totalRank: 10 },
        { user: 'gm-ahead-loses', totalRank: 20 },
        { user: 'gm-behind', totalRank: 200 },
        { user: 'master-only', totalRank: 30 },
    ];
    const gmRanks = [
        { user: 'gm-ahead-wins', totalRank: 1 },
        { user: 'gm-ahead-loses', totalRank: 9 },
        { user: 'gm-behind', totalRank: 2 },
    ];
    const split = splitGmSeats({
        masterRanks,
        gmRanks,
        userId: 'self',
        gmQuota: 2,
        masterAhead: 3,
        masterQuota: 250,
    });
    assert.equal(split.gmCount, 3);
    assert.equal(split.gmAhead, 2);
    assert.equal(split.gmNotAhead, 1);
    assert.equal(split.winnersAhead, 1);
    assert.equal(split.adjustedAhead, 2);
    assert.equal(split.inSeat, true);
});

test('applySixDimRanks rewards high counts and low averages', () => {
    const ranked = applySixDimRanks([
        consultant({ user: 'a', operatorCount: 10, fieldCount: 10, communityActivity: 1, completedReferrals: 0, maxSimulationStreak: 1, operatorAvg: 10, fieldAvg: 5 }),
        consultant({ user: 'b', operatorCount: 80, fieldCount: 80, communityActivity: 80, completedReferrals: 5, maxSimulationStreak: 80, operatorAvg: 3, fieldAvg: 1 }),
    ]);
    const byUser = Object.fromEntries(ranked.map((item) => [item.user, item]));
    assert.ok(byUser.b.totalRank < byUser.a.totalRank);
});
