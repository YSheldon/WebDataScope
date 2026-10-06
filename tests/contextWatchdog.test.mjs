// contextWatchdog.test.mjs — 扩展上下文失效的统一兜底横幅
// 切 contextWatchdog.js 真实源码 + new Function 沙箱 + 假定时器/假 DOM, 沿用既有测试写法。
// 背景: 扩展重载后页面上每个注入脚本都会各自弹一条看不懂的错, 这里统一挂一条横幅。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(root, 'src/content/shared/contextWatchdog.js'), 'utf8');

function slice(startMark, endMark) {
    const a = src.indexOf(startMark);
    const b = src.indexOf(endMark, a);
    if (a < 0 || b < 0) throw new Error(`切片失败: ${startMark} / ${endMark}`);
    return src.slice(a, b);
}

const probeBlock = slice('function isContextAlive()', 'function buildBanner()');

let pass = 0, fail = 0;
function check(name, cond, info = '') {
    if (cond) { pass += 1; console.log('  ok  ', name); }
    else { fail += 1; console.log('  FAIL', name, info); }
}

console.log('\n[1] 探针: 只有 runtime.id 才算活着');
{
    // eslint-disable-next-line no-new-func
    const makeProbe = new Function('__chrome', `
        const chrome = __chrome;
        const globalThis = { chrome };
${probeBlock}
        return isContextAlive;
    `);
    check('runtime.id 存在 -> 活着', makeProbe({ runtime: { id: 'abc' } })() === true);
    check('runtime 整个没了 -> 死了', makeProbe({})() === false);
    check('runtime 在但 id 没了 -> 死了(失效的另一种形态)',
        makeProbe({ runtime: { sendMessage() {} } })() === false);
    check('chrome 整个没了 -> 死了', makeProbe(undefined)() === false);
}

console.log('\n[2] 横幅: 失效才出现, 内容与按钮齐全');
{
    // 用一个可变 chrome 驱动两种时机: 先活着, 后失效
    // eslint-disable-next-line no-new-func
    const scenario = new Function(`
        const appended = [];
        const BANNER_ID = 'wqp-context-lost-banner';
        const CHECK_INTERVAL_MS = 1500;
        const state = { alive: true, reloaded: false, timerCleared: false, intervalMs: 0 };
        const location = { reload() { state.reloaded = true; } };
        function makeNode(tag) {
            return {
                tagName: tag, id: '', type: '', textContent: '', style: { cssText: '' },
                children: [], listeners: {},
                setAttribute() {},
                remove() { const i = body.children.indexOf(this); if (i >= 0) body.children.splice(i, 1); },
                addEventListener(ev, fn) { this.listeners[ev] = fn; },
                append(...kids) { this.children.push(...kids); },
                appendChild(kid) { this.children.push(kid); appended.push(kid); return kid; },
            };
        }
        const body = makeNode('body');
        const document = {
            body, documentElement: {},
            createElement: makeNode,
            getElementById: (id) => appended.find((n) => n.id === id) || null,
            addEventListener() {},
        };
        let tick = null;
        function setInterval(fn, ms) { state.intervalMs = ms; tick = fn; return 1; }
        function clearInterval() { state.timerCleared = true; }
        const chromeObj = { runtime: { id: 'abc', sendMessage() {} } };
        const chrome = new Proxy(chromeObj, {
            get(target, prop) {
                if (prop === 'runtime') return state.alive ? target.runtime : undefined;
                return target[prop];
            },
        });
        const globalThis = { chrome };
        const window = globalThis;
${src}
        return {
            state, tick: () => tick && tick(), body, appended,
            clickReload() { appended[0].children[1].children[1].listeners.click(); },
            clickDismiss() { appended[0].children[1].children[0].listeners.click(); },
        };
    `);

    const ctl = scenario();
    check('轮询间隔 1500ms', ctl.state.intervalMs === 1500, String(ctl.state.intervalMs));
    ctl.tick();
    check('上下文还活着时不挂横幅', ctl.appended.length === 0, String(ctl.appended.length));

    ctl.state.alive = false;
    ctl.tick();
    check('失效后挂出横幅', ctl.appended.length === 1, String(ctl.appended.length));
    check('定时器已停, 不再反复检查', ctl.state.timerCleared === true);
    const banner = ctl.appended[0];
    check('横幅挂在 body 上', ctl.body.children.includes(banner));
    check('文案提到刷新', /刷新/.test(banner.children[0].textContent), banner.children[0].textContent);
    check('文案提到扩展已更新', /扩展已更新/.test(banner.children[0].textContent), banner.children[0].textContent);
    check('有「刷新页面」和「忽略」两个按钮', banner.children[1].children.length === 2);

    ctl.clickReload();
    check('点刷新按钮触发 location.reload()', ctl.state.reloaded === true);

    ctl.clickDismiss();
    check('点忽略把横幅移除', ctl.body.children.length === 0, String(ctl.body.children.length));
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);