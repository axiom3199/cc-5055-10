/* 数学核心无头测试：node test/run.cjs */
const Geom = require('../js/geom.js');
const Scene = require('../js/scene.js');
const Estimate = require('../js/estimate.js');

const { shots, grids, room } = Scene.buildAll();
const DEG = 180 / Math.PI;
let failures = 0;

function check(name, cond, detail) {
  const ok = !!cond;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

function baseParams(shot, extra) {
  return Object.assign({
    segments: shot.segments,
    assignments: shot.autoAssignments,
    camDef: { f: shot.def.cam.f, cx: shot.def.cam.cx, cy: shot.def.cam.cy, k1: shot.def.cam.k1 },
    k1Applied: false,
    fMode: 'auto',
    fChained: null,
    hChained: null,
    H: room.height,
    tileW: room.tileCorridor,
    zeroRoll: true,
    knownPoint: { px: shot.knownPointPx, world: shot.def.knownPointWorld },
  }, extra || {});
}

const yawDeg = (sol) => {
  let y = sol.angles.yaw * DEG;
  while (y > 180) y -= 360;
  while (y < -180) y += 360;
  return y;
};

// ---------- 机位1：长廊斜视，独立解算 ----------
{
  const shot = shots[0];
  const sol = Estimate.solve(baseParams(shot, { fMode: 'independent' }));
  console.log('\n[机位1] f =', sol.focal.value && sol.focal.value.toFixed(1),
    ' h =', sol.h && sol.h.toFixed(3), ' yaw =', sol.angles && yawDeg(sol).toFixed(2));
  check('机位1 焦距≈900', sol.focal.value && Math.abs(sol.focal.value - 900) < 30, `f=${sol.focal.value && sol.focal.value.toFixed(1)}`);
  check('机位1 相机高≈1.6', sol.h && Math.abs(sol.h - 1.6) < 0.06, `h=${sol.h && sol.h.toFixed(3)}`);
  check('机位1 偏航≈162.9°', sol.angles && Math.abs(Math.abs(yawDeg(sol)) - 162.9) < 1.0, `yaw=${yawDeg(sol).toFixed(2)}`);
  const rm = Estimate.rulerMeasure(sol, shot.rulerPx[0], shot.rulerPx[1]);
  check('机位1 尺测走廊宽≈2.4m', rm && rm.ok && Math.abs(rm.d - 2.4) < 0.05, `d=${rm && rm.d && rm.d.toFixed(3)}`);
  const val = Estimate.validate(sol, shot, shot.autoAssignments, grids);
  check('机位1 held-out RMS < 3px', val && val.rmsPx !== null && val.rmsPx < 3, `rms=${val && val.rmsPx && val.rmsPx.toFixed(2)}px (${val && val.nHeld} 边)`);
  check('机位1 砖宽误差 < 5cm', val && val.widthErr !== null && val.widthErr < 0.05, `err=${val && val.widthErr && (val.widthErr * 100).toFixed(1)}cm`);
  global.__f1 = sol.focal.value;
  global.__h1 = sol.h;
}

// ---------- 机位2：灭点近无穷远，沿用 vs 独立 ----------
{
  const shot = shots[1];
  const solInd = Estimate.solve(baseParams(shot, { fMode: 'independent' }));
  const solCh = Estimate.solve(baseParams(shot, { fMode: 'chained', fChained: global.__f1 }));
  console.log('\n[机位2] 独立 f =', solInd.focal.value, ' 沿用 f =', solCh.focal.value && solCh.focal.value.toFixed(1));
  const zvp = solCh.vps.Z;
  check('机位2 纵深灭点确实近无穷远', zvp && (zvp.infinite || (zvp.px && Math.hypot(zvp.px[0] - 480, zvp.px[1] - 270) > 4000)),
    zvp && zvp.px ? `|vp|=${Math.hypot(zvp.px[0] - 480, zvp.px[1] - 270).toFixed(0)}px` : 'infinite');
  check('机位2 独立焦距不可解', !solInd.focal.value, `f_ind=${solInd.focal.value}`);
  check('机位2 沿用焦距可解姿态与高度', solCh.cam && Math.abs(solCh.h - 1.6) < 0.12, `h=${solCh.h && solCh.h.toFixed(3)}`);
  const rm = Estimate.rulerMeasure(solCh, shot.rulerPx[0], shot.rulerPx[1]);
  check('机位2 尺测墙基 4.5m', rm && rm.ok && Math.abs(rm.d - 4.5) < 0.15, `d=${rm && rm.d && rm.d.toFixed(3)}`);
  const valCh = Estimate.validate(solCh, shot, shot.autoAssignments, grids);
  const valInd = solInd.cam ? Estimate.validate(solInd, shot, shot.autoAssignments, grids) : null;
  check('机位2 沿用方案 held-out RMS < 6px', valCh && valCh.rmsPx !== null && valCh.rmsPx < 6,
    `rms=${valCh && valCh.rmsPx && valCh.rmsPx.toFixed(2)}px (${valCh && valCh.nHeld} 边)`);
  check('机位2 沿用优于独立', !valInd || valInd.rmsPx === null || valCh.rmsPx < valInd.rmsPx,
    valInd && `ind=${valInd.rmsPx && valInd.rmsPx.toFixed(1)} vs ch=${valCh.rmsPx && valCh.rmsPx.toFixed(1)}`);
}

// ---------- 机位3：横梁遮挡 → 恢复后改善 ----------
{
  const shot = shots[2];
  const fragIds = shot.segments.filter((s) => s.srcTag === 'beam:z=6').map((s) => s.id);
  check('机位3 横梁已裂成两段', fragIds.length === 2, `fragments=${fragIds.length}`);
  const solBefore = Estimate.solve(baseParams(shot, { fMode: 'independent' }));
  const rmBefore = Estimate.rulerMeasure(solBefore, shot.rulerPx[0], shot.rulerPx[1]);
  const mg = Estimate.mergeCollinear(shot.segments, shot.autoAssignments);
  check('机位3 合并产生恢复段', mg.mergedSegs.length >= 1, `merged=${mg.mergedSegs.length}`);
  const segs2 = shot.segments.filter((s) => !mg.removedIds.includes(s.id)).concat(mg.mergedSegs);
  const asg2 = Object.assign({}, shot.autoAssignments);
  for (const id of mg.removedIds) delete asg2[id];
  for (const m of mg.mergedSegs) asg2[m.id] = m.family;
  const solAfter = Estimate.solve(baseParams(shot, { segments: segs2, assignments: asg2, fMode: 'independent' }));
  const rmAfter = Estimate.rulerMeasure(solAfter, shot.rulerPx[0], shot.rulerPx[1]);
  console.log('\n[机位3] 恢复前 f =', solBefore.focal.value && solBefore.focal.value.toFixed(1),
    ' 恢复后 f =', solAfter.focal.value && solAfter.focal.value.toFixed(1),
    ' 尺:', rmBefore.d && rmBefore.d.toFixed(3), '->', rmAfter.d && rmAfter.d.toFixed(3));
  const eB = Math.abs(solBefore.focal.value - 900), eA = Math.abs(solAfter.focal.value - 900);
  check('机位3 恢复后焦距更准', eA < eB, `${eB.toFixed(1)} -> ${eA.toFixed(1)}`);
  const dErrB = Math.abs(rmBefore.d - 2.4), dErrA = Math.abs(rmAfter.d - 2.4);
  check('机位3 恢复后尺距更准', dErrA <= dErrB + 1e-9, `${(dErrB * 100).toFixed(1)}cm -> ${(dErrA * 100).toFixed(1)}cm`);
  const g1 = Geom.groundIntersection(solBefore.cam, shot.rulerPx[0]);
  const reproj = Geom.project(solAfter.cam, g1.G);
  const drift = Math.hypot(reproj[0] - shot.rulerPx[0][0], reproj[1] - shot.rulerPx[0][1]);
  check('机位3 旧尺端重投可计算', isFinite(drift), `drift=${drift.toFixed(2)}px`);
}

// ---------- 机位5：畸变估计与校正 ----------
{
  const shot = shots[4];
  const assigned = shot.segments.filter((s) => shot.autoAssignments[s.id]);
  const est = Estimate.estimateK1(assigned, { f: 900, cx: 480, cy: 270 });
  console.log('\n[机位5] k1 估计 =', est.k1.toFixed(3), '（真值 -0.22）');
  check('机位5 k1 估计接近真值', Math.abs(est.k1 - (-0.22)) < 0.03, `k1=${est.k1.toFixed(3)}`);
  const sol = Estimate.solve(baseParams(shot, {
    fMode: 'independent',
    camDef: { f: 900, cx: 480, cy: 270, k1: est.k1 },
    k1Applied: true,
  }));
  check('机位5 校正后焦距≈900', sol.focal.value && Math.abs(sol.focal.value - 900) < 45,
    `f=${sol.focal.value && sol.focal.value.toFixed(1)}`);
  const val = Estimate.validate(sol, shot, shot.autoAssignments, grids);
  check('机位5 校正后 held-out RMS < 5px', val && val.rmsPx !== null && val.rmsPx < 5,
    `rms=${val && val.rmsPx && val.rmsPx.toFixed(2)}px`);
}

// ---------- 单族线：受约束方向 + 零滚转假设 + 沿用高度 ----------
{
  const shot = shots[0];
  const onlyZ = {};
  for (const [id, fam] of Object.entries(shot.autoAssignments)) if (fam === 'Z') onlyZ[id] = fam;
  const sol = Estimate.solve(baseParams(shot, {
    assignments: onlyZ, fMode: 'chained', fChained: 900, hChained: global.__h1, zeroRoll: true,
  }));
  check('单族线 姿态可按零滚转补全', !!sol.cam, sol.messages.join('；'));
  check('单族线 地平线存在', !!sol.horizon);
  const rm = Estimate.rulerMeasure(sol, shot.rulerPx[0], shot.rulerPx[1]);
  check('单族线 尺测仍可用(≈2.4m)', rm && rm.ok && Math.abs(rm.d - 2.4) < 0.1,
    `d=${rm && rm.d && rm.d.toFixed(3)}`);
  const onlyY = {};
  for (const [id, fam] of Object.entries(shot.autoAssignments)) if (fam === 'Y') onlyY[id] = fam;
  const solY = Estimate.solve(baseParams(shot, { assignments: onlyY, fMode: 'chained', fChained: 900 }));
  check('纯竖直族 地平线可定', !!solY.horizon);
  check('纯竖直族 地面尺不可用（偏航自由）', !solY.cam);
}

// ---------- 机位4：带滚转的长廊转门厅 ----------
{
  const shot = shots[3];
  const sol = Estimate.solve(baseParams(shot, { fMode: 'independent' }));
  console.log('\n[机位4] f =', sol.focal.value && sol.focal.value.toFixed(1),
    ' roll =', sol.angles && (sol.angles.roll * DEG).toFixed(2));
  check('机位4 焦距≈900', sol.focal.value && Math.abs(sol.focal.value - 900) < 35,
    `f=${sol.focal.value && sol.focal.value.toFixed(1)}`);
  check('机位4 滚转≈1°', sol.angles && Math.abs(sol.angles.roll * DEG - 1.0) < 0.4,
    `roll=${sol.angles && (sol.angles.roll * DEG).toFixed(2)}`);
  const rm = Estimate.rulerMeasure(sol, shot.rulerPx[0], shot.rulerPx[1]);
  check('机位4 尺测门厅 3m', rm && rm.ok && Math.abs(rm.d - 3) < 0.12, `d=${rm && rm.d && rm.d.toFixed(3)}`);
  const val = Estimate.validate(sol, shot, shot.autoAssignments, grids);
  check('机位4 held-out RMS < 5px', val && val.rmsPx !== null && val.rmsPx < 5,
    `rms=${val && val.rmsPx && val.rmsPx.toFixed(2)}px (${val && val.nHeld} 边)`);
}

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
