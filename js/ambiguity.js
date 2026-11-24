/* ambiguity.js — 室内焦距歧义对
 * 构造一对“后墙投影几乎相同、焦距不同”的室内片：
 *   相机 A 在深度 d_A、焦距 f_A；相机 B 沿光轴后退到 d_B，
 *   令 f_B = f_A·d_B/d_A，则后墙（固定深度平面）上的点投影完全重合，
 *   而侧墙（不同深度）的投影系统性偏移，歧义只能由侧墙控制点解除。
 * 末段才把侧墙控制点交给求解器：先验阶段只用后墙线，模型选择阶段加入侧墙线。
 */
(function (root, factory) {
  const Geom = (typeof module !== 'undefined' && module.exports) ? require('./geom.js') : root.Geom;
  const api = factory(Geom);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Ambiguity = api;
})(typeof self !== 'undefined' ? self : globalThis, function (Geom) {
  const W = 960, H = 540;

  // 确定性随机
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
  // 按 tag 派生的确定性噪声：两机位对同一世界线施加相同噪声，
  // 使后墙一致性指标只反映几何投影重合度，而不是两份独立噪声。
  function hashSeed(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  /* 歧义舞台：矩形厅，后墙在 z=Z_BACK，相机朝 +Z 看（pc.z>0 为前方）。
   * 后墙线（back）两机位投影重合；侧墙线（side）揭示歧义；控制点单独标注。 */
  function stageSpec() {
    return {
      halfW: 2.0,
      height: 2.6,
      yFloor: 0.3, // 抬高地面/降低天花，使近端侧墙控制点落在画面内
      zBack: 12.0,
      zNear: 7.0, // 必须在两机位之前，且近端侧墙控制点需落在 A 近端画面内（A 景深仅 0.5）
      fA: 760,
      czA: 3.0, // 相机 A 的 z；深度 dA = zBack - czA = 9
      czB: 0.8, // 相机 B 的 z；深度 dB = zBack - czB = 11.2
      camY: 1.5,
      noiseSigma: 0.7,
    };
  }

  function buildStage() {
    const sp = stageSpec();
    const { halfW: hw, height: hh, zBack: zb, zNear: zn, yFloor: yf } = sp;
    const yc = yf + hh;
    const segs = [];
    const add = (p1, p2, family, role, tag, extra) =>
      segs.push(Object.assign({ p1, p2, family, role, tag }, extra || {}));

    // 后墙（z=zb）矩形与分格：role=back
    add([-hw, yf, zb], [hw, yf, zb], 'X', 'back', 'back:floor');
    add([-hw, yc, zb], [hw, yc, zb], 'X', 'back', 'back:ceil');
    add([-hw, yf, zb], [-hw, yc, zb], 'Y', 'back', 'back:left');
    add([hw, yf, zb], [hw, yc, zb], 'Y', 'back', 'back:right');
    for (const x of [-1, 0, 1]) {
      add([x, yf, zb], [x, yc, zb], 'Y', 'back', `back:v:${x}`);
    }
    for (const y of [yf + 0.9, yf + 1.8]) {
      add([-hw, y, zb], [hw, y, zb], 'X', 'back', `back:h:${y.toFixed(1)}`);
    }

    // 侧墙纵深线（role=side）：从近 z=zn 到后墙 zb
    for (const sx of [-hw, hw]) {
      add([sx, yf, zn], [sx, yf, zb], 'Z', 'side', `side:floor:x=${sx}`);
      add([sx, yc, zn], [sx, yc, zb], 'Z', 'side', `side:ceil:x=${sx}`);
      for (const y of [yf + 0.9, yf + 1.8]) {
        add([sx, y, zn], [sx, y, zb], 'Z', 'side', `side:h:${y.toFixed(1)}:x=${sx}`);
      }
      // 侧墙竖棱（近端点，作为控制点）
      add([sx, yf, zn], [sx, yc, zn], 'Y', 'side', `side:nearV:x=${sx}`, { control: true });
      for (const z of [8.5, 10]) {
        add([sx, yf, z], [sx, yc, z], 'Y', 'side', `side:v:${z}:x=${sx}`);
      }
    }
    return { spec: sp, segments: segs };
  }

  // 两机位定义：深度 d=zBack-cz，令 fB=fA*dB/dA，则后墙投影重合。相机朝 +Z（yaw=π）。
  function cameraDefs(sp) {
    const dA = sp.zBack - sp.czA, dB = sp.zBack - sp.czB;
    const fB = sp.fA * (dB / dA);
    const cx = W / 2, cy = H / 2;
    const camA = { f: sp.fA, cx, cy, C: [0, sp.camY, sp.czA], yaw: Math.PI, pitch: 0, roll: 0, k1: 0 };
    const camB = { f: fB, cx, cy, C: [0, sp.camY, sp.czB], yaw: Math.PI, pitch: 0, roll: 0, k1: 0 };
    return [{ id: 'amb-A', name: '歧义片A（近，短焦）', cam: camA },
    { id: 'amb-B', name: '歧义片B（远，长焦）', cam: camB, fB, dA, dB }];
  }

  function renderPair() {
    const { spec, segments } = buildStage();
    const defs = cameraDefs(spec);
    const shots = defs.map((def, si) => {
      const cam = Geom.makeCamera(def.cam);
      const out = [];
      let n = 0;
      for (const s of segments) {
        const p1 = Geom.project(cam, s.p1), p2 = Geom.project(cam, s.p2);
        if (!p1 || !p2) continue;
        const rnd = mulberry32(hashSeed(s.tag)); // 同一世界线两机位同噪声
        const sig = spec.noiseSigma;
        const pts = Geom.clipPtsToRect([
          [p1[0] + gauss(rnd) * sig, p1[1] + gauss(rnd) * sig],
          [p2[0] + gauss(rnd) * sig, p2[1] + gauss(rnd) * sig],
        ], W, H);
        if (pts.length < 2) continue;
        out.push({
          id: `a${si}:${n++}`, pts, family: s.family, role: s.role, tag: s.tag,
          control: !!s.control, srcTag: s.tag, worldP1: s.p1, worldP2: s.p2,
        });
      }
      return { def, cam, segments: out };
    });
    return { spec, defs, model: segments, shots, W, H };
  }

  // 后墙投影一致性：两机位对所有 back 线端点的像素差（应≈0，仅噪声）
  function backWallAgreement(pair) {
    const [A, B] = pair.shots;
    const byTagA = {};
    for (const s of A.segments) byTagA[s.tag] = s;
    const diffs = [];
    for (const sb of B.segments) {
      if (sb.role !== 'back') continue;
      const sa = byTagA[sb.tag];
      if (!sa) continue;
      for (let k = 0; k < 2; k++) {
        diffs.push(Math.hypot(sa.pts[k][0] - sb.pts[k][0], sa.pts[k][1] - sb.pts[k][1]));
      }
    }
    return {
      n: diffs.length,
      mean: diffs.reduce((a, v) => a + v, 0) / (diffs.length || 1),
      max: Math.max.apply(null, diffs.length ? diffs : [0]),
    };
  }

  // 侧墙分离度：两机位 side 线端点像素差（应显著大于噪声）
  function sideWallSeparation(pair) {
    const [A, B] = pair.shots;
    const byTagA = {};
    for (const s of A.segments) byTagA[s.tag] = s;
    const rows = [];
    for (const sb of B.segments) {
      if (sb.role !== 'side') continue;
      const sa = byTagA[sb.tag];
      if (!sa) continue;
      const near = Math.hypot(sa.pts[0][0] - sb.pts[0][0], sa.pts[0][1] - sb.pts[0][1]);
      rows.push({ tag: sb.tag, control: !!sb.control, nearEndPx: Number(near.toFixed(3)) });
    }
    const vals = rows.map((r) => r.nearEndPx);
    return {
      rows,
      mean: vals.reduce((a, v) => a + v, 0) / (vals.length || 1),
      max: Math.max.apply(null, vals.length ? vals : [0]),
    };
  }

  /* 模型选择：歧义模型是“机位 + 焦距”成套替换（两台相机 f/d 相等，
   * 后墙投影因此重合）。trialCam 给出整套候选相机；useSide 控制是否启用侧墙。
   * 阶段一 useSide=false：仅后墙线，两模型残差都低（歧义不可分辨）；
   * 阶段二 useSide=true：加入侧墙控制点，正确模型残差显著更低。 */
  function scoreFocalModel(shot, trialCam, useSide) {
    const lines = shot.segments.filter((s) => s.role === 'back' || (useSide && s.role === 'side'));
    const cam = Geom.makeCamera(trialCam);
    let sum2 = 0, n = 0;
    const perRole = { back: { s2: 0, n: 0 }, side: { s2: 0, n: 0 } };
    for (const s of lines) {
      const p1 = Geom.project(cam, s.worldP1), p2 = Geom.project(cam, s.worldP2);
      if (!p1 || !p2) continue;
      const line = Geom.lineFromPoints(p1, p2);
      for (const p of s.pts) {
        const d = Geom.pointLineDist(line, p);
        sum2 += d * d; n++;
        perRole[s.role].s2 += d * d; perRole[s.role].n++;
      }
    }
    return {
      f: trialCam.f,
      camZ: trialCam.C[2],
      useSide,
      rms: n ? Math.sqrt(sum2 / n) : null,
      backRms: perRole.back.n ? Math.sqrt(perRole.back.s2 / perRole.back.n) : null,
      sideRms: perRole.side.n ? Math.sqrt(perRole.side.s2 / perRole.side.n) : null,
    };
  }

  // 完整求解：两阶段，返回歧义证据与最终选择
  function solveAmbiguity(pair) {
    const sp = pair.spec;
    const dA = sp.zBack - sp.czA, dB = sp.zBack - sp.czB;
    const fB = sp.fA * (dB / dA);
    const [defA, defB] = pair.defs;
    const stages = [];
    // 每个镜头在两套完整“机位+焦距”模型之间选择
    for (const [shot, trueDef, wrongDef, label] of [
      [pair.shots[0], defA.cam, defB.cam, 'A'],
      [pair.shots[1], defB.cam, defA.cam, 'B'],
    ]) {
      const backOnly = {
        correct: scoreFocalModel(shot, trueDef, false),
        wrong: scoreFocalModel(shot, wrongDef, false),
      };
      const withSide = {
        correct: scoreFocalModel(shot, trueDef, true),
        wrong: scoreFocalModel(shot, wrongDef, true),
      };
      const backGap = Math.abs(backOnly.wrong.rms - backOnly.correct.rms);
      const sideGap = withSide.wrong.rms - withSide.correct.rms;
      stages.push({
        shot: label,
        trueF: Number(trueDef.f.toFixed(2)),
        candidateF: Number(wrongDef.f.toFixed(2)),
        stage1_backOnly: backOnly,
        stage2_withSide: withSide,
        backStageGap: Number(backGap.toFixed(4)),
        sideStageGap: Number(sideGap.toFixed(4)),
        resolvedBySide: sideGap > 1.0, // 侧墙加入后错误模型残差高出 >1px 才算可分辨
      });
    }
    return {
      fA: sp.fA,
      fB: Number(fB.toFixed(2)),
      backAgreement: backWallAgreement(pair),
      sideSeparation: sideWallSeparation(pair),
      stages,
    };
  }

  return {
    stageSpec, buildStage, cameraDefs, renderPair,
    backWallAgreement, sideWallSeparation, scoreFocalModel, solveAmbiguity, W, H,
  };
});
