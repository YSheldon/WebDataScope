// fieldUsageFlag.js: 数据字段列表/详情页直接显示字段本季使用状态,不再需要双击查询
console.log('[WQP] fieldUsageFlag v1.10.4 loaded');

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

// ---------- 数据字段列表行打标 ----------

async function flagRow(row) {
    if (FIELD_USAGE_STATE.flaggedRows.has(row)) return;
    const link = row.querySelector('a.link[href*="data-fields"]');
    if (!link?.href) return;
    const parts = link.href.split('/').filter(Boolean);
    const fieldId = parts[parts.length - 1];
    if (!fieldId) return;
    FIELD_USAGE_STATE.flaggedRows.add(row);

    const usage = await usageOf(fieldId);
    if (!link.isConnected) return;
    link.querySelector('.wq-field-usage-badge')?.remove();
    link.appendChild(usageBadge(fieldId, usage));
}

function flagVisibleRows() {
    document.querySelectorAll('.rt-tr-group').forEach((row) => {
        if (row.querySelector('a.link[href*="data-fields"]')) flagRow(row);
    });
}

// ---------- 数据字段副页横幅 ----------

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
    const usage = await usageOf(fieldId);
    if (getFieldIdFromUrl() !== fieldId) return;
    renderDetailBanner(fieldId, usage);
}

// ---------- Alpha 详情: 表达式字段 新/已用 条(强不变量: 每轮全清,只建一条) ----------

const ALPHA_STOPWORDS = new Set(['true', 'false', 'nan', 'and', 'or', 'not', 'if', 'else']);
const RESERVED_IDS = new Set(['unsubmitted', 'submitted', 'distribution']);
let alphaStripBuilding = false;

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

function getAlphaIdFromUrl() {
    const match = location.href.match(/\/alpha\/([^/?#]+)/);
    const id = match ? decodeURIComponent(match[1]) : '';
    return id && !RESERVED_IDS.has(id.toLowerCase()) ? id : '';
}

async function fetchAlphaExpression(alphaId) {
    for (const url of [
        `https://api.worldquantbrain.com/users/self/alphas/${alphaId}`,
        `https://api.worldquantbrain.com/alphas/${alphaId}`,
    ]) {
        try {
            const response = await fetch(url, {
                credentials: 'include',
                signal: AbortSignal.timeout(15000), // 防止请求挂起把构建锁卡死
            });
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

const fieldTokenCache = new Map();
const NEG_TTL = 30000; // 否定结果只缓存30秒,翻页限流时不至于永久误判

async function verifyFieldToken(token) {
    const cached = fieldTokenCache.get(token);
    if (cached) {
        if (cached.ok) return true;
        if (Date.now() - cached.at < NEG_TTL) return false;
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
    fieldTokenCache.set(token, { ok: isField, at: Date.now() });
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

async function buildChipsForCode(code) {
    const chips = document.createElement('span');
    chips.className = 'wqp-alpha-chips';
    chips.style.cssText = 'display:inline-flex; flex-wrap:wrap; gap:6px; align-items:center;';
    let newCount = 0;
    let usedCount = 0;
    for (const token of extractFieldTokens(code || '')) {
        if (!(await verifyFieldToken(token))) continue;
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

function removeAlphaStrips() {
    document.querySelectorAll('[id^="wqp-alpha-field-strip"]').forEach((strip) => strip.remove());
}

// 统一路径: 整页 /alpha/{id} 与列表抽屉都走这里。
// 位置不变量: 条嵌在 Code 标题所在行的父容器末尾(「Code」文字右侧同一行)。
// 检测用「直接文本节点 === 'Code'」: 条是行容器的子元素而非标题的子元素,
// 不会污染标题 textContent,检测稳定 → 不闪烁。
function findVisibleCodeHeadings() {
    return [...document.querySelectorAll('h1,h2,h3,h4,h5,div,span,b')]
        .filter((h) => h.getClientRects().length > 0
            && [...h.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() === 'Code'));
}

function resolveAlphaId(headings) {
    const urlId = getAlphaIdFromUrl();
    if (urlId) return urlId;
    for (const heading of headings) {
        let node = heading.parentElement;
        for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
            const link = node.querySelector('a[href*="/alpha/"]');
            const id = alphaIdFromHref(link?.href);
            if (id) return id;
        }
    }
    return '';
}

async function updateAlphaStrip() {
    const headings = findVisibleCodeHeadings();
    const alphaId = resolveAlphaId(headings);
    if (!alphaId || !headings.length) {
        removeAlphaStrips();
        await updateCodeBlockStrips();
        return;
    }
    const heading = headings[0];
    const headingRow = heading.parentElement;

    const existing = document.getElementById('wqp-alpha-field-strip');
    if (existing && existing.dataset.alpha === alphaId && existing.dataset.done === '1'
        && existing.isConnected && existing.parentElement === headingRow) {
        return; // 已在当前标题行右侧,内容就绪
    }
    if (existing && (existing.dataset.alpha !== alphaId || existing.dataset.done === '1')) {
        existing.remove(); // 换了 alpha,或上次已失败重试过 → 重建占位
    }
    if (alphaStripBuilding) return;
    alphaStripBuilding = true;
    try {
        // 立即占位显示「正在分析」,表达式就绪后原位填充
        let strip = document.getElementById('wqp-alpha-field-strip');
        if (!strip || !strip.isConnected) {
            removeAlphaStrips();
            strip = document.createElement('div');
            strip.id = 'wqp-alpha-field-strip';
            strip.dataset.alpha = alphaId;
            strip.style.cssText = 'display:inline-flex; flex-wrap:wrap; gap:6px; align-items:center; margin-left:12px; padding:3px 8px; border:1px solid #d0d7de; border-radius:8px; background:#f6f8fa; font-size:12px; vertical-align:middle;';
            strip.innerHTML = `<b style="color:#57606a;">字段使用:</b> <span class="wqp-strip-status">正在分析...</span>`;
            headingRow.appendChild(strip);
        } else if (strip.parentElement !== headingRow) {
            headingRow.appendChild(strip); // 跟随当前标题行
        }
        const code = await fetchAlphaExpression(alphaId);
        if (!strip.isConnected) return;
        if (!code) {
            const status = strip.querySelector('.wqp-strip-status');
            if (status) status.textContent = '表达式获取失败,将自动重试...';
            return; // done 未标记,下一轮重试
        }
        strip.querySelector('.wqp-strip-status')?.remove();
        strip.querySelector('.wqp-alpha-chips')?.remove();
        strip.appendChild(await buildChipsForCode(code));
        strip.dataset.done = '1';
    } finally {
        alphaStripBuilding = false;
    }
}

// ---------- 数据字段代码块路径(列表详情等无 /alpha/{id} 的页面) ----------

function findCodeBlocks() {
    const boxes = [];
    for (const heading of document.querySelectorAll('h1,h2,h3,h4,h5,div,span,b')) {
        if (heading.textContent.trim() !== 'Code') continue;
        let node = heading.parentElement;
        for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
            let best = null;
            for (const candidate of node.querySelectorAll('pre, code, [class*="code" i], [class*="expression" i]')) {
                if (candidate.closest('.monaco-editor, .wqp-code-strip, [id^="wqp-alpha-field-strip"], .wqp-alpha-chips')) continue;
                const text = (candidate.innerText || '').trim();
                if (/^code$/i.test(text)) continue;
                if (text.length < 4 || !/[A-Za-z_]/.test(text)) continue;
                if (!best || text.length < best.innerText.trim().length) best = candidate;
            }
            if (best && best.getClientRects().length > 0) {
                boxes.push(best);
                break;
            }
        }
    }
    const unique = [...new Set(boxes)];
    return unique.filter((box) => !unique.some((other) => other !== box && other.contains(box)));
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
    removeAlphaStrips();
    const keptBoxes = findCodeBlocks();
    for (const box of keptBoxes) {
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
        const chips = await buildChipsForCode(code);
        strip.querySelector('.wqp-strip-status')?.remove();
        if (strip.isConnected) strip.appendChild(chips);
        codeBlockStrips.set(box, strip);
    }
    document.querySelectorAll('.wqp-code-strip').forEach((strip) => {
        const box = strip._box;
        // 严格白名单: 宿主必须是当前识别到的代码块(裸字段/切换 alpha 时旧条立即失效)
        if (!box || !box.isConnected || !keptBoxes.includes(box)) {
            strip.remove();
        }
    });
}

// ---------- 主循环 ----------

// 表达式文本 XPath 全页反查: 不依赖类名。取最内层命中后,
// 沿「父级新增文本很少则继续上溯」爬到代码区块边界,条插在该区块之后
function findCodeBoxByText(code) {
    const snippet = (code || '').replace(/\s+/g, ' ').trim().slice(0, 30);
    if (!snippet || /['"]/.test(snippet)) return null;
    let matches;
    try {
        matches = document.evaluate(
            `//*[contains(normalize-space(.), "${snippet}")]`,
            document.body, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null,
        );
    } catch (_) {
        return null;
    }
    let innermost = null;
    let innerLen = Infinity;
    for (let i = 0; i < matches.snapshotLength; i += 1) {
        const el = matches.snapshotItem(i);
        if (!el || el.closest('.wqp-code-strip, [id^="wqp-alpha-field-strip"], .wqp-alpha-chips, script, style')) continue;
        if (el.getClientRects().length === 0) continue;
        const len = (el.innerText || '').replace(/\s+/g, ' ').trim().length;
        if (len < innerLen) {
            innermost = el;
            innerLen = len;
        }
    }
    if (!innermost) return null;
    let node = innermost;
    for (let depth = 0; depth < 8; depth += 1) {
        const parent = node.parentElement;
        if (!parent || parent === document.body) break;
        const plen = (parent.innerText || '').replace(/\s+/g, ' ').trim().length;
        const nlen = (node.innerText || '').replace(/\s+/g, ' ').trim().length;
        if (plen > nlen * 1.5 + 20) break; // 父级开始包含其他内容(settings 等),停在代码区块边界
        node = parent;
    }
    return node;
}

// 嵌入到 Code 标题之后(标题和代码块之间);标题是父容器末尾时上提一层
function insertAfterHeading(strip, heading) {
    if (heading.nextElementSibling) {
        heading.parentNode.insertBefore(strip, heading.nextElementSibling);
    } else if (heading.parentNode && heading.parentNode.nextElementSibling) {
        heading.parentNode.parentNode.insertBefore(strip, heading.parentNode.nextElementSibling);
    } else if (heading.parentNode) {
        heading.parentNode.appendChild(strip);
    } else {
        (document.querySelector('main') || document.body).prepend(strip);
    }
}

let observeTimer = null;
let mainPassRunning = false;
async function mainPass() {
    if (mainPassRunning) return;
    mainPassRunning = true;
    try {
        flagVisibleRows();
        if (getFieldIdFromUrl()) {
            await updateDetailBanner();
        } else if (findVisibleCodeHeadings().length > 0) {
            await updateAlphaStrip();
        } else {
            await updateCodeBlockStrips();
        }
    } catch (error) {
        console.error('[WQP] fieldUsageFlag 轮询异常:', error);
    } finally {
        mainPassRunning = false;
    }
}

function scheduleFlag() {
    if (observeTimer) return;
    observeTimer = setTimeout(() => {
        observeTimer = null;
        mainPass();
    }, 300);
}

new MutationObserver(scheduleFlag).observe(document.body, { childList: true, subtree: true });
setInterval(mainPass, 1500);
mainPass();
