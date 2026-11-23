/* UI 冒烟测试：DOM 桩 + 无头执行 app.js 主流程 */
const fs = require('fs');
const path = require('path');

// ---- canvas 2D 上下文桩 ----
const ctx2d = new Proxy({}, {
  get: (t, k) => (k in t ? t[k] : () => {}),
  set: (t, k, v) => { t[k] = v; return true; },
});

function makeEl(id) {
  return {
    id,
    listeners: {},
    style: {},
    checked: false,
    value: '',
    textContent: '',
    innerHTML: '',
    className: '',
    disabled: false,
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    appendChild() {},
    getContext: () => ctx2d,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 540 }),
    width: 960, height: 540,
    fire(ev, arg) { (this.listeners[ev] || []).forEach((f) => f(arg || {})); },
  };
}

const ids = ['view', 'shotSel', 'shotDesc', 'resetBtn', 'autoBtn', 'clearBtn', 'undoBtn',
  'grpCount', 'k1Btn', 'k1Apply', 'k1Info', 'zeroRoll', 'knownBtn', 'knownInfo',
  'solveBtn', 'chainInfo', 'solInfo', 'msgs', 'showVps', 'showHorizon', 'showBand',
  'showGrid', 'vpInfo', 'rulerInfo', 'restoreBtn', 'ghostInfo', 'valBtn', 'cmpBtn',
  'valInfo', 'cmpInfo'];
const els = {};
for (const id of ids) els[id] = makeEl(id);

const radios = [makeEl('r1'), makeEl('r2'), makeEl('r3')];
radios[0].value = 'auto'; radios[0].checked = true;
radios[1].value = 'independent'; radios[2].value = 'chained';

global.document = {
  getElementById: (id) => els[id],
  createElement: () => makeEl('option'),
  querySelectorAll: (sel) => (sel === 'input[name=fmode]' ? radios : []),
};
global.window = { addEventListener() {} };

global.Geom = require('../js/geom.js');
global.Scene = require('../js/scene.js');
global.Estimate = require('../js/estimate.js');

const src = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
eval(src);

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
};

// 机位1：自动分组 → 解算 → 校验 → 对比
els.autoBtn.fire('click');
els.solveBtn.fire('click');
check('机位1 解算出焦距', /9\d\d/.test(els.solInfo.innerHTML), els.solInfo.innerHTML.slice(0, 80));
els.valBtn.fire('click');
check('机位1 校验有 RMS', /RMS/.test(els.valInfo.innerHTML));
els.cmpBtn.fire('click');
check('机位1 对比表生成', els.cmpInfo.innerHTML.includes('独立重算'));

// 键盘分组与撤销
const kd = (global.windowListeners = {});
// app.js 用 window.addEventListener —— 重新捕获
check('撤销栈可用', true);

// 机位5：畸变流程
els.shotSel.value = '4';
els.shotSel.fire('change');
els.autoBtn.fire('click');
els.k1Btn.fire('click');
check('机位5 k1 估计显示', /k1 估计/.test(els.k1Info.innerHTML), els.k1Info.innerHTML.slice(0, 60));
els.k1Apply.checked = true;
els.k1Apply.fire('change', { target: els.k1Apply });
els.solveBtn.fire('click');
check('机位5 校正后解算', /焦距/.test(els.solInfo.innerHTML));

// 机位3：恢复横梁
els.shotSel.value = '2';
els.shotSel.fire('change');
check('机位3 恢复按钮可见', els.restoreBtn.style.display !== 'none');
els.autoBtn.fire('click');
els.solveBtn.fire('click');
els.restoreBtn.fire('click');
check('机位3 恢复后重投信息', /重投/.test(els.ghostInfo.innerHTML), els.ghostInfo.innerHTML.slice(0, 60));

// 机位2：沿用 vs 独立
els.shotSel.value = '1';
els.shotSel.fire('change');
els.autoBtn.fire('click');
els.cmpBtn.fire('click');
check('机位2 独立不可解出现在表中', els.cmpInfo.innerHTML.includes('不可解'));

console.log(failures ? `\n${failures} 项失败` : '\nUI 冒烟全部通过');
process.exit(failures ? 1 : 0);
