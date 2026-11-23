/* estimate.js — 由线族分组估计焦距/朝向/地面尺度，并用 held-out 地砖边校验 */
(function (root, factory) {
  const Geom = (typeof module !== 'undefined' && module.exports) ? require('./geom.js') : root.Geom;
  const api = factory(Geom);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Estimate = api;
})(typeof self !== 'undefined' ? self : globalThis, function (Geom) {
  const FAMILIES = ['X', 'Y', 'Z'];
  const FAMILY_LABEL = { X: '横向(X)', Y: '竖向(Y)', Z: '纵深(Z)' };

  // 取线段的“工作点”（按需去畸变）
  function straightenedPoints(seg, camDef, k1Applied) {
    if (!k1Applied || !camDef.k1) return seg.pts;
    const cam = { f: camDef.f, cx: camDef.cx, cy: camDef.cy, k1: camDef.k1 };
    return seg.pts.map((p) => Geom.undistortPixel(cam, p));
  }

  function segmentLine(pts) {
    if (pts.length === 2) return Geom.lineFromPoints(pts[0], pts[1]);
    return Geom.fitLine(pts).line;
  }

  // ---- 畸变估计：让已分组线段尽量变直 ----
  function k1Cost(segs, camDef, k1) {
    const cam = { f: camDef.f, cx: camDef.cx, cy: camDef.cy, k1 };
    let cost = 0, n = 0;
    for (const s of segs) {
      const pts = s.pts.map((p) => Geom.undistortPixel(cam, p));
      const { line } = Geom.fitLine(pts);
      for (const p of pts) {
        const d = Geom.pointLineDist(line, p);
        cost += d * d; n++;
      }
    }
    return n ? cost / n : 0;
  }

  function estimateK1(segs, camDef) {
    let best = 0, bestC = k1Cost(segs, camDef, 0);
    for (let k = -0.45; k <= 0.4501; k += 0.01) {
      const c = k1Cost(segs, camDef, k);
      if (c < bestC) { bestC = c; best = k; }
    }
    const lo = best - 0.01, hi = best + 0.01; // 固定区间，避免边界随 best 移动而失控
    for (let k = lo; k <= hi + 1e-9; k += 0.001) {
      const c = k1Cost(segs, camDef, k);
      if (c < bestC) { bestC = c; best = k; }
    }
    return { k1: best, cost: bestC };
  }

  // ---- 灭点 ----
  function computeVPs(familySegs) {
    const vps = {};
    for (const fam of FAMILIES) {
      const segs = familySegs[fam] || [];
      if (segs.length >= 2) {
        const vp = Geom.vanishingPoint(segs.map((s) => s.line));
        vps[fam] = { vp, infinite: Geom.vpIsInfinite(vp), px: Geom.vpToPixel(vp), n: segs.length };
      } else if (segs.length === 1) {
        vps[fam] = { vp: null, singleLine: segs[0].line, n: 1 };
      } else {
        vps[fam] = { vp: null, n: 0 };
      }
    }
    return vps;
  }

  // ---- 焦距 ----
  // 仅使用主点附近 4000px 内的有限灭点：过远的灭点（近无穷远）在数值上病态
  const VP_PAIR_RANGE = 4000;
  function computeFocal(vps, cx, cy) {
    const cands = [];
    const usable = {};
    for (const fam of FAMILIES) {
      const v = vps[fam];
      usable[fam] = !!(v && v.px && Math.hypot(v.px[0] - cx, v.px[1] - cy) < VP_PAIR_RANGE);
    }
    for (let i = 0; i < FAMILIES.length; i++) {
      for (let j = i + 1; j < FAMILIES.length; j++) {
        const A = FAMILIES[i], B = FAMILIES[j];
        if (!usable[A] || !usable[B]) continue;
        const f = Geom.focalFromVPs(vps[A].px, vps[B].px, cx, cy);
        cands.push({ pair: A + B, f, ok: f !== null });
      }
    }
    const valid = cands.filter((c) => c.ok).map((c) => c.f).sort((a, b) => a - b);
    const f = valid.length ? valid[Math.floor(valid.length / 2)] : null;
    return { f, cands };
  }

  // ---- 姿态 ----
  function colsToMat(cols) {
    return [
      [cols[0][0], cols[1][0], cols[2][0]],
      [cols[0][1], cols[1][1], cols[2][1]],
      [cols[0][2], cols[1][2], cols[2][2]],
    ];
  }

  const CROSS_FOR = {
    X: (c) => Geom.V.cross(c.Y, c.Z),
    Y: (c) => Geom.V.cross(c.Z, c.X),
    Z: (c) => Geom.V.cross(c.X, c.Y),
  };
  const VP_NEAR = 4000; // 灭点距主点超过此值视为远灭点（噪声放大）

  function orthonormalize(cols) {
    for (let it = 0; it < 3; it++) {
      cols.X = Geom.V.normalize(CROSS_FOR.X(cols));
      cols.Y = Geom.V.normalize(CROSS_FOR.Y(cols));
      cols.Z = Geom.V.normalize(CROSS_FOR.Z(cols));
    }
    return cols;
  }

  function buildRotation(vps, f, cx, cy, zeroRoll, messages) {
    const dirs = {}, dist = {};
    for (const fam of FAMILIES) {
      if (vps[fam] && vps[fam].vp) {
        dirs[fam] = Geom.dirFromVP(vps[fam].vp, f, cx, cy);
        const px = vps[fam].px;
        dist[fam] = px ? Math.hypot(px[0] - cx, px[1] - cy) : Infinity;
      }
    }
    const have = FAMILIES.filter((fam) => dirs[fam]);
    let cols = null; // [cX, cY, cZ] = R_cw 的列（房间轴在相机系中的方向）
    if (have.length === 3) {
      const c = { X: dirs.X, Y: dirs.Y, Z: dirs.Z };
      // 最远且噪声最大的灭点，若另两个更近，则用它们的叉积替换
      const far = have.filter((fam) => dist[fam] > VP_NEAR).sort((a, b) => dist[b] - dist[a]);
      if (far.length && far[0] !== undefined) {
        const fam = far[0];
        const others = FAMILIES.filter((x) => x !== fam);
        if (dist[others[0]] < dist[fam] && dist[others[1]] < dist[fam]) {
          c[fam] = Geom.V.normalize(CROSS_FOR[fam](c));
          messages.push(`${FAMILY_LABEL[fam]}灭点过远（>${VP_NEAR}px），改由另两族正交补全。`);
        }
      }
      cols = [c.X, c.Y, c.Z];
      cols = orthonormalize({ X: cols[0], Y: cols[1], Z: cols[2] });
      cols = [cols.X, cols.Y, cols.Z];
    } else if (have.length === 2) {
      const missing = FAMILIES.find((x) => !dirs[x]);
      const c = { X: dirs.X, Y: dirs.Y, Z: dirs.Z };
      c[missing] = Geom.V.normalize(CROSS_FOR[missing](c));
      messages.push(`仅两族线：第三方向由正交性补全（${FAMILY_LABEL[missing]}）。`);
      cols = orthonormalize(c);
      cols = [cols.X, cols.Y, cols.Z];
    } else if (have.length === 1 && zeroRoll && (have[0] === 'X' || have[0] === 'Z')) {
      const fam = have[0];
      let w = dirs[fam].slice();
      if (w[2] < 0) w = Geom.V.scale(w, -1); // 朝前
      const cY = Geom.V.normalize([0, -w[2], w[1]]); // 零滚转：世界“上”在图像中竖直
      if (fam === 'Z') cols = [Geom.V.normalize(Geom.V.cross(cY, w)), cY, w];
      else cols = [w, cY, Geom.V.normalize(Geom.V.cross(w, cY))];
      messages.push(`仅一族线（${FAMILY_LABEL[fam]}）：方向受约束但未定，按零滚转假设补全姿态。`);
    } else if (have.length === 1 && have[0] === 'Y') {
      messages.push('仅竖直族：地平线可定，偏航未定（绕竖直轴自由）。');
      return { Rcw: null, wY: dirs.Y };
    } else {
      return { Rcw: null, wY: null };
    }
    // 行列式修正为右手系
    let Rcw = colsToMat(cols);
    if (Geom.M.det(Rcw) < 0) {
      cols[2] = Geom.V.scale(cols[2], -1);
      Rcw = colsToMat(cols);
    }
    // 竖直轴应大致指向图像上方（世界“上”在相机系中 y 为负）
    if (cols[1][1] > 0) {
      cols[1] = Geom.V.scale(cols[1], -1);
      cols[0] = Geom.V.scale(cols[0], -1);
      Rcw = colsToMat(cols);
    }
    return { Rcw, wY: cols[1] };
  }

  // ---- 相机高度（已知竖线段端点高度）----
  function heightFromVerticals(ySegs, Rwc, f, cx, cy) {
    let num = 0, den = 0, used = 0;
    const cam = { f, cx, cy, C: [0, 0, 0], Rwc, Rcw: Geom.M.T(Rwc), k1: 0 };
    for (const s of ySegs) {
      if (!s.yRange) continue;
      const [y1, y2] = s.yRange;
      const pA = s.pts[0], pB = s.pts[s.pts.length - 1];
      const topPx = pA[1] < pB[1] ? pA : pB;
      const botPx = pA[1] < pB[1] ? pB : pA;
      const w1 = Geom.rayDir(cam, botPx); // y1 端
      const w2 = Geom.rayDir(cam, topPx); // y2 端
      if (Math.abs(w1[1]) < 1e-8 || Math.abs(w2[1]) < 1e-8) continue;
      for (const k of [0, 2]) { // x、z 两个方程
        const A = w1[k] / w1[1], B = w2[k] / w2[1];
        const dBA = B - A;
        if (Math.abs(dBA) < 1e-6) continue;
        num += dBA * (y2 * B - y1 * A);
        den += dBA * dBA;
      }
      used++;
    }
    return den > 0 ? { h: num / den, used } : null;
  }

  // ---- 地面尺度（已知地砖宽，备用路径）----
  function scaleFromTiles(tileSegs, Rwc, f, cx, cy, tileW) {
    const cam = { f, cx, cy, C: [0, 1, 0], Rwc, Rcw: Geom.M.T(Rwc), k1: 0 };
    const hs = [];
    const byKind = { tileX: [], tileZ: [] };
    for (const s of tileSegs) if (byKind[s.kind]) byKind[s.kind].push(s);
    for (const kind of Object.keys(byKind)) {
      const list = byKind[kind].slice().sort((a, b) => a.gridPos - b.gridPos);
      for (let i = 0; i + 1 < list.length; i++) {
        if (Math.abs(list[i + 1].gridPos - list[i].gridPos - tileW) > 1e-6) continue;
        const ground = (px) => {
          const w = Geom.rayDir(cam, px);
          if (w[1] >= -1e-9) return null;
          return [w[0] / -w[1], w[2] / -w[1]]; // h=1 时的地面坐标（相对相机）
        };
        const a1 = ground(list[i].pts[0]), a2 = ground(list[i].pts[list[i].pts.length - 1]);
        const b1 = ground(list[i + 1].pts[0]);
        if (!a1 || !a2 || !b1) continue;
        const d = [a2[0] - a1[0], a2[1] - a1[1]];
        const n = Math.hypot(d[0], d[1]) || 1e-12;
        const dist = Math.abs(d[1] * (b1[0] - a1[0]) - d[0] * (b1[1] - a1[1])) / n;
        if (dist > 1e-6) hs.push(tileW / dist);
      }
    }
    if (!hs.length) return null;
    hs.sort((a, b) => a - b);
    return { h: hs[Math.floor(hs.length / 2)], used: hs.length };
  }

  // ---- 联合精炼（分块交替，避免联合病态）----
  // 块A：灭点对齐残差上精炼 (f, yaw, pitch, roll)；fixF 时焦距固定
  function refineFR(familySegs, f0, angles0, cx, cy, fixF) {
    const FAMS = [['X', [1, 0, 0]], ['Y', [0, 1, 0]], ['Z', [0, 0, 1]]];
    const data = [];
    const famSet = new Set();
    for (const [fam, dir] of FAMS) {
      for (const s of familySegs[fam]) {
        let len = 0;
        for (let i = 0; i + 1 < s.pts.length; i++)
          len += Math.hypot(s.pts[i + 1][0] - s.pts[i][0], s.pts[i + 1][1] - s.pts[i][1]);
        data.push({ dir, line: s.line, w: Math.max(0.25, Math.min(1, len / 200)) });
        famSet.add(fam);
      }
    }
    if (famSet.size < 2 || data.length < 3) return null;
    const unpack = (p) => fixF
      ? { f: f0, yaw: p[0], pitch: p[1], roll: p[2] }
      : { f: p[0], yaw: p[1], pitch: p[2], roll: p[3] };
    const residual = (p) => {
      const { f, yaw, pitch, roll } = unpack(p);
      const { Rcw } = Geom.poseFromAngles(yaw, pitch, roll);
      return data.map((d) => {
        const c = Geom.M.vec(Rcw, d.dir);
        const v = [f * c[0] + cx * c[2], f * c[1] + cy * c[2], c[2]];
        const nn = Math.hypot(v[0], v[1]) || 1e-12;
        return d.w * (d.line[0] * v[0] + d.line[1] * v[1] + d.line[2] * v[2]) / nn;
      });
    };
    const p0 = fixF
      ? [angles0.yaw, angles0.pitch, angles0.roll]
      : [f0, angles0.yaw, angles0.pitch, angles0.roll];
    const best = gaussNewton(residual, p0, (j) => (!fixF && j === 0) ? 0.5 : 1e-6);
    const { f, yaw, pitch, roll } = unpack(best);
    const { Rcw, Rwc } = Geom.poseFromAngles(yaw, pitch, roll);
    return { f, Rcw, Rwc };
  }

  // 块B：已知端点高度竖线的自洽残差上精炼 (pitch, h)（yaw/roll/f 固定）
  function refinePH(familySegs, f, angles0, h0, cx, cy) {
    const verts = [];
    for (const s of familySegs.Y) {
      if (!s.yRange) continue;
      verts.push({ q1: s.pts[0], q2: s.pts[s.pts.length - 1], y1: s.yRange[0], y2: s.yRange[1] });
    }
    if (verts.length < 2 || h0 === null) return null; // 单根竖线时 2 残差定 2 参数会吸收噪声
    const residual = (p) => {
      const [pitch, h] = p;
      const { Rwc } = Geom.poseFromAngles(angles0.yaw, pitch, angles0.roll);
      const rs = [];
      for (const vt of verts) {
        const w1 = Geom.M.vec(Rwc, [(vt.q1[0] - cx) / f, (vt.q1[1] - cy) / f, 1]);
        const w2 = Geom.M.vec(Rwc, [(vt.q2[0] - cx) / f, (vt.q2[1] - cy) / f, 1]);
        if (Math.abs(w1[1]) < 1e-6 || Math.abs(w2[1]) < 1e-6) continue;
        const t1 = (vt.y1 - h) / w1[1], t2 = (vt.y2 - h) / w2[1];
        const sc = f / Math.max(1, Math.abs(t1));
        rs.push(sc * (t1 * w1[0] - t2 * w2[0]));
        rs.push(sc * (t1 * w1[2] - t2 * w2[2]));
      }
      return rs;
    };
    const best = gaussNewton(residual, [angles0.pitch, h0], (j) => j === 0 ? 1e-6 : 1e-4);
    return { pitch: best[0], h: best[1] };
  }

  // 阻尼高斯-牛顿：返回代价最优点（不会比初值差）
  function gaussNewton(residual, p0, epsFn) {
    const cost = (r) => r.reduce((a, v) => a + v * v, 0);
    const n = p0.length;
    let p = p0.slice();
    let bestP = p.slice(), bestC = cost(residual(p));
    for (let it = 0; it < 15; it++) {
      const r0 = residual(p);
      const m = r0.length;
      const J = [];
      for (let j = 0; j < n; j++) {
        const eps = epsFn(j);
        const pj = p.slice(); pj[j] += eps;
        const rj = residual(pj);
        J.push(rj.map((v, i) => (v - r0[i]) / eps));
      }
      const A = [], b = [];
      for (let j = 0; j < n; j++) {
        A.push([]); b.push(0);
        for (let k = 0; k < n; k++) {
          let s = 0;
          for (let i = 0; i < m; i++) s += J[j][i] * J[k][i];
          A[j].push(s);
        }
        A[j][j] += 1e-6;
        let s = 0;
        for (let i = 0; i < m; i++) s += J[j][i] * r0[i];
        b[j] = -s;
      }
      for (let col = 0; col < n; col++) {
        let piv = col;
        for (let r2 = col + 1; r2 < n; r2++) if (Math.abs(A[r2][col]) > Math.abs(A[piv][col])) piv = r2;
        if (Math.abs(A[piv][col]) < 1e-14) continue;
        [A[col], A[piv]] = [A[piv], A[col]]; [b[col], b[piv]] = [b[piv], b[col]];
        for (let r2 = col + 1; r2 < n; r2++) {
          const t = A[r2][col] / A[col][col];
          for (let k = col; k < n; k++) A[r2][k] -= t * A[col][k];
          b[r2] -= t * b[col];
        }
      }
      const delta = new Array(n).fill(0);
      for (let row = n - 1; row >= 0; row--) {
        let s = b[row];
        for (let k = row + 1; k < n; k++) s -= A[row][k] * delta[k];
        delta[row] = Math.abs(A[row][row]) < 1e-14 ? 0 : s / A[row][row];
      }
      const pn = p.map((v, j) => v + 0.7 * delta[j]);
      const cn = cost(residual(pn));
      if (cn < bestC) { bestC = cn; bestP = pn.slice(); }
      p = pn;
    }
    return bestP;
  }

  // ---- 主求解 ----
  function solve(opts) {
    const {
      segments, assignments, camDef, k1Applied,
      fMode, fChained, H, tileW, zeroRoll, knownPoint,
    } = opts;
    const messages = [];
    const cx = camDef.cx, cy = camDef.cy;

    // 1) 整理各族线段
    const familySegs = { X: [], Y: [], Z: [] };
    for (const s of segments) {
      const fam = assignments[s.id];
      if (!fam) continue;
      const pts = straightenedPoints(s, camDef, k1Applied);
      familySegs[fam].push({
        id: s.id, pts, line: segmentLine(pts), kind: s.kind,
        yRange: s.yRange, gridPos: s.gridPos, tileEdge: s.tileEdge,
      });
    }

    // 2) 灭点
    const vps = computeVPs(familySegs);

    // 3) 焦距
    const focalInfo = computeFocal(vps, cx, cy);
    let f = null, fSource = null;
    if (fMode === 'chained') {
      f = fChained || null; fSource = f ? 'chained' : null;
      if (!f) messages.push('沿用模式但上一段没有可用焦距。');
    } else if (fMode === 'independent') {
      f = focalInfo.f; fSource = f ? 'independent' : null;
      if (!f) messages.push('本机位无法独立解焦距（灭点在无穷远、线族不足或 f²<0）。');
    } else { // auto：独立优先，失败回退沿用
      f = focalInfo.f; fSource = f ? 'independent' : null;
      if (!f && fChained) {
        f = fChained; fSource = 'chained-fallback';
        messages.push('本机位无法独立解焦距，回退沿用上一段焦距。');
      }
    }
    if (focalInfo.cands.some((c) => !c.ok)) {
      messages.push('存在 f²<0 的灭点对的：该组合在数值上病态（常见于灭点近无穷远）。');
    }

    // 4) 姿态
    let Rcw = null, Rwc = null, wY = null, angles = null;
    if (f) {
      const r = buildRotation(vps, f, cx, cy, zeroRoll, messages);
      Rcw = r.Rcw; wY = r.wY;
      if (Rcw) {
        Rwc = Geom.M.T(Rcw);
        angles = Geom.anglesFromRwc(Rwc);
      }
    } else {
      messages.push('无焦距：姿态与尺度不可解。');
    }

    // 5) 相机高度 / 地面尺度
    let h = null, hSource = null;
    if (Rwc) {
      const ySegs = familySegs.Y;
      const hv = heightFromVerticals(ySegs, Rwc, f, cx, cy);
      if (hv) { h = hv.h; hSource = `已知竖线端点高度（${hv.used} 段）`; }
      else {
        const assignedTiles = [];
        for (const fam of ['X', 'Z']) for (const s of familySegs[fam]) if (s.tileEdge) assignedTiles.push(s);
        const st = scaleFromTiles(assignedTiles, Rwc, f, cx, cy, tileW);
        if (st) { h = st.h; hSource = `已知砖宽（${st.used} 对）`; }
        else if (opts.hChained) {
          h = opts.hChained; hSource = '沿用上一段相机高度';
          messages.push('本机位无法定地面尺度，沿用上一段相机高度。');
        } else {
          messages.push('地面尺度未定：请标记竖线（已知层高）或相邻地砖边（已知砖宽）。');
        }
      }
    }

    // 5b) 分块联合精炼：灭点块 (f,姿态) 与竖线块 (pitch,h) 交替两轮
    if (Rcw && f) {
      const fixF = fSource === 'chained' || fSource === 'chained-fallback';
      for (let round = 0; round < 2; round++) {
        const rf = refineFR(familySegs, f, angles, cx, cy, fixF);
        if (rf) {
          f = rf.f; Rcw = rf.Rcw; Rwc = rf.Rwc;
          angles = Geom.anglesFromRwc(Rwc);
        }
        const ph = refinePH(familySegs, f, angles, h, cx, cy);
        if (ph) {
          const pose = Geom.poseFromAngles(angles.yaw, ph.pitch, angles.roll);
          Rcw = pose.Rcw; Rwc = pose.Rwc;
          angles = Geom.anglesFromRwc(Rwc);
          if (round === 0) hSource += '（联合精炼）';
          h = ph.h;
        }
      }
    }

    // 6) 平移（已知地面点）
    let C = null;
    if (Rwc && h !== null) {
      if (knownPoint && knownPoint.px) {
        const camTmp = { f, cx, cy, C: [0, h, 0], Rwc, Rcw, k1: 0 };
        const w = Geom.rayDir(camTmp, knownPoint.px);
        if (w[1] < -1e-9) {
          const t = -h / w[1];
          C = [knownPoint.world[0] - t * w[0], h, knownPoint.world[2] - t * w[2]];
        }
      }
      if (!C) {
        C = [0, h, 0];
        messages.push('未标已知地面点：平移未定（距离测量不受影响，绝对校验不可用）。');
      }
    }

    // 7) 地平线
    let horizon = null;
    if (Rcw && f) {
      horizon = Geom.horizonLine({ f, cx, cy, C: C || [0, 1, 0], Rwc, Rcw, k1: 0 });
    } else if (wY && f) {
      const a = wY[0] / f, b = wY[1] / f;
      horizon = [a, b, wY[2] - (wY[0] * cx + wY[1] * cy) / f];
    }

    const cam = (Rwc && h !== null && C)
      ? { f, cx, cy, C, Rwc, Rcw, k1: 0 }
      : null;

    return {
      vps, focal: { value: f, source: fSource, cands: focalInfo.cands },
      Rcw, Rwc, angles, h, hSource, C, horizon, cam, messages,
      nAssigned: Object.values(familySegs).reduce((a, l) => a + l.length, 0),
    };
  }

  // 将三维线段裁剪到相机前方（z_c > zMin），返回世界系端点或 null
  function clipToFront(cam, P1, P2, zMin) {
    const c1 = Geom.M.vec(cam.Rcw, Geom.V.sub(P1, cam.C));
    const c2 = Geom.M.vec(cam.Rcw, Geom.V.sub(P2, cam.C));
    const zm = zMin || 0.05;
    const a = c1[2] > zm, b = c2[2] > zm;
    if (!a && !b) return null;
    const toWorld = (c) => Geom.V.add(cam.C, Geom.M.vec(cam.Rwc, c));
    if (a && b) return [P1, P2];
    const t = (zm - c1[2]) / (c2[2] - c1[2]);
    const m = [c1[0] + t * (c2[0] - c1[0]), c1[1] + t * (c2[1] - c1[1]), zm];
    return a ? [P1, toWorld(m)] : [toWorld(m), P2];
  }

  // 折线裁剪到画面矩形（委托 Geom）
  function clipPtsToRect(pts, W, H) {
    return Geom.clipPtsToRect(pts, W, H);
  }

  // ---- held-out 地砖边校验（走廊 + 门厅两套网格）----
  function validate(sol, shot, assignments, grids) {
    if (!sol.cam) return null;
    const cam = sol.cam;
    const pred = { X: [], Z: [] };
    const addGrid = (list, fam) => {
      for (const g of list) {
        const clipped = clipToFront(cam, g.p1, g.p2);
        if (!clipped) continue;
        // 畸变下投影是曲线：采样成折线
        const pts = [];
        const NS = 24;
        for (let i = 0; i <= NS; i++) {
          const P = [
            clipped[0][0] + (i / NS) * (clipped[1][0] - clipped[0][0]),
            clipped[0][1] + (i / NS) * (clipped[1][1] - clipped[0][1]),
            clipped[0][2] + (i / NS) * (clipped[1][2] - clipped[0][2]),
          ];
          const q = Geom.project(cam, P);
          if (q) pts.push(q);
        }
        if (pts.length >= 2) pred[fam].push({ pos: g.pos, pts });
      }
    };
    for (const gd of [grids.corridor, grids.foyer]) {
      addGrid(gd.tileZ, 'Z');
      addGrid(gd.tileX, 'X');
    }
    const kindWidth = {
      tileZ: grids.corridor.width, tileX: grids.corridor.width,
      ftileZ: grids.foyer.width, ftileX: grids.foyer.width,
    };
    // held-out：未被用户用作约束的地砖边；只在画面内可见部分上测距
    const W = cam.cx * 2, H = cam.cy * 2;
    const held = shot.segments.filter((s) =>
      s.tileEdge && kindWidth[s.kind] && !assignments[s.id]);
    let sum2 = 0, n = 0;
    const perSeg = [];
    for (const s of held) {
      const cands = pred[s.family];
      if (!cands.length) continue;
      const pts = clipPtsToRect(s.pts, W, H);
      if (pts.length < 2) continue;
      let best = Infinity, bestPos = null;
      for (const c of cands) {
        let d = 0;
        for (const p of pts) d += Geom.pointPolylineDist(p, c.pts);
        d /= pts.length;
        if (d < best) { best = d; bestPos = c.pos; }
      }
      sum2 += best * best; n++;
      perSeg.push({ id: s.id, dist: best, gridPos: bestPos });
    }
    // 砖宽核对：每族 held-out 线反投影到地面，对栅格位置做整体最小二乘，
    // 拟合出的间距与已知砖宽比较（比逐对量距抗噪，远端浅擦地角端点噪声大）
    const widthErrs = [];
    for (const kind of Object.keys(kindWidth)) {
      const list = held.filter((s) => s.kind === kind);
      const w = kindWidth[kind];
      const gls = [];
      for (const s of list) {
        const pts = clipPtsToRect(s.pts, W, H);
        if (pts.length < 2) continue;
        const g1 = Geom.groundIntersection(cam, pts[0]);
        const g2 = Geom.groundIntersection(cam, pts[pts.length - 1]);
        if (!g1 || !g2) continue;
        gls.push({
          k: s.gridPos / w,
          m: [(g1.G[0] + g2.G[0]) / 2, (g1.G[2] + g2.G[2]) / 2],
          d: [g2.G[0] - g1.G[0], g2.G[2] - g1.G[2]],
        });
      }
      if (gls.length < 2) continue;
      const d0 = gls[0].d;
      let dx = 0, dz = 0;
      for (const g of gls) {
        const sgn = (g.d[0] * d0[0] + g.d[1] * d0[1]) >= 0 ? 1 : -1;
        dx += sgn * g.d[0]; dz += sgn * g.d[1];
      }
      const dn = Math.hypot(dx, dz) || 1e-12;
      const nx = -dz / dn, nz = dx / dn;
      const ptsK = gls.map((g) => ({ k: g.k, s: nx * g.m[0] + nz * g.m[1] }));
      const km = ptsK.reduce((a, p) => a + p.k, 0) / ptsK.length;
      const sm = ptsK.reduce((a, p) => a + p.s, 0) / ptsK.length;
      let num = 0, den = 0;
      for (const p of ptsK) { num += (p.k - km) * (p.s - sm); den += (p.k - km) * (p.k - km); }
      if (den < 1e-9) continue;
      widthErrs.push(Math.abs(Math.abs(num / den) - w));
    }
    const meanAbsWidthErr = widthErrs.length
      ? widthErrs.reduce((a, e) => a + Math.abs(e), 0) / widthErrs.length : null;
    return {
      nHeld: n,
      rmsPx: n ? Math.sqrt(sum2 / n) : null,
      perSeg,
      widthErr: meanAbsWidthErr,
      nWidth: widthErrs.length,
    };
  }

  // ---- 测量尺 ----
  const GRAZING_MIN = (2.5 * Math.PI) / 180; // 擦地角阈值
  const T_MAX = 150;

  function rulerMeasure(sol, p1, p2) {
    if (!sol.cam) return null;
    const cam = sol.cam;
    const ends = [p1, p2].map((px) => {
      const gi = Geom.groundIntersection(cam, px);
      if (!gi) return { px, status: 'up', G: null };
      if (gi.grazing < GRAZING_MIN || gi.t > T_MAX) {
        return { px, status: 'grazing', G: gi.G, grazing: gi.grazing };
      }
      return { px, status: 'ok', G: gi.G, grazing: gi.grazing };
    });
    const ok = ends.every((e) => e.status === 'ok');
    const d = (ends[0].G && ends[1].G)
      ? Math.hypot(ends[0].G[0] - ends[1].G[0], ends[0].G[2] - ends[1].G[2])
      : null;
    return { ok, d, ends };
  }

  function rulerTruth(trueCam, p1, p2) {
    const g1 = Geom.groundIntersection(trueCam, p1);
    const g2 = Geom.groundIntersection(trueCam, p2);
    if (!g1 || !g2) return null;
    return {
      d: Math.hypot(g1.G[0] - g2.G[0], g1.G[2] - g2.G[2]),
      G1: g1.G, G2: g2.G,
    };
  }

  // ---- 共线碎片合并（恢复被遮横梁）----
  function mergeCollinear(segments, assignments) {
    const byFam = { X: [], Y: [], Z: [] };
    for (const s of segments) {
      const fam = assignments[s.id];
      if (fam) byFam[fam].push(s);
    }
    const removed = new Set();
    const mergedSegs = [];
    const pairs = [];
    for (const fam of Object.keys(byFam)) {
      const list = byFam[fam];
      for (let i = 0; i < list.length; i++) {
        if (removed.has(list[i].id)) continue;
        for (let j = i + 1; j < list.length; j++) {
          if (removed.has(list[j].id)) continue;
          const A = list[i], B = list[j];
          const pa = A.pts[0], pb = A.pts[A.pts.length - 1];
          const qa = B.pts[0], qb = B.pts[B.pts.length - 1];
          let la = Geom.lineFromPoints(pa, pb), lb = Geom.lineFromPoints(qa, qb);
          if (la[0] * lb[0] + la[1] * lb[1] < 0) lb = [-lb[0], -lb[1], -lb[2]];
          // 法向夹角 < 4°
          if (la[0] * lb[0] + la[1] * lb[1] < Math.cos((4 * Math.PI) / 180)) continue;
          // 线间距：互取中点到对方直线的距离（避免用截距外推放大噪声）
          const midA = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
          const midB = [(qa[0] + qb[0]) / 2, (qa[1] + qb[1]) / 2];
          const lineDist = (Geom.pointLineDist(la, midB) + Geom.pointLineDist(lb, midA)) / 2;
          if (lineDist > 6) continue;
          // 沿线方向的间隙
          const dir = [-la[1], la[0]];
          const proj = (p) => p[0] * dir[0] + p[1] * dir[1];
          const a1 = proj(pa), a2 = proj(pb), b1 = proj(qa), b2 = proj(qb);
          const loA = Math.min(a1, a2), hiA = Math.max(a1, a2);
          const loB = Math.min(b1, b2), hiB = Math.max(b1, b2);
          const gap = Math.max(0, Math.max(loA, loB) - Math.min(hiA, hiB));
          const span = Math.max(hiA, hiB) - Math.min(loA, loB);
          if (gap > 0.6 * span) continue;
          // 取四个端点中投影最远的两个作为合并后端点
          const cand = [[pa, a1], [pb, a2], [qa, b1], [qb, b2]];
          cand.sort((u, v) => u[1] - v[1]);
          const p1 = cand[0][0], p2 = cand[cand.length - 1][0];
          const id = `m:${A.id}+${B.id}`;
          mergedSegs.push({
            id, pts: [p1.slice(), p2.slice()], family: fam, kind: 'restored',
            tag: `restored(${A.tag}|${B.tag})`, tileEdge: false, yRange: null,
            srcTag: A.srcTag,
          });
          removed.add(A.id); removed.add(B.id);
          pairs.push([A.id, B.id, id, fam]);
          break;
        }
      }
    }
    return { mergedSegs, removedIds: [...removed], pairs };
  }

  return {
    FAMILY_LABEL, GRAZING_MIN,
    estimateK1, solve, validate, rulerMeasure, rulerTruth, straightenedPoints,
    mergeCollinear,
  };
});
