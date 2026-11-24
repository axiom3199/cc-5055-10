/* 素材包真实存在 + 重建约定无头测试：node test/packs.cjs
 * 1) 三个包文件必须真实存在于 assets/packs，结构符合约定；
 * 2) 证据文件真实存在且数值有限；
 * 3) 以子进程跑 tools/reconstruct.cjs 端到端重建，必须退出码 0；
 * 4) 损坏/缺字段的包必须被拒绝（不以默认值遮错）。 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PACK_DIR = path.join(ROOT, 'assets', 'packs');
const EVID = path.join(ROOT, 'assets', 'evidence', 'build-evidence.json');
const NAMES = ['street-facade', 'ambiguity-indoor', 'line-samples'];

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
};
const finite = (x) => typeof x === 'number' && isFinite(x);

for (const name of NAMES) {
  const file = path.join(PACK_DIR, `${name}.pack.json`);
  check(`包文件真实存在 ${name}`, fs.existsSync(file), file);
  const pack = JSON.parse(fs.readFileSync(file, 'utf8'));
  check(`${name} 含 packVersion/kind/content/provenance`,
    pack.packVersion === 1 && typeof pack.kind === 'string' &&
    !!pack.content && !!pack.provenance && !!pack.provenance.generator);
  check(`${name} provenance 保存来源参数与真值相机`,
    !!pack.provenance.params && Array.isArray(pack.provenance.truth.cameras) &&
    pack.provenance.truth.cameras.length > 0);
}

// 街景包内容约定
const street = JSON.parse(fs.readFileSync(path.join(PACK_DIR, 'street-facade.pack.json'), 'utf8'));
check('街景包含 3 个镜头 A/B/B′', street.content.shots.map((s) => s.id).join(',') === "A,B,B'");
for (const sh of street.content.shots) {
  check(`街景镜头 ${sh.id} 观测线非空`, Array.isArray(sh.observedLines) && sh.observedLines.length > 0);
  check(`街景镜头 ${sh.id} 带已知点`, sh.knownPoint && sh.knownPoint.px.length === 2);
  check(`街景镜头 ${sh.id} 店招观测含遮挡边界数值`,
    finite(sh.signObserved.occlusionBoundaryY) && finite(sh.signObserved.fraction));
}
check('街景包含遮挡盒与简模线', Array.isArray(street.content.boxes) && street.content.modelLines.length > 0);

// 歧义包内容约定
const amb = JSON.parse(fs.readFileSync(path.join(PACK_DIR, 'ambiguity-indoor.pack.json'), 'utf8'));
for (const sh of amb.content.shots) {
  check(`歧义镜头 ${sh.id} 声明末段控制点`, Array.isArray(sh.controlTags) && sh.controlTags.length > 0);
  check(`歧义镜头 ${sh.id} 观测线带 role`, sh.observedLines.every((l) => l.role === 'back' || l.role === 'side'));
}

// 证据文件
check('构建证据文件真实存在', fs.existsSync(EVID));
const evid = JSON.parse(fs.readFileSync(EVID, 'utf8'));
check('证据覆盖三个包', evid.results.length === 3);
const streetEv = evid.results.find((r) => r.pack === 'street-facade');
check('证据含焦距候选与选解',
  streetEv.focalCandidates.length === 3 && streetEv.occlusionSelection.comboCount > 0 &&
  finite(streetEv.occlusionSelection.boundaryErr));
check('证据含复演翻转与锚点保持',
  streetEv.replay.flipped === true && streetEv.replay.anchorUnchanged === true);
const ambEv = evid.results.find((r) => r.pack === 'ambiguity-indoor');
check('证据含两阶段解歧记录',
  ambEv.stages.every((s) => s.resolvedBySide === true && finite(s.stage1.gap)));
const sampEv = evid.results.find((r) => r.pack === 'line-samples');
check('证据含灭点夹角与投影残差',
  sampEv.verifications.every((v) => v.pass && finite(v.projectionRmsPx) &&
    v.vpDirections.every((r) => r.pass && finite(r.angleDeg))));

// 端到端重建子进程
try {
  const out = execFileSync('node', [path.join(ROOT, 'tools', 'reconstruct.cjs')], { encoding: 'utf8' });
  check('重建脚本端到端退出 0', /全部素材包重建核验通过/.test(out));
} catch (e) {
  check('重建脚本端到端退出 0', false, e.message);
}

// 缺字段包必须被拒绝（不以默认值遮错）
const tmp = path.join(ROOT, 'assets', 'packs', '__broken.pack.json');
const broken = JSON.parse(JSON.stringify(street));
delete broken.content;
fs.writeFileSync(tmp, JSON.stringify(broken));
let rejected = false;
try {
  execFileSync('node', [path.join(ROOT, 'tools', 'reconstruct.cjs'), tmp], { encoding: 'utf8', stdio: 'pipe' });
} catch (e) {
  rejected = /不符合约定|字段缺失/.test(e.stdout || '') || /不符合约定|字段缺失/.test(e.stderr || '');
}
check('损坏素材包被显式拒绝', rejected);
fs.unlinkSync(tmp);

console.log(failures ? `\n${failures} 项失败` : '\n素材包测试全部通过');
process.exit(failures ? 1 : 0);
