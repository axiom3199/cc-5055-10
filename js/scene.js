/* scene.js — 合成已知房间与多机位输入
 * 房间：长廊 x∈[-1.2,1.2]、z∈[0,12]、高 2.7，尽头接门厅 x∈[-4,4]、z∈[12,20]。
 * 走廊地砖 0.6m，门厅地砖 0.75m，横梁 y=2.55。
 * 机位：1 长廊正视 / 2 正对侧墙(纵深灭点近无穷远) / 3 横梁被风管遮挡 /
 *       4 长廊转入门厅(带滚转) / 5 镜头桶形畸变。
 */
(function (root, factory) {
  const Geom = (typeof module !== 'undefined' && module.exports) ? require('./geom.js') : root.Geom;
  const api = factory(Geom);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Scene = api;
})(typeof self !== 'undefined' ? self : globalThis, function (Geom) {
  const W_IMG = 960, H_IMG = 540;
  const ROOM = {
    corridor: { x0: -1.2, x1: 1.2, z0: 0, z1: 12 },
    foyer: { x0: -4, x1: 4, z0: 12, z1: 20 },
    height: 2.7,
    beamY: 2.55,
    tileCorridor: 0.6,
    tileFoyer: 0.75,
  };

  // 确定性随机数
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gauss(rnd) {
    const u = Math.max(1e-12, rnd()), v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // ---- 房间三维边线 ----
  function buildRoomSegments() {
    const segs = [];
    const C = ROOM.corridor, F = ROOM.foyer, H = ROOM.height, BY = ROOM.beamY;
    const add = (p1, p2, family, kind, tag, extra) =>
      segs.push(Object.assign({ p1, p2, family, kind, tag }, extra || {}));

    // 走廊墙面-地面 / 墙面-天花交线（纵深 Z 族）
    for (const x of [C.x0, C.x1]) {
      add([x, 0, C.z0], [x, 0, C.z1], 'Z', 'wallfloor', `wallfloor:x=${x}`, { yRange: null });
      add([x, H, C.z0], [x, H, C.z1], 'Z', 'wallceil', `wallceil:x=${x}`);
    }
    // 走廊横梁（横向 X 族，y=2.55）
    for (const z of [2, 4, 6, 8, 10]) {
      add([C.x0, BY, z], [C.x1, BY, z], 'X', 'beam', `beam:z=${z}`, { beamZ: z });
    }
    // 走廊地砖：Z 向线 x=-0.6,0,0.6；X 向线 z=0.6k
    for (let k = 1; k <= 3; k++) {
      const x = C.x0 + ROOM.tileCorridor * k;
      add([x, 0, C.z0], [x, 0, C.z1], 'Z', 'tileZ', `tileZ:x=${x.toFixed(2)}`,
        { tileEdge: true, gridPos: x });
    }
    for (let k = 1; k <= 19; k++) {
      const z = ROOM.tileCorridor * k;
      add([C.x0, 0, z], [C.x1, 0, z], 'X', 'tileX', `tileX:z=${z.toFixed(2)}`,
        { tileEdge: true, gridPos: z });
    }
    // 门框（右墙 z=5、左墙 z=8）：竖边高 0..2.1，门楣沿 Z
    for (const d of [{ x: C.x1, z: 5 }, { x: C.x0, z: 8 }]) {
      add([d.x, 0, d.z - 0.45], [d.x, 2.1, d.z - 0.45], 'Y', 'door', `doorV:x=${d.x}:z=${(d.z - 0.45).toFixed(2)}`, { yRange: [0, 2.1] });
      add([d.x, 0, d.z + 0.45], [d.x, 2.1, d.z + 0.45], 'Y', 'door', `doorV:x=${d.x}:z=${(d.z + 0.45).toFixed(2)}`, { yRange: [0, 2.1] });
      add([d.x, 2.1, d.z - 0.45], [d.x, 2.1, d.z + 0.45], 'Z', 'doorTop', `doorTop:x=${d.x}`);
    }
    // 走廊-门厅转角竖线（全高 0..2.7）
    for (const x of [C.x0, C.x1]) {
      add([x, 0, C.z1], [x, H, C.z1], 'Y', 'vertical', `junctionV:x=${x}`, { yRange: [0, H] });
    }
    // 门厅前墙（z=12 两侧段）
    for (const s of [[F.x0, C.x0], [C.x1, F.x1]]) {
      add([s[0], 0, F.z0], [s[1], 0, F.z0], 'X', 'fwallfloor', `fwallfloor:s=${s[0]}`);
      add([s[0], H, F.z0], [s[1], H, F.z0], 'X', 'fwallceil', `fwallceil:s=${s[0]}`);
    }
    // 门厅侧墙与后墙
    for (const x of [F.x0, F.x1]) {
      add([x, 0, F.z0], [x, 0, F.z1], 'Z', 'fwallfloor', `fwallfloor:x=${x}`);
      add([x, H, F.z0], [x, H, F.z1], 'Z', 'fwallceil', `fwallceil:x=${x}`);
      add([x, 0, F.z0], [x, H, F.z0], 'Y', 'vertical', `foyerV:x=${x}:z=${F.z0}`, { yRange: [0, H] });
      add([x, 0, F.z1], [x, H, F.z1], 'Y', 'vertical', `foyerV:x=${x}:z=${F.z1}`, { yRange: [0, H] });
    }
    add([F.x0, 0, F.z1], [F.x1, 0, F.z1], 'X', 'fbackfloor', 'fbackfloor');
    add([F.x0, H, F.z1], [F.x1, H, F.z1], 'X', 'fbackceil', 'fbackceil');
    // 门厅横梁
    for (const z of [14, 16, 18]) {
      add([F.x0, BY, z], [F.x1, BY, z], 'X', 'beam', `fbeam:z=${z}`, { beamZ: z });
    }
    // 门厅右墙壁柱（全高竖线，供机位2竖直族）
    for (const z of [14, 18]) {
      add([F.x1, 0, z], [F.x1, H, z], 'Y', 'vertical', `pilasterV:z=${z}`, { yRange: [0, H] });
    }
    // 门厅地砖 0.75
    for (let k = 1; k <= 9; k++) {
      const x = F.x0 + ROOM.tileFoyer * k;
      add([x, 0, F.z0], [x, 0, F.z1], 'Z', 'ftileZ', `ftileZ:x=${x.toFixed(2)}`, { tileEdge: true, gridPos: x });
    }
    for (let k = 1; k <= 10; k++) {
      const z = F.z0 + ROOM.tileFoyer * k;
      add([F.x0, 0, z], [F.x1, 0, z], 'X', 'ftileX', `ftileX:z=${z.toFixed(2)}`, { tileEdge: true, gridPos: z });
    }
    return segs;
  }

  // 风管（机位 3 的遮挡物）：x∈[-0.5,0.5], y∈[2.0,2.7], z∈[5.6,6.0]
  const DUCT = { min: [-0.5, 2.0, 5.6], max: [0.5, 2.7, 6.0] };
  function ductSegments() {
    const segs = [];
    const [x0, y0, z0] = DUCT.min, [x1, y1, z1] = DUCT.max;
    const add = (p1, p2, family, tag, yRange) =>
      segs.push({ p1, p2, family, kind: 'duct', tag, yRange: yRange || null });
    add([x0, y0, z0], [x1, y0, z0], 'X', 'duct:front:bot');
    add([x0, y0, z1], [x1, y0, z1], 'X', 'duct:back:bot');
    add([x0, y0, z0], [x0, y0, z1], 'Z', 'duct:left:bot');
    add([x1, y0, z0], [x1, y0, z1], 'Z', 'duct:right:bot');
    add([x0, y0, z0], [x0, y1, z0], 'Y', 'ductV:fl', [y0, y1]);
    add([x1, y0, z0], [x1, y1, z0], 'Y', 'ductV:fr', [y0, y1]);
    add([x0, y0, z1], [x0, y1, z1], 'Y', 'ductV:bl', [y0, y1]);
    add([x1, y0, z1], [x1, y1, z1], 'Y', 'ductV:br', [y0, y1]);
    return segs;
  }

  // 射线与 AABB 求交（slab），返回进入 t 或 null
  function rayBox(Cam, P, box) {
    const d = [P[0] - Cam[0], P[1] - Cam[1], P[2] - Cam[2]];
    let t0 = 0, t1 = 1;
    for (let i = 0; i < 3; i++) {
      if (Math.abs(d[i]) < 1e-12) {
        if (Cam[i] < box.min[i] || Cam[i] > box.max[i]) return null;
      } else {
        let a = (box.min[i] - Cam[i]) / d[i], b = (box.max[i] - Cam[i]) / d[i];
        if (a > b) [a, b] = [b, a];
        t0 = Math.max(t0, a); t1 = Math.min(t1, b);
        if (t0 > t1) return null;
      }
    }
    return t0;
  }

  // 计算机位定义
  function shotDefs() {
    const base = { f: 900, cx: W_IMG / 2, cy: H_IMG / 2 };
    return [
      {
        id: 'corr', name: '机位1 · 长廊斜视',
        desc: '横向与纵深灭点均在有限远处，三族线齐全，适合独立解算焦距。',
        cam: Object.assign({}, base, { C: [0, 1.6, 0.8], yaw: Math.PI - 0.3, pitch: -0.01, roll: 0, k1: 0 }),
        knownPointWorld: [-1.2, 0, 12],
        rulerWorld: [[-1.2, 0, 9], [1.2, 0, 9]],
        autoMark: { kinds: { Z: ['wallfloor'], X: ['beam'], Y: ['vertical', 'door'] }, beamZ: [4, 6, 8, 10] },
      },
      {
        id: 'wall', name: '机位2 · 门厅正对侧墙',
        desc: '纵深方向灭点接近无穷远（线在画面中近乎平行），独立焦距病态，宜沿用上一段焦距。',
        cam: Object.assign({}, base, { C: [-2.5, 1.6, 15.5], yaw: -Math.PI / 2 - 0.12, pitch: -0.08, roll: 0, k1: 0 }),
        knownPointWorld: [4, 0, 16],
        rulerWorld: [[4, 0, 14], [4, 0, 18.5]],
        autoMark: { kinds: { Z: ['fwallfloor', 'fwallceil'], X: ['beam', 'fbackfloor', 'fbackceil'], Y: ['vertical'] }, beamZ: [14, 16, 18], wallX: 4 },
      },
      {
        id: 'beam', name: '机位3 · 横梁被风管遮挡',
        desc: 'z=6 横梁中段被风管遮住，裂成两条短段；可“恢复横梁”合并共线碎片再重投尺端。',
        cam: Object.assign({}, base, { C: [0, 1.6, 1.0], yaw: Math.PI - 0.3, pitch: -0.02, roll: 0, k1: 0 }),
        occluders: [DUCT], occludeKinds: ['beam'],
        extraSegs: ductSegments(),
        knownPointWorld: [-1.2, 0, 7.55],
        rulerWorld: [[-1.2, 0, 8], [1.2, 0, 8]],
        autoMark: { kinds: { Z: ['wallfloor'], X: ['beam'], Y: ['vertical', 'door'] }, beamZ: [6, 10] },
      },
      {
        id: 'foyer', name: '机位4 · 长廊转入门厅',
        desc: '走廊尽头接门厅，带 1° 滚转；可对照走廊 0.6m 砖与门厅 0.75m 砖。',
        cam: Object.assign({}, base, { C: [0, 1.6, 9.5], yaw: Math.PI - 0.28, pitch: -0.02, roll: 0.017, k1: 0 }),
        knownPointWorld: [-1.2, 0, 12],
        rulerWorld: [[-1.5, 0, 17], [1.5, 0, 17]],
        autoMark: { kinds: { Z: ['wallfloor', 'fwallfloor', 'wallceil', 'fwallceil'], X: ['beam', 'fwallfloor', 'fbackfloor', 'fbackceil'], Y: ['vertical'] }, beamZ: [10, 14, 16, 18] },
      },
      {
        id: 'distort', name: '机位5 · 镜头畸变',
        desc: '桶形畸变 k1=-0.22，直线变曲线；先“估计畸变”校正，再分组解算。',
        cam: Object.assign({}, base, { C: [0.2, 1.6, 1.0], yaw: Math.PI + 0.3, pitch: -0.035, roll: 0, k1: -0.22 }),
        knownPointWorld: [1.2, 0, 12],
        rulerWorld: [[-1.2, 0, 9], [1.2, 0, 9]],
        autoMark: { kinds: { Z: ['wallfloor', 'doorTop'], X: ['beam', 'fbeam', 'fbackfloor', 'fbackceil'], Y: ['vertical', 'door'] }, beamZ: [6, 8, 10] },
      },
    ];
  }

  // 相机空间裁剪：z_c > zMin
  function clipSegmentCam(p1, p2, zMin) {
    const d = [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]];
    const a = p1[2] > zMin, b = p2[2] > zMin;
    if (!a && !b) return null;
    if (a && b) return [p1, p2];
    const t = (zMin - p1[2]) / (p2[2] - p1[2]);
    const m = [p1[0] + t * d[0], p1[1] + t * d[1], zMin];
    return a ? [p1, m] : [m, p2];
  }

  // 房间平面（L 形）：走廊矩形 ∪ 门厅矩形；墙竖直，平面可见性即可
  function inRoomPlan(x, z) {
    const C = ROOM.corridor, F = ROOM.foyer, E = 1e-6;
    return (x >= C.x0 - E && x <= C.x1 + E && z >= C.z0 - E && z <= C.z1 + E) ||
           (x >= F.x0 - E && x <= F.x1 + E && z >= F.z0 - E && z <= F.z1 + E);
  }

  // 点 P 从相机是否可见：射线 C->P 需留在房间内（平面意义）且不被遮挡物挡住
  function pointVisible(cam, P, occluders) {
    const K = 32;
    for (let i = 1; i <= K; i++) {
      const t = i / K;
      const x = cam.C[0] + t * (P[0] - cam.C[0]);
      const z = cam.C[2] + t * (P[2] - cam.C[2]);
      if (!inRoomPlan(x, z)) return false;
    }
    if (occluders) {
      for (const box of occluders) {
        const thit = rayBox(cam.C, P, box);
        if (thit !== null && thit < 1 - 1e-6) return false;
      }
    }
    return true;
  }

  // 沿段的可见 t 区间
  function visibleIntervals(cam, p1w, p2w, occluders) {
    const N = 240;
    const vis = [];
    let start = null;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const P = [p1w[0] + t * (p2w[0] - p1w[0]), p1w[1] + t * (p2w[1] - p1w[1]), p1w[2] + t * (p2w[2] - p1w[2])];
      const ok = pointVisible(cam, P, occluders);
      if (ok && start === null) start = t;
      if (!ok && start !== null) { vis.push([start, t]); start = null; }
    }
    if (start !== null) vis.push([start, 1]);
    return vis.filter(([a, b]) => b - a > 0.01);
  }

  // 渲染一个机位 -> 二维线段（含噪声、畸变折线、遮挡碎片）
  function renderShot(def, roomSegs, shotIndex) {
    const cam = Geom.makeCamera(def.cam);
    const rnd = mulberry32(1234 + shotIndex * 77);
    const allSegs = roomSegs.concat(def.extraSegs || []);
    const out = [];
    let n = 0;
    const zMin = 0.05;
    for (const s of allSegs) {
      // 世界 -> 相机系裁剪
      const c1 = Geom.M.vec(cam.Rcw, Geom.V.sub(s.p1, cam.C));
      const c2 = Geom.M.vec(cam.Rcw, Geom.V.sub(s.p2, cam.C));
      const clipped = clipSegmentCam(c1, c2, zMin);
      if (!clipped) continue;
      // 回到世界系（裁剪后的端点）
      const w1 = Geom.V.add(cam.C, Geom.M.vec(cam.Rwc, clipped[0]));
      const w2 = Geom.V.add(cam.C, Geom.M.vec(cam.Rwc, clipped[1]));
      // 遮挡（墙体始终生效；盒式遮挡物仅作用于指定类别）
      const occ = (def.occluders && def.occludeKinds && def.occludeKinds.includes(s.kind))
        ? def.occluders : null;
      const intervals = visibleIntervals(cam, w1, w2, occ);
      const fragCount = intervals.length;
      intervals.forEach(([ta, tb], fi) => {
        const A = [w1[0] + ta * (w2[0] - w1[0]), w1[1] + ta * (w2[1] - w1[1]), w1[2] + ta * (w2[2] - w1[2])];
        const B = [w1[0] + tb * (w2[0] - w1[0]), w1[1] + tb * (w2[1] - w1[1]), w1[2] + tb * (w2[2] - w1[2])];
        // 投影（畸变时采样成折线；奇异/后方点处切断）
        const samples = cam.k1 ? 24 : 2;
        const raw = [];
        for (let i = 0; i < samples; i++) {
          const t = i / (samples - 1);
          const P = [A[0] + t * (B[0] - A[0]), A[1] + t * (B[1] - A[1]), A[2] + t * (B[2] - A[2])];
          const px = Geom.project(cam, P);
          if (!px) { raw.push(null); continue; }
          const sig = cam.k1 ? 0.5 : 1.0;
          raw.push([px[0] + gauss(rnd) * sig, px[1] + gauss(rnd) * sig]);
        }
        const runs = [];
        let run = [];
        for (const p of raw) {
          if (p) run.push(p);
          else if (run.length) { runs.push(run); run = []; }
        }
        if (run.length) runs.push(run);
        for (let pts of runs) {
          if (pts.length < 2) continue;
          // 真实照片只保留画面内的部分
          pts = Geom.clipPtsToRect(pts, W_IMG, H_IMG);
          if (pts.length < 2) continue;
          // 端点出画的竖线：端点高度不再对应已知值，yRange 失效（仍可作普通竖线）
          let yRange = s.yRange || null;
          if (yRange) {
            const inFrame = (p) => p && p[0] >= 0 && p[0] <= W_IMG && p[1] >= 0 && p[1] <= H_IMG;
            if (!inFrame(Geom.project(cam, A)) || !inFrame(Geom.project(cam, B))) yRange = null;
          }
          out.push({
            id: `s${shotIndex}:${n++}`,
            pts,
            family: s.family, kind: s.kind, tag: s.tag,
            tileEdge: !!s.tileEdge, gridPos: s.gridPos,
            yRange,
            occluded: fragCount > 1, fragIndex: fi, fragCount,
            srcTag: s.tag,
          });
        }
      });
    }
    return { def, cam, segments: out };
  }

  // 地砖验证网格（世界系）：走廊 0.6m、门厅 0.75m
  function buildGrids() {
    const zs = [], xs = [-1.2, -0.6, 0, 0.6, 1.2];
    for (let k = 1; k <= 19; k++) zs.push(0.6 * k);
    const fxs = [], fzs = [];
    for (let k = 0; k <= 10; k++) fxs.push(-4 + 0.75 * k);
    fxs.push(4);
    for (let k = 0; k <= 10; k++) fzs.push(12 + 0.75 * k);
    fzs.push(20);
    return {
      corridor: {
        tileZ: xs.map((x) => ({ pos: x, p1: [x, 0, 0], p2: [x, 0, 12] })),
        tileX: zs.map((z) => ({ pos: z, p1: [-1.2, 0, z], p2: [1.2, 0, z] })),
        width: 0.6,
      },
      foyer: {
        tileZ: fxs.map((x) => ({ pos: x, p1: [x, 0, 12], p2: [x, 0, 20] })),
        tileX: fzs.map((z) => ({ pos: z, p1: [-4, 0, z], p2: [4, 0, z] })),
        width: 0.75,
      },
    };
  }

  function autoMarkAssignments(shot, def) {
    const am = def.autoMark;
    const res = {};
    for (const s of shot.segments) {
      const kinds = am.kinds[s.family];
      if (!kinds || !kinds.includes(s.kind)) continue;
      if (s.kind === 'beam' && am.beamZ) {
        const m = /z=(\d+)/.exec(s.srcTag);
        if (!m || !am.beamZ.includes(+m[1])) continue;
      }
      if ((s.kind === 'wallfloor' || s.kind === 'wallceil' ||
           s.kind === 'fwallfloor' || s.kind === 'fwallceil') && am.wallX !== undefined) {
        const m = /x=(-?[\d.]+)/.exec(s.srcTag);
        if (!m || Math.abs(+m[1] - am.wallX) > 1e-6) continue;
      }
      res[s.id] = s.family;
    }
    return res;
  }

  function buildAll() {
    const roomSegs = buildRoomSegments();
    const defs = shotDefs();
    const shots = defs.map((d, i) => {
      const shot = renderShot(d, roomSegs, i);
      shot.autoAssignments = autoMarkAssignments(shot, d);
      shot.knownPointPx = Geom.project(shot.cam, d.knownPointWorld);
      shot.rulerPx = d.rulerWorld.map((P) => Geom.project(shot.cam, P));
      return shot;
    });
    return { shots, grids: buildGrids(), room: ROOM, W: W_IMG, H: H_IMG };
  }

  return { buildAll, ROOM, W_IMG, H_IMG, DUCT };
});
