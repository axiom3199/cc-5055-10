/* 街景双解 + 复演 + 线源对比无头测试：node test/street.cjs */
const Facade = require('../js/facade.js');
const Street = require('../js/street.js');
const Replay = require('../js/replay.js');

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
};

const data = Facade.buildAll();
const [A, B, Bp] = data.shots;

// 遮挡物理：A 全可见、B 上沿被遮、B' 复演后露出
check('店招 A 完整可见', A.sign.fraction > 0.99, `frac=${A.sign.fraction.toFixed(3)}`);
check('店招 B 上沿藏檐后', B.sign.fraction < 0.95, `frac=${B.sign.fraction.toFixed(3)}`);
check("店招 B' 复演后露出", Bp.sign.fraction > 0.95, `frac=${Bp.sign.fraction.toFixed(3)}`);
check('遮挡随距离翻转（B 与 B′ 状态不同）',
  (B.sign.fraction < 0.95) !== (Bp.sign.fraction < 0.95));

// 标定器：每镜头交出全部焦距候选，病态对显式 null 且带原因（不用默认值遮错）
const sols = data.shots.map((s) => Street.solveShot(s, {}));
let sawNull = false;
for (const [i, sol] of sols.entries()) {
  check(`镜头${data.shots[i].def.id} 给出 3 个灭点对候选`, sol.focalCandidates.length === 3);
  for (const c of sol.focalCandidates) {
    if (c.f === null) {
      sawNull = true;
      check(`镜头${data.shots[i].def.id} 病态候选 ${c.pair} 带原因`, typeof c.reason === 'string' && c.reason.length > 0);
    }
  }
  check(`镜头${data.shots[i].def.id} 至少一个候选可构造相机`,
    sol.focalCandidates.some((c) => c.cam));
  check(`镜头${data.shots[i].def.id} 线-灭点残差有限`,
    sol.residual.rms !== null && isFinite(sol.residual.rms), `rms=${sol.residual.rms}`);
}
check('至少一个镜头出现显式 null 焦距候选（病态不被遮）', sawNull);

// 每个有效候选带对应地面平面
for (const sol of sols) {
  for (const c of sol.focalCandidates) {
    if (c.cam) check(`候选 ${c.pair} 带地面`, c.ground && Array.isArray(c.ground.nCam));
  }
}

// 跨镜头遮挡选解：选中 YZ/YZ，且显著优于狂野候选
const ranking = Street.occlusionRanking(sols.slice(0, 2), [A, B], data.facade, data.boxes, data.model);
const sel = ranking.selected;
check('选解组合遮挡错误为 0', sel.occErrors === 0);
check('选解为 YZ/YZ 稳健对', sel.pair.join('') === 'YZYZ', sel.pair.join('/'));
check('选解焦距接近真值 820',
  Math.abs(sel.f[0] - 820) < 90 && Math.abs(sel.f[1] - 820) < 90,
  sel.f.map((v) => v.toFixed(1)).join('/'));
const wild = ranking.combos.find((cmb) => cmb.pair.join('') === 'XYXY');
if (wild) check('遮挡边界误差能拒绝狂野焦距', sel.boundaryErr < wild.boundaryErr,
  `sel=${sel.boundaryErr} wild=${wild.boundaryErr}`);

// 复演：只移动第二机位、A 锚点不变、遮挡翻转
const rep = Replay.replayCompare(data);
check('复演仅移动第二机位', rep.movedOnly === 'second camera');
check('复演遮挡状态翻转', rep.flipped === true);
check('固定机位 A 锚点保持', rep.fixedAnchor.unchanged === true && rep.fixedAnchor.anchors.length >= 3);
check('复演预测边界均为有限值',
  isFinite(rep.predictedBoundary.B) && isFinite(rep.predictedBoundary["B'"]));

// 线源对比：直接投线在遮挡区产生幻影，提取线无幻影、拟合残差小
const lscB = Replay.lineSourceCompare(data, 1);
check('B 镜头存在幻影像素', lscB.phantomLen > 50, `phantom=${lscB.phantomLen}px`);
check('幻影比例为正且 ≤1', lscB.phantomRatio > 0 && lscB.phantomRatio <= 1);
check('可见部分两线源拟合 RMS < 2px',
  lscB.perLine.every((r) => r.fitRms === null || r.fitRms < 2));
const lscBp = Replay.lineSourceCompare(data, 2);
check("B' 镜头幻影显著少于 B", lscBp.phantomLen < lscB.phantomLen,
  `B'=${lscBp.phantomLen} B=${lscB.phantomLen}`);

console.log(failures ? `\n${failures} 项失败` : '\n街景/复演全部通过');
process.exit(failures ? 1 : 0);
