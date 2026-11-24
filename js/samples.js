/* samples.js — 线结构样例创作（可用内容，非一次性截图）
 * 两类合成镜头样例，全部带已知相机与消失方向、来源与生成参数：
 *   few  —— 少线组：每族仅 2~3 条线，纹理不足条件下仍可求灭点/焦距；
 *   wide —— 宽视角：短焦 + 大滚转/俯仰，灭点靠近画面甚至在画面内，
 *            并包含一族受遮挡的平行线（裂成可见片段）。
 * 每个样例保存 provenance（种子、噪声、相机真值、生成函数与参数），
 * 核验使用两种执行证据：
 *   1) 灭点反投影方向与真值世界方向的夹角（VP 方向核验）；
 *   2) 真值相机把世界线重投影到观测片段端点的像素 RMS（投影残差核验）。
 * 不以任何默认值填充失败：族内线不足时灭点为 null、核验结论为 fail。
 */
(function (root, factory) {
  const Geom = (typeof module !== 'undefined' && module.exports) ? require('./geom.js') : root.Geom;
  const api = factory(Geom);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Samples = api;
})(typeof self !== 'undefined' ? self : globalThis, function (Geom) {
  const W = 960, H = 540, CX = W / 2, CY = H / 2;
  const FAMILIES = ['X', 'Y', 'Z'];
  // 世界系三向真值方向（相机系表达由 Rwc 决定，核验时走同一约定）
  const WORLD_DIR = {
    X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1],
  };

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

  // 样例参数（创作内容的一部分；改参数即得到新的可重建样例）
  function sampleParams() {
    return {
      image: { W, H, CX, CY },
      few: {
        id: 'sample-few',
        kind: 'few-line-group',
        title: '少线组 · 纹理不足室内角',
        seed: 101,
        noiseSigma: 0.8,
        cam: { f: 880, C: [0.4, 1.55, 1.0], yaw: -0.18, pitch: 0.05, roll: 0.0 },
        // 每族线数刻意压到下限附近
        linesPerFamily: { X: 3, Y: 3, Z: 2 },
        // 相机沿 -Z 观察（工程约定），房间位于相机前方 z<cz
        box: { x0: -1.8, x1: 1.8, y0: 0.2, y1: 2.7, z0: -6, z1: -1.4 },
      },
      wide: {
        id: 'sample-wide',
        kind: 'wide-view',
        title: '宽视角 · 短焦大滚转，纵深族受遮挡',
        seed: 202,
        noiseSigma: 0.9,
        cam: { f: 520, C: [-0.3, 1.5, 0.8], yaw: 0.22, pitch: -0.28, roll: 0.12 },
        linesPerFamily: { X: 5, Y: 5, Z: 4 },
        box: { x0: -3, x1: 3, y0: 0, y1: 3.0, z0: -6, z1: -0.5 },
        // Z 族在该深度被横梁遮挡，裂成两段（平行线受遮挡条件）
        occludeZ: { atZ: -3.0, halfDepth: 0.28 },
      },
    };
  }

  // 由盒体角点生成每族的世界线段（确定性布局，参数可复算）
  function buildWorldLines(p) {
    const b = p.box, out = [];
    const add = (p1, p2, family, tag) => out.push({ p1, p2, family, tag });
    const n = p.linesPerFamily;
    // X 族：后墙与侧墙上的横线
    for (let i = 0; i < n.X; i++) {
      const y = b.y0 + ((i + 1) / (n.X + 1)) * (b.y1 - b.y0);
      add([b.x0, y, b.z1], [b.x1, y, b.z1], 'X', `X:back:${i}`);
    }
    // Y 族：后墙竖线
    for (let i = 0; i < n.Y; i++) {
      const x = b.x0 + ((i + 1) / (n.Y + 1)) * (b.x1 - b.x0);
      add([x, b.y0, b.z1], [x, b.y1, b.z1], 'Y', `Y:back:${i}`);
    }
    // Z 族：两侧墙的纵深线（宽视角样例带遮挡区间）
    for (let i = 0; i < n.Z; i++) {
      const side = i % 2 === 0 ? b.x0 : b.x1;
      const y = b.y0 + (0.35 + 0.55 * Math.floor(i / 2)) * (b.y1 - b.y0);
      const seg = { p1: [side, y, b.z0], p2: [side, y, b.z1], family: 'Z', tag: `Z:side:${i}` };
      if (p.occludeZ) seg.occlude = Object.assign({}, p.occludeZ);
      out.push(seg);
    }
    return out;
  }

  function fitSegLine(pts) {
    return pts.length === 2 ? Geom.lineFromPoints(pts[0], pts[1]) : Geom.fitLine(pts).line;
  }

  // 渲染单镜头：世界线 → 投影 → 加噪 → （可选）按遮挡区间裂段 → 画面裁剪
  function renderSample(p) {
    const camDef = Object.assign({ cx: CX, cy: CY, k1: 0 }, p.cam);
    const cam = Geom.makeCamera(camDef);
    const rnd = mulberry32(p.seed);
    const world = buildWorldLines(p);
    const segments = [];
    let seq = 0;
    const pushFrag = (A, B, s, fragIndex, fragCount) => {
      const q1 = Geom.project(cam, A), q2 = Geom.project(cam, B);
      if (!q1 || !q2) return;
      const pts = Geom.clipPtsToRect([
        [q1[0] + gauss(rnd) * p.noiseSigma, q1[1] + gauss(rnd) * p.noiseSigma],
        [q2[0] + gauss(rnd) * p.noiseSigma, q2[1] + gauss(rnd) * p.noiseSigma],
      ], W, H);
      if (pts.length < 2) return;
      segments.push({
        id: `${p.id}:${seq++}`, pts, family: s.family, tag: s.tag, srcTag: s.tag,
        occluded: fragCount > 1, fragIndex, fragCount, worldP1: A.slice(), worldP2: B.slice(),
      });
    };
    for (const s of world) {
      if (s.occlude) {
        // 用世界 z 区间把线切成 遮挡前 / 遮挡后 两个可见片段
        const zA = s.occlude.atZ - s.occlude.halfDepth;
        const zB = s.occlude.atZ + s.occlude.halfDepth;
        const at = (z) => {
          const t = (z - s.p1[2]) / (s.p2[2] - s.p1[2]);
          return [
            s.p1[0] + t * (s.p2[0] - s.p1[0]),
            s.p1[1] + t * (s.p2[1] - s.p1[1]),
            z,
          ];
        };
        const parts = [[s.p1, at(zA), 0, 2], [at(zB), s.p2, 1, 2]];
        for (const [A, B, fi, fc] of parts) pushFrag(A, B, s, fi, fc);
      } else {
        pushFrag(s.p1, s.p2, s, 0, 1);
      }
    }
    return {
      id: p.id, kind: p.kind, title: p.title, W, H,
      camDef, cam, worldLines: world, segments,
      provenance: {
        generator: 'Samples.renderSample',
        params: JSON.parse(JSON.stringify(p)),
        truthCamera: JSON.parse(JSON.stringify(camDef)),
        noiseModel: `gaussian sigma=${p.noiseSigma}px, rng=mulberry32(${p.seed})`,
      },
    };
  }

  // 灭点方向核验：灭点反投影到相机系方向，与真值世界方向经 Rcw 变换后比对夹角
  function verifyVPDirections(sample) {
    const fl = { X: [], Y: [], Z: [] };
    for (const s of sample.segments) fl[s.family].push(fitSegLine(s.pts));
    const rows = [];
    let allOk = true;
    for (const fam of FAMILIES) {
      const lines = fl[fam];
      if (lines.length < 2) {
        rows.push({ family: fam, n: lines.length, vp: null, angleDeg: null, pass: false,
          reason: '族内少于 2 条线，灭点不可估（不使用默认值）' });
        allOk = false;
        continue;
      }
      const vp = Geom.vanishingPoint(lines);
      const dCam = Geom.dirFromVP(vp, sample.camDef.f, CX, CY);
      // 真值世界方向 → 相机系（Rcw 列为世界基的相机坐标）
      const w = WORLD_DIR[fam];
      const dTruth = [
        sample.cam.Rcw[0][0] * w[0] + sample.cam.Rcw[0][1] * w[1] + sample.cam.Rcw[0][2] * w[2],
        sample.cam.Rcw[1][0] * w[0] + sample.cam.Rcw[1][1] * w[1] + sample.cam.Rcw[1][2] * w[2],
        sample.cam.Rcw[2][0] * w[0] + sample.cam.Rcw[2][1] * w[1] + sample.cam.Rcw[2][2] * w[2],
      ];
      // dirFromVP 与 rayDir 存在整体符号约定差，方向核验取无向夹角
      const dot = Geom.V.dot(Geom.V.normalize(dCam), Geom.V.normalize(dTruth));
      const angle = Math.acos(Math.max(-1, Math.min(1, Math.abs(dot)))) * 180 / Math.PI;
      const pass = angle < 1.0;
      if (!pass) allOk = false;
      rows.push({
        family: fam, n: lines.length,
        vpPx: Geom.vpToPixel(vp), infinite: Geom.vpIsInfinite(vp),
        angleDeg: Number(angle.toFixed(4)), pass,
      });
    }
    return { pass: allOk, rows };
  }

  // 投影残差核验：真值相机重投世界线，观测点到投影直线的像素 RMS
  function verifyProjection(sample) {
    let sum2 = 0, n = 0;
    const perFam = { X: { s2: 0, n: 0 }, Y: { s2: 0, n: 0 }, Z: { s2: 0, n: 0 } };
    for (const s of sample.segments) {
      const q1 = Geom.project(sample.cam, s.worldP1);
      const q2 = Geom.project(sample.cam, s.worldP2);
      if (!q1 || !q2) continue;
      const line = Geom.lineFromPoints(q1, q2);
      for (const pt of s.pts) {
        const d = Geom.pointLineDist(line, pt);
        sum2 += d * d; n++;
        perFam[s.family].s2 += d * d; perFam[s.family].n++;
      }
    }
    const rms = n ? Math.sqrt(sum2 / n) : null;
    const rows = FAMILIES.map((fam) => ({
      family: fam,
      rmsPx: perFam[fam].n ? Number(Math.sqrt(perFam[fam].s2 / perFam[fam].n).toFixed(3)) : null,
      n: perFam[fam].n,
    }));
    // 纯加性高斯噪声下，点到线 RMS 应与 sigma 同量级；放宽到 1.6σ 作为执行阈值
    const sigma = sample.provenance.params.noiseSigma;
    return { pass: rms !== null && rms < sigma * 1.6, rmsPx: rms === null ? null : Number(rms.toFixed(3)), rows };
  }

  // 完整核验 + 来源回卷：用 provenance 参数重新渲染，必须与当前样例逐片段一致
  function verifySample(sample) {
    const vp = verifyVPDirections(sample);
    const pr = verifyProjection(sample);
    const rebuilt = renderSample(sample.provenance.params);
    let reproducible = rebuilt.segments.length === sample.segments.length;
    let maxDelta = 0;
    if (reproducible) {
      for (let i = 0; i < sample.segments.length; i++) {
        const a = sample.segments[i].pts, b = rebuilt.segments[i].pts;
        if (a.length !== b.length) { reproducible = false; break; }
        for (let k = 0; k < a.length; k++) {
          maxDelta = Math.max(maxDelta, Math.hypot(a[k][0] - b[k][0], a[k][1] - b[k][1]));
        }
      }
    }
    return {
      id: sample.id,
      pass: vp.pass && pr.pass && reproducible && maxDelta < 1e-9,
      vpDirections: vp,
      projection: pr,
      reproducible,
      rebuildMaxDeltaPx: Number(maxDelta.toFixed(6)),
    };
  }

  function buildAll() {
    const p = sampleParams();
    const few = renderSample(p.few);
    const wide = renderSample(p.wide);
    return { params: p, samples: [few, wide], W, H };
  }

  return {
    sampleParams, buildWorldLines, renderSample, buildAll,
    verifyVPDirections, verifyProjection, verifySample, W, H,
  };
});
