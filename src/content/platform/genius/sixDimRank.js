(function (global) {
    const HIGHER_BETTER = ['operatorCount', 'fieldCount', 'communityActivity', 'completedReferrals', 'maxSimulationStreak'];
    const LOWER_BETTER = ['operatorAvg', 'fieldAvg'];
    const RANK_COLS = [...HIGHER_BETTER, ...LOWER_BETTER];

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

    // 实力池: 全取 Expert 资格人群,按六维总评在整池里排名。
    // 名额只用来判断是否挤进 Master 座位,不截断池子。
    function buildMasterStrengthPool(data, options = {}) {
        const list = Array.isArray(data) ? data : [];
        const userId = options.userId;
        const geniusCombineTag = options.geniusCombineTag === true;
        const geniusAlphaCount = Number(options.geniusAlphaCount || 40);
        const expertCriteria = options.expertCriteria || {
            alphaCount: 20,
            pyramidCount: 10,
            combinedAlphaPerformance: 0.5,
            combinedSelectedAlphaPerformance: 0.5,
            combinedPowerPoolAlphaPerformance: 0.5,
            combinedOsmosisPerformance: 0.5,
        };
        const baseCount = list.filter((item) => (item.alphaCount || 0) >= geniusAlphaCount).length;
        const quota = Number.isFinite(options.quota) && options.quota > 0
            ? options.quota
            : Math.max(1, getMasterQuota(baseCount));

        let candidates = list.filter((item) => meetsLevelCriteria(item, expertCriteria, geniusCombineTag));
        if (!candidates.length) {
            candidates = list.filter((item) => (item.alphaCount || 0) >= geniusAlphaCount);
        }

        const pool = applySixDimRanks(candidates);
        const userAlreadyIn = Boolean(userId && pool.some((item) => item.user === userId));
        if (userId && !userAlreadyIn) {
            const user = list.find((item) => item.user === userId);
            if (user) pool.push({ ...user });
        }

        const poolRanked = applySixDimRanks(pool);
        const userRow = userId ? poolRanked.find((item) => item.user === userId) : null;
        const userRank = userRow
            ? poolRanked.filter((item) => item.totalRank < userRow.totalRank).length + 1
            : null;

        return {
            quota,
            baseCount,
            sourceCount: candidates.length,
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
        applySixDimRanks,
        meetsLevelCriteria,
        getMasterQuota,
        collectRankFields,
        buildMasterStrengthPool,
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
