/* facade.js — 合成临街店招场景（已知相机与消失方向）
 * 世界系：x 沿街向右、y 上、z 离墙朝向街道；正立面 z=0，地面 y=0。
 * 简模：正立面 + 右侧墙（x=6 后退到 z=8）+ 挑檐板（遮挡盒）+ 墙挂店招（遮挡盒）。
 * 机位：A 固定机位；B 街对面机位（店招上沿藏在檐后）；
 *       B' 仅移动第二机位得到的复演机位（店招露出）。A 在两次复演间完全不变。
 */
(function (root, factory) {
  const Geom = (typeof module !== 'undefined' && module.exports) ? require('./geom.js') : root.Geom;
  const api = factory(Geom);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Facade = api;
})(typeof self !== 'undefined' ? self : globalThis, function (Geom) {
  const W_IMG = 960, H_IMG = 540;

  const FACADE = {
    wall: { x0: -6, x1: 6, yTop: 3.6, z: 0 },
    sideWall: { x: 6, z1: 8, yTop: 3.6 },
    // 挑檐：水平顶板 + 前缘竖向封檐板（fascia，真正产生距离相关遮挡）
    eave: { min: [-6.2, 3.3, -0.6], max: [6.2, 3.6, 0.85] },
    fascia: { min: [-6.2, 3.05, 0.78], max: [6.2, 3.3, 0.85] },
    sign: { min: [-1.6, 2.5, -0.1], max: [1.6, 3.18, 0.12] },
    ground: { y: 0 },
  };
  // 遮挡盒：檐板、封檐板与店招。boxOwner 标注盒自身边线，自身不遮自身。
  const BOXES = [
    { name: 'eave', min: FACADE.eave.min, max: FACADE.eave.max, ownerKind: 'eave' },
    { name: 'fascia', min: FACADE.fascia.min, max: FACADE.fascia.max, ownerKind: 'fascia' },
    { name: 'sign', min: FACADE.sign.min, max: FACADE.sign.max, ownerKind: 'sign' },
  ];

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

  // ---- 三维线组（简模）----
  function buildFacadeSegments() {
    const segs = [];
    const W = FACADE.wall, SW = FACADE.sideWall;
    const add = (p1, p2, family, kind, tag, extra) =>
      segs.push(Object.assign({ p1, p2, family, kind, tag }, extra || {}));

    // 正立面竖线 Y（x = -6,-3,0,3,6），分段以体现窗洞，但保持消失方向可用
    for (const x of [-6, -3, 0, 3, 6]) {
      add([x, 0, 0], [x, 1.1, 0], 'Y', 'facadeV', `facV:lo:x=${x}`);
      add([x, 1.1, 0], [x, 2.4, 0], 'Y', 'facadeV', `facV:mid:x=${x}`);
      add([x, 2.4, 0], [x, 3.3, 0], 'Y', 'facadeV', `facV:hi:x=${x}`);
    }
    // 正立面横线 X：墙基线、窗上下沿、檐下口
    for (const y of [0, 1.1, 2.4, 3.3]) {
      add([W.x0, y, 0], [W.x1, y, 0], 'X', y === 0 ? 'groundWall' : 'facadeH',
        `facH:y=${y}`);
    }
    // 挑檐边线（盒自身，boxOwner=0）
    const E = FACADE.eave;
    add([E.min[0], E.min[1], E.max[2]], [E.max[0], E.min[1], E.max[2]], 'X', 'eave', 'eave:front:under', { boxOwner: 0 });
    add([E.min[0], E.max[1], E.max[2]], [E.max[0], E.max[1], E.max[2]], 'X', 'eave', 'eave:front:top', { boxOwner: 0 });
    add([E.max[0], E.min[1], E.min[2]], [E.max[0], E.min[1], E.max[2]], 'Z', 'eave', 'eave:right:under', { boxOwner: 0 });
    add([E.max[0], E.max[1], E.min[2]], [E.max[0], E.max[1], E.max[2]], 'Z', 'eave', 'eave:right:top', { boxOwner: 0 });

    // 封檐板（fascia）边线：竖向板自身（boxOwner=1）
    const FC = FACADE.fascia;
    add([FC.min[0], FC.min[1], FC.max[2]], [FC.max[0], FC.min[1], FC.max[2]], 'X', 'fascia', 'fascia:under', { boxOwner: 1 });
    add([FC.min[0], FC.max[1], FC.max[2]], [FC.max[0], FC.max[1], FC.max[2]], 'X', 'fascia', 'fascia:top', { boxOwner: 1 });
    add([FC.max[0], FC.min[1], FC.min[2]], [FC.max[0], FC.min[1], FC.max[2]], 'Z', 'fascia', 'fascia:right', { boxOwner: 1 });

    // 店招矩形（盒自身，boxOwner=2）：四根边
    const S = FACADE.sign;
    add([S.min[0], S.min[1], S.max[2]], [S.max[0], S.min[1], S.max[2]], 'X', 'sign', 'sign:bot', { boxOwner: 2, signEdge: true });
    add([S.min[0], S.max[1], S.max[2]], [S.max[0], S.max[1], S.max[2]], 'X', 'sign', 'sign:top', { boxOwner: 2, signEdge: true });
    add([S.min[0], S.min[1], S.max[2]], [S.min[0], S.max[1], S.max[2]], 'Y', 'sign', 'sign:left', { boxOwner: 2, signEdge: true });
    add([S.max[0], S.min[1], S.max[2]], [S.max[0], S.max[1], S.max[2]], 'Y', 'sign', 'sign:topR', { boxOwner: 2, signEdge: true });
    // 店招上的字杆（横线，纹理不足场景下也能提供 X 方向约束）
    for (let i = 1; i <= 3; i++) {
      const x0 = S.min[0] + (i * (S.max[0] - S.min[0])) / 4 - 0.28;
      add([x0, 2.78, S.max[2]], [x0 + 0.56, 2.78, S.max[2]], 'X', 'sign', `sign:glyph:${i}`, { boxOwner: 2 });
    }

    // 右侧墙（x=6 后退）：地面/檐口 Z 线 + 竖线
    add([SW.x, 0, 0], [SW.x, 0, SW.z1], 'Z', 'groundWall', 'side:ground');
    add([SW.x, 3.3, 0], [SW.x, 3.3, SW.z1], 'Z', 'facadeH', 'side:eaveunder');
    add([SW.x, 3.6, 0], [SW.x, 3.6, SW.z1], 'Z', 'eave', 'side:eavetop', { boxOwner: 0 });
    for (const z of [2, 4, 6, 8]) {
      add([SW.x, 0, z], [SW.x, 2.4, z], 'Y', 'facadeV', `sideV:z=${z}`);
      add([SW.x, 1.1, z], [SW.x, 3.3, z], 'Y', 'facadeV', `sideVhi:z=${z}`);
    }
    // 街面横向线（地面 X 族，z=3,6,9,12），提供地面约束
    for (const z of [3, 6, 9, 12]) {
      add([W.x0, 0, z], [W.x1 + 2, 0, z], 'X', 'groundLine', `ground:z=${z}`, { groundEdge: true, gridPos: z });
    }
    // 人行道纵线（地面 Z 族）
    for (const x of [-3, 0, 3]) {
      add([x, 0, 0.5], [x, 0, 13], 'Z', 'groundLine', `ground:x=${x}`, { groundEdge: true, gridPos: x });
    }
    return segs;
  }

  // 射线与 AABB 求交，返回真实参数区间 {t0,t1}（不钳制到[0,1]），不相交返回 null
  function rayBox(C, P, box) {
    const d = [P[0] - C[0], P[1] - C[1], P[2] - C[2]];
    let t0 = -Infinity, t1 = Infinity;
    for (let i = 0; i < 3; i++) {
      if (Math.abs(d[i]) < 1e-12) {
        if (C[i] < box.min[i] || C[i] > box.max[i]) return null;
      } else {
        let a = (box.min[i] - C[i]) / d[i], b = (box.max[i] - C[i]) / d[i];
        if (a > b) [a, b] = [b, a];
        t0 = Math.max(t0, a); t1 = Math.min(t1, b);
        if (t0 > t1) return null;
      }
    }
    return { t0, t1 };
  }

  function pointVisible(cam, P, ownerKind) {
    for (const box of BOXES) {
      if (box.ownerKind === ownerKind) continue;
      const hit = rayBox(cam.C, P, box);
      // 射线在起点与 P 之间（开区间）穿过盒体 → 被遮挡
      if (hit && hit.t1 > 1e-9 && hit.t0 < 1 - 1e-9) return false;
    }
    return true;
  }

  function visibleIntervals(cam, p1w, p2w, ownerKind) {
    const N = 200;
    const vis = [];
    let start = null;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const P = [
        p1w[0] + t * (p2w[0] - p1w[0]),
        p1w[1] + t * (p2w[1] - p1w[1]),
        p1w[2] + t * (p2w[2] - p1w[2]),
      ];
      const ok = pointVisible(cam, P, ownerKind);
      if (ok && start === null) start = t;
      if (!ok && start !== null) { vis.push([start, t]); start = null; }
    }
    if (start !== null) vis.push([start, 1]);
    return vis.filter(([a, b]) => b - a > 0.012);
  }

  function clipSegmentCam(p1, p2, zMin) {
    const d = [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]];
    const a = p1[2] > zMin, b = p2[2] > zMin;
    if (!a && !b) return null;
    if (a && b) return [p1, p2];
    const t = (zMin - p1[2]) / (p2[2] - p1[2]);
    const m = [p1[0] + t * d[0], p1[1] + t * d[1], zMin];
    return a ? [p1, m] : [m, p2];
  }

  // 店招被檐板遮挡的面积比例（在店招前面板上采样，供跨镜头遮挡测试）
  function signVisibility(cam) {
    const S = FACADE.sign;
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
        if (pointVisible(cam, P, 'sign')) visible++;
      }
    }
    return { total, visible, fraction: total ? visible / total : 0 };
  }

  // 几何遮挡重新提取的可见线（fragment 级别）
  function renderShot(def, roomSegs, shotIndex) {
    const cam = Geom.makeCamera(def.cam);
    const rnd = mulberry32(9001 + shotIndex * 131);
    const out = [];
    let n = 0;
    const zMin = 0.05;
    for (const s of roomSegs) {
      const c1 = Geom.M.vec(cam.Rcw, Geom.V.sub(s.p1, cam.C));
      const c2 = Geom.M.vec(cam.Rcw, Geom.V.sub(s.p2, cam.C));
      const clipped = clipSegmentCam(c1, c2, zMin);
      if (!clipped) continue;
      const w1 = Geom.V.add(cam.C, Geom.M.vec(cam.Rwc, clipped[0]));
      const w2 = Geom.V.add(cam.C, Geom.M.vec(cam.Rwc, clipped[1]));
      const intervals = visibleIntervals(cam, w1, w2, s.kind);
      const fragCount = intervals.length;
      intervals.forEach(([ta, tb], fi) => {
        const A = [w1[0] + ta * (w2[0] - w1[0]), w1[1] + ta * (w2[1] - w1[1]), w1[2] + ta * (w2[2] - w1[2])];
        const B = [w1[0] + tb * (w2[0] - w1[0]), w1[1] + tb * (w2[1] - w1[1]), w1[2] + tb * (w2[2] - w1[2])];
        const pts = [];
        for (const P of [A, B]) {
          const px = Geom.project(cam, P);
          if (!px) { pts.push(null); continue; }
          pts.push([px[0] + gauss(rnd) * 0.9, px[1] + gauss(rnd) * 0.9]);
        }
        if (pts[0] && pts[1]) {
          const clippedPts = Geom.clipPtsToRect(pts, W_IMG, H_IMG);
          if (clippedPts.length < 2) return;
          out.push({
            id: `f${shotIndex}:${n++}`,
            pts: clippedPts,
            family: s.family, kind: s.kind, tag: s.tag,
            signEdge: !!s.signEdge, groundEdge: !!s.groundEdge, gridPos: s.gridPos,
            occluded: fragCount > 1, fragIndex: fi, fragCount, srcTag: s.tag,
            worldP1: A, worldP2: B,
          });
        }
      });
    }
    const sv = signVisibility(cam);
    return { def, cam, segments: out, sign: sv };
  }

  // 合成场景直接投线：不经遮挡提取，整条模型线直接投影（对照组）
  function directProjectedLines(def, roomSegs) {
    const cam = Geom.makeCamera(def.cam);
    const out = [];
    for (const s of roomSegs) {
      const p1 = Geom.project(cam, s.p1), p2 = Geom.project(cam, s.p2);
      if (!p1 || !p2) continue;
      const pts = Geom.clipPtsToRect([p1, p2], W_IMG, H_IMG);
      if (pts.length < 2) continue;
      out.push({ id: `d:${s.tag}`, pts, family: s.family, kind: s.kind, tag: s.tag, srcTag: s.tag });
    }
    return out;
  }

  function shotDefs() {
    const base = { f: 820, cx: W_IMG / 2, cy: H_IMG / 2, k1: 0 };
    return [
      {
        id: 'A', name: '街景机位A · 近景固定机位',
        desc: '近景正视，店招完整可见；作为复演中不修改的固定机位，锚点在两次求解间保持。',
        cam: Object.assign({}, base, { C: [1.7, 1.5, 5.0], yaw: -0.28, pitch: 0.03, roll: 0 }),
        knownPointWorld: [0, 0, 0],
        anchorWorld: [[-3, 0, 0], [3, 0, 0], [-3, 3.3, 0], [3, 3.3, 0]],
      },
      {
        id: 'B', name: '街景机位B · 街对面（店招藏檐后）',
        desc: '退到街对面，店招上沿被挑檐遮住；与 A 构成双解街景素材的第二机位。',
        cam: Object.assign({}, base, { C: [-0.5, 1.6, 16.0], yaw: 0.10, pitch: -0.02, roll: 0 }),
        knownPointWorld: [0, 0, 3],
        anchorWorld: [[-3, 0, 0], [3, 0, 0]],
      },
      {
        id: "B'", name: "街景机位B' · 仅移动第二机位的复演",
        desc: '只移动第二机位（更靠近、稍抬俯仰），店招不再藏在檐后；机位 A 与其锚点保持不变。',
        cam: Object.assign({}, base, { C: [-0.5, 1.6, 6.2], yaw: 0.10, pitch: -0.03, roll: 0 }),
        knownPointWorld: [0, 0, 3],
        anchorWorld: [[-3, 0, 0], [3, 0, 0]],
      },
    ];
  }

  function buildAll() {
    const modelSegs = buildFacadeSegments();
    const defs = shotDefs();
    const shots = defs.map((d, i) => {
      const shot = renderShot(d, modelSegs, i);
      shot.knownPointPx = Geom.project(shot.cam, d.knownPointWorld);
      shot.anchorPx = d.anchorWorld.map((P) => Geom.project(shot.cam, P));
      shot.directLines = directProjectedLines(d, modelSegs);
      return shot;
    });
    return { shots, model: modelSegs, boxes: BOXES, facade: FACADE, W: W_IMG, H: H_IMG };
  }

  return { buildAll, buildFacadeSegments, shotDefs, BOXES, FACADE, W_IMG, H_IMG, signVisibility, rayBox };
});
