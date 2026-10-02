import { sendMessage } from './runtimeClient.js';
import { loadSidebarLibraries } from './sidebarLibraries.js';
import { formatBytes, setStatus } from './ui.js';

const ids = {
    form: 'settingsForm',
    dataAnalysis: 'dataAnalysis',
    geniusCombineTag: 'geniusCombineTag',
    geniusAlphaCount: 'geniusAlphaCount',
    apiMonitorEnabled: 'apiMonitorEnabled',
    pnlShareEnabled: 'pnlShareEnabled',
    llmEnabled: 'llmEnabled',
    llmDefaultState: 'llmDefaultState',
    llmProvider: 'llmProvider',
    llmBaseUrl: 'llmBaseUrl',
    llmModel: 'llmModel',
    llmModelSelect: 'llmModelSelect',
    llmModelSelectField: 'llmModelSelectField',
    llmModelField: 'llmModelField',
    llmCherryRow: 'llmCherryRow',
    llmFetchModels: 'llmFetchModelsBtn',
    llmModelHint: 'llmModelHint',
    llmApiKey: 'llmApiKey',
    testLlm: 'testLlmBtn',
    save: 'saveSettingsBtn',
};

let hasSavedLlmApiKey = false;

function currentProvider() {
    return document.getElementById(ids.llmProvider)?.value === 'cherry' ? 'cherry' : 'custom';
}

// 自定义方式保持原来的手写输入框; 选 Cherry 时换成接口下拉, 其余字段一个都不动
function applyProviderVisibility() {
    const cherry = currentProvider() === 'cherry';
    const modelField = document.getElementById(ids.llmModelField);
    const selectField = document.getElementById(ids.llmModelSelectField);
    const cherryRow = document.getElementById(ids.llmCherryRow);
    if (modelField) modelField.hidden = cherry;
    if (selectField) selectField.hidden = !cherry;
    if (cherryRow) cherryRow.hidden = !cherry;
    return cherry;
}

function fillModelSelect(models, preferred) {
    const select = document.getElementById(ids.llmModelSelect);
    if (!select) return;
    select.textContent = '';
    for (const id of models) {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = id;
        select.appendChild(option);
    }
    if (preferred && models.includes(preferred)) select.value = preferred;
}

function readSettingsFromForm() {
    return {
        dataAnalysisEnabled: document.getElementById(ids.dataAnalysis).checked,
        geniusCombineTag: document.getElementById(ids.geniusCombineTag).checked,
        geniusAlphaCount: parseInt(document.getElementById(ids.geniusAlphaCount).value, 10) || 40,
        apiMonitorEnabled: document.getElementById(ids.apiMonitorEnabled).checked,
        pnlShareEnabled: document.getElementById(ids.pnlShareEnabled).checked,
    };
}

function writeSettingsToForm(settings) {
    document.getElementById(ids.dataAnalysis).checked = settings.dataAnalysisEnabled !== false;
    document.getElementById(ids.geniusCombineTag).checked = settings.geniusCombineTag === true;
    document.getElementById(ids.geniusAlphaCount).value = settings.geniusAlphaCount || 40;
    document.getElementById(ids.apiMonitorEnabled).checked = settings.apiMonitorEnabled === true;
    document.getElementById(ids.pnlShareEnabled).checked = settings.pnlShareEnabled === true;
}

function readLlmConfigFromForm() {
    const rawApiKey = document.getElementById(ids.llmApiKey).value;
    const apiKey = rawApiKey === '********' ? '' : rawApiKey;
    const cherry = currentProvider() === 'cherry';
    const selected = document.getElementById(ids.llmModelSelect)?.value || '';
    return {
        enabled: document.getElementById(ids.llmEnabled).checked,
        defaultCollapsed: document.getElementById(ids.llmDefaultState).value === 'collapsed',
        provider: cherry ? 'cherry' : 'custom',
        baseUrl: document.getElementById(ids.llmBaseUrl).value.trim(),
        model: (cherry ? selected : document.getElementById(ids.llmModel).value).trim(),
        apiKey,
        keepExistingApiKey: (!apiKey || rawApiKey === '********') && hasSavedLlmApiKey,
    };
}

function writeLlmConfigToForm(config = {}) {
    document.getElementById(ids.llmEnabled).checked = config.enabled === true;
    document.getElementById(ids.llmDefaultState).value = config.defaultCollapsed === true ? 'collapsed' : 'expanded';
    if (document.getElementById(ids.llmProvider)) {
        document.getElementById(ids.llmProvider).value = config.provider === 'cherry' ? 'cherry' : 'custom';
    }
    document.getElementById(ids.llmBaseUrl).value = config.baseUrl || '';
    document.getElementById(ids.llmModel).value = config.model || '';
    const cherry = applyProviderVisibility();
    if (cherry && config.model) {
        const select = document.getElementById(ids.llmModelSelect);
        if (select && !Array.from(select.options).some((o) => o.value === config.model)) {
            const option = document.createElement('option');
            option.value = config.model;
            option.textContent = config.model;
            select.appendChild(option);
        }
        if (select) select.value = config.model;
    }
    const apiKeyInput = document.getElementById(ids.llmApiKey);
    hasSavedLlmApiKey = config.hasApiKey === true;
    apiKeyInput.value = hasSavedLlmApiKey ? '********' : '';
    apiKeyInput.placeholder = hasSavedLlmApiKey ? '留空则保留已保存 Key' : '请输入 API Key（如接口需要）';
}

function setLlmModelHint(text, mode) {
    const hint = document.getElementById(ids.llmModelHint);
    if (hint) {
        hint.textContent = text || '';
        hint.style.color = mode === 'error' ? '#d9534f' : mode === 'success' ? '#2e7d32' : '';
    }
}

async function loadLlmModels() {
    const btn = document.getElementById(ids.llmFetchModels);
    const baseUrlInput = document.getElementById(ids.llmBaseUrl);
    const provider = currentProvider();
    if (btn) btn.disabled = true;
    setLlmModelHint('正在读取模型列表...');
    try {
        const rawKey = document.getElementById(ids.llmApiKey).value;
        const result = await sendMessage('WQP_LLM_MODELS', {
            provider,
            config: {
                baseUrl: baseUrlInput.value.trim(),
                apiKey: rawKey === '********' ? '' : rawKey,
            },
        });
        const models = Array.isArray(result?.models) ? result.models : [];
        fillModelSelect(models, document.getElementById(ids.llmModel).value.trim());
        if (result?.baseUrl && result.baseUrl !== baseUrlInput.value.trim()) {
            baseUrlInput.value = result.baseUrl;
        }
        setLlmModelHint(models.length ? `已读取 ${models.length} 个模型` : '接口未返回模型', models.length ? 'success' : 'error');
        return models;
    } catch (error) {
        setLlmModelHint(`读取失败：${error.message}`, 'error');
        return [];
    } finally {
        if (btn) btn.disabled = false;
    }
}

function bindLlmApiKeyPlaceholder() {
    const apiKeyInput = document.getElementById(ids.llmApiKey);
    if (!apiKeyInput) return;
    apiKeyInput.addEventListener('focus', () => {
        if (apiKeyInput.value === '********') {
            apiKeyInput.value = '';
        }
    });
    apiKeyInput.addEventListener('blur', () => {
        if (!apiKeyInput.value && hasSavedLlmApiKey) {
            apiKeyInput.value = '********';
        }
    });
}

function setDataMeta(text) {
    const el = document.getElementById('dataMeta');
    if (el) el.textContent = text || '';
}

async function notifyIndexedDataUpdated() {
    await sendMessage('WQP_INDEXED_DATA_UPDATED');
}

async function loadDataMeta() {
    try {
        const meta = await sendMessage('WQP_INDEXED_DATA_GET', { responseType: 'meta' });
        if (!meta) {
            setDataMeta('请导入WebData.zip文件');
            return;
        }
        const missing = Array.isArray(meta.missingRequired) && meta.missingRequired.length
            ? `；缺少 ${meta.missingRequired.join(', ')}`
            : '';
        setDataMeta(`当前数据：${meta.sourceName || '-'}，${meta.fileCount || 0} 个文件，${formatBytes(meta.totalBytes || 0)}，${meta.infoDataKeyCount || 0} 个 info 分片${missing}`);
    } catch (_) {
        setDataMeta('请导入WebData.zip文件');
    }
}

async function importDataZip(file) {
    if (!/\.zip$/i.test(file.name)) {
        throw new Error('请选择 zip 文件。');
    }
    await loadSidebarLibraries();

    const meta = await globalThis.WQPDataStore.importZip(file, {
        onProgress: ({ current, total, path }) => {
            setStatus(path.startsWith('preprocess ')
                ? '正在预处理 info_data.bin...'
                : `正在导入 ${current}/${total}: ${path}`);
        },
    });
    await notifyIndexedDataUpdated();
    return meta;
}

export async function initSettingsPanel() {
    const form = document.getElementById(ids.form);
    const saveBtn = document.getElementById(ids.save);
    const importDataZipBtn = document.getElementById('importDataZipBtn');
    const importDataZipFile = document.getElementById('importDataZipFile');
    bindLlmApiKeyPlaceholder();
    document.getElementById(ids.llmProvider)?.addEventListener('change', async () => {
        const cherry = applyProviderVisibility();
        setLlmModelHint('');
        if (!cherry) return;
        const baseUrlInput = document.getElementById(ids.llmBaseUrl);
        if (!baseUrlInput.value.trim()) baseUrlInput.value = 'http://127.0.0.1:3000/api/v1';
        await loadLlmModels();
    });
    document.getElementById(ids.llmFetchModels)?.addEventListener('click', () => { loadLlmModels(); });
    applyProviderVisibility();
    document.getElementById(ids.testLlm).addEventListener('click', async () => {
        const testBtn = document.getElementById(ids.testLlm);
        const inlineStatus = document.getElementById('llmTestStatus');
        const show = (message, mode) => {
            if (inlineStatus) {
                inlineStatus.textContent = message;
                inlineStatus.style.color = mode === 'error' ? '#d9534f' : '#2e7d32';
            }
            setStatus(message, mode);
        };
        const llmConfig = readLlmConfigFromForm();
        testBtn.disabled = true;
        show('正在测试 AI 连接...', '');
        try {
            const result = await sendMessage('WQP_LLM_CONFIG_TEST', {
                config: {
                    baseUrl: llmConfig.baseUrl,
                    model: llmConfig.model,
                    apiKey: llmConfig.apiKey,
                },
            });
            const enabledBox = document.getElementById(ids.llmEnabled);
            if (enabledBox) enabledBox.checked = true;
            show(`AI 连接成功：${result?.model || llmConfig.model || '未知模型'}（已自动启用）`, 'success');
        } catch (error) {
            show(`AI 连接失败：${error.message}`, 'error');
        } finally {
            testBtn.disabled = false;
        }
    });

    importDataZipBtn.addEventListener('click', () => {
        importDataZipFile.value = '';
        importDataZipFile.click();
    });

    importDataZipFile.addEventListener('change', async (event) => {
        const file = event.target.files && event.target.files[0];
        if (!file) return;
        importDataZipBtn.disabled = true;
        try {
            const meta = await importDataZip(file);
            const missing = Array.isArray(meta.missingRequired) && meta.missingRequired.length
                ? `，缺少 ${meta.missingRequired.join(', ')}`
                : '';
            setStatus(`导入完成：${meta.fileCount} 个文件，${formatBytes(meta.totalBytes)}，${meta.infoDataKeyCount || 0} 个 info 分片${missing}`, missing ? 'error' : 'success');
            await loadDataMeta();
        } catch (error) {
            setStatus(`导入失败：${error.message}`, 'error');
        } finally {
            importDataZipBtn.disabled = false;
            importDataZipFile.value = '';
        }
    });

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        saveBtn.disabled = true;
        const settings = readSettingsFromForm();
        const llmConfig = readLlmConfigFromForm();
        try {
            await sendMessage('WQP_SETTINGS_SAVE', { settings });
            if (llmConfig.enabled) {
                setStatus('正在测试 AI 模型连接...');
            }
            const savedLlmConfig = await sendMessage('WQP_LLM_CONFIG_SAVE', { config: llmConfig });
            writeLlmConfigToForm(savedLlmConfig || {});
            setStatus(llmConfig.enabled ? '设置已保存，AI 模型连接测试通过。' : '设置已保存，AI 功能已关闭。', 'success');
        } catch (error) {
            setStatus(`保存失败：${error.message}`, 'error');
        } finally {
            saveBtn.disabled = false;
        }
    });

    setStatus('加载设置...');
    const [settingsResult, llmResult] = await Promise.allSettled([
        sendMessage('WQP_SETTINGS_GET'),
        sendMessage('WQP_LLM_CONFIG_GET'),
    ]);
    const errors = [];
    if (settingsResult.status === 'fulfilled') writeSettingsToForm(settingsResult.value || {});
    else errors.push(settingsResult.reason?.message || '基础设置读取失败');
    if (llmResult.status === 'fulfilled') writeLlmConfigToForm(llmResult.value || {});
    else errors.push(llmResult.reason?.message || 'AI 设置读取失败');
    // 选了 Cherry 就自动把模型列表拉下来, 不用手点
    if (llmResult.status === 'fulfilled' && (llmResult.value?.provider === 'cherry')) {
        await loadLlmModels();
    }
    setStatus(errors.length ? `设置加载失败：${errors.join('；')}` : '', errors.length ? 'error' : '');

    const scheduleMetaLoad = globalThis.requestIdleCallback
        ? (callback) => globalThis.requestIdleCallback(callback, { timeout: 1000 })
        : (callback) => setTimeout(callback, 0);
    scheduleMetaLoad(() => loadDataMeta());
}
