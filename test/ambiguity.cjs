/* 焦距歧义室内对无头测试：node test/ambiguity.cjs */
const Ambiguity = require('../js/ambiguity.js');

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
};

const pair = Ambiguity.renderPair();
const sp = pair.spec;

// 几何构造：fB = fA·dB/dA
const dA = sp.zBack - sp.czA, dB = sp.zBack - sp.czB;
const fBExpect = sp.fA * dB / dA;
check('fB 按深度比构造', Math.abs(pair.defs[1].cam.f - fBExpect) < 1e-9,
  `fB=${pair.defs[1].cam.f.toFixed(2)} expect=${fBExpect.toFixed(2)}`);
check('两镜头焦距确实不同', Math.abs(pair.defs[0].cam.f - pair.defs[1].cam.f) > 100);

// 两镜头都含后墙与侧墙线，且侧墙控制点可见
for (const [i, shot] of pair.shots.entries()) {
  const roles = {};
  for (const s of shot.segments) roles[s.role] = (roles[s.role] || 0) + 1;
  check(`镜头${i} 含后墙线`, (roles.back || 0) >= 8, JSON.stringify(roles));
  check(`镜头${i} 含侧墙线`, (roles.side || 0) >= 4, JSON.stringify(roles));
  check(`镜头${i} 侧墙控制点可见`, shot.segments.some((s) => s.control),
    `${shot.segments.filter((s) => s.control).length} 个控制点`);
}

const rep = Ambiguity.solveAmbiguity(pair);

// 后墙投影近似相同（同噪声，几何上逐像素一致）
check('后墙投影一致 mean < 0.5px', rep.backAgreement.mean < 0.5,
  `mean=${rep.backAgreement.mean} max=${rep.backAgreement.max}`);
// 侧墙投影显著分离
check('侧墙分离 mean > 5px', rep.sideSeparation.mean > 5,
  `mean=${rep.sideSeparation.mean.toFixed(2)} max=${rep.sideSeparation.max.toFixed(2)}`);

// 两阶段求解
for (const st of rep.stages) {
  check(`镜头${st.shot} 阶段一两模型后墙 RMS 都低（<1.5px）`,
    st.stage1_backOnly.correct.rms < 1.5 && st.stage1_backOnly.wrong.rms < 1.5,
    `c=${st.stage1_backOnly.correct.rms.toFixed(2)} w=${st.stage1_backOnly.wrong.rms.toFixed(2)}`);
  check(`镜头${st.shot} 阶段一歧义不可分辨（gap<1px）`, st.backStageGap < 1,
    `gap=${st.backStageGap}`);
  check(`镜头${st.shot} 阶段二正确模型 RMS < 1.5px`,
    st.stage2_withSide.correct.rms < 1.5, `rms=${st.stage2_withSide.correct.rms.toFixed(2)}`);
  check(`镜头${st.shot} 阶段二错误模型侧墙 RMS 显著（>10px）`,
    st.stage2_withSide.wrong.sideRms > 10, `sideRms=${st.stage2_withSide.wrong.sideRms.toFixed(2)}`);
  check(`镜头${st.shot} 实际求解选择正确模型（侧墙解歧）`, st.resolvedBySide === true);
  // 正确模型侧墙 RMS 必须远小于错误模型
  check(`镜头${st.shot} 正确侧墙 RMS << 错误侧墙 RMS`,
    st.stage2_withSide.correct.sideRms < st.stage2_withSide.wrong.sideRms / 5);
}

console.log(failures ? `\n${failures} 项失败` : '\n歧义对全部通过');
process.exit(failures ? 1 : 0);
