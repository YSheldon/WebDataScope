(function (global) {
    const HIGHER_BETTER = ['operatorCount', 'fieldCount', 'communityActivity', 'completedReferrals', 'maxSimulationStreak'];
    const LOWER_BETTER = ['operatorAvg', 'fieldAvg'];
    const RANK_COLS = [...HIGHER_BETTER, ...LOWER_BETTER];
    const MASTER_NEAR_RATIO = 0.8;
    const DEFAULT_MASTER_CRITERIA = {
        alphaCount: 120,
        pyramidCount: 30,
        combinedAlphaPerformance: 1,
        combinedSelectedAlphaPerformance: 1,
        combinedPowerPoolAlphaPerformance: 1,
        combinedOsmosisPerformance: 1,
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

    function nearMasterThresholds(masterCriteria, ratio = MASTER_NEAR_RATIO) {
        const criteria = masterCriteria || DEFAULT_MASTER_CRITERIA;
        return {
            alphaCount: Math.round(criteria.alphaCount * ratio),
            pyramidCount: Math.round(criteria.pyramidCount * ratio),
        };
    }

    // 已过 Master 门槛,或信号/塔达到门槛的 80%(差不多能进)。不要求 Combined。
    function isMasterContender(item, masterCriteria, geniusCombineTag, ratio = MASTER_NEAR_RATIO) {
        if (meetsLevelCriteria(item, masterCriteria || DEFAULT_MASTER_CRITERIA, geniusCombineTag)) return true;
        const near = nearMasterThresholds(masterCriteria, ratio);
        return (item.alphaCount || 0) >= near.alphaCount && (item.pyramidCount || 0) >= near.pyramidCount;
    }

    function collectRankFields(row) {
        const out = {};
        RANK_COLS.forEach((col) => {
            out[`${col}Rank`] = row[`${col}Rank`];
        });
        out.totalRank = row.totalRank;
        return out;
    }

    // 实力池: 全取「已过 Master 门槛 + 差不多能进(信号/塔 ≥80%)」的人,按六维在整池里排名。
    // 比 Expert Universe 更窄,比官方 Master Universe 更宽(差几座塔的人也会进)。
    function buildMasterStrengthPool(data, options = {}) {
        const list = Array.isArray(data) ? data : [];
        const userId = options.userId;
        const geniusCombineTag = options.geniusCombineTag === true;
        const geniusAlphaCount = Number(options.geniusAlphaCount || 40);
        const masterCriteria = options.masterCriteria || DEFAULT_MASTER_CRITERIA;
        const nearRatio = Number(options.nearRatio || MASTER_NEAR_RATIO);
        const baseCount = list.filter((item) => (item.alphaCount || 0) >= geniusAlphaCount).length;
        const quota = Number.isFinite(options.quota) && options.quota > 0
            ? options.quota
            : Math.max(1, getMasterQuota(baseCount));
        const near = nearMasterThresholds(masterCriteria, nearRatio);

        let candidates = list.filter((item) => isMasterContender(item, masterCriteria, geniusCombineTag, nearRatio));
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
            near,
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
        MASTER_NEAR_RATIO,
        DEFAULT_MASTER_CRITERIA,
        applySixDimRanks,
        meetsLevelCriteria,
        isMasterContender,
        nearMasterThresholds,
        getMasterQuota,
        collectRankFields,
        buildMasterStrengthPool,
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);
