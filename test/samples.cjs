/* 线结构样例无头测试：node test/samples.cjs
 * 覆盖少线组（纹理不足）与宽视角（含受遮挡平行线），
 * 以灭点方向夹角与投影残差为执行证据，并核验来源参数可重建。 */
const Samples = require('../js/samples.js');

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
};

const built = Samples.buildAll();
check('产出两个样例', built.samples.length === 2);
const [few, wide] = built.samples;

// 少线组：每族观测线 ≤3（纹理不足），三族仍可求灭点
const fewCount = {};
for (const s of few.segments) fewCount[s.family] = (fewCount[s.family] || 0) + 1;
check('少线组每族 ≤3 条线', Object.values(fewCount).every((n) => n <= 3), JSON.stringify(fewCount));
check('少线组三族均至少 2 条（灭点可估下限）',
  ['X', 'Y', 'Z'].every((f) => (fewCount[f] || 0) >= 2), JSON.stringify(fewCount));

// 宽视角：含受遮挡平行线段（fragCount=2）
const occ = wide.segments.filter((s) => s.occluded && s.fragCount === 2);
check('宽视角含裂成两段的受遮挡平行线', occ.length >= 2, `${occ.length} 段`);
check('宽视角焦距短于少线组（视角更宽）', wide.camDef.f < few.camDef.f,
  `wide=${wide.camDef.f} few=${few.camDef.f}`);

for (const smp of built.samples) {
  const v = Samples.verifySample(smp);
  // 灭点方向证据
  check(`${smp.id} 灭点方向全部通过（夹角<1°）`, v.vpDirections.pass,
    v.vpDirections.rows.map((r) => `${r.family}:${r.angleDeg === null ? 'n/a' : r.angleDeg + '°'}`).join(' '));
  for (const r of v.vpDirections.rows) {
    check(`${smp.id} 族 ${r.family} 灭点方向有数值证据`, r.angleDeg !== null && isFinite(r.angleDeg));
  }
  // 投影残差证据
  check(`${smp.id} 投影 RMS 有限且 < 1.6σ`, v.projection.pass, `rms=${v.projection.rmsPx}px`);
  for (const r of v.projection.rows) {
    check(`${smp.id} 族 ${r.family} 投影残差有数值`, r.rmsPx !== null && isFinite(r.rmsPx));
  }
  // 来源与参数
  check(`${smp.id} provenance 记录生成器与参数`,
    !!smp.provenance.generator && !!smp.provenance.params &&
    !!smp.provenance.truthCamera && typeof smp.provenance.noiseModel === 'string');
  check(`${smp.id} 来源参数可逐像素重建`, v.reproducible && v.rebuildMaxDeltaPx < 1e-9,
    `delta=${v.rebuildMaxDeltaPx}`);
  check(`${smp.id} 综合核验通过`, v.pass);
}

// 失败条件不被默认值掩盖：人为删掉一族线后核验必须报 fail 而非兜底
const broken = JSON.parse(JSON.stringify(few));
broken.segments = broken.segments.filter((s) => s.family !== 'Z');
const vBroken = Samples.verifyVPDirections(broken);
check('删族后灭点核验显式失败（无默认值遮错）', vBroken.pass === false);
check('失败行带原因说明', vBroken.rows.some((r) => !r.pass && /灭点不可估/.test(r.reason || '')));

console.log(failures ? `\n${failures} 项失败` : '\n线结构样例全部通过');
process.exit(failures ? 1 : 0);
