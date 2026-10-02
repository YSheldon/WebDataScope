import { getLocalValue, setLocalValue } from './storageService.js';

const CONFIG_KEY = 'WQP_LLM_Config';

// Cherry Studio 内置 API Server 是 OpenAI 兼容的, 本机实测 127.0.0.1:23333, 路径是 /v1(不是 /api/v1), 需要 API Key
const CHERRY_BASE_URLS = [
    'http://127.0.0.1:23333/v1',
    'http://localhost:23333/v1',
];
const PROVIDER_CUSTOM = 'custom';
const PROVIDER_CHERRY = 'cherry';

const DEFAULT_CONFIG = {
    enabled: false,
    defaultCollapsed: false,
    provider: PROVIDER_CUSTOM,
    baseUrl: '',
    model: '',
    apiKey: '',
};

function normalizeBaseUrl(value) {
    return String(value || '').trim().replace(/\/+$/, '');
}

function normalizeProvider(value) {
    return value === PROVIDER_CHERRY ? PROVIDER_CHERRY : PROVIDER_CUSTOM;
}

function normalizeConfig(config = {}) {
    return {
        enabled: config.enabled === true,
        defaultCollapsed: config.defaultCollapsed === true,
        provider: normalizeProvider(config.provider),
        baseUrl: normalizeBaseUrl(config.baseUrl),
        model: String(config.model || '').trim(),
        apiKey: String(config.apiKey || '').trim(),
    };
}

function sanitizeConfig(config) {
    const normalized = normalizeConfig(config);
    return {
        ...normalized,
        apiKey: '',
        hasApiKey: Boolean(normalized.apiKey),
    };
}

export function isLlmConfigured(config = {}) {
    return Boolean(normalizeBaseUrl(config.baseUrl) && String(config.model || '').trim());
}

function assertLlmReady(config) {
    if (!isLlmConfigured(config)) {
        throw new Error('请先在侧边栏「设置 → AI 设置」填写 Base URL 和 Model，点「测试连接」通过后再生成。');
    }
}

export async function getLlmConfig() {
    const saved = await getLocalValue(CONFIG_KEY);
    return sanitizeConfig({ ...DEFAULT_CONFIG, ...(saved || {}) });
}

export async function getLlmConfigRaw() {
    const saved = await getLocalValue(CONFIG_KEY);
    return normalizeConfig({ ...DEFAULT_CONFIG, ...(saved || {}) });
}

export async function saveLlmConfig(input = {}) {
    const existing = await getLlmConfigRaw();
    const next = normalizeConfig({
        ...existing,
        enabled: input.enabled === true,
        defaultCollapsed: typeof input.defaultCollapsed === 'boolean'
            ? input.defaultCollapsed
            : existing.defaultCollapsed,
        provider: input.provider,
        baseUrl: input.baseUrl,
        model: input.model,
        apiKey: typeof input.apiKey === 'string' && input.apiKey.length > 0
            ? input.apiKey
            : input.keepExistingApiKey === true
                ? existing.apiKey
                : '',
    });
    if (isLlmConfigured(next)) next.enabled = true;
    if (next.enabled) {
        await testLlmConfig(next);
    }
    await setLocalValue(CONFIG_KEY, next);
    return sanitizeConfig(next);
}

function extractJsonObject(text) {
    const raw = String(text || '').trim();
    if (!raw) throw new Error('LLM returned an empty response.');
    try {
        return JSON.parse(raw);
    } catch (_) {
        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) throw new Error('LLM response is not valid JSON.');
        return JSON.parse(match[0]);
    }
}

export async function testLlmConnection(input = {}) {
    const existing = await getLlmConfigRaw();
    const config = {
        baseUrl: normalizeBaseUrl(input.baseUrl),
        model: String(input.model || '').trim(),
        apiKey: (typeof input.apiKey === 'string' && input.apiKey && input.apiKey !== '********')
            ? input.apiKey
            : existing.apiKey,
    };
    await testLlmConfig(config);
    const next = {
        ...existing,
        enabled: true,
        baseUrl: config.baseUrl || existing.baseUrl,
        model: config.model || existing.model,
        apiKey: config.apiKey || existing.apiKey,
    };
    await setLocalValue(CONFIG_KEY, next);
    return { ok: true, model: config.model, enabled: true };
}

async function requestModelList(baseUrl, apiKey, timeoutMs = 6000) {
    const url = `${normalizeBaseUrl(baseUrl)}/models`;
    const headers = { Accept: 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const response = await fetch(url, { headers, ...(timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const detail = data?.error?.message || data?.message
            || (typeof data?.error === 'string' ? data.error : '') || response.statusText;
        const hint = response.status === 401
            ? '（Cherry Studio 需要 API Key，请在下方 API Key 栏填 Cherry「设置 → API 服务」里的密钥）'
            : response.status === 403 ? '（API Key 不对）' : '';
        throw new Error(`HTTP ${response.status}: ${detail}${hint}`);
    }
    const list = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
    const models = list
        .map((m) => (typeof m === 'string' ? m : m?.id || m?.name))
        .filter((id) => typeof id === 'string' && id.trim())
        .map((id) => id.trim());
    return Array.from(new Set(models)).sort((a, b) => a.localeCompare(b));
}

// 从指定接口拉模型列表(下拉框用), 模型 id 一律来自接口返回, 不手写
export async function listLlmModels(input = {}) {
    const existing = await getLlmConfigRaw();
    const baseUrl = normalizeBaseUrl(input.baseUrl) || existing.baseUrl;
    const apiKey = (typeof input.apiKey === 'string' && input.apiKey && input.apiKey !== '********')
        ? input.apiKey
        : existing.apiKey;
    if (!baseUrl) throw new Error('请先填写 Base URL。');
    const models = await requestModelList(baseUrl, apiKey);
    return { baseUrl, models };
}

// 探测本机 Cherry Studio API Server 并取模型列表
export async function discoverCherryModels(input = {}) {
    const existing = await getLlmConfigRaw();
    const apiKey = (typeof input.apiKey === 'string' && input.apiKey && input.apiKey !== '********')
        ? input.apiKey
        : existing.apiKey;
    const preferred = normalizeBaseUrl(input.baseUrl);
    const candidates = preferred && !CHERRY_BASE_URLS.includes(preferred)
        ? [preferred, ...CHERRY_BASE_URLS]
        : [...CHERRY_BASE_URLS];
    const tried = [];
    for (const baseUrl of candidates) {
        try {
            const models = await requestModelList(baseUrl, apiKey);
            return { baseUrl, models };
        } catch (error) {
            tried.push(`${baseUrl}（${error.message}）`);
        }
    }
    throw new Error(`未找到本机 Cherry Studio API Server。请在 Cherry Studio「设置 → API 服务」里启动服务。已尝试：${tried.join('；')}`);
}

export { CHERRY_BASE_URLS, PROVIDER_CHERRY, PROVIDER_CUSTOM };

export async function runLlmJson({ systemPrompt, userPrompt, schemaName = 'result' }) {
    const config = await getLlmConfigRaw();
    assertLlmReady(config);
    return runLlmJsonWithConfig(config, { systemPrompt, userPrompt, schemaName });
}

export async function runLlmText({ systemPrompt, userPrompt, taskName = 'result' }) {
    const config = await getLlmConfigRaw();
    assertLlmReady(config);
    return runLlmTextWithConfig(config, { systemPrompt, userPrompt, taskName });
}

async function requestChatCompletion(config, payload, timeoutMs = 0) {
    const headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
    };
    if (config.apiKey) {
        headers.Authorization = `Bearer ${config.apiKey}`;
    }

    const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        ...(timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const detail = data?.error?.message || data?.message || response.statusText;
        throw new Error(`LLM request failed (${response.status}): ${detail}`);
    }
    return data;
}

async function testLlmConfig(config) {
    if (!config.baseUrl) throw new Error('AI Base URL is required.');
    if (!config.model) throw new Error('AI model is required.');
    const data = await requestChatCompletion(config, {
        model: config.model,
        stream: false,
        messages: [
            { role: 'user', content: 'Reply with exactly: ok' },
        ],
    }, 20000);
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
        throw new Error('LLM connectivity check returned an empty response.');
    }
    return true;
}

async function runLlmJsonWithConfig(config, { systemPrompt, userPrompt, schemaName = 'result' }) {
    const data = await requestChatCompletion(config, {
        model: config.model,
        stream: false,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
    });

    const content = data?.choices?.[0]?.message?.content;
    const parsed = extractJsonObject(content);
    if (!parsed || typeof parsed !== 'object') {
        throw new Error(`LLM ${schemaName} response is not an object.`);
    }
    return {
        result: parsed,
        usage: data?.usage || null,
        model: data?.model || config.model,
    };
}

async function runLlmTextWithConfig(config, { systemPrompt, userPrompt, taskName = 'result' }) {
    const data = await requestChatCompletion(config, {
        model: config.model,
        stream: false,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
    });

    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
        throw new Error(`LLM ${taskName} response is empty.`);
    }
    return {
        text: content.trim(),
        usage: data?.usage || null,
        model: data?.model || config.model,
    };
}
