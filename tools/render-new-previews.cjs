/* 新场景渲染预览：软件光栅化街景/歧义/线样例画面 -> PNG（/tmp，供人工目检）
 * 不引入任何依赖，光栅器与 test/render-preview.cjs 同风格。 */
const zlib = require('zlib');
const fs = require('fs');
const Geom = require('../js/geom.js');
const Facade = require('../js/facade.js');
const Street = require('../js/street.js');
const Ambiguity = require('../js/ambiguity.js');
const Samples = require('../js/samples.js');

function makeCanvas(w, h) {
  const buf = new Uint8Array(w * h * 3);
  const set = (x, y, c, a) => {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 3;
    const al = a === undefined ? 1 : a;
    buf[i] = buf[i] * (1 - al) + c[0] * al;
    buf[i + 1] = buf[i + 1] * (1 - al) + c[1] * al;
    buf[i + 2] = buf[i + 2] * (1 - al) + c[2] * al;
  };
  const line = (p, q, c, a) => {
    const n = Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) * 1.5) + 1;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      set(p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1]), c, a);
    }
  };
  const poly = (pts, c, a) => { for (let i = 0; i + 1 < pts.length; i++) line(pts[i], pts[i + 1], c, a); };
  return { buf, set, line, poly };
}

function writePNG(file, w, h, buf) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    Buffer.from(buf.buffer, y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
}

const FAM = { X: [231, 76, 60], Y: [46, 204, 113], Z: [52, 152, 219] };
const GREY = [120, 126, 140], GOLD = [255, 214, 90], CYAN = [63, 214, 214];

function base(w, h) {
  const cv = makeCanvas(w, h);
  for (let i = 0; i < w * h * 3; i += 3) { cv.buf[i] = 16; cv.buf[i + 1] = 18; cv.buf[i + 2] = 24; }
  return cv;
}
function drawSegs(cv, segs, colorOf) {
  for (const s of segs) cv.poly(s.pts, colorOf(s), 1);
}

// 街景：观测线 + 选中候选相机模型投影
const data = Facade.buildAll();
data.shots.forEach((shot, i) => {
  const sol = Street.solveShot(shot, {});
  // 预览优先画遮挡选解会保留的 YZ 稳健候选，而非首个有效（可能狂野）候选
  const cand = sol.focalCandidates.find((c) => c.pair === 'YZ' && c.cam) ||
    sol.focalCandidates.find((c) => c.cam);
  const cv = base(data.W, data.H);
  drawSegs(cv, shot.segments, (s) => FAM[s.family] || GREY);
  if (cand) for (const m of data.model) {
    const q1 = Geom.project(cand.cam, m.p1), q2 = Geom.project(cand.cam, m.p2);
    if (!q1 || !q2) continue;
    const pts = Geom.clipPtsToRect([q1, q2], data.W, data.H);
    if (pts.length === 2) cv.line(pts[0], pts[1], GOLD, 0.7);
  }
  const kp = shot.knownPointPx;
  cv.line([kp[0] - 5, kp[1] - 5], [kp[0] + 5, kp[1] + 5], CYAN, 1);
  cv.line([kp[0] + 5, kp[1] - 5], [kp[0] - 5, kp[1] + 5], CYAN, 1);
  const f = `/tmp/street-${shot.def.id.replace(/'/g, 'p')}.png`;
  writePNG(f, data.W, data.H, cv.buf);
  console.log(f, `f=${cand.f.toFixed(1)} signFrac=${shot.sign.fraction.toFixed(3)}`);
});

// 歧义对：后墙灰、侧墙金、控制点青
const pair = Ambiguity.renderPair();
pair.shots.forEach((shot, i) => {
  const cv = base(pair.W, pair.H);
  drawSegs(cv, shot.segments, (s) => s.control ? CYAN : (s.role === 'side' ? GOLD : FAM[s.family] || GREY));
  const f = `/tmp/ambiguity-${i}.png`;
  writePNG(f, pair.W, pair.H, cv.buf);
  console.log(f, `segs=${shot.segments.length}`);
});

// 线样例
Samples.buildAll().samples.forEach((smp) => {
  const cv = base(smp.W, smp.H);
  drawSegs(cv, smp.segments, (s) => FAM[s.family] || GREY);
  const f = `/tmp/sample-${smp.id}.png`;
  writePNG(f, smp.W, smp.H, cv.buf);
  console.log(f, `segs=${smp.segments.length}`);
});
console.log('已输出 /tmp/street-*.png、/tmp/ambiguity-*.png、/tmp/sample-*.png');
