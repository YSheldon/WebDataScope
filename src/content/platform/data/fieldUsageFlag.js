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
        updateAlphaFieldStrip();
    }, 300);
}

// ---------- Alpha 详情页: 表达式字段直接标注 新/已用 ----------

const ALPHA_STRIP_STATE = { alphaId: '', tokenCache: new Map() };
const ALPHA_STOPWORDS = new Set(['true', 'false', 'nan', 'and', 'or', 'not', 'if', 'else']);

function getAlphaIdFromUrl() {
    const match = location.href.match(/\/alpha\/([^/?#]+)/);
    const id = match ? decodeURIComponent(match[1]) : '';
    return id && !['unsubmitted', 'submitted', 'distribution'].includes(id.toLowerCase()) ? id : '';
}

async function fetchAlphaExpression(alphaId) {
    for (const url of [
        `https://api.worldquantbrain.com/users/self/alphas/${alphaId}`,
        `https://api.worldquantbrain.com/alphas/${alphaId}`,
    ]) {
        try {
            const response = await fetch(url, { credentials: 'include' });
            if (!response.ok) continue;
            const data = await response.json();
            const code = data?.regular?.code
                || [data?.combo?.code, data?.selection?.code].filter(Boolean).join('\n');
            if (code) return code;
        } catch (_) { /* try next */ }
    }
    return '';
}

function extractFieldTokens(code) {
    const tokens = new Set();
    // 不带括号的标识符 = 变量(字段);带括号的是函数调用(算子)
    for (const match of code.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\b(?!\s*\()/g)) {
        const token = match[1];
        if (token.length < 2 || ALPHA_STOPWORDS.has(token.toLowerCase())) continue;
        tokens.add(token);
        if (tokens.size >= 24) break;
    }
    return [...tokens];
}

async function verifyFieldToken(token) {
    if (ALPHA_STRIP_STATE.tokenCache.has(token)) {
        return ALPHA_STRIP_STATE.tokenCache.get(token);
    }
    let isField = false;
    try {
        const response = await fetch(`https://api.worldquantbrain.com/data-fields/${encodeURIComponent(token)}`, {
            credentials: 'include',
        });
        isField = response.ok;
    } catch (_) {
        isField = false;
    }
    ALPHA_STRIP_STATE.tokenCache.set(token, isField);
    return isField;
}

function alphaStripChip(token, usage) {
    const chip = document.createElement('span');
    chip.style.cssText = 'display:inline-flex; align-items:center; gap:4px; padding:2px 8px; border-radius:10px; border:1px solid #d0d7de; background:#fff; font-size:12px;';
    const name = document.createElement('span');
    name.textContent = token;
    name.style.cssText = 'font-weight:600; color:#24292f;';
    chip.appendChild(name);
    chip.appendChild(usageBadge(token, usage));
    return chip;
}

const RESERVED_IDS = new Set(['unsubmitted', 'submitted', 'distribution']);

function alphaIdFromHref(href) {
    const match = String(href || '').match(/\/alpha\/([^/?#]+)/);
    const id = match ? decodeURIComponent(match[1]) : '';
    return id && !RESERVED_IDS.has(id.toLowerCase()) ? id : '';
}

function findAlphaIdInNode(node) {
    const link = node.querySelector('a[href*="/alpha/"]');
    const fromLink = alphaIdFromHref(link?.href);
    if (fromLink) return fromLink;
    const match = (node.innerText || '').match(/Alpha ID\s*[:：]?\s*([A-Za-z0-9]{5,12})/i);
    if (match && !RESERVED_IDS.has(match[1].toLowerCase())) return match[1];
    return '';
}

function resolveAlphaContexts() {
    const contexts = [];
    const urlId = getAlphaIdFromUrl();
    if (urlId) {
        contexts.push({
            alphaId: urlId,
            editor: document.querySelector('.monaco-editor'),
            dialog: null,
        });
        return contexts;
    }
    const dialogs = [...document.querySelectorAll('.ui.modal, [role="dialog"], .modal')]
        .filter((dialog) => dialog.getClientRects().length > 0);
    for (const dialog of dialogs) {
        const alphaId = findAlphaIdInNode(dialog);
        if (alphaId) {
            contexts.push({ alphaId, editor: dialog.querySelector('.monaco-editor'), dialog });
        }
    }
    return contexts;
}

function stripHostNodeId(alphaId) {
    return `wqp-alpha-field-strip-${alphaId}`;
}

let stripBuilding = '';

async function buildChipsForCode(code) {
    const chips = document.createElement('span');
    chips.className = 'wqp-alpha-chips';
    chips.style.cssText = 'display:inline-flex; flex-wrap:wrap; gap:6px; align-items:center;';
    const tokens = extractFieldTokens(code || '');
    let newCount = 0;
    let usedCount = 0;
    for (const token of tokens) {
        const isField = await verifyFieldToken(token);
        if (!isField) continue;
        const usage = await usageOf(token);
        if (usage.count) usedCount += 1; else newCount += 1;
        chips.appendChild(alphaStripChip(token, usage));
    }
    if (!chips.childElementCount) {
        chips.innerHTML = '<span style="color:#57606a;">未识别到数据字段</span>';
    } else {
        const summary = document.createElement('span');
        summary.style.cssText = 'margin-left:4px; color:#57606a;';
        summary.textContent = `— 共 ${newCount + usedCount} 个字段: 新 ${newCount} / 已用 ${usedCount}`;
        chips.appendChild(summary);
    }
    return chips;
}

// 路径 A: /alpha/{id} 整页,表达式是 Monaco 编辑器
async function updateUrlPageStrip(urlId) {
    const editor = document.querySelector('.monaco-editor');
    if (!editor) return;
    let strip = document.getElementById('wqp-alpha-field-strip-page');
    if (strip?.dataset.alpha === urlId && strip.querySelector('.wqp-alpha-chips')) return;
    if (!strip) {
        strip = document.createElement('div');
        strip.id = 'wqp-alpha-field-strip-page';
        strip.style.cssText = 'display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin:4px 0; padding:6px 8px; border:1px solid #d0d7de; border-radius:8px; background:#f6f8fa; font-size:12px;';
        strip.innerHTML = `<b style="color:#57606a;">字段使用 (${urlId}):</b> <span class="wqp-strip-status">分析中...</span>`;
        const anchor = editor.closest('div[class*="container"], section, div') || editor;
        anchor.parentNode.insertBefore(strip, anchor);
        console.log('[WQP] 字段使用条已挂载(monaco):', urlId);
    }
    strip.dataset.alpha = urlId;
    strip.querySelectorAll('.wqp-alpha-chips').forEach((chip) => chip.remove());
    const code = await fetchAlphaExpression(urlId);
    if (getAlphaIdFromUrl() !== urlId) return;
    strip.querySelector('.wqp-strip-status')?.remove();
    strip.appendChild(await buildChipsForCode(code));
}

// 路径 B: 列表详情/任何带 Code 标题的代码块,直接读 DOM 表达式,不需要 alpha id
function findCodeBlocks() {
    const boxes = [];
    const deadHeadings = [];
    for (const heading of document.querySelectorAll('h1,h2,h3,h4,h5,div,span,b')) {
        if (heading.textContent.trim() !== 'Code') continue;
        let node = heading.parentElement;
        let found = null;
        for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
            found = findExprBoxUnder(node);
            if (found) break;
        }
        if (found) {
            boxes.push(found);
        } else {
            deadHeadings.push(heading);
        }
    }
    // 诊断: 找到 Code 标题但没定位到代码块时,给出可见提示而不是无声失败
    for (const heading of deadHeadings) {
        if (heading.parentElement?.querySelector(':scope > .wqp-usage-miss')) continue;
        const miss = document.createElement('div');
        miss.className = 'wqp-usage-miss';
        miss.style.cssText = 'font-size:11px; color:#9e9e9e;';
        miss.textContent = 'WQP: 已发现 Code 标题但未定位到代码块';
        heading.parentElement?.appendChild(miss);
        console.warn('[WQP] Code 标题下未找到代码块', heading);
    }
    return [...new Set(boxes)];
}

function findExprBoxUnder(node) {
    const candidates = node.querySelectorAll('pre, code, [class*="code" i], [class*="expression" i], .view-lines');
    for (const candidate of candidates) {
        if (candidate.closest('.monaco-editor')) continue;
        const text = (candidate.innerText || '').trim();
        if (text.length >= 8 && text.includes('(') && /[A-Za-z_]/.test(text)) return candidate;
    }
    return null;
}

function expressionFromBox(box) {
    return (box.innerText || '')
        .split('\n')
        .map((line) => line.replace(/^\s*\d+\s*\|?\s*/, ''))
        .join('\n')
        .trim();
}

const codeBlockStrips = new WeakMap();

async function updateCodeBlockStrips() {
    for (const box of findCodeBlocks()) {
        const code = expressionFromBox(box);
        if (!code) continue;
        let strip = codeBlockStrips.get(box);
        if (strip) {
            if (strip.dataset.code === code) continue;
            strip.remove();
        }
        strip = document.createElement('div');
        strip.className = 'wqp-code-strip';
        strip._box = box;
        strip.dataset.code = code;
        strip.style.cssText = 'display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin:4px 0; padding:6px 8px; border:1px solid #d0d7de; border-radius:8px; background:#f6f8fa; font-size:12px;';
        strip.innerHTML = '<b style="color:#57606a;">字段使用:</b> <span class="wqp-strip-status">分析中...</span>';
        box.parentNode.insertBefore(strip, box.nextSibling);
        console.log('[WQP] 字段使用条已挂载(代码块):', code.slice(0, 60));
        const chips = await buildChipsForCode(code);
        strip.querySelector('.wqp-strip-status')?.remove();
        if (strip.isConnected) strip.appendChild(chips);
        codeBlockStrips.set(box, strip);
    }
    // 清理代码块已被移除的孤儿条
    document.querySelectorAll('.wqp-code-strip').forEach((strip) => {
        if (!strip._box || !strip._box.isConnected) strip.remove();
    });
}

async function updateAlphaFieldStrip() {
    const urlId = getAlphaIdFromUrl();
    if (urlId && document.querySelector('.monaco-editor')) {
        await updateUrlPageStrip(urlId);
        return;
    }
    await updateCodeBlockStrips();
}

new MutationObserver(scheduleFlag).observe(document.body, { childList: true, subtree: true });
setInterval(scheduleFlag, 1500);
scheduleFlag();
