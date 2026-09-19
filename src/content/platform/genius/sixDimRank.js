(function (global) {
    const HIGHER_BETTER = ['operatorCount', 'fieldCount', 'communityActivity', 'completedReferrals', 'maxSimulationStreak'];
    const LOWER_BETTER = ['operatorAvg', 'fieldAvg'];
    const RANK_COLS = [...HIGHER_BETTER, ...LOWER_BETTER];
    const DEFAULT_MASTER_CRITERIA = {
        alphaCount: 120,
        pyramidCount: 30,
        combinedAlphaPerformance: 1,
        combinedSelectedAlphaPerformance: 1,
        combinedPowerPoolAlphaPerformance: 1,
        combinedOsmosisPerformance: 1,
    };
    const DEFAULT_EXPERT_CRITERIA = {
        alphaCount: 20,
        pyramidCount: 10,
        combinedAlphaPerformance: 0.5,
        combinedSelectedAlphaPerformance: 0.5,
        combinedPowerPoolAlphaPerformance: 0.5,
        combinedOsmosisPerformance: 0.5,
    };

    function applySixDimRanks(items) {
        const itemData = (items || []).map((item) => ({ ...item, totalRank: 0 }));
        HIGHER_BETTER.forEach((col) => {
            const sorted = itemData.map((item) => item[col]).sort((a, b) => b - a);
            itemData.forEach((item) => {
                item[`${col}Rank`] = sorted.indexOf(item[col]) + 1;
                item.totalRank += item[`${col}Rank`];
            });
        });
        LOWER_BETTER.forEach((col) => {
            const sorted = itemData.map((item) => item[col]).sort((a, b) => a - b);
            itemData.forEach((item) => {
                item[`${col}Rank`] = sorted.indexOf(item[col]) + 1;
                item.totalRank += item[`${col}Rank`];
            });
        });
        return itemData;
    }

    function meetsLevelCriteria(item, criteria, geniusCombineTag) {
        if (!item || !criteria) return false;
        if ((item.alphaCount || 0) < criteria.alphaCount) return false;
        if ((item.pyramidCount || 0) < criteria.pyramidCount) return false;
        if (!geniusCombineTag) return true;
        return (
            (item.combinedAlphaPerformance || 0) >= criteria.combinedAlphaPerformance
            || (item.combinedSelectedAlphaPerformance || 0) >= criteria.combinedSelectedAlphaPerformance
            || (item.combinedPowerPoolAlphaPerformance || 0) >= criteria.combinedPowerPoolAlphaPerformance
            || (item.combinedOsmosisPerformance || 0) >= criteria.combinedOsmosisPerformance
        );
    }

    function getMasterQuota(baseCount) {
        return Math.min(250, Math.round(Number(baseCount || 0) * 0.08));
    }

    function collectRankFields(row) {
        const out = {};
        RANK_COLS.forEach((col) => {
            out[`${col}Rank`] = row[`${col}Rank`];
        });
        out.totalRank = row.totalRank;
        return out;
    }

    // 实力池: 已过 Master 门槛的人全收(哪怕六维弱),
    // 再从其余 Expert 资格人群里按六维总评取前 quota 名挑战者。
    // 池大小 = 已过门槛人数 + quota(名额)。在整池内按六维排名,名额只作对照线。
    function buildMasterStrengthPool(data, options = {}) {
        const list = Array.isArray(data) ? data : [];
        const userId = options.userId;
        const geniusCombineTag = options.geniusCombineTag === true;
        const geniusAlphaCount = Number(options.geniusAlphaCount || 40);
        const masterCriteria = options.masterCriteria || DEFAULT_MASTER_CRITERIA;
        const expertCriteria = options.expertCriteria || DEFAULT_EXPERT_CRITERIA;
        const baseCount = list.filter((item) => (item.alphaCount || 0) >= geniusAlphaCount).length;
        const quota = Number.isFinite(options.quota) && options.quota > 0
            ? options.quota
            : Math.max(1, getMasterQuota(baseCount));

        const qualified = list.filter((item) => meetsLevelCriteria(item, masterCriteria, geniusCombineTag));
        const qualifiedUsers = new Set(qualified.map((item) => item.user));
        const challengersPool = list.filter((item) => !qualifiedUsers.has(item.user)
            && meetsLevelCriteria(item, expertCriteria, geniusCombineTag));
        const topChallengers = applySixDimRanks(challengersPool)
            .sort((a, b) => a.totalRank - b.totalRank)
            .slice(0, quota)
            .map((item) => ({ ...item }));

        const candidates = [...qualified.map((item) => ({ ...item })), ...topChallengers];
        const sourceCount = candidates.length;
        const userAlreadyIn = Boolean(userId && candidates.some((item) => item.user === userId));
        if (userId && !userAlreadyIn) {
            const user = list.find((item) => item.user === userId);
            if (user) candidates.push({ ...user });
        }

        const poolRanked = applySixDimRanks(candidates);
        const userRow = userId ? poolRanked.find((item) => item.user === userId) : null;
        const userRank = userRow
            ? poolRanked.filter((item) => item.totalRank < userRow.totalRank).length + 1
            : null;

        return {
            quota,
            baseCount,
            qualifiedCount: qualified.length,
            challengerCount: topChallengers.length,
            sourceCount,
            poolCount: poolRanked.length,
            inQuota: userRank != null && userRank <= quota,
            injected: Boolean(userId && !userAlreadyIn && userRow),
            userRank,
            userData: userRow || null,
            ranks: userRow ? collectRankFields(userRow) : null,
            pool: poolRanked,
        };
    }

    global.WQPSixDimRank = {
        HIGHER_BETTER,
        LOWER_BETTER,
        RANK_COLS,
        DEFAULT_MASTER_CRITERIA,
        applySixDimRanks,
        meetsLevelCriteria,
        getMasterQuota,
        collectRankFields,
        buildMasterStrengthPool,
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
