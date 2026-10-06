// alphaDescriptionContext.test.mjs — AI 描述助手的扩展上下文失效处理
// 切 alphaDescriptionAssistant.js 真实源码 + new Function 沙箱, 沿用既有测试写法。
// 回归背景: 扩展更新/重载后, 已打开页面里的旧 content script 仍在跑但 chrome.runtime 已被置空,
// 直接 sendMessage 会抛 "Cannot read properties of undefined (reading 'sendMessage')"。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(
    path.join(root, 'src/content/platform/alpha/alphaDescriptionAssistant.js'),
    'utf8',
);

function slice(startMark, endMark) {
    const a = src.indexOf(startMark);
    const b = src.indexOf(endMark, a);
    if (a < 0 || b < 0) throw new Error(`切片失败: ${startMark} / ${endMark}`);
    return src.slice(a, b);
}

const sendBlock = slice('const CONTEXT_LOST_HINT', 'function setNativeTextareaValue');

let pass = 0, fail = 0;
function check(name, cond, info = '') {
    if (cond) { pass += 1; console.log('  ok  ', name); }
    else { fail += 1; console.log('  FAIL', name, info); }
}

// chromeArg 就是要挂到沙箱 globalThis 上的 chrome, 用来模拟各种上下文状态
function makeSendMessage(chromeArg) {
    const sandbox = `
      const chrome = __chrome;
      const globalThis = { chrome };
${sendBlock}
      return { isContextAlive, sendMessage, CONTEXT_LOST_HINT };
    `;
    // eslint-disable-next-line no-new-func
    return new Function('__chrome', sandbox)(chromeArg);
}

async function expectReject(promise, hint, name) {
    try {
        await promise;
        check(name, false, '本该 reject, 实际 resolve 了');
    } catch (error) {
        check(name, error.message === hint && !(error instanceof TypeError),
            `message=${error.message}`);
    }
}

console.log('\n[1] chrome 完全不存在 —— 不该再抛 TypeError');
{
    const m = makeSendMessage(undefined);
    check('isContextAlive() === false', m.isContextAlive() === false);
    await expectReject(
        m.sendMessage('WQP_ALPHA_AI_GENERATE_DESCRIPTION', {}),
        m.CONTEXT_LOST_HINT,
        'reject 文案是刷新提示而非 TypeError',
    );
    check('提示文案含“刷新”', /刷新/.test(m.CONTEXT_LOST_HINT), m.CONTEXT_LOST_HINT);
}

console.log('\n[2] chrome 存在但 runtime 被置空(扩展重载后的真实状态)');
{
    const m = makeSendMessage({});
    check('isContextAlive() === false', m.isContextAlive() === false);
    await expectReject(
        m.sendMessage('WQP_ALPHA_AI_GENERATE_DESCRIPTION', {}),
        m.CONTEXT_LOST_HINT,
        'reject 文案是刷新提示而非 TypeError',
    );
}

console.log('\n[3] chrome.runtime 存在但没有 sendMessage');
{
    const m = makeSendMessage({ runtime: { id: 'x' } });
    check('isContextAlive() === false', m.isContextAlive() === false);
    await expectReject(m.sendMessage('X', {}), m.CONTEXT_LOST_HINT, 'reject 刷新提示');
}

console.log('\n[4] 上下文正常 —— 仍然按原来的契约走, 不被新逻辑误伤');
{
    const sent = [];
    const m = makeSendMessage({
        runtime: {
            lastError: null,
            sendMessage(message, callback) {
                sent.push(message);
                callback({ ok: true, data: { description: '生成的描述' } });
            },
        },
    });
    check('isContextAlive() === true', m.isContextAlive() === true);
    const data = await m.sendMessage('WQP_ALPHA_AI_GENERATE_DESCRIPTION', { alphaId: 'abc' });
    check('透传 response.data', data?.description === '生成的描述', JSON.stringify(data));
    check('消息体带上 type 与 payload',
        sent.length === 1 && sent[0].type === 'WQP_ALPHA_AI_GENERATE_DESCRIPTION'
        && sent[0].alphaId === 'abc',
        JSON.stringify(sent));
}

console.log('\n[5] 上下文正常但后台报错 —— 错误文案照旧透出');
{
    const m = makeSendMessage({
        runtime: {
            lastError: { message: 'Could not establish connection.' },
            sendMessage(_message, callback) { callback(undefined); },
        },
    });
    try {
        await m.sendMessage('X', {});
        check('reject lastError 文案', false, '本该 reject');
    } catch (error) {
        check('reject lastError 文案', error.message === 'Could not establish connection.',
            error.message);
    }
}

console.log('\n[6] handleGenerate 在上下文失效时提前返回, 不去跑 buildAlphaContext');
{
    const handleBlock = slice('function showReloadButton(controls) {', 'function createControls(targets) {');
    const sandbox = `
      const chrome = {};
      const globalThis = { chrome };
      const document = {
        createElement: () => ({ className: '', addEventListener: () => {} }),
        querySelectorAll: () => [],
      };
      const location = { reload() { __reloaded = true; } };
      let __reloaded = false;
      const controls = {
        _status: '', _mode: '', _reloadAdded: false, _label: null,
        querySelector(sel) {
          if (sel === '.wqp-alpha-description-ai__actions') {
            const self = this;
            return { querySelector: () => (self._reloadAdded ? {} : null), appendChild() { self._reloadAdded = true; } };
          }
          if (sel === '.wqp-alpha-description-ai__button') {
            return { disabled: false, textContent: 'AI 生成描述' };
          }
          if (sel === '.wqp-alpha-description-ai__reload') return null;
          return null;
        },
      };
      function setStatus(_c, text, mode) { controls._status = text; controls._mode = mode; }
      function updateButtonLabel() {}
      function getAlphaId() { return 'alpha-1'; }
      function buildAlphaContext() { throw new Error('buildAlphaContext 不该被调用'); }
${sendBlock}
${handleBlock}
      return handleGenerate(controls, { kind: 'REGULAR', regular: {} }).then(() => ({
        status: controls._status, mode: controls._mode,
        reloadAdded: controls._reloadAdded,
      }));
    `;
    // eslint-disable-next-line no-new-func
    const run = new Function(sandbox);
    const result = await run();
    check('状态文案是刷新提示', /刷新/.test(result.status || ''), result.status);
    check('状态是 error 态', result.mode === 'error', result.mode);
    check('插入了刷新按钮', result.reloadAdded === true);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);