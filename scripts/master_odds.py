"""Precise Master-seat calculation for SY86571 from the WQP_RankData snapshot.

Official rules (user-provided, 2026-09):
- Master base: alphaCount>=120, pyramidCount>=30, any combined>=1
- GM base: alphaCount>=220, pyramidCount>=60, any combined>=2
- Tiebreaker = sum of ranks:
    avg distinct ops/alpha   (lower better)   ts_backfill/group_backfill excluded (data already excludes)
    avg distinct fields/alpha(lower better)
    total distinct ops       (higher better)
    total distinct fields    (higher better)
    max simulation streak    (higher better)
    community = forum likes + successful referrals (higher better)
- Seats: Master min(250, 8%*base), GM min(75, 2%*base). A GM winner occupies a GM seat,
  freeing a Master seat (each consultant lands in exactly one level).
"""
import json
import glob
import os
import sys

HERE = os.path.dirname(__file__)
USER = 'SY86571'
COMBINED = ['combinedAlphaPerformance', 'combinedSelectedAlphaPerformance',
            'combinedPowerPoolAlphaPerformance', 'combinedOsmosisPerformance']


def best_combined(item, level):
    need = 1 if level == 'master' else 2
    return any((item.get(k) or 0) >= need for k in COMBINED)


def master_ok(i):
    return i.get('alphaCount', 0) >= 120 and i.get('pyramidCount', 0) >= 30 and best_combined(i, 'master')


def gm_ok(i):
    return i.get('alphaCount', 0) >= 220 and i.get('pyramidCount', 0) >= 60 and best_combined(i, 'gm')


def community(i):
    return (i.get('communityActivity') or 0) + (i.get('completedReferrals') or 0)


METRICS = [
    ('operatorAvg', 'asc'),
    ('fieldAvg', 'asc'),
    ('operatorCount', 'desc'),
    ('fieldCount', 'desc'),
    ('maxSimulationStreak', 'desc'),
    ('community', 'desc'),  # forum likes + referrals, computed
]


def metric_value(item, key):
    if key == 'community':
        return community(item)
    return item.get(key)


def ranks_for(pool, key, direction):
    vals = sorted({metric_value(i, key) for i in pool}, reverse=(direction == 'desc'))
    order = {v: n + 1 for n, v in enumerate(vals)}  # dense rank, ties share
    return {id(i): order[metric_value(i, key)] for i in pool}


def sums_for(pool):
    out = {}
    detail = {}
    for i in pool:
        total = 0
        parts = {}
        for key, direction in METRICS:
            rank_map = ranks_for(pool, key, direction)
            r = rank_map[id(i)]
            parts[key] = r
            total += r
        out[id(i)] = total
        detail[id(i)] = parts
    return out, detail


def position(pool_sums, target_id):
    """1-based competition position with ties sharing the better rank."""
    t = pool_sums[target_id]
    ahead = sum(1 for v in pool_sums.values() if v < t)
    tied = sum(1 for v in pool_sums.values() if v == t)
    return ahead + 1, tied


def main():
    files = glob.glob(os.path.join(HERE, 'extracted', 'WQP_RankData*'))
    if not files:
        print('WQP_RankData not extracted'); sys.exit(1)
    data = json.load(open(files[0], encoding='utf-8'))
    arr = data.get('array') or data
    ts = data.get('timestamp') or data.get('savedTimestamp')
    print(f"snapshot: {ts}, consultants: {len(arr)}")

    user = next((i for i in arr if i.get('user') == USER), None)
    if not user:
        print('user not in snapshot'); sys.exit(1)

    base_count = sum(1 for i in arr if (i.get('alphaCount') or 0) >= 40)
    master_quota = min(250, round(base_count * 0.08))
    gm_quota = min(75, round(base_count * 0.02))
    print(f"base(>=40 alphas): {base_count}, master seats: {master_quota}, gm seats: {gm_quota}")

    master_pool = [i for i in arr if master_ok(i)]
    gm_pool = [i for i in arr if gm_ok(i)]
    print(f"master-eligible: {len(master_pool)}, gm-eligible: {len(gm_pool)}")

    m_sums, m_detail = sums_for(master_pool)
    g_sums, _ = sums_for(gm_pool)

    m_pos, m_tied = position(m_sums, id(user))
    print(f"\nuser six-dim sum (master pool): {m_sums[id(user)]} -> position {m_pos}, tied {m_tied}")
    print('  per-metric ranks:', m_detail[id(user)])

    gm_sorted = sorted(gm_pool, key=lambda i: (g_sums[id(i)], str(i.get('user'))))
    winners = gm_sorted[:gm_quota]
    winner_ids = {id(i) for i in winners}
    user_sum = m_sums[id(user)]
    winners_ahead = sum(1 for i in winners if m_sums[id(i)] < user_sum)
    gm_ahead = sum(1 for i in gm_pool if id(i) != id(user) and m_sums[id(i)] < user_sum)
    print(f"\ngm pool: {len(gm_pool)}, winners: {len(winners)}")
    print(f"  gm-eligible ahead of you in master ranks: {gm_ahead}")
    print(f"  of the {len(winners)} gm winners, ahead of you: {winners_ahead}")

    competitors = [i for i in master_pool if id(i) not in winner_ids]
    ahead_after = sum(1 for i in competitors if m_sums[id(i)] < user_sum)
    pos_after = ahead_after + 1
    print(f"\nmaster competitors after GM removal: {len(competitors)}")
    print(f"  people ahead of you: {ahead_after} -> your position {pos_after} / {master_quota} seats")

    boundary = sorted(m_sums.values())[master_quota - 1] if len(m_sums) >= master_quota else None
    tied_at_boundary = sum(1 for v in m_sums.values() if v == boundary) if boundary else 0
    print(f"  seat-boundary sum: {boundary} (tied {tied_at_boundary}); your sum {user_sum}")

    if pos_after <= master_quota:
        margin = master_quota - pos_after
        print(f"\nVERDICT: IN. you hold seat #{pos_after}, {margin} seats of margin")
    else:
        need = pos_after - master_quota
        print(f"\nVERDICT: OUT by {need} positions (need to overtake {need} people)")

    print('\n-- sensitivity: position if one metric improves --')
    for label, key, delta in [
        ('total_ops +5', 'operatorCount', +5),
        ('total_ops +15', 'operatorCount', +15),
        ('total_fields +15', 'fieldCount', +15),
        ('streak +50', 'maxSimulationStreak', +50),
        ('community +10', 'community', +10),
        ('community +36 (would top the pool)', 'community', +36),
        ('avg_ops -0.2', 'operatorAvg', -0.2),
        ('avg_fields -0.1', 'fieldAvg', -0.1),
    ]:
        bumped = dict(user)
        if key == 'community':
            bumped['communityActivity'] = (bumped.get('communityActivity') or 0) + delta
        else:
            bumped[key] = (bumped.get(key) or 0) + delta
        pool2 = [bumped if i.get('user') == USER else i for i in master_pool]
        s2, _ = sums_for(pool2)
        pos2, _ = position(s2, id(bumped))
        print(f"  {label}: position {m_pos} -> {pos2}")


if __name__ == '__main__':
    main()
