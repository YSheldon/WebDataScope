import assert from 'node:assert/strict';
import test from 'node:test';
import { getLlmConfig, saveLlmConfig, testLlmConnection } from '../src/background/services/llmService.js';

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

function okCompletion(model = 'test-model') {
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], model }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

function withFetch(stub) {
    const original = globalThis.fetch;
    globalThis.fetch = stub;
    return () => { globalThis.fetch = original; };
}

test('testLlmConnection posts to chat/completions with provided key and does not change saved config', async () => {
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
        const saved = await getLlmConfig();
        assert.equal(saved.enabled, false, '测试连接不得改变保存的启用状态');
        assert.equal(saved.hasApiKey, false, '测试连接不得保存 API Key');
    } finally {
        restore();
    }
});

test('testLlmConnection falls back to stored API key when input is masked/empty', async () => {
    globalThis.chrome = createChromeMock();
    await saveLlmConfig({ baseUrl: 'https://api.example.com/v1', model: 'm1', apiKey: 'stored-key' });
    const restore = withFetch(async (_url, options) => {
        assert.equal(options.headers.Authorization, 'Bearer stored-key');
        return okCompletion();
    });
    try {
        const result = await testLlmConnection({ baseUrl: 'https://api.example.com/v1', model: 'm1', apiKey: '********' });
        assert.equal(result.ok, true);
    } finally {
        restore();
    }
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
