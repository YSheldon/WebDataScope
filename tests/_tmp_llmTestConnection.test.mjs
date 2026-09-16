import assert from 'node:assert/strict';
import test from 'node:test';
import { getLlmConfig, saveLlmConfig, testLlmConnection, runLlmText, isLlmConfigured } from '../src/background/services/llmService.js';

function createChromeMock() {
    const memory = {};
    return {
        memory,
        runtime: { lastError: null },
        storage: {
            local: {
                get(key, callback) { callback({ [key]: memory[key] }); },
                set(values, callback) { Object.assign(memory, structuredClone(values)); callback(); },
            },
        },
    };
}

function okCompletion(model = 'test-model', content = 'ok') {
    return new Response(JSON.stringify({ choices: [{ message: { content } }], model }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

function withFetch(stub) {
    const original = globalThis.fetch;
    globalThis.fetch = stub;
    return () => { globalThis.fetch = original; };
}

test('isLlmConfigured requires both baseUrl and model', () => {
    assert.equal(isLlmConfigured({ baseUrl: 'http://192.168.100.191:8000/v1', model: 'qwen' }), true);
    assert.equal(isLlmConfigured({ baseUrl: 'http://x/v1', model: '' }), false);
    assert.equal(isLlmConfigured({ baseUrl: '', model: 'qwen' }), false);
});

test('testLlmConnection posts to chat/completions and auto-enables saved config', async () => {
    globalThis.chrome = createChromeMock();
    const restore = withFetch(async (url, options) => {
        assert.equal(url, 'https://api.example.com/v1/chat/completions');
        assert.equal(options.headers.Authorization, 'Bearer new-key');
        assert.deepEqual(JSON.parse(options.body).messages, [{ role: 'user', content: 'Reply with exactly: ok' }]);
        return okCompletion();
    });
    try {
        const result = await testLlmConnection({ baseUrl: 'https://api.example.com/v1/', model: 'm1', apiKey: 'new-key' });
        assert.equal(result.ok, true);
        assert.equal(result.enabled, true);
        const saved = await getLlmConfig();
        assert.equal(saved.enabled, true);
        assert.equal(saved.hasApiKey, true);
        assert.equal(saved.baseUrl, 'https://api.example.com/v1');
        assert.equal(saved.model, 'm1');
    } finally {
        restore();
    }
});

test('testLlmConnection falls back to stored API key when input is masked/empty', async () => {
    globalThis.chrome = createChromeMock();
    const restore = withFetch(async (_url, options) => {
        assert.equal(options.headers.Authorization, 'Bearer stored-key');
        return okCompletion();
    });
    try {
        await saveLlmConfig({ baseUrl: 'https://api.example.com/v1', model: 'm1', apiKey: 'stored-key' });
        const result = await testLlmConnection({ baseUrl: 'https://api.example.com/v1', model: 'm1', apiKey: '********' });
        assert.equal(result.ok, true);
    } finally {
        restore();
    }
});

test('runLlmText works when enabled is false as long as URL and model exist', async () => {
    globalThis.chrome = createChromeMock();
    globalThis.chrome.memory.WQP_LLM_Config = {
        enabled: false,
        baseUrl: 'http://192.168.100.191:8000/v1',
        model: 'local-model',
        apiKey: 'k',
    };
    const restore = withFetch(async (url) => {
        assert.equal(url, 'http://192.168.100.191:8000/v1/chat/completions');
        return okCompletion('local-model', 'hello');
    });
    try {
        const result = await runLlmText({ systemPrompt: 's', userPrompt: 'u' });
        assert.equal(result.text, 'hello');
    } finally {
        restore();
    }
});

test('runLlmText fails with a Chinese setup hint when not configured', async () => {
    globalThis.chrome = createChromeMock();
    await assert.rejects(
        () => runLlmText({ systemPrompt: 's', userPrompt: 'u' }),
        /Base URL 和 Model/,
    );
});

test('testLlmConnection surfaces validation and HTTP errors', async () => {
    globalThis.chrome = createChromeMock();
    const restore = withFetch(async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 }));
    try {
        await assert.rejects(() => testLlmConnection({ baseUrl: '', model: 'm1' }), /Base URL/);
        await assert.rejects(() => testLlmConnection({ baseUrl: 'https://api.example.com/v1', model: '' }), /model is required/);
        await assert.rejects(
            () => testLlmConnection({ baseUrl: 'https://api.example.com/v1', model: 'm1', apiKey: 'k' }),
            /401.*bad key/,
        );
    } finally {
        restore();
    }
});
