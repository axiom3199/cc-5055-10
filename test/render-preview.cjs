/* 渲染预览：软件光栅化 app.js 的画面内容 -> PNG，供人工目检 */
const zlib = require('zlib');
const fs = require('fs');
const Geom = require('../js/geom.js');
const Scene = require('../js/scene.js');
const Estimate = require('../js/estimate.js');

const { shots, grids, room, W, H } = Scene.buildAll();

// ---- 极简光栅器 ----
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
  const fillPoly = (pts, c, a) => {
    // 扫描线
    let y0 = Infinity, y1 = -Infinity;
    for (const p of pts) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
    for (let y = Math.max(0, y0 | 0); y <= Math.min(h - 1, Math.ceil(y1)); y++) {
      const xs = [];
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i], [xj, yj] = pts[j];
        if ((yi > y) !== (yj > y)) xs.push(xi + ((y - yi) / (yj - yi)) * (xj - xi));
      }
      xs.sort((a2, b2) => a2 - b2);
      for (let k = 0; k + 1 < xs.length; k += 2)
        for (let x = Math.max(0, xs[k] | 0); x <= Math.min(w - 1, Math.ceil(xs[k + 1])); x++) set(x, y, c, a);
    }
  };
  const circle = (p, r, c, a) => {
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++)
      if (x * x + y * y <= r * r) set(p[0] + x, p[1] + y, c, a);
  };
  return { buf, set, line, poly, fillPoly, circle };
}

// ---- PNG 编码 ----
function writePNG(file, w, h, buf) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    Buffer.from(buf.buffer, y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(td) : crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8bit RGB
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
}
function crc32(data) { // node 老版本无 zlib.crc32
  let c, table = crc32.t;
  if (!table) {
    table = crc32.t = [];
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  c = 0xffffffff;
  for (const b of data) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---- 场景绘制（对应 app.js 的 draw）----
const FAM_COLOR = { X: [231, 76, 60], Y: [46, 204, 113], Z: [52, 152, 219] };
function renderShotPreview(idx, file, opts) {
  const shot = shots[idx];
  const cv = makeCanvas(W, H);
  // 背景
  for (let i = 0; i < W * H * 3; i += 3) { cv.buf[i] = 16; cv.buf[i + 1] = 18; cv.buf[i + 2] = 24; }
  const assignments = shot.autoAssignments;
  const k1 = opts && opts.k1 || 0;
  const sol = Estimate.solve({
    segments: shot.segments, assignments,
    camDef: { f: 900, cx: 480, cy: 270, k1 },
    k1Applied: !!k1,
    fMode: (opts && opts.fMode) || 'independent',
    fChained: (opts && opts.fChained) || null, hChained: null,
    H: room.height, tileW: room.tileCorridor, zeroRoll: true,
    knownPoint: { px: shot.knownPointPx, world: shot.def.knownPointWorld },
  });
  // 不可测带
  if (sol.cam) {
    const contour = Geom.grazingContour(sol.cam, Estimate.GRAZING_MIN, W, H);
    if (contour.length > 1) {
      const l = sol.horizon;
      const polyPts = contour.slice();
      if (l && Math.abs(l[1]) > 1e-9) {
        polyPts.push([W, -(l[0] * W + l[2]) / l[1]], [0, -l[2] / l[1]]);
      }
      cv.fillPoly(polyPts, [231, 76, 60], 0.13);
      cv.poly(contour, [231, 76, 60], 0.7);
    }
  }
  // 线段
  for (const s of shot.segments) {
    const fam = assignments[s.id];
    const c = fam ? FAM_COLOR[fam] : [90, 96, 112];
    cv.poly(s.pts, c, fam ? 1 : 0.8);
  }
  // 地平线
  if (sol.horizon && Math.abs(sol.horizon[1]) > 1e-9) {
    const l = sol.horizon;
    cv.line([0, -l[2] / l[1]], [W, -(l[0] * W + l[2]) / l[1]], [77, 163, 255], 0.8);
  }
  // 灭点
  if (sol.vps) for (const fam of ['X', 'Y', 'Z']) {
    const v = sol.vps[fam];
    if (v && v.px && v.px[0] > -200 && v.px[0] < W + 200 && v.px[1] > -200 && v.px[1] < H + 200) {
      cv.circle(v.px, 5, FAM_COLOR[fam], 0.9);
    }
  }
  // 已知点
  cv.circle(shot.knownPointPx, 5, [63, 214, 214], 1);
  // 尺
  const rm = Estimate.rulerMeasure(sol, shot.rulerPx[0], shot.rulerPx[1]);
  cv.line(shot.rulerPx[0], shot.rulerPx[1], [255, 255, 255], 1);
  [shot.rulerPx[0], shot.rulerPx[1]].forEach((p, i) => {
    const st = rm ? rm.ends[i].status : 'ok';
    cv.circle(p, 6, st === 'ok' ? [46, 204, 113] : st === 'grazing' ? [240, 163, 94] : [231, 76, 60], 1);
  });
  console.log(`${file}: f=${sol.focal.value && sol.focal.value.toFixed(1)} h=${sol.h && sol.h.toFixed(3)} 尺=${rm && rm.d && rm.d.toFixed(3)}m`);
  writePNG(file, W, H, cv.buf);
}

renderShotPreview(0, '/tmp/preview1.png');
renderShotPreview(1, '/tmp/preview2.png', { fMode: 'chained', fChained: 907.6 });
renderShotPreview(2, '/tmp/preview3.png');
renderShotPreview(4, '/tmp/preview5.png', { k1: -0.202 });
console.log('已输出 /tmp/preview*.png');
