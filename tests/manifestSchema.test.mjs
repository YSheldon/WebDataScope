// manifestSchema.test.mjs — manifest.json 的 Chrome 语义校验
//
// 背景: 1.10.50 把 content script 条目误插进 web_accessible_resources 数组。
// JSON.parse 能过(node 校验一直是绿的), 但 Chrome 要求 web_accessible_resources 的
// 每个条目必须有 resources, 于是整个扩展加载失败、连 reload 都点不动。
// 这个测试专门挡这类"语法合法但语义非法"的问题。
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const CONTENT_SCRIPT_KEYS = new Set(['matches', 'exclude_matches', 'js', 'css', 'run_at', 'world', 'all_frames', 'match_about_blank']);
const WEB_ACCESSIBLE_KEYS = new Set(['resources', 'matches', 'exclude_matches', 'use_dynamic_url']);
const RUN_AT = new Set(['document_start', 'document_end', 'document_idle']);

test('content_scripts 每条都符合 Chrome 的 schema', () => {
    const entries = manifest.content_scripts || [];
    assert.ok(entries.length > 0, 'content_scripts 不应为空');

    entries.forEach((entry, index) => {
        const at = `content_scripts[${index}]`;
        for (const key of Object.keys(entry)) {
            assert.ok(CONTENT_SCRIPT_KEYS.has(key), `${at} 出现非法键 ${key}`);
        }
        assert.ok(Array.isArray(entry.matches) && entry.matches.length > 0, `${at} 缺少 matches`);
        assert.ok(entry.js || entry.css, `${at} 必须至少有 js 或 css`);
        if (entry.run_at) {
            assert.ok(RUN_AT.has(entry.run_at), `${at} 的 run_at=${entry.run_at} 非法`);
        }
    });
});

test('web_accessible_resources 每条都有 resources, 绝不混进 content script 的键', () => {
    const entries = manifest.web_accessible_resources || [];
    entries.forEach((entry, index) => {
        const at = `web_accessible_resources[${index}]`;
        for (const key of Object.keys(entry)) {
            assert.ok(WEB_ACCESSIBLE_KEYS.has(key),
                `${at} 出现非法键 ${key} —— web_accessible_resources 的条目必须含 resources, 不能放 js/run_at`);
        }
        assert.ok(Array.isArray(entry.resources) && entry.resources.length > 0, `${at} 缺少 resources`);
        assert.ok(Array.isArray(entry.matches) && entry.matches.length > 0, `${at} 缺少 matches`);
    });
});

test('content_scripts 里没有长成 web_accessible_resources 形状的条目', () => {
    // 1.10.50 的实际错法: 条目被插进了 web_accessible_resources 数组。
    // 反过来也要防: content_scripts 里混入只有 resources 没有 js/css 的条目。
    (manifest.content_scripts || []).forEach((entry, index) => {
        assert.ok(!Array.isArray(entry.resources),
            `content_scripts[${index}] 含有 resources 字段, 看起来是被插错位置的 web_accessible_resources 条目`);
    });
});

test('manifest 引用的每个 js/css 文件都真实存在', () => {
    const missing = [];
    const collect = (list) => (list || []).forEach((file) => {
        if (!existsSync(path.join(root, file))) missing.push(file);
    });

    (manifest.content_scripts || []).forEach((entry) => {
        collect(entry.js);
        collect(entry.css);
    });
    (manifest.web_accessible_resources || []).forEach((entry) => {
        entry.resources.forEach((resource) => {
            // 允许通配符
            if (resource.includes('*')) return;
            if (!existsSync(path.join(root, resource))) missing.push(resource);
        });
    });
    Object.values(manifest.icons || {}).forEach((icon) => {
        if (!existsSync(path.join(root, icon))) missing.push(icon);
    });

    assert.deepEqual(missing, [], `manifest 引用了不存在的文件: ${missing.join(', ')}`);
});

test('基本字段', () => {
    assert.equal(manifest.manifest_version, 3);
    assert.match(manifest.version, /^\d+(\.\d+){0,3}$/);
    assert.ok(manifest.name);
});