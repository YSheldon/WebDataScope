// fieldUsageFlag.js: 数据字段列表/详情页直接显示字段本季使用状态,不再需要双击查询
console.log('fieldUsageFlag.js loaded');

const FIELD_USAGE_STATE = {
    alphasPromise: null,
    usageByField: new Map(), // fieldId -> { count, alphaIds: [] }
    flaggedRows: new WeakSet(),
    currentDetailField: '',
};

function getUsageAlphas() {
    if (!FIELD_USAGE_STATE.alphasPromise) {
        FIELD_USAGE_STATE.alphasPromise = getSubmittedFields().catch((error) => {
            console.error('[WQP] 已提交 Alpha 加载失败,字段使用标记跳过:', error);
            FIELD_USAGE_STATE.alphasPromise = null;
            return [];
        });
    }
    return FIELD_USAGE_STATE.alphasPromise;
}

async function usageOf(fieldId) {
    if (FIELD_USAGE_STATE.usageByField.has(fieldId)) {
        return FIELD_USAGE_STATE.usageByField.get(fieldId);
    }
    const alphas = await getUsageAlphas();
    const alphaIds = [];
    for (const alpha of alphas) {
        const code = alpha?.regular?.code || '';
        if (code && code.includes(fieldId)) alphaIds.push(alpha.id);
    }
    const usage = { count: alphaIds.length, alphaIds };
    FIELD_USAGE_STATE.usageByField.set(fieldId, usage);
    return usage;
}

function usageBadge(fieldId, usage) {
    const badge = document.createElement('span');
    if (!usage.count) {
        badge.textContent = '新';
        badge.title = `${fieldId}\n本赛季提交中未使用(新字段)`;
        badge.style.cssText = [
            'display:inline-block', 'margin-left:6px', 'padding:0 6px',
            'border-radius:6px', 'background-color:#2e7d32', 'color:#fff',
            'font-size:12px', 'font-weight:600', 'line-height:1.6',
            'vertical-align:middle',
        ].join(';');
    } else {
        badge.textContent = `已用${usage.count}`;
        const ids = usage.alphaIds.slice(0, 8).join(', ');
        const more = usage.alphaIds.length > 8 ? `\n...共 ${usage.alphaIds.length} 支` : '';
        badge.title = `${fieldId}\n本赛季提交已使用: ${ids}${more}`;
        badge.style.cssText = [
            'display:inline-block', 'margin-left:6px', 'padding:0 6px',
            'border-radius:6px', 'background-color:#9e9e9e', 'color:#fff',
            'font-size:12px', 'font-weight:600', 'line-height:1.6',
            'vertical-align:middle',
        ].join(';');
    }
    badge.className = 'wq-field-usage-badge';
    return badge;
}

async function flagRow(row) {
    if (FIELD_USAGE_STATE.flaggedRows.has(row)) return;
    const link = row.querySelector('a.link[href*="data-fields"]');
    if (!link?.href) return;
    const parts = link.href.split('/').filter(Boolean);
    const fieldId = parts[parts.length - 1];
    if (!fieldId) return;
    FIELD_USAGE_STATE.flaggedRows.add(row);

    const usage = await usageOf(fieldId);
    if (!link.isConnected) return; // 行已被替换/移除
    link.querySelector('.wq-field-usage-badge')?.remove();
    link.appendChild(usageBadge(fieldId, usage));
}

function flagVisibleRows() {
    const rows = document.querySelectorAll('.rt-tr-group');
    rows.forEach((row) => {
        if (row.querySelector('a.link[href*="data-fields"]')) {
            flagRow(row);
        }
    });
}

let detailTimer = null;
function getFieldIdFromUrl() {
    const match = location.href.match(/data-fields\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : '';
}

function renderDetailBanner(fieldId, usage) {
    document.getElementById('wqp-field-usage-banner')?.remove();
    const banner = document.createElement('div');
    banner.id = 'wqp-field-usage-banner';
    if (!usage.count) {
        banner.style.cssText = 'padding:8px 14px; margin:6px 0; border-radius:8px; background:#e8f5e9; color:#1b5e20; font-size:13px; font-weight:600;';
        banner.textContent = `🆕 新字段: ${fieldId} 本赛季提交中未使用`;
    } else {
        const links = usage.alphaIds.slice(0, 6)
            .map((id) => `<a href="https://platform.worldquantbrain.com/alpha/${id}" target="_blank" rel="noopener noreferrer" style="color:#1565c0; text-decoration:none;">${id}</a>`)
            .join(', ');
        const more = usage.alphaIds.length > 6 ? ` 等 ${usage.alphaIds.length} 支` : '';
        banner.style.cssText = 'padding:8px 14px; margin:6px 0; border-radius:8px; background:#eceff1; color:#37474f; font-size:13px;';
        banner.innerHTML = `字段 <b>${fieldId}</b> 本赛季已用于提交(${usage.count} 支): ${links}${more}`;
    }
    const main = document.querySelector('main') || document.body;
    main.prepend(banner);
}

async function updateDetailBanner() {
    const fieldId = getFieldIdFromUrl();
    if (!fieldId) return;
    if (fieldId === FIELD_USAGE_STATE.currentDetailField) {
        if (!document.getElementById('wqp-field-usage-banner') && FIELD_USAGE_STATE.usageByField.has(fieldId)) {
            renderDetailBanner(fieldId, FIELD_USAGE_STATE.usageByField.get(fieldId));
        }
        return;
    }
    FIELD_USAGE_STATE.currentDetailField = fieldId;
    const usage = await usageOf(fieldId);
    if (getFieldIdFromUrl() !== fieldId) return; // url changed while loading
    renderDetailBanner(fieldId, usage);
}

let observeTimer = null;
function scheduleFlag() {
    if (observeTimer) return;
    observeTimer = setTimeout(() => {
        observeTimer = null;
        flagVisibleRows();
        updateDetailBanner();
    }, 300);
}

new MutationObserver(scheduleFlag).observe(document.body, { childList: true, subtree: true });
setInterval(scheduleFlag, 1500);
scheduleFlag();
