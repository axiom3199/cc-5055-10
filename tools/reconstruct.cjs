/* tools/reconstruct.cjs — 从素材包重建相机与线结构（建筑匹配直接加载入口）
 * 用法：node tools/reconstruct.cjs [packFile ...]
 * 不传参数时重建 assets/packs 下全部三个包。
 * 约定（与 build-packs.cjs 对应）：
 *   - 只用 content 中的观测线/分组/已知点/先验驱动求解内核；
 *   - provenance.truth 仅用于重建后的符合性核验，不进入求解；
 *   - 任何必需字段缺失立即报错退出（不以默认值遮错）；
 *   - 重建结果与真值/约定的偏差以断言形式给出，并打印执行证据。
 */
const fs = require('fs');
const path = require('path');

const Geom = require('../js/geom.js');
const Street = require('../js/street.js');
const Ambiguity = require('../js/ambiguity.js');
const Samples = require('../js/samples.js');

const ROOT = path.join(__dirname, '..');
const PACK_DIR = path.join(ROOT, 'assets', 'packs');
const DEG = 180 / Math.PI;
let failures = 0;

function fail(msg) {
  failures++;
  console.log('  FAIL — ' + msg);
}
function ok(msg) { console.log('  PASS — ' + msg); }
function check(name, cond, detail) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
}
function requireField(obj, field, where) {
  if (obj === undefined || obj === null || obj[field] === undefined) {
    throw new Error(`素材包字段缺失：${where}.${field}`);
  }
  return obj[field];
}

// 把包内观测线恢复成 street 内核所需 shot 形态
function shotFromPack(sh) {
  const segments = requireField(sh, 'observedLines', sh.id).map((l) => ({
    id: l.id, pts: l.pts, family: l.family, srcTag: l.srcTag,
    kind: l.kind, occluded: l.occluded, fragCount: l.fragCount,
  }));
  return {
    def: {
      id: sh.id,
      cam: { cx: sh.image.cx, cy: sh.image.cy },
      knownPointWorld: sh.knownPoint.world,
    },
    knownPointPx: sh.knownPoint.px,
    segments,
    // 观测遮挡量来自素材包内容（非真值相机），供选解排序使用
    sign: { total: sh.signObserved.total, visible: sh.signObserved.visible,
      fraction: sh.signObserved.fraction },
    occlusionBoundaryY: sh.signObserved.occlusionBoundaryY,
  };
}

function reconstructStreet(pack) {
  const c = requireField(pack, 'content', pack.kind);
  const boxes = requireField(c, 'boxes', 'content');
  const facade = requireField(c, 'facade', 'content');
  const model = requireField(c, 'modelLines', 'content');
  const shots = c.shots.map(shotFromPack);

  // 1) 每镜头灭点 + 焦距候选（含显式 null 候选）
  const sols = shots.map((s) => Street.solveShot(s, {}));
  sols.forEach((sol, i) => {
    const nulls = sol.focalCandidates.filter((x) => x.f === null);
    console.log(`  镜头 ${shots[i].def.id}: 线-灭点 RMS=${sol.residual.rms.toFixed(4)}px，` +
      `候选 ${sol.focalCandidates.map((x) => x.pair + '=' + (x.f === null ? 'null(' + x.reason + ')' : x.f.toFixed(1))).join('，')}`);
    check(`${shots[i].def.id} 至少一个有效焦距候选`,
      sol.focalCandidates.some((x) => x.cam), nulls.length + ' 个显式病态候选已保留原因');
  });

  // 2) 双镜头遮挡选解（A、B），观测边界取自素材包观测证据（不碰真值相机）
  const obsOverride = shots.slice(0, 2).map((s) => {
    if (typeof s.occlusionBoundaryY !== 'number') {
      throw new Error('素材包缺少 signObserved.occlusionBoundaryY，拒绝以默认值选解');
    }
    return s.occlusionBoundaryY;
  });
  const ranking = Street.occlusionRanking(sols.slice(0, 2), shots.slice(0, 2),
    facade, boxes, model, obsOverride);
  check('遮挡选解产生组合', ranking.combos.length > 0, `${ranking.combos.length} 组`);
  const sel = ranking.selected;
  check('选中组合遮挡错误为 0', sel.occErrors === 0, `occErrors=${sel.occErrors}`);
  check('选中组合遮挡边界误差 < 0.05m', sel.boundaryErr < 0.05, `boundaryErr=${sel.boundaryErr}`);

  // 3) 真值符合性：重建焦距与真值焦距偏差（来自 provenance，不参与求解）
  const truthCams = pack.provenance.truth.cameras;
  sel.cams.forEach((cam, i) => {
    const truth = truthCams[i].cam;
    const ferr = Math.abs(cam.f - truth.f) / truth.f;
    check(`${truthCams[i].id} 重建焦距偏差 < 12%`, ferr < 0.12,
      `est=${cam.f.toFixed(1)} truth=${truth.f} (${(ferr * 100).toFixed(1)}%)`);
  });

  // 4) 复演约定：B 隐藏、B' 露出；A 锚点像素与包内记录一致
  const stateB = c.shots.find((s) => s.id === 'B');
  const stateBp = c.shots.find((s) => s.id === "B'");
  check("B 店招被遮 / B' 店招露出（复演翻转）",
    stateB.signObserved.fraction < 0.95 && stateBp.signObserved.fraction >= 0.95,
    `B=${stateB.signObserved.fraction}, B'=${stateBp.signObserved.fraction}`);
  const anchorA = c.shots.find((s) => s.id === 'A').anchors;
  check('A 锚点记录完整（复演中保持的已确认锚点）',
    anchorA.length >= 3 && anchorA.every((a) => a.px.length === 2 && a.world.length === 3));

  // 5) 线源约定：direct 包含幻影段，extracted 不含；phantom 比例为正且有限
  const bPack = c.shots.find((s) => s.id === 'B');
  const phantom = bPack.directLines.length >= bPack.observedLines.length;
  check('B 镜头直接投线数 ≥ 遮挡提取片段数（幻影线存在）', phantom,
    `direct=${bPack.directLines.length}, observed=${bPack.observedLines.length}`);
  return { selected: sel.pair, focal: sel.f.map((v) => Number(v.toFixed(2))) };
}

function reconstructAmbiguity(pack) {
  const c = requireField(pack, 'content', pack.kind);
  // 用包内参数与观测线重建 pair 形态，再走真实两阶段求解
  const spec = requireField(c, 'stage', 'content');
  const live = Ambiguity.renderPair();
  // 以包内观测线替换渲染结果，保证求解输入来自素材包而非重新生成
  live.shots.forEach((shot, i) => {
    const packed = requireField(c.shots[i], 'observedLines', 'shot' + i);
    shot.segments = packed.map((l) => ({
      id: l.id, pts: l.pts, family: l.family, role: l.role, tag: l.tag,
      control: l.control, srcTag: l.tag,
      worldP1: live.model.find((m) => m.tag === l.tag).p1,
      worldP2: live.model.find((m) => m.tag === l.tag).p2,
    }));
  });
  const report = Ambiguity.solveAmbiguity(live);
  check('后墙投影一致性 mean < 0.5px', report.backAgreement.mean < 0.5,
    `mean=${report.backAgreement.mean}, max=${report.backAgreement.max}`);
  check('侧墙分离度 mean > 1px', report.sideSeparation.mean > 1,
    `mean=${report.sideSeparation.mean.toFixed(2)}px`);
  for (const st of report.stages) {
    check(`镜头${st.shot} 阶段一后墙两模型不可分辨（gap<1px）`, st.backStageGap < 1,
      `gap=${st.backStageGap}`);
    check(`镜头${st.shot} 阶段二侧墙控制点解歧（wrong RMS 高出 >1px）`, st.resolvedBySide,
      `sideRms correct=${st.stage2_withSide.correct.sideRms.toFixed(2)} wrong=${st.stage2_withSide.wrong.sideRms.toFixed(2)}`);
  }
  // 控制点在 stage1 被 withhold 的约定：controlTags 非空
  for (const sh of c.shots) {
    check(`${sh.id} 声明末段解锁控制点`, Array.isArray(sh.controlTags) && sh.controlTags.length > 0,
      `controls=${sh.controlTags.length}`);
  }
  return { fA: report.fA, fB: report.fB };
}

function reconstructSamples(pack) {
  const c = requireField(pack, 'content', pack.kind);
  const params = requireField(c, 'params', 'content');
  for (const sh of c.shots) {
    // 从 provenance 参数重新渲染（来源回卷），再用包内观测线做核验
    const p = params[sh.kind === 'few-line-group' ? 'few' : 'wide'];
    const sample = Samples.renderSample(p);
    check(`${sh.id} 重渲染片段数与包一致`, sample.segments.length === sh.observedLines.length,
      `live=${sample.segments.length} pack=${sh.observedLines.length}`);
    const v = Samples.verifySample(sample);
    check(`${sh.id} 灭点方向核验通过（每族夹角 <1°）`, v.vpDirections.pass,
      v.vpDirections.rows.map((r) => `${r.family}:${r.angleDeg === null ? 'n/a' : r.angleDeg + '°'}`).join(' '));
    check(`${sh.id} 投影残差核验通过（RMS < 1.6σ）`, v.projection.pass,
      `rms=${v.projection.rmsPx}px`);
    check(`${sh.id} 来源参数可重建（逐像素一致）`, v.reproducible && v.rebuildMaxDeltaPx < 1e-9,
      `delta=${v.rebuildMaxDeltaPx}`);
    if (sh.kind === 'wide-view') {
      const occ = sh.observedLines.filter((l) => l.occluded);
      check('宽视角样例含受遮挡平行线段', occ.length > 0, `${occ.length} 个遮挡片段`);
    }
    if (sh.kind === 'few-line-group') {
      const perFam = {};
      for (const l of sh.observedLines) perFam[l.family] = (perFam[l.family] || 0) + 1;
      check('少线组样例每族 ≤3 条（纹理不足条件）',
        Object.values(perFam).every((n) => n <= 3), JSON.stringify(perFam));
    }
  }
}

function loadPack(file) {
  if (!fs.existsSync(file)) throw new Error('素材包不存在：' + file);
  const pack = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!pack.packVersion || !pack.kind || !pack.content || !pack.provenance) {
    throw new Error('素材包结构不符合约定（缺 packVersion/kind/content/provenance）：' + file);
  }
  return pack;
}

function main() {
  const args = process.argv.slice(2);
  const files = args.length ? args.map((f) => path.resolve(f)) :
    ['street-facade', 'ambiguity-indoor', 'line-samples']
      .map((n) => path.join(PACK_DIR, `${n}.pack.json`));
  for (const file of files) {
    const pack = loadPack(file);
    console.log(`\n=== 重建 ${path.relative(ROOT, file)}（kind=${pack.kind}, v${pack.packVersion}）===`);
    if (pack.kind === 'street-facade') reconstructStreet(pack);
    else if (pack.kind === 'ambiguity-indoor') reconstructAmbiguity(pack);
    else if (pack.kind === 'line-samples') reconstructSamples(pack);
    else throw new Error('未知素材包 kind：' + pack.kind);
  }
  console.log(failures ? `\n${failures} 项重建核验失败` : '\n全部素材包重建核验通过');
  process.exit(failures ? 1 : 0);
}

main();
