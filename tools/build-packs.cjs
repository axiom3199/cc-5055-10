/* tools/build-packs.cjs — 生成建筑镜头素材包（真实 JSON 文件，非截图）
 * 输出：
 *   assets/packs/street-facade.pack.json   双解街景（A/B/B'，含遮挡盒与店招）
 *   assets/packs/ambiguity-indoor.pack.json 焦距歧义室内对
 *   assets/packs/line-samples.pack.json     少线组/宽视角线结构样例
 *   assets/evidence/build-evidence.json     一次构建的全部核验证据
 * 包格式约定（reconstruct.cjs 按此加载）：
 *   { packVersion, kind, createdAt, generator, provenance, content }
 * 真值相机只放在 provenance.truth 中；content 提供求解所需的观测线、分组、
 * 已知点与先验。任何字段缺失直接抛错，不以默认值遮错。
 */
const fs = require('fs');
const path = require('path');

const Facade = require('../js/facade.js');
const Street = require('../js/street.js');
const Replay = require('../js/replay.js');
const Ambiguity = require('../js/ambiguity.js');
const Samples = require('../js/samples.js');

const ROOT = path.join(__dirname, '..');
const PACK_DIR = path.join(ROOT, 'assets', 'packs');
const EVID_DIR = path.join(ROOT, 'assets', 'evidence');
const PACK_VERSION = 1;

function assert(cond, msg) {
  if (!cond) throw new Error('素材包构建失败：' + msg);
}

function round(x, d = 6) {
  if (x === null || x === undefined) return x;
  return Number(x.toFixed(d));
}
function roundPt(p, d = 4) {
  return p.map((v) => round(v, d));
}

// ---------- 街景包 ----------
function buildStreetPack() {
  const data = Facade.buildAll();
  const shots = data.shots.map((shot) => ({
    id: shot.def.id,
    name: shot.def.name,
    desc: shot.def.desc,
    image: { W: data.W, H: data.H, cx: shot.def.cam.cx, cy: shot.def.cam.cy },
    knownPoint: { px: roundPt(shot.knownPointPx), world: roundPt(shot.def.knownPointWorld) },
    anchors: shot.def.anchorWorld.map((w, i) => ({ world: roundPt(w), px: roundPt(shot.anchorPx[i]) })),
    // 观测：几何遮挡重新提取的可见片段（求解输入）
    observedLines: shot.segments.map((s) => ({
      id: s.id, pts: s.pts.map((p) => roundPt(p, 6)), family: s.family, srcTag: s.srcTag,
      kind: s.kind, occluded: s.occluded, fragCount: s.fragCount,
    })),
    // 对照：合成场景直接投线（不经过遮挡）
    directLines: shot.directLines.map((s) => ({
      id: s.id, pts: s.pts.map((p) => roundPt(p, 6)), family: s.family, srcTag: s.srcTag, kind: s.kind,
    })),
    signObserved: {
      total: shot.sign.total, visible: shot.sign.visible,
      fraction: round(shot.sign.fraction),
      // 构建期由真实几何计算的遮挡边界（观测证据，重建选解直接使用）
      occlusionBoundaryY: round(Street.signOcclusionBoundary(shot.cam, data.facade, data.boxes), 4),
    },
  }));

  const content = {
    facade: data.facade,
    boxes: data.boxes,
    modelLines: data.model.map((m) => ({
      tag: m.tag, p1: roundPt(m.p1), p2: roundPt(m.p2),
      family: m.family, kind: m.kind, boxOwner: m.boxOwner === undefined ? null : m.boxOwner,
    })),
    shots,
    priors: { cameraHeight: Street.CAMERA_H_PRIOR },
  };

  // 构建期证据：真实跑一遍标定内核 + 遮挡选解 + 复演 + 线源对比
  const sols = data.shots.map((s) => Street.solveShot(s, {}));
  const ranking = Street.occlusionRanking(sols.slice(0, 2), data.shots.slice(0, 2),
    data.facade, data.boxes, data.model);
  const replay = Replay.replayCompare(data);
  const lineSrc = [0, 1, 2].map((i) => Replay.lineSourceCompare(data, i));

  const evidence = {
    focalCandidates: sols.map((sol, i) => ({
      shot: data.shots[i].def.id,
      nAssigned: sol.nAssigned,
      lineVpRms: round(sol.residual.rms, 4),
      candidates: sol.focalCandidates.map((c) => ({
        pair: c.pair, f: c.f === null ? null : round(c.f, 2),
        reason: c.reason || null,
        hasCamera: !!c.cam,
      })),
    })),
    occlusionSelection: {
      comboCount: ranking.combos.length,
      selectedPair: ranking.selected.pair,
      selectedF: ranking.selected.f.map((v) => round(v, 2)),
      occErrors: ranking.selected.occErrors,
      boundaryErr: ranking.selected.boundaryErr,
      reprRms: ranking.selected.reprRms,
      obsBoundaries: ranking.obsBoundaries.map((v) => round(v, 4)),
    },
    replay: {
      movedOnly: replay.movedOnly,
      flipped: replay.flipped,
      fixedAnchorShot: replay.fixedAnchor.shot,
      anchorUnchanged: replay.fixedAnchor.unchanged,
      anchorPx: replay.fixedAnchor.anchors.map((a) => roundPt(a.px, 3)),
      states: {
        B: { hidden: replay.observation.B.hidden, fraction: round(replay.observation.B.signFraction) },
        "B'": { hidden: replay.observation["B'"].hidden, fraction: round(replay.observation["B'"].signFraction) },
      },
      predictedBoundary: replay.predictedBoundary,
    },
    lineSource: lineSrc.map((r) => ({
      shot: r.shot, phantomPx: round(r.phantomLen), phantomRatio: r.phantomRatio,
      directRegionPx: round(r.directRegionLen), extractedRegionPx: round(r.extractedRegionLen),
    })),
  };

  const provenance = {
    generator: 'tools/build-packs.cjs::buildStreetPack',
    sourceModules: ['js/facade.js', 'js/street.js', 'js/replay.js'],
    params: {
      facade: data.facade,
      cameraDefs: data.shots.map((s) => s.def.cam),
      image: { W: data.W, H: data.H },
      rng: 'mulberry32 per-shot (facade.renderShot)',
    },
    truth: {
      cameras: data.shots.map((s) => ({ id: s.def.id, cam: s.def.cam })),
    },
  };

  return {
    pack: {
      packVersion: PACK_VERSION, kind: 'street-facade',
      createdAt: new Date().toISOString(),
      generator: provenance.generator, provenance, content,
    },
    evidence: { pack: 'street-facade', ...evidence },
  };
}

// ---------- 歧义室内对包 ----------
function buildAmbiguityPack() {
  const pair = Ambiguity.renderPair();
  const report = Ambiguity.solveAmbiguity(pair);
  const shots = pair.shots.map((shot, i) => ({
    id: pair.defs[i].id,
    name: pair.defs[i].name,
    image: { W: pair.W, H: pair.H, cx: shot.def.cam.cx, cy: shot.def.cam.cy },
    // 末段才解锁的侧墙控制点单独列出，默认 stage=1 不参与求解
    controlTags: shot.segments.filter((s) => s.control).map((s) => s.tag),
    observedLines: shot.segments.map((s) => ({
      id: s.id, pts: s.pts.map(roundPt), family: s.family, role: s.role,
      tag: s.tag, control: s.control,
    })),
  }));
  const content = {
    stage: pair.spec,
    modelLines: pair.model.map((m) => ({
      tag: m.tag, p1: roundPt(m.p1), p2: roundPt(m.p2),
      family: m.family, role: m.role, control: !!m.control,
    })),
    shots,
    solveStages: {
      stage1: 'back-only（侧墙控制点 withheld）',
      stage2: 'with-side-control（控制点解锁后模型选择）',
    },
  };
  const evidence = {
    pack: 'ambiguity-indoor',
    focalPair: { fA: report.fA, fB: report.fB },
    backWallAgreement: report.backAgreement,
    sideWallSeparation: {
      n: report.sideSeparation.rows.length,
      mean: round(report.sideSeparation.mean, 4),
      max: round(report.sideSeparation.max, 4),
    },
    stages: report.stages.map((st) => ({
      shot: st.shot, trueF: st.trueF, candidateF: st.candidateF,
      stage1: {
        correctRms: round(st.stage1_backOnly.correct.rms, 4),
        wrongRms: round(st.stage1_backOnly.wrong.rms, 4),
        gap: st.backStageGap,
      },
      stage2: {
        correctRms: round(st.stage2_withSide.correct.rms, 4),
        wrongRms: round(st.stage2_withSide.wrong.rms, 4),
        correctSideRms: round(st.stage2_withSide.correct.sideRms, 4),
        wrongSideRms: round(st.stage2_withSide.wrong.sideRms, 4),
      },
      resolvedBySide: st.resolvedBySide,
    })),
  };
  const provenance = {
    generator: 'tools/build-packs.cjs::buildAmbiguityPack',
    sourceModules: ['js/ambiguity.js'],
    params: pair.spec,
    truth: { cameras: pair.defs.map((d) => ({ id: d.id, cam: d.cam })) },
  };
  return {
    pack: {
      packVersion: PACK_VERSION, kind: 'ambiguity-indoor',
      createdAt: new Date().toISOString(),
      generator: provenance.generator, provenance, content,
    },
    evidence,
  };
}

// ---------- 线结构样例包 ----------
function buildSamplesPack() {
  const built = Samples.buildAll();
  const shots = built.samples.map((smp) => ({
    id: smp.id, kind: smp.kind, title: smp.title,
    image: { W: smp.W, H: smp.H, cx: smp.camDef.cx, cy: smp.camDef.cy },
    observedLines: smp.segments.map((s) => ({
      id: s.id, pts: s.pts.map(roundPt), family: s.family,
      srcTag: s.srcTag, occluded: s.occluded, fragCount: s.fragCount,
    })),
    worldLines: smp.worldLines.map((m) => ({
      tag: m.tag, p1: roundPt(m.p1), p2: roundPt(m.p2), family: m.family,
      occlude: m.occlude || null,
    })),
  }));
  const verifications = built.samples.map((smp) => Samples.verifySample(smp));
  for (const v of verifications) {
    assert(v.pass, `线样例 ${v.id} 核验未通过`);
  }
  const content = {
    params: built.params,
    shots,
  };
  const evidence = {
    pack: 'line-samples',
    verifications: verifications.map((v) => ({
      id: v.id, pass: v.pass, reproducible: v.reproducible,
      rebuildMaxDeltaPx: v.rebuildMaxDeltaPx,
      projectionRmsPx: v.projection.rmsPx,
      vpDirections: v.vpDirections.rows.map((r) => ({
        family: r.family, n: r.n, angleDeg: r.angleDeg, pass: r.pass,
        infinite: !!r.infinite, reason: r.reason || null,
      })),
      projectionPerFamily: v.projection.rows,
    })),
  };
  const provenance = {
    generator: 'tools/build-packs.cjs::buildSamplesPack',
    sourceModules: ['js/samples.js'],
    params: built.params,
    truth: { cameras: built.samples.map((s) => ({ id: s.id, cam: s.camDef })) },
  };
  return {
    pack: {
      packVersion: PACK_VERSION, kind: 'line-samples',
      createdAt: new Date().toISOString(),
      generator: provenance.generator, provenance, content,
    },
    evidence,
  };
}

function main() {
  fs.mkdirSync(PACK_DIR, { recursive: true });
  fs.mkdirSync(EVID_DIR, { recursive: true });
  const parts = [buildStreetPack(), buildAmbiguityPack(), buildSamplesPack()];
  const names = ['street-facade', 'ambiguity-indoor', 'line-samples'];
  parts.forEach((part, i) => {
    const file = path.join(PACK_DIR, `${names[i]}.pack.json`);
    fs.writeFileSync(file, JSON.stringify(part.pack, null, 2) + '\n');
    // 包必须真实存在且可重新解析
    const reread = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert(reread.packVersion === PACK_VERSION && reread.content, `${names[i]} 回读校验失败`);
    console.log('写入素材包:', path.relative(ROOT, file),
      `(${(fs.statSync(file).size / 1024).toFixed(1)} KB)`);
  });
  const evidence = {
    builtAt: new Date().toISOString(),
    packVersion: PACK_VERSION,
    packs: names.map((n) => `assets/packs/${n}.pack.json`),
    results: parts.map((p) => p.evidence),
  };
  const evFile = path.join(EVID_DIR, 'build-evidence.json');
  fs.writeFileSync(evFile, JSON.stringify(evidence, null, 2) + '\n');
  console.log('写入构建证据:', path.relative(ROOT, evFile));
}

main();
