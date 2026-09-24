(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.WQPClientQuery = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const CLIENT_FIELDS = [
        'is.failedNumRA',
        'failedNumRA',
        'is.failedNumPPA',
        'failedNumPPA',
        'is.WQPPYS',
        'WQPPYS',
        'maxSelfCorr',
        'maxPoolProdCorr',
        'maxProdCorr',
    ];
    const FIELD_CANONICAL = {
        failedNumRA: 'is.failedNumRA',
        failedNumPPA: 'is.failedNumPPA',
        WQPPYS: 'is.WQPPYS',
    };
    const SERVER_REWRITES = {
        operatorCount: 'regular.operatorCount',
    };
    const OPS = ['<=', '>=', '!=', '<', '>', '='];

    function valueOf(row, field) {
        if (!row) return undefined;
        const canonical = FIELD_CANONICAL[field] || field;
        if (canonical === 'is.failedNumRA') return Number(row.is?.failedNumRA ?? 0);
        if (canonical === 'is.failedNumPPA') return Number(row.is?.failedNumPPA ?? 0);
        if (canonical === 'is.WQPPYS') return String(row.is?.WQPPYS ?? '');
        return row[field];
    }

    function numericOf(value) {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        const match = String(value ?? '').match(/-?\d+(?:\.\d+)?/);
        return match ? Number(match[0]) : NaN;
    }

    function compare(op, actual, raw) {
        const left = numericOf(actual);
        const right = Number(raw);
        if (Number.isFinite(left) && Number.isFinite(right)) {
            if (op === '<') return left < right;
            if (op === '>') return left > right;
            if (op === '<=') return left <= right;
            if (op === '>=') return left >= right;
            if (op === '=') return left === right;
            if (op === '!=') return left !== right;
        }
        const text = String(actual ?? '');
        const expect = String(raw ?? '');
        if (op === '=') return text === expect;
        if (op === '!=') return text !== expect;
        return text.includes(expect);
    }

    function rewriteServerFilter(token) {
        const fields = Object.keys(SERVER_REWRITES).sort((a, b) => b.length - a.length);
        for (const field of fields) {
            if (!token.startsWith(field)) continue;
            const rest = token.slice(field.length);
            if (OPS.some((op) => rest.startsWith(op))) return `${SERVER_REWRITES[field]}${rest}`;
        }
        return null;
    }

    function ensureOption(node, key, spec) {
        if (!node || typeof node !== 'object') return;
        node.children = node.children && typeof node.children === 'object' ? node.children : {};
        if (!node.children[key]) node.children[key] = spec;
    }

    // 筛选框会先对照 OPTIONS 字段表校验。虚拟列不在官方表里时，
    // 页面直接报 "The filter failedNumPPA is invalid"，请求根本发不出去。
    function injectAlphaOptions(root, seen = new Set()) {
        if (!root || typeof root !== 'object' || seen.has(root)) return root;
        seen.add(root);
        if (root.is && typeof root.is === 'object') {
            ensureOption(root.is, 'failedNumRA', { type: 'integer', required: false, readOnly: true });
            ensureOption(root.is, 'failedNumPPA', { type: 'integer', required: false, readOnly: true });
            ensureOption(root.is, 'WQPPYS', { type: 'string', required: false, readOnly: true });
        }
        if (root.regular && typeof root.regular === 'object') {
            ensureOption(root.regular, 'operatorCount', { type: 'integer', required: false, readOnly: true });
        }
        for (const key of ['maxProdCorr', 'maxPoolProdCorr', 'maxSelfCorr']) {
            if (root.is && !root[key]) root[key] = { type: 'string', required: false, readOnly: true };
        }
        const values = Array.isArray(root) ? root : Object.values(root);
        values.forEach((value) => {
            if (value && typeof value === 'object') injectAlphaOptions(value, seen);
        });
        return root;
    }

    function matchClientFilter(token) {
        const fields = CLIENT_FIELDS.slice().sort((a, b) => b.length - a.length);
        for (const field of fields) {
            if (!token.startsWith(field)) continue;
            const rest = token.slice(field.length);
            for (const op of OPS) {
                if (rest.startsWith(op)) {
                    return { field: FIELD_CANONICAL[field] || field, op, value: rest.slice(op.length) };
                }
            }
        }
        return null;
    }

    function parseAlphasListUrl(rawUrl) {
        let url;
        try {
            url = new URL(rawUrl, 'https://api.worldquantbrain.com');
        } catch (_) {
            return null;
        }
        if (!/\/users\/[^/]+\/alphas$/.test(url.pathname)) return null;
        const parts = url.search.replace(/^\?/, '').split('&').filter(Boolean);
        let limit = 10;
        let offset = 0;
        let clientOrder = null;
        const clientFilters = [];
        const serverParts = [];
        for (const part of parts) {
            const decoded = decodeURIComponent(part.replace(/\+/g, ' '));
            if (decoded.startsWith('limit=')) {
                limit = Number(decoded.slice(6)) || 10;
                continue;
            }
            if (decoded.startsWith('offset=')) {
                offset = Number(decoded.slice(7)) || 0;
                continue;
            }
            if (decoded.startsWith('order=')) {
                const order = decoded.slice(6);
                const field = order.startsWith('-') ? order.slice(1) : order;
                if (CLIENT_FIELDS.includes(field)) {
                    clientOrder = { field: FIELD_CANONICAL[field] || field, desc: order.startsWith('-') };
                    continue;
                }
                if (SERVER_REWRITES[field]) {
                    const prefix = order.startsWith('-') ? '-' : '';
                    serverParts.push(`order=${prefix}${SERVER_REWRITES[field]}`);
                    continue;
                }
                serverParts.push(part);
                continue;
            }
            const rewritten = rewriteServerFilter(decoded);
            if (rewritten) {
                serverParts.push(rewritten);
                continue;
            }
            const filter = matchClientFilter(decoded);
            if (filter) {
                clientFilters.push(filter);
                continue;
            }
            serverParts.push(part);
        }
        const serverUrl = `${url.origin}${url.pathname}${serverParts.length ? `?${serverParts.join('&')}` : ''}`;
        return {
            limit,
            offset,
            clientOrder,
            clientFilters,
            serverUrl,
            active: Boolean(clientOrder || clientFilters.length),
        };
    }

    function applyClientQuery(rows, parsed) {
        let out = Array.isArray(rows) ? rows.slice() : [];
        for (const filter of parsed.clientFilters || []) {
            out = out.filter((row) => compare(filter.op, valueOf(row, filter.field), filter.value));
        }
        if (parsed.clientOrder) {
            const { field, desc } = parsed.clientOrder;
            out.sort((a, b) => {
                const av = valueOf(a, field);
                const bv = valueOf(b, field);
                const an = numericOf(av);
                const bn = numericOf(bv);
                const cmp = Number.isFinite(an) && Number.isFinite(bn)
                    ? an - bn
                    : String(av ?? '').localeCompare(String(bv ?? ''));
                return desc ? -cmp : cmp;
            });
        }
        return out;
    }

    function pageResult(rows, parsed) {
        const start = Math.max(0, parsed.offset || 0);
        const size = Math.max(1, parsed.limit || 10);
        return {
            count: rows.length,
            results: rows.slice(start, start + size),
        };
    }

    return {
        CLIENT_FIELDS,
        injectAlphaOptions,
        rewriteServerFilter,
        valueOf,
        compare,
        matchClientFilter,
        parseAlphasListUrl,
        applyClientQuery,
        pageResult,
    };
});
