/* geom.js — 相机几何核心：投影、畸变、灭点、焦距、姿态、地面交点
 * 约定：世界系 x 右、y 上、z 沿走廊；地面 y=0。
 * 相机系 x 右、y 下、z 前（右手系：x×y=z）。
 * 规范机位 (yaw=pitch=roll=0)：朝世界 -Z 看，上方为 +Y。
 * Rwc = Ry(yaw)·Rx(pitch)·Rz(roll)·M0，M0=diag(1,-1,-1)。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Geom = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  const V = {
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ],
    norm: (a) => Math.hypot(a[0], a[1], a[2]),
    normalize: (a) => {
      const n = Math.hypot(a[0], a[1], a[2]) || 1;
      return [a[0] / n, a[1] / n, a[2] / n];
    },
  };

  const M = {
    T: (m) => [
      [m[0][0], m[1][0], m[2][0]],
      [m[0][1], m[1][1], m[2][1]],
      [m[0][2], m[1][2], m[2][2]],
    ],
    vec: (m, v) => [
      m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
      m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
      m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ],
    mul: (a, b) => {
      const bt = M.T(b);
      return a.map((row) => bt.map((col) => row[0] * col[0] + row[1] * col[1] + row[2] * col[2]));
    },
    det: (m) => V.dot(m[0], V.cross(m[1], m[2])),
    rotX: (t) => {
      const c = Math.cos(t), s = Math.sin(t);
      return [[1, 0, 0], [0, c, -s], [0, s, c]];
    },
    rotY: (t) => {
      const c = Math.cos(t), s = Math.sin(t);
      return [[c, 0, s], [0, 1, 0], [-s, 0, c]];
    },
    rotZ: (t) => {
      const c = Math.cos(t), s = Math.sin(t);
      return [[c, -s, 0], [s, c, 0], [0, 0, 1]];
    },
  };
  const M0 = [[1, 0, 0], [0, -1, 0], [0, 0, -1]];

  function poseFromAngles(yaw, pitch, roll) {
    const Rwc = M.mul(M.mul(M.rotY(yaw), M.rotX(pitch)), M.mul(M.rotZ(roll), M0));
    return { Rwc, Rcw: M.T(Rwc) };
  }

  function anglesFromRwc(Rwc) {
    const A = M.mul(Rwc, M0); // = Ry·Rx·Rz
    const pitch = Math.asin(Math.max(-1, Math.min(1, -A[1][2])));
    const yaw = Math.atan2(A[0][2], A[2][2]);
    const roll = Math.atan2(A[1][0], A[1][1]);
    return { yaw, pitch, roll };
  }

  function makeCamera(o) {
    const { Rwc, Rcw } = poseFromAngles(o.yaw || 0, o.pitch || 0, o.roll || 0);
    return {
      f: o.f, cx: o.cx, cy: o.cy,
      C: o.C.slice(), yaw: o.yaw || 0, pitch: o.pitch || 0, roll: o.roll || 0,
      k1: o.k1 || 0, Rwc, Rcw,
    };
  }

  function distortNorm(x, y, k1) {
    const r2 = x * x + y * y;
    const s = 1 + k1 * r2;
    return [x * s, y * s];
  }

  function undistortNorm(xd, yd, k1) {
    let x = xd, y = yd;
    for (let i = 0; i < 12; i++) {
      const s = Math.max(0.05, 1 + k1 * (x * x + y * y));
      x = xd / s; y = yd / s;
    }
    return [x, y];
  }

  // 世界点 -> 像素；在相机后方或畸变奇异区（1+k1r² 过小）返回 null
  function project(cam, P) {
    const pc = M.vec(cam.Rcw, V.sub(P, cam.C));
    if (pc[2] <= 1e-6) return null;
    let x = pc[0] / pc[2], y = pc[1] / pc[2];
    if (cam.k1) {
      // 畸变折叠区（缩放因子 < 0.5）在真实照片中不可见，丢弃
      if (1 + cam.k1 * (x * x + y * y) < 0.5) return null;
      [x, y] = distortNorm(x, y, cam.k1);
    }
    return [cam.f * x + cam.cx, cam.f * y + cam.cy];
  }

  // 像素 -> 世界系射线方向（未归一）
  function rayDir(cam, px) {
    let x = (px[0] - cam.cx) / cam.f, y = (px[1] - cam.cy) / cam.f;
    if (cam.k1) [x, y] = undistortNorm(x, y, cam.k1);
    return M.vec(cam.Rwc, [x, y, 1]);
  }

  // 像素 -> 去畸变后的像素坐标（用于直线拟合/灭点）
  function undistortPixel(cam, px) {
    if (!cam.k1) return px.slice();
    const [x, y] = undistortNorm((px[0] - cam.cx) / cam.f, (px[1] - cam.cy) / cam.f, cam.k1);
    return [cam.f * x + cam.cx, cam.f * y + cam.cy];
  }

  // 像素 -> 地面交点；返回 {G:[x,0,z], t, grazing} 或 null
  function groundIntersection(cam, px) {
    const w = rayDir(cam, px);
    const n = V.norm(w);
    const wy = w[1] / n;
    if (w[1] >= -1e-9) return null; // 朝上或平行
    const t = -cam.C[1] / w[1];
    if (t <= 0) return null;
    return {
      G: [cam.C[0] + t * w[0], 0, cam.C[2] + t * w[2]],
      t,
      grazing: Math.asin(Math.min(1, -wy)),
    };
  }

  // 地平线（图像直线 ax+by+c=0）：射线世界 y 分量为 0 的轨迹
  function horizonLine(cam) {
    const wY = [cam.Rcw[0][1], cam.Rcw[1][1], cam.Rcw[2][1]]; // R_cw·e_y：世界上方向在相机系中的表示
    const a = wY[0] / cam.f, b = wY[1] / cam.f;
    const c = wY[2] - (wY[0] * cam.cx + wY[1] * cam.cy) / cam.f;
    return [a, b, c];
  }

  // 擦地角 = th 的等值线：对每列 u 求 v（取地平线下方根）。返回 [[u,v],...]
  function grazingContour(cam, thRad, W, H, samples) {
    const s = Math.sin(thRad);
    const wY = [cam.Rcw[0][1], cam.Rcw[1][1], cam.Rcw[2][1]];
    const pts = [];
    const N = samples || 96;
    for (let i = 0; i <= N; i++) {
      const u = (i / N) * W;
      const xn = (u - cam.cx) / cam.f;
      // worldY(v) = wY·[xn, (v-cy)/f, 1]；|dir| = sqrt(xn²+yn²+1)
      // 解 worldY/|dir| = -s（下方根）
      const A = wY[0] * xn + wY[2] - (wY[1] * cam.cy) / cam.f;
      const B = wY[1] / cam.f;
      // (A + B v)^2 = s^2 (xn^2 + ((v-cy)/f)^2 + 1)，且 A+Bv < 0
      const q = xn * xn + 1;
      const cy = cam.cy, f = cam.f;
      // 展开为关于 v 的二次方程
      const a2 = B * B - (s * s) / (f * f);
      const a1 = 2 * A * B + (2 * s * s * cy) / (f * f);
      const a0 = A * A - s * s * (q + (cy * cy) / (f * f));
      const disc = a1 * a1 - 4 * a2 * a0;
      if (disc < 0) continue;
      const sq = Math.sqrt(disc);
      for (const v of [(-a1 + sq) / (2 * a2), (-a1 - sq) / (2 * a2)]) {
        if (!isFinite(v)) continue;
        if (A + B * v < 0 && v >= -H && v <= 2 * H) { pts.push([u, v]); break; }
      }
    }
    return pts;
  }

  // 过两点的直线（齐次，a²+b²=1）
  function lineFromPoints(p1, p2) {
    const l = V.cross([p1[0], p1[1], 1], [p2[0], p2[1], 1]);
    const n = Math.hypot(l[0], l[1]) || 1;
    return [l[0] / n, l[1] / n, l[2] / n];
  }

  // 点集 PCA 拟合直线
  function fitLine(pts) {
    let mx = 0, my = 0;
    for (const p of pts) { mx += p[0]; my += p[1]; }
    mx /= pts.length; my /= pts.length;
    let sxx = 0, sxy = 0, syy = 0;
    for (const p of pts) {
      const dx = p[0] - mx, dy = p[1] - my;
      sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
    }
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const dir = [Math.cos(theta), Math.sin(theta)];
    const n = [-dir[1], dir[0]];
    return { line: [n[0], n[1], -(n[0] * mx + n[1] * my)], dir, mean: [mx, my] };
  }

  function pointLineDist(l, p) { return Math.abs(l[0] * p[0] + l[1] * p[1] + l[2]); }

  // 对称 3x3 最小特征向量（Jacobi）
  function smallestEigenvector(A) {
    const a = A.map((r) => r.slice());
    let v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let it = 0; it < 64; it++) {
      let p = 0, q = 1, mx = Math.abs(a[0][1]);
      if (Math.abs(a[0][2]) > mx) { p = 0; q = 2; mx = Math.abs(a[0][2]); }
      if (Math.abs(a[1][2]) > mx) { p = 1; q = 2; mx = Math.abs(a[1][2]); }
      if (mx < 1e-13) break;
      const theta = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]);
      const c = Math.cos(theta), s = Math.sin(theta);
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq;
      }
    }
    let idx = 0;
    for (let i = 1; i < 3; i++) if (a[i][i] < a[idx][idx]) idx = i;
    return [v[0][idx], v[1][idx], v[2][idx]];
  }

  // 直线族 -> 灭点（齐次单位向量；v[2]≈0 表示无穷远）
  function vanishingPoint(lines) {
    const Macc = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const l of lines) {
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) Macc[i][j] += l[i] * l[j];
    }
    return smallestEigenvector(Macc);
  }

  function vpIsInfinite(vp) { return Math.abs(vp[2]) < 1e-4; }
  function vpToPixel(vp) {
    if (vpIsInfinite(vp)) return null;
    return [vp[0] / vp[2], vp[1] / vp[2]];
  }

  // 两正交有限灭点求焦距：f² = -(u1-cx)(u2-cx) - (v1-cy)(v2-cy)
  function focalFromVPs(px1, px2, cx, cy) {
    const f2 = -((px1[0] - cx) * (px2[0] - cx) + (px1[1] - cy) * (px2[1] - cy));
    return f2 > 0 ? Math.sqrt(f2) : null;
  }

  // 齐次灭点版焦距：两正交世界方向对应灭点 v1,v2（齐次），主点 (cx,cy)。
  // 由相机系方向点积为 0 推导，无需先把灭点转像素（对近无穷远灭点更稳）。
  // dir_i = [(vix - viz*cx)/f, (viy - viz*cy)/f, viz]，dir1·dir2=0 解 f²。
  function focalFromHomVPs(v1, v2, cx, cy) {
    const a1 = v1[0] - v1[2] * cx, b1 = v1[1] - v1[2] * cy;
    const a2 = v2[0] - v2[2] * cx, b2 = v2[1] - v2[2] * cy;
    const num = -(a1 * a2 + b1 * b2);
    const den = v1[2] * v2[2];
    if (Math.abs(den) < 1e-12) return null; // 任一灭点在无穷远，焦距不可由该对解出
    const f2 = num / den;
    return f2 > 0 ? Math.sqrt(f2) : null;
  }

  // 灭点(齐次) -> 相机系方向（单位向量），支持无穷远灭点
  function dirFromVP(vp, f, cx, cy) {
    return V.normalize([
      (vp[0] - vp[2] * cx) / f,
      (vp[1] - vp[2] * cy) / f,
      vp[2],
    ]);
  }

  // 点到折线最短距离
  function pointPolylineDist(p, pts) {
    let best = Infinity;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      const abx = b[0] - a[0], aby = b[1] - a[1];
      const len2 = abx * abx + aby * aby || 1e-12;
      let t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2;
      t = Math.max(0, Math.min(1, t));
      const dx = p[0] - (a[0] + t * abx), dy = p[1] - (a[1] + t * aby);
      best = Math.min(best, Math.hypot(dx, dy));
    }
    return best;
  }

  // 折线裁剪到矩形（Liang–Barsky，逐边），返回裁剪后的有序点列
  function clipPtsToRect(pts, W, H) {
    const out = [];
    const clip = (p, q) => {
      let t0 = 0, t1 = 1;
      const d = [q[0] - p[0], q[1] - p[1]];
      const tests = [[-d[0], p[0]], [d[0], W - p[0]], [-d[1], p[1]], [d[1], H - p[1]]];
      for (const [dd, uu] of tests) {
        if (Math.abs(dd) < 1e-12) { if (uu < 0) return null; continue; }
        const t = uu / dd;
        if (dd < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
        if (t0 > t1) return null;
      }
      return [[p[0] + t0 * d[0], p[1] + t0 * d[1]], [p[0] + t1 * d[0], p[1] + t1 * d[1]]];
    };
    for (let i = 0; i + 1 < pts.length; i++) {
      const c = clip(pts[i], pts[i + 1]);
      if (!c) continue;
      if (!out.length || Math.hypot(out[out.length - 1][0] - c[0][0], out[out.length - 1][1] - c[0][1]) > 1e-6) {
        out.push(c[0]);
      }
      out.push(c[1]);
    }
    return out;
  }

  return {
    V, M, M0,
    poseFromAngles, anglesFromRwc, makeCamera,
    project, rayDir, undistortPixel, undistortNorm, distortNorm,
    groundIntersection, horizonLine, grazingContour,
    lineFromPoints, fitLine, pointLineDist,
    smallestEigenvector, vanishingPoint, vpIsInfinite, vpToPixel,
    focalFromVPs, focalFromHomVPs, dirFromVP, pointPolylineDist, clipPtsToRect,
  };
});
