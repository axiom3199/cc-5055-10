/* 镜头跟踪窗口 UI 冒烟：DOM 桩 + 无头执行 tracking.js
 * 覆盖：素材包载入、建筑线标注（1/2/3/0、撤销、自动/清除）、内核求解、
 * 候选切换、模型投影叠加、双镜头遮挡选解、损坏包失败反馈、内核控件禁用态。 */
const fs = require('fs');
const path = require('path');

const ctx2d = new Proxy({}, {
  get: (t, k) => (k in t ? t[k] : () => {}),
  set: (t, k, v) => { t[k] = v; return true; },
});

function makeEl(id) {
  return {
    id, listeners: {}, style: {}, checked: false, value: '',
    textContent: '', innerHTML: '', className: '', disabled: false, files: null,
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    appendChild(c) { (this.children = this.children || []).push(c); },
    getContext: () => ctx2d,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 540 }),
    width: 960, height: 540,
    fire(ev, arg) { (this.listeners[ev] || []).forEach((f) => f(arg || { target: this })); },
  };
}

const IDS = ['view', 'filePicker', 'loadInfo', 'shotSel', 'shotDesc', 'grpCount',
  'autoBtn', 'clearBtn', 'undoBtn', 'kernelState', 'solveBtn', 'candSel', 'solInfo',
  'residInfo', 'rankBtn', 'rankInfo', 'showObs', 'showModel', 'showVps', 'showSign'];
const els = {};
for (const id of IDS) els[id] = makeEl(id);

global.document = {
  getElementById: (id) => els[id],
  createElement: () => makeEl('option'),
};
const windowListeners = {};
global.window = { addEventListener: (ev, fn) => { (windowListeners[ev] = windowListeners[ev] || []).push(fn); } };
global.fetch = async () => { throw new Error('stub: no network in headless'); };
let packText = '';
global.FileReader = function () {
  this.readAsText = (file) => {
    this.result = (file && file._text !== undefined) ? file._text : packText;
    this.onload({ target: { result: this.result } });
  };
};

global.Geom = require('../js/geom.js');
global.Street = require('../js/street.js');

const src = fs.readFileSync(path.join(__dirname, '../js/tracking.js'), 'utf8');
eval(src);

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
};

const packPath = path.join(__dirname, '../assets/packs/street-facade.pack.json');
packText = fs.readFileSync(packPath, 'utf8');
const pack = JSON.parse(packText);
const T = globalThis.__tracking;
const tick = () => new Promise((r) => setImmediate(r));

(async () => {
  await tick(); // 等 tryAutoLoad 的 fetch reject 落盘
  // 1) 无网络时自动载入失败 → 提示文件选择，控件禁用
  check('未载入时求解按钮禁用', els.solveBtn.disabled === true);
  check('自动载入失败给出反馈', /选择素材包|静态服务器/.test(els.loadInfo.innerHTML));

  // 2) 经文件选择载入真实包
  els.filePicker.files = [{ name: 'street-facade.pack.json', _text: packText }];
  els.filePicker.fire('change');
  check('真实素材包载入成功', T.state.pack !== null, els.loadInfo.innerHTML.slice(0, 60));
  check('载入后内核控件启用', els.solveBtn.disabled === false && els.autoBtn.disabled === false);
  check('载入三个镜头', T.state.shots.length === 3);
  check('默认预分组覆盖全部观测线',
    Object.keys(T.state.assignments).length === T.state.shots[0].segments.length);
  check('内核就绪反馈三族可求灭点', /内核就绪/.test(els.kernelState.innerHTML));

// 3) 建筑线标注交互：1/2/3/0 + 撤销
const shot = T.state.shots[0];
T.state.selected = shot.segments[0].id;
const before = T.state.assignments[shot.segments[0].id];
windowListeners.keydown.forEach((f) => f({ key: '2', preventDefault() {} }));
check('按 2 改为 Y 族', T.state.assignments[shot.segments[0].id] === 'Y');
check('标注后解算失效（需重跑）', T.state.sol === null);
windowListeners.keydown.forEach((f) => f({ key: '0', preventDefault() {} }));
check('按 0 取消分组', !(shot.segments[0].id in T.state.assignments));
windowListeners.keydown.forEach((f) => f({ key: 'z', ctrlKey: true, preventDefault() {} }));
check('Ctrl+Z 恢复标注', T.state.assignments[shot.segments[0].id] === 'Y');
els.clearBtn.fire('click');
check('清除分组后为空', Object.keys(T.state.assignments).length === 0);
check('线族不足给出内核未就绪反馈', /内核未就绪/.test(els.kernelState.innerHTML));
els.autoBtn.fire('click');
check('自动分组恢复', Object.keys(T.state.assignments).length === shot.segments.length);

// 4) 运行内核求解：候选含显式 null 与原因，可构造相机
els.solveBtn.fire('click');
check('内核产出 3 个灭点对候选', T.state.sol.focalCandidates.length === 3);
check('至少一个候选可构造相机', T.state.sol.focalCandidates.some((c) => c.cam));
check('候选表渲染 null 原因（不遮错）', /null|f²|灭点/.test(els.solInfo.innerHTML));
check('残差面板给出数值', /RMS/.test(els.residInfo.innerHTML));
const validIdx = T.state.sol.focalCandidates.findIndex((c) => c.cam);
check('候选选择器在多候选时可用', els.candSel.disabled === false);
// 切换候选 → 选中下标变化、投影绘制不报错
const idx2 = T.state.sol.focalCandidates.findIndex((c, i) => i !== validIdx && c.cam);
if (idx2 >= 0) {
  els.candSel.value = String(idx2);
  els.candSel.fire('change');
  check('切换焦距候选生效', T.state.selCand === idx2);
}

// 5) 双镜头遮挡选解
els.rankBtn.fire('click');
check('遮挡选解产出结果', T.state.ranking !== null, els.rankInfo.innerHTML.slice(0, 70));
check('选解遮挡错误为 0', T.state.ranking && T.state.ranking.selected.occErrors === 0);
check('选解信息回显界面', /选中候选对/.test(els.rankInfo.innerHTML));

// 6) 切换镜头后状态重置
els.shotSel.value = '1';
els.shotSel.fire('change');
check('切换镜头清空旧解', T.state.sol === null && T.state.ranking === null);
els.solveBtn.fire('click');
check('第二镜头可独立求解', T.state.sol && T.state.sol.focalCandidates.some((c) => c.cam));

// 7) 损坏包失败反馈（不静默兜底）
const broken = JSON.parse(JSON.stringify(pack));
delete broken.content;
T.loadPack(broken);
check('损坏包被拒绝并反馈', T.state.pack === null && /不符合约定/.test(els.loadInfo.innerHTML));
check('损坏后求解按钮重新禁用', els.solveBtn.disabled === true);
const wrongKind = JSON.parse(JSON.stringify(pack));
wrongKind.kind = 'something-else';
T.loadPack(wrongKind);
check('错误 kind 被拒绝', T.state.pack === null && /street-facade/.test(els.loadInfo.innerHTML));

// 8) 重新载入正常包恢复
T.loadPack(pack);
check('正常包可重新载入', T.state.pack !== null);

console.log(failures ? `\n${failures} 项失败` : '\n跟踪窗口 UI 冒烟全部通过');
process.exit(failures ? 1 : 0);
})();
