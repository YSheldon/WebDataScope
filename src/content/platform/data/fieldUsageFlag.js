// fieldUsageFlag.js: 数据字段列表/详情页直接显示字段本季使用状态,不再需要双击查询
console.log('[WQP] fieldUsageFlag v1.9.4 loaded');

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

// 锚点优先级: Code 标题下的代码块(插其下方) > Monaco(插其上方) > main(插顶部)
function locateAlphaAnchor() {
    for (const heading of document.querySelectorAll('h1,h2,h3,h4,h5,div,span,b')) {
        if (heading.textContent.trim() !== 'Code') continue;
        let node = heading.parentElement;
        for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
            let best = null;
            for (const candidate of node.querySelectorAll('pre, code, [class*="code" i], [class*="expression" i]')) {
                // 排除自己生成的条,否则条会把自己当代码块,永远显示旧字段
                if (candidate.closest('.monaco-editor, .wqp-code-strip, [id^="wqp-alpha-field-strip"], .wqp-alpha-chips')) continue;
                const text = (candidate.innerText || '').trim();
                // "Code" 标题自身的 class 往往也含 code 字样,必须排除
                if (/^code$/i.test(text)) continue;
                // 裸字段表达式没有括号,只要求含标识符
                if (text.length < 4 || !/[A-Za-z_]/.test(text)) continue;
                if (!best || text.length < best.innerText.trim().length) best = candidate;
            }
            if (best && best.getClientRects().length > 0) {
                return { mode: 'after-code-block', node: best };
            }
        }
    }
    const editor = document.querySelector('.monaco-editor');
    if (editor) {
        return { mode: 'before-monaco', node: editor.closest('div[class*="container"], section, div') || editor };
    }
    return { mode: 'main', node: document.querySelector('main') || document.body };
}

async function updateAlphaStrip() {
    const alphaId = getAlphaIdFromUrl();
    if (!alphaId) {
        removeAlphaStrips();
        return;
    }
    const anchor = locateAlphaAnchor();

    // 根部降级不挂载: 等 Code 块/Monaco 渲染出来再挂,避免条出现在页首
    if (anchor.mode === 'main') {
        return;
    }

    const existing = document.getElementById('wqp-alpha-field-strip');
    if (existing && existing.dataset.alpha === alphaId && existing.dataset.done === '1') {
        // 内容已就绪: 若出现了更贴切的锚点位置,把条搬过去
        if (anchor.mode === 'after-code-block' && existing.previousElementSibling !== anchor.node) {
            anchor.node.parentNode.insertBefore(existing, anchor.node.nextSibling);
        } else if (anchor.mode === 'before-monaco' && anchor.node.previousElementSibling !== existing) {
            anchor.node.parentNode.insertBefore(existing, anchor.node);
        }
        return;
    }

    if (alphaStripBuilding) return;
    alphaStripBuilding = true;
    try {
        removeAlphaStrips();
        const strip = document.createElement('div');
        strip.id = 'wqp-alpha-field-strip';
        strip.dataset.alpha = alphaId;
        strip.style.cssText = 'display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin:4px 0; padding:6px 8px; border:1px solid #d0d7de; border-radius:8px; background:#f6f8fa; font-size:12px;';
        strip.innerHTML = `<b style="color:#57606a;">字段使用 (${alphaId}):</b> <span class="wqp-strip-status">分析中...</span>`;
        if (anchor.mode === 'after-code-block') {
            anchor.node.parentNode.insertBefore(strip, anchor.node.nextSibling);
        } else {
            anchor.node.parentNode.insertBefore(strip, anchor.node);
        }
        console.log('[WQP] 字段使用条已挂载:', alphaId, anchor.mode);

        const code = await fetchAlphaExpression(alphaId);
        if (!strip.isConnected || getAlphaIdFromUrl() !== alphaId) return; // 已被下一轮接管
        strip.querySelector('.wqp-strip-status')?.remove();
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

// 无 /alpha/{id} URL 时(列表详情抽屉): 从 Code 标题向上找面板里的 alpha 链接,
// 表达式一律取 API,条按"包含表达式文本"反查到的可视代码块定位
function findDrawerAlphaContext() {
    for (const heading of document.querySelectorAll('h1,h2,h3,h4,h5,div,span,b')) {
        if (heading.textContent.trim() !== 'Code') continue;
        if (heading.getClientRects().length === 0) continue;
        let node = heading.parentElement;
        for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
            const link = node.querySelector('a[href*="/alpha/"]');
            const alphaId = alphaIdFromHref(link?.href) || findAlphaIdInNode(node);
            if (alphaId) return { alphaId, heading, panel: node };
        }
    }
    return null;
}

function findVisibleCodeBox(panel, code) {
    const snippet = (code || '').replace(/\s+/g, ' ').trim().slice(0, 30);
    if (!snippet) return null;
    let best = null;
    for (const candidate of panel.querySelectorAll('pre, code, [class*="code" i], [class*="expression" i]')) {
        if (candidate.closest('.wqp-code-strip, [id^="wqp-alpha-field-strip"], .wqp-alpha-chips')) continue;
        if (candidate.getClientRects().length === 0) continue;
        const text = (candidate.innerText || '').replace(/\s+/g, ' ');
        if (!text.includes(snippet)) continue;
        if (!best || text.length < best.innerText.replace(/\s+/g, ' ').length) best = candidate;
    }
    return best;
}

let drawerStripBuilding = false;
async function updateDrawerStrip() {
    const ctx = findDrawerAlphaContext();
    const existing = document.getElementById('wqp-alpha-field-strip-drawer');
    if (!ctx) {
        if (existing) existing.remove();
        await updateCodeBlockStrips();
        return;
    }

    // 条挂在 body 层绝对定位到 Code 标题正下方: React 重渲染碰不到,位置每轮校正
    const rect = ctx.heading.getBoundingClientRect();
    const top = `${window.scrollY + rect.bottom + 6}px`;
    const left = `${window.scrollX + rect.left}px`;

    if (existing && existing.dataset.alpha !== ctx.alphaId) {
        existing.remove();
    }
    let strip = document.getElementById('wqp-alpha-field-strip-drawer');
    if (!strip) {
        strip = document.createElement('div');
        strip.id = 'wqp-alpha-field-strip-drawer';
        strip.dataset.alpha = ctx.alphaId;
        strip.style.cssText = 'position:absolute; z-index:900; display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin:0; padding:6px 8px; border:1px solid #d0d7de; border-radius:8px; background:#f6f8fa; font-size:12px; box-shadow:0 2px 6px rgba(0,0,0,.08);';
        strip.innerHTML = `<b style="color:#57606a;">字段使用 (${ctx.alphaId}):</b> <span class="wqp-strip-status">分析中...</span>`;
        document.body.appendChild(strip);
        console.log('[WQP] 抽屉字段条已挂载:', ctx.alphaId);
    }
    strip.style.top = top;
    strip.style.left = left;
    strip.style.maxWidth = `${Math.max(320, Math.round(rect.width))}px`;
    if (existing && existing.dataset.done !== '1' && drawerStripBuilding) return; // 上一轮还在构建,只校正位置

    if (existing.dataset.done === '1') return;
    if (drawerStripBuilding) return;
    drawerStripBuilding = true;
    try {
        const code = await fetchAlphaExpression(ctx.alphaId);
        if (!strip.isConnected) return;
        if (!code) {
            const status = strip.querySelector('.wqp-strip-status');
            if (status) status.textContent = '表达式获取失败,将自动重试...';
            return; // 不标记 done,下一轮重试
        }
        strip.querySelector('.wqp-strip-status')?.remove();
        strip.appendChild(await buildChipsForCode(code));
        strip.dataset.done = '1';
    } finally {
        drawerStripBuilding = false;
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
        } else if (getAlphaIdFromUrl()) {
            await updateAlphaStrip();
        } else {
            await updateDrawerStrip();
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
