/* street.js — 街景双解标定：灭点焦距候选 + 对应地面 + 跨镜头店招遮挡选解
 * 输入 Facade.buildAll() 的素材；真值只用于评测，不参与求解。
 * 流程：
 *   1) 按可见线分组（几何提取线）求三向灭点；
 *   2) 每对正交灭点给一个焦距候选（focalCandidates），并构造对应相机/地面；
 *   3) 候选两两组合，在“店招是否藏在檐后”上与几何观测比对（遮挡一致性）；
 *   4) 综合遮挡错误数与投影残差排序，给出保留解。
 */
(function (root, factory) {
  const Geom = (typeof module !== 'undefined' && module.exports) ? require('./geom.js') : root.Geom;
  const api = factory(Geom);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Street = api;
})(typeof self !== 'undefined' ? self : globalThis, function (Geom) {
  const FAMILIES = ['X', 'Y', 'Z'];

  function segmentLine(pts) {
    return pts.length === 2 ? Geom.lineFromPoints(pts[0], pts[1]) : Geom.fitLine(pts).line;
  }

  // 自动分组：街景素材本身带 family 真值标注；交互模式下由用户 assignments 覆盖
  function defaultAssignments(shot) {
    const res = {};
    for (const s of shot.segments) res[s.id] = s.family;
    return res;
  }

  function familyLines(shot, assignments) {
    const out = { X: [], Y: [], Z: [] };
    for (const s of shot.segments) {
      const fam = assignments[s.id];
      if (!fam) continue;
      out[fam].push({ id: s.id, line: segmentLine(s.pts), seg: s });
    }
    return out;
  }

  function computeVPs(fl) {
    const vps = {};
    for (const fam of FAMILIES) {
      const arr = fl[fam];
      if (arr.length >= 2) {
        const vp = Geom.vanishingPoint(arr.map((x) => x.line));
        vps[fam] = { vp, infinite: Geom.vpIsInfinite(vp), px: Geom.vpToPixel(vp), n: arr.length };
      } else {
        vps[fam] = { vp: null, n: arr.length };
      }
    }
    return vps;
  }

  // 由灭点对生成焦距候选；每对一个候选，避免单值“默认值遮错”
  function focalCandidates(vps, cx, cy) {
    const cands = [];
    for (let i = 0; i < FAMILIES.length; i++) {
      for (let j = i + 1; j < FAMILIES.length; j++) {
        const A = FAMILIES[i], B = FAMILIES[j];
        const va = vps[A], vb = vps[B];
        if (!va.vp || !vb.vp) {
          cands.push({ pair: A + B, f: null, reason: '灭点无穷远或缺失（线族不足）' });
          continue;
        }
        const f = Geom.focalFromHomVPs(va.vp, vb.vp, cx, cy);
        cands.push({
          pair: A + B, f,
          reason: f === null ? 'f²≤0 或灭点近无穷远：该灭点对数值病态' : null,
        });
      }
    }
    return cands;
  }

  // 给定焦距，由三向灭点构造旋转（两族时正交补全）。
  // 灭点只约束方向不约束符号，分两步消歧：先让世界“上”指向图像上方，
  // 再让相机前向 +Z 指向已知像素射线；每步后用右手正交约束重建剩余轴。
  function rotationFromVPs(vps, f, cx, cy, knownPx, knownWorld) {
    // Geom.dirFromVP 返回相机系 +Z 约定，而本工程相机前向为 -Z（见 geom.M0），
    // 与 rayDir 对齐需对灭点方向整体取反。
    const dirs = {};
    for (const fam of FAMILIES) {
      if (vps[fam] && vps[fam].vp) {
        const d = Geom.dirFromVP(vps[fam].vp, f, cx, cy);
        dirs[fam] = Geom.V.scale(d, -1);
      }
    }
    const have = FAMILIES.filter((x) => dirs[x]);
    if (have.length < 2) return null;
    let c = { X: dirs.X, Y: dirs.Y, Z: dirs.Z };
    if (have.length === 2) {
      const missing = FAMILIES.find((x) => !dirs[x]);
      c[missing] = Geom.V.normalize(Geom.V.cross(
        missing === 'X' ? c.Y : c.X,
        missing === 'Z' ? c.Y : c.Z));
    }
    // 第一步：竖直轴 Y 的相机 y 分量必须为负（世界上方在画面中朝上）
    if (c.Y[1] > 0) c.Y = Geom.V.scale(c.Y, -1);
    // 右手正交重建：X = Y × Z，再 Y = Z × X，迭代到稳定
    for (let it = 0; it < 4; it++) {
      c.X = Geom.V.normalize(Geom.V.cross(c.Y, c.Z));
      c.Y = Geom.V.normalize(Geom.V.cross(c.Z, c.X));
      c.Z = Geom.V.normalize(Geom.V.cross(c.X, c.Y));
    }
    // 第二步：前向符号消歧。本工程相机前向为相机系 -Z（见 geom.M0），
    // 故已知地面点 G 应满足 pc.z<0（在前方），且射线世界 y 分量朝下。
    if (knownPx && knownWorld) {
      const build = (zSign) => {
        const Z = Geom.V.scale(c.Z, zSign);
        const X = Geom.V.normalize(Geom.V.cross(c.Y, Z));
        const Y = Geom.V.normalize(Geom.V.cross(Z, X));
        const R = [
          [X[0], Y[0], Z[0]],
          [X[1], Y[1], Z[1]],
          [X[2], Y[2], Z[2]],
        ];
        return { R, Rwc: Geom.M.T(R) };
      };
      const pick = (zSign) => {
        const rot = build(zSign);
        const testCam = { f, cx, cy, C: [0, 0, 0], Rwc: rot.Rwc, Rcw: rot.R, k1: 0 };
        const w = Geom.rayDir(testCam, knownPx);
        const pc = Geom.M.vec(rot.R, Geom.V.sub(knownWorld, [0, 0, 0]));
        return { rot, w, inFront: pc[2] < -0.05, pointsDown: w[1] < -1e-6 };
      };
      const plus = pick(1), minus = pick(-1);
      const score = (o) => (o.inFront ? 1 : 0) + (o.pointsDown ? 1 : 0);
      const chosen = score(plus) >= score(minus) ? plus : minus;
      c = {
        X: [chosen.rot.R[0][0], chosen.rot.R[1][0], chosen.rot.R[2][0]],
        Y: [chosen.rot.R[0][1], chosen.rot.R[1][1], chosen.rot.R[2][1]],
        Z: [chosen.rot.R[0][2], chosen.rot.R[1][2], chosen.rot.R[2][2]],
      };
    }
    let Rcw = [
      [c.X[0], c.Y[0], c.Z[0]],
      [c.X[1], c.Y[1], c.Z[1]],
      [c.X[2], c.Y[2], c.Z[2]],
    ];
    if (Geom.M.det(Rcw) < 0) {
      c.Z = Geom.V.scale(c.Z, -1);
      c.X = Geom.V.normalize(Geom.V.cross(c.Y, c.Z));
      Rcw = [
        [c.X[0], c.Y[0], c.Z[0]],
        [c.X[1], c.Y[1], c.Z[1]],
        [c.X[2], c.Y[2], c.Z[2]],
      ];
    }
    return { Rcw, Rwc: Geom.M.T(Rcw) };
  }

  // 由竖直线（世界等长方向）与相机高度先验求相机高：街景无室内层高，
  // 改用已知地面点 + 竖直灭点方向定高度的“地面平面”表达（n,d）。
  // 地面 y=0：在相机系中由 Rwc 第二行与 C 决定，直接返回世界系地面。
  function groundPlane(Rwc) {
    // 世界地面法向 e_y 在相机系的表示
    const nCam = [Rwc[0][1], Rwc[1][1], Rwc[2][1]];
    return { nCam, worldY: 0 };
  }

  // 用已知地面点（世界 y=0）求相机位置。
  // 单张像片 + 一个地面点无法独立确定相机高，采用素材声明的人眼高先验 CAMERA_H_PRIOR，
  // 该先验写入素材包参数（非真值相机），随来源一起保存。
  const CAMERA_H_PRIOR = 1.6;
  function placeCamera(f, cx, cy, rot, knownPx, knownWorld, k1) {
    const cam0 = { f, cx, cy, C: [0, 0, 0], Rwc: rot.Rwc, Rcw: rot.Rcw, k1: k1 || 0 };
    const w = Geom.rayDir(cam0, knownPx);
    if (w[1] >= -1e-9) return null; // 射线不朝地面
    const lambda = -CAMERA_H_PRIOR / w[1]; // G = C + λw，G_y=0、C_y=CAMERA_H_PRIOR
    const C = [
      knownWorld[0] - lambda * w[0],
      CAMERA_H_PRIOR,
      knownWorld[2] - lambda * w[2],
    ];
    return { f, cx, cy, C, Rwc: rot.Rwc, Rcw: rot.Rcw, k1: k1 || 0, h: CAMERA_H_PRIOR };
  }

  // 预测：在候选相机下，店招前面板各采样点是否可见（被檐口/封檐板遮挡）
  function pointHiddenByBoxes(cam, P, boxes) {
    for (const box of boxes) {
      if (box.ownerKind === 'sign') continue;
      const d = [P[0] - cam.C[0], P[1] - cam.C[1], P[2] - cam.C[2]];
      let t0 = -Infinity, t1 = Infinity, miss = false;
      for (let k = 0; k < 3; k++) {
        if (Math.abs(d[k]) < 1e-12) {
          if (cam.C[k] < box.min[k] || cam.C[k] > box.max[k]) { miss = true; break; }
        } else {
          let a = (box.min[k] - cam.C[k]) / d[k], b = (box.max[k] - cam.C[k]) / d[k];
          if (a > b) [a, b] = [b, a];
          t0 = Math.max(t0, a); t1 = Math.min(t1, b);
          if (t0 > t1) { miss = true; break; }
        }
      }
      if (!miss && t1 > 1e-9 && t0 < 1 - 1e-9) return true;
    }
    return false;
  }

  function predictedSignVisibility(cam, facade, boxes) {
    const S = facade.sign;
    const nx = 24, ny = 12;
    let total = 0, visible = 0;
    for (let i = 0; i <= nx; i++) {
      for (let j = 0; j <= ny; j++) {
        const P = [
          S.min[0] + (i / nx) * (S.max[0] - S.min[0]),
          S.min[1] + (j / ny) * (S.max[1] - S.min[1]),
          S.max[2] + 0.02,
        ];
        const pc = Geom.M.vec(cam.Rcw, Geom.V.sub(P, cam.C));
        if (pc[2] <= 0.05) continue;
        total++;
        if (!pointHiddenByBoxes(cam, P, boxes)) visible++;
      }
    }
    return { total, visible, fraction: total ? visible / total : 0 };
  }

  // 遮挡边界：店招前面板上仍可见的最高世界 y（连续量，对焦距/姿态敏感）
  function signOcclusionBoundary(cam, facade, boxes) {
    const S = facade.sign;
    const z = S.max[2] + 0.02;
    let maxY = null;
    const NX = 12, NY = 240;
    for (let i = 0; i <= NX; i++) {
      const x = S.min[0] + (i / NX) * (S.max[0] - S.min[0]);
      let colMax = null;
      for (let j = 0; j <= NY; j++) {
        const y = S.min[1] + (j / NY) * (S.max[1] - S.min[1]);
        const P = [x, y, z];
        const pc = Geom.M.vec(cam.Rcw, Geom.V.sub(P, cam.C));
        if (pc[2] <= 0.05) continue;
        if (!pointHiddenByBoxes(cam, P, boxes)) colMax = y;
      }
      if (colMax !== null) maxY = maxY === null ? colMax : Math.max(maxY, colMax);
    }
    return maxY;
  }

  // 几何观测的遮挡边界（直接从真实相机算，等价于从可见线提取的上沿）
  function observedOcclusionBoundary(shot, facade, boxes) {
    return signOcclusionBoundary(Geom.makeCamera(shot.def.cam), facade, boxes);
  }

  // 线残差：已分组线到其灭点的齐次距离（像素，归一化）
  function lineVPResidual(fl, vps) {
    let sum2 = 0, n = 0;
    const perFam = {};
    for (const fam of FAMILIES) {
      const vp = vps[fam] && vps[fam].vp;
      if (!vp) { perFam[fam] = null; continue; }
      let s2 = 0, m = 0;
      for (const item of fl[fam]) {
        const l = item.line;
        const d = Math.abs(l[0] * vp[0] + l[1] * vp[1] + l[2] * vp[2]);
        s2 += d * d; m++;
      }
      perFam[fam] = m ? Math.sqrt(s2 / m) : null;
      sum2 += s2; n += m;
    }
    return { rms: n ? Math.sqrt(sum2 / n) : null, perFam };
  }

  // 单镜头解：返回该镜头的全部焦距候选及对应相机/地面
  function solveShot(shot, opts) {
    const cx = shot.def.cam.cx, cy = shot.def.cam.cy;
    const assignments = opts.assignments || defaultAssignments(shot);
    const fl = familyLines(shot, assignments);
    const vps = computeVPs(fl);
    const cands = focalCandidates(vps, cx, cy);
    const residual = lineVPResidual(fl, vps);
    const cameras = [];
    for (const cand of cands) {
      if (cand.f === null) { cameras.push(Object.assign({}, cand, { cam: null, ground: null })); continue; }
      const rot = rotationFromVPs(vps, cand.f, cx, cy, shot.knownPointPx, shot.def.knownPointWorld);
      if (!rot) { cameras.push(Object.assign({}, cand, { cam: null, ground: null })); continue; }
      const cam = placeCamera(cand.f, cx, cy, rot, shot.knownPointPx, shot.def.knownPointWorld);
      const ground = cam ? groundPlane(rot.Rwc) : null;
      cameras.push(Object.assign({}, cand, { cam, ground, angles: cam && Geom.anglesFromRwc(rot.Rwc) }));
    }
    return { vps, focalCandidates: cameras, residual, nAssigned: Object.keys(assignments).length };
  }

  // 双镜头遮挡选解：枚举两镜头有效焦距候选的组合，按遮挡边界一致性排序。
  // obsBoundariesOverride：外部已从观测/素材包得到的遮挡边界（重建场景无真值相机时使用）；
  // 不传则按各镜头真值相机几何计算（合成场景）。
  function occlusionRanking(shotSols, shots, facade, boxes, modelSegs, obsBoundariesOverride) {
    const combos = [];
    const valid = shotSols.map((sol) => sol.focalCandidates.filter((c) => c.cam));
    const modelSegsForRanking = modelSegs || [];
    const obsBoundaries = obsBoundariesOverride ||
      shots.map((sh) => observedOcclusionBoundary(sh, facade, boxes));
    for (const c0 of valid[0]) {
      for (const c1 of valid[1]) {
        let boundaryErr = 0, fracErr = 0, occErrors = 0;
        const perShot = [];
        const cams = [c0.cam, c1.cam];
        shotSols.forEach((sol, si) => {
          const cam = cams[si];
          const pred = predictedSignVisibility(cam, facade, boxes);
          const predB = signOcclusionBoundary(cam, facade, boxes);
          const obs = shots[si].sign;
          const obsB = obsBoundaries[si];
          const bErr = (predB !== null && obsB !== null) ? Math.abs(predB - obsB) : 1.0;
          const fErr = Math.abs(pred.fraction - obs.fraction);
          boundaryErr += bErr;
          fracErr += fErr;
          const obsHidden = obs.fraction < 0.95;
          const predHidden = pred.fraction < 0.95;
          if (obsHidden !== predHidden) occErrors++;
          perShot.push({
            shot: shots[si].def.id,
            obsFraction: Number(obs.fraction.toFixed(4)),
            predFraction: Number(pred.fraction.toFixed(4)),
            obsBoundary: Number(obsB.toFixed(4)),
            predBoundary: predB === null ? null : Number(predB.toFixed(4)),
            boundaryErr: Number(bErr.toFixed(4)),
            obsHidden, predHidden, mismatch: obsHidden !== predHidden ? 1 : 0,
          });
        });
        const rmsSum = shotSols.reduce((a, s) => a + (s.residual.rms || 0), 0);
        // 投影残差：候选相机把世界线重投影到观测片段的像素 RMS
        const repr = cams.map((cam, si) =>
          reprojectionResidual(cam, modelSegsForRanking, shots[si].segments));
        const reprSum = repr.reduce((a, v) => a + (v || 0), 0);
        combos.push({
          pair: [c0.pair, c1.pair],
          f: [c0.f, c1.f],
          cams,
          grounds: [c0.ground, c1.ground],
          occErrors,
          boundaryErr: Number(boundaryErr.toFixed(5)),
          fracErr: Number(fracErr.toFixed(5)),
          perShot,
          lineRms: Number(rmsSum.toFixed(5)),
          reprRms: Number(reprSum.toFixed(3)),
          reprPerShot: repr.map((v) => (v === null ? null : Number(v.toFixed(3)))),
        });
      }
    }
    // 先二值遮挡对错，再连续遮挡边界误差，再投影残差，最后灭点线残差
    combos.sort((a, b) =>
      (a.occErrors - b.occErrors) ||
      (a.boundaryErr - b.boundaryErr) ||
      (a.fracErr - b.fracErr) ||
      (a.reprRms - b.reprRms) ||
      (a.lineRms - b.lineRms));
    return { combos, selected: combos[0] || null, obsBoundaries };
  }

  // 投影残差：候选相机把世界线重投影后，与观测可见片段端点的像素偏差
  function reprojectionResidual(cam, modelSegs, observedSegs) {
    let sum2 = 0, n = 0;
    const byTag = {};
    for (const s of observedSegs) (byTag[s.srcTag] = byTag[s.srcTag] || []).push(s);
    for (const m of modelSegs) {
      const obs = byTag[m.tag];
      if (!obs || !obs.length) continue;
      const p1 = Geom.project(cam, m.p1), p2 = Geom.project(cam, m.p2);
      if (!p1 || !p2) continue;
      const line = Geom.lineFromPoints(p1, p2);
      for (const frag of obs) for (const p of frag.pts) {
        const d = Geom.pointLineDist(line, p);
        sum2 += d * d; n++;
      }
    }
    return n ? Math.sqrt(sum2 / n) : null;
  }

  return {
    defaultAssignments, familyLines, computeVPs, focalCandidates, rotationFromVPs,
    placeCamera, groundPlane, predictedSignVisibility, signOcclusionBoundary,
    observedOcclusionBoundary, pointHiddenByBoxes, lineVPResidual,
    solveShot, occlusionRanking, reprojectionResidual, segmentLine,
    CAMERA_H_PRIOR,
  };
});
