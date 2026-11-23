/* app.js — 交互：线族分组、解算、测量尺、校验 */
(function () {
  const { shots, grids, room, W, H } = Scene.buildAll();
  const FAM_COLOR = { X: '#e74c3c', Y: '#2ecc71', Z: '#3498db' };
  const FAM_KEY = { 1: 'X', 2: 'Y', 3: 'Z' };
  const DEG = 180 / Math.PI;

  const state = {
    shotIdx: 0,
    segments: [],
    assignments: {},
    undoStack: [],
    selected: null,
    hover: null,
    mode: 'select', // 'select' | 'known'
    ruler: null,
    dragging: null,
    knownPx: null,
    k1: null,
    k1Applied: false,
    fMode: 'auto',
    zeroRoll: true,
    sol: null,
    validation: null,
    compare: null,
    ghost: null, // 恢复横梁前的尺端地面点（用于重投对比）
    restored: false,
    chain: { f: null, h: null },
    show: { vps: true, horizon: true, band: true, grid: false },
  };

  const canvas = document.getElementById('view');
  const ctx = canvas.getContext('2d');
  const $ = (id) => document.getElementById(id);

  // ---------- 状态操作 ----------
  function loadShot(i) {
    state.shotIdx = i;
    const shot = shots[i];
    state.segments = shot.segments;
    state.assignments = {};
    state.undoStack = [];
    state.selected = null;
    state.mode = 'select';
    state.ruler = { p1: shot.rulerPx[0].slice(), p2: shot.rulerPx[1].slice() };
    state.knownPx = shot.knownPointPx ? shot.knownPointPx.slice() : null;
    state.k1 = null;
    state.k1Applied = false;
    state.sol = null;
    state.validation = null;
    state.compare = null;
    state.ghost = null;
    state.restored = false;
    $('k1Apply').checked = false;
    $('restoreBtn').style.display =
      shot.segments.some((s) => s.occluded) ? '' : 'none';
    $('shotDesc').textContent = shot.def.desc;
    draw();
    updatePanel();
  }

  function pushUndo() {
    state.undoStack.push(Object.assign({}, state.assignments));
    if (state.undoStack.length > 60) state.undoStack.shift();
  }

  function undo() {
    const prev = state.undoStack.pop();
    if (prev) {
      state.assignments = prev;
      state.sol = null; state.validation = null; state.compare = null;
      draw(); updatePanel();
    }
  }

  function camDef() {
    const d = shots[state.shotIdx].def.cam;
    return { f: d.f, cx: d.cx, cy: d.cy, k1: state.k1Applied && state.k1 ? state.k1 : 0 };
  }

  function solveOpts(fMode) {
    const shot = shots[state.shotIdx];
    return {
      segments: state.segments,
      assignments: state.assignments,
      camDef: camDef(),
      k1Applied: state.k1Applied,
      fMode: fMode || state.fMode,
      fChained: state.chain.f,
      hChained: state.chain.h,
      H: room.height,
      tileW: room.tileCorridor,
      zeroRoll: state.zeroRoll,
      knownPoint: state.knownPx
        ? { px: state.knownPx, world: shot.def.knownPointWorld }
        : null,
    };
  }

  function doSolve() {
    state.sol = Estimate.solve(solveOpts());
    if (state.sol.focal.value && state.sol.h !== null) {
      state.chain.f = state.sol.focal.value;
      state.chain.h = state.sol.h;
    }
    state.validation = null;
    state.compare = null;
    draw();
    updatePanel();
  }

  function doValidate() {
    if (!state.sol || !state.sol.cam) return;
    state.validation = Estimate.validate(
      state.sol, { segments: state.segments }, state.assignments, grids);
    state.show.grid = true;
    $('showGrid').checked = true;
    draw();
    updatePanel();
  }

  function doCompare() {
    const ind = Estimate.solve(solveOpts('independent'));
    const ch = state.chain.f ? Estimate.solve(solveOpts('chained')) : null;
    const val = (sol) => sol.cam
      ? Estimate.validate(sol, { segments: state.segments }, state.assignments, grids) : null;
    const rm = (sol) => state.ruler
      ? Estimate.rulerMeasure(sol, state.ruler.p1, state.ruler.p2) : null;
    state.compare = {
      ind, ch,
      valInd: val(ind), valCh: ch && val(ch),
      rmInd: rm(ind), rmCh: ch && rm(ch),
    };
    updatePanel();
  }

  function doEstimateK1() {
    const assigned = state.segments.filter((s) => state.assignments[s.id]);
    if (assigned.length < 3) {
      $('k1Info').innerHTML = '<span class="warn">请先用自动分组标记线族，再估计畸变。</span>';
      return;
    }
    const d = shots[state.shotIdx].def.cam;
    const est = Estimate.estimateK1(assigned, { f: d.f, cx: d.cx, cy: d.cy });
    state.k1 = est.k1;
    updatePanel();
  }

  function doRestore() {
    const mg = Estimate.mergeCollinear(state.segments, state.assignments);
    if (!mg.mergedSegs.length) {
      $('ghostInfo').innerHTML = '<span class="dim">没有可合并的共线碎片。</span>';
      return;
    }
    // 恢复前的尺端地面点：恢复后重投，对比“确实量对”与“视觉贴边”
    state.ghost = null;
    if (state.sol && state.sol.cam && state.ruler) {
      const g1 = Geom.groundIntersection(state.sol.cam, state.ruler.p1);
      const g2 = Geom.groundIntersection(state.sol.cam, state.ruler.p2);
      state.ghost = [g1 && g1.G, g2 && g2.G].filter(Boolean);
    }
    state.segments = state.segments
      .filter((s) => !mg.removedIds.includes(s.id))
      .concat(mg.mergedSegs);
    for (const id of mg.removedIds) delete state.assignments[id];
    for (const m of mg.mergedSegs) state.assignments[m.id] = m.family;
    state.restored = true;
    $('restoreBtn').disabled = true;
    doSolve();
  }

  // ---------- 绘制 ----------
  function drawPolyline(pts, color, width, dash) {
    if (pts.length < 2) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dash || []);
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function segDrawPoints(s) {
    if (!state.k1Applied || !state.k1) return s.pts;
    return Estimate.straightenedPoints(s, camDef(), true);
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#101218';
    ctx.fillRect(0, 0, W, H);

    // 预测网格（在地砖线之下）
    if (state.show.grid && state.sol && state.sol.cam) drawPredGrid();

    // 线段（照片内容）
    for (const s of state.segments) {
      const fam = state.assignments[s.id];
      let color = fam ? FAM_COLOR[fam] : '#5a6070';
      let width = fam ? 2 : 1.2;
      const dash = s.kind === 'restored' ? [7, 4] : null;
      if (s.id === state.selected) { color = '#ffffff'; width = 3; }
      else if (s.id === state.hover) { width += 1; }
      drawPolyline(segDrawPoints(s), color, width, dash);
    }

    // 校验高亮：held-out 地砖边
    if (state.validation) {
      for (const ps of state.validation.perSeg) {
        const s = state.segments.find((x) => x.id === ps.id);
        if (!s) continue;
        drawPolyline(segDrawPoints(s), ps.dist < 5 ? 'rgba(255,170,0,0.9)' : 'rgba(231,76,60,0.95)', 3);
      }
    }

    // 灭点
    if (state.show.vps && state.sol) drawVps();
    // 地平线 + 不可测带
    if (state.sol && state.sol.cam && state.show.band) drawBand();
    if (state.show.horizon && state.sol && state.sol.horizon) drawHorizon();

    // 已知点
    if (state.knownPx) {
      drawDiamond(state.knownPx, '#3fd6d6', true);
      const shot = shots[state.shotIdx];
      if (shot.knownPointPx &&
          (Math.abs(shot.knownPointPx[0] - state.knownPx[0]) > 2 ||
           Math.abs(shot.knownPointPx[1] - state.knownPx[1]) > 2)) {
        drawDiamond(shot.knownPointPx, '#3fd6d6', false); // 真值位置（空心）
      }
    }

    drawRuler();
    drawGhost();

    if (state.k1Applied && state.k1) {
      ctx.fillStyle = 'rgba(77,163,255,0.9)';
      ctx.font = '12px sans-serif';
      ctx.fillText(`已应用畸变校正 k1=${state.k1.toFixed(3)}（显示为校正后直线）`, 10, H - 10);
    }
  }

  function drawDiamond(p, color, filled) {
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(p[0], p[1] - 7); ctx.lineTo(p[0] + 7, p[1]);
    ctx.lineTo(p[0], p[1] + 7); ctx.lineTo(p[0] - 7, p[1]);
    ctx.closePath();
    if (filled) ctx.fill(); else ctx.stroke();
  }

  function drawVps() {
    const vps = state.sol.vps;
    ctx.font = '12px sans-serif';
    for (const fam of ['X', 'Y', 'Z']) {
      const v = vps[fam];
      if (!v || !v.px) continue;
      const [u, vv] = v.px;
      if (u < -1500 || u > W + 1500 || vv < -1500 || vv > H + 1500) continue;
      // 画面外的灭点画在边缘方向指示处
      const cu = Math.max(8, Math.min(W - 8, u));
      const cv = Math.max(8, Math.min(H - 8, vv));
      ctx.strokeStyle = FAM_COLOR[fam]; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(cu, cv, 5, 0, 2 * Math.PI); ctx.stroke();
      ctx.fillStyle = FAM_COLOR[fam];
      ctx.fillText(`VP-${fam}${u !== cu || vv !== cv ? '（画面外）' : ''}`, cu + 8, cv - 8);
    }
  }

  function horizonUV() {
    const l = state.sol.horizon;
    if (Math.abs(l[1]) < 1e-9) return null;
    return [(u) => -(l[0] * u + l[2]) / l[1]];
  }

  function drawHorizon() {
    const l = state.sol.horizon;
    if (Math.abs(l[1]) < 1e-9) return;
    const v0 = -(l[0] * 0 + l[2]) / l[1];
    const v1 = -(l[0] * W + l[2]) / l[1];
    ctx.strokeStyle = 'rgba(77,163,255,0.8)';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([10, 6]);
    ctx.beginPath(); ctx.moveTo(0, v0); ctx.lineTo(W, v1); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(77,163,255,0.8)';
    ctx.font = '12px sans-serif';
    ctx.fillText('地平线', 8, Math.max(12, Math.min(H - 6, (v0 + v1) / 2 - 6)));
  }

  function drawBand() {
    const cam = state.sol.cam;
    const contour = Geom.grazingContour(cam, Estimate.GRAZING_MIN, W, H);
    if (contour.length < 2) return;
    const l = state.sol.horizon;
    ctx.beginPath();
    ctx.moveTo(contour[0][0], contour[0][1]);
    for (const p of contour) ctx.lineTo(p[0], p[1]);
    if (l && Math.abs(l[1]) > 1e-9) {
      ctx.lineTo(W, -(l[0] * W + l[2]) / l[1]);
      ctx.lineTo(0, -(l[2]) / l[1]);
    } else {
      ctx.lineTo(W, 0); ctx.lineTo(0, 0);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(231,76,60,0.13)';
    ctx.fill();
    drawPolyline(contour, 'rgba(231,76,60,0.7)', 1.2, [4, 4]);
    const mid = contour[Math.floor(contour.length / 2)];
    ctx.fillStyle = 'rgba(231,76,60,0.9)';
    ctx.font = '12px sans-serif';
    ctx.fillText('擦地角<2.5°：不可测', mid[0] - 60, mid[1] + 16);
  }

  function drawPredGrid() {
    const cam = state.sol.cam;
    ctx.lineWidth = 1;
    const drawGrid = (gd) => {
      for (const list of [gd.tileZ, gd.tileX]) {
        for (const g of list) {
          const NS = 24;
          let run = [];
          for (let i = 0; i <= NS; i++) {
            const P = [
              g.p1[0] + (i / NS) * (g.p2[0] - g.p1[0]),
              g.p1[1] + (i / NS) * (g.p2[1] - g.p1[1]),
              g.p1[2] + (i / NS) * (g.p2[2] - g.p1[2]),
            ];
            const q = Geom.project(cam, P);
            if (q) run.push(q);
            else if (run.length) { flush(run); run = []; }
          }
          if (run.length) flush(run);
        }
      }
    };
    function flush(run) {
      const clipped = Geom.clipPtsToRect(run, W, H);
      drawPolyline(clipped, 'rgba(255,255,255,0.28)', 1);
    }
    drawGrid(grids.corridor);
    drawGrid(grids.foyer);
  }

  function rulerResult() {
    if (!state.sol || !state.ruler) return null;
    return Estimate.rulerMeasure(state.sol, state.ruler.p1, state.ruler.p2);
  }

  function drawRuler() {
    if (!state.ruler) return;
    const rm = rulerResult();
    const { p1, p2 } = state.ruler;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); ctx.stroke();
    [p1, p2].forEach((p, i) => {
      let color = '#9aa0b0';
      if (rm) {
        const st = rm.ends[i].status;
        color = st === 'ok' ? '#2ecc71' : st === 'grazing' ? '#f0a35e' : '#e74c3c';
      }
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(p[0], p[1], 6, 0, 2 * Math.PI); ctx.fill();
      ctx.strokeStyle = '#101218'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(p[0], p[1], 6, 0, 2 * Math.PI); ctx.stroke();
      if (rm && rm.ends[i].status !== 'ok') {
        ctx.fillStyle = color;
        ctx.font = 'bold 13px sans-serif';
        ctx.fillText(rm.ends[i].status === 'grazing' ? '擦地角过小' : '射线朝天', p[0] + 9, p[1] - 9);
      }
    });
    if (rm && rm.d !== null) {
      const mx = (p1[0] + p2[0]) / 2, my = (p1[1] + p2[1]) / 2;
      ctx.fillStyle = rm.ok ? '#2ecc71' : '#f0a35e';
      ctx.font = 'bold 14px sans-serif';
      ctx.fillText(`${rm.d.toFixed(3)} m${rm.ok ? '' : '（含不可测端）'}`, mx + 10, my - 10);
    }
  }

  function drawGhost() {
    if (!state.ghost || !state.sol || !state.sol.cam) return;
    ctx.font = '12px sans-serif';
    state.ghost.forEach((G, i) => {
      const px = Geom.project(state.sol.cam, G);
      if (!px) return;
      ctx.strokeStyle = '#ff5edb'; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px[0] - 6, px[1] - 6); ctx.lineTo(px[0] + 6, px[1] + 6);
      ctx.moveTo(px[0] + 6, px[1] - 6); ctx.lineTo(px[0] - 6, px[1] + 6);
      ctx.stroke();
      const handle = i === 0 ? state.ruler.p1 : state.ruler.p2;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(px[0], px[1]); ctx.lineTo(handle[0], handle[1]); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#ff5edb';
      ctx.fillText('旧尺端重投', px[0] + 8, px[1] + 14);
    });
  }

  // ---------- 面板 ----------
  function fmt(v, n) { return v === null || v === undefined ? '—' : v.toFixed(n === undefined ? 2 : n); }

  function updatePanel() {
    const shot = shots[state.shotIdx];
    // 分组计数
    const cnt = { X: 0, Y: 0, Z: 0 };
    for (const id in state.assignments) cnt[state.assignments[id]]++;
    $('grpCount').textContent =
      `已分组 ${cnt.X + cnt.Y + cnt.Z} 段（X:${cnt.X} Y:${cnt.Y} Z:${cnt.Z}），共 ${state.segments.length} 段`;

    // 畸变
    if (state.k1 !== null) {
      const truth = shot.def.cam.k1;
      $('k1Info').innerHTML =
        `k1 估计 <b>${state.k1.toFixed(3)}</b>` +
        (truth ? `（真值 ${truth}）` : '（本机位无畸变）') +
        (state.k1Applied ? '，已应用校正' : '，未应用');
    }

    // 已知点
    $('knownInfo').textContent = state.knownPx
      ? `已标 (${state.knownPx[0].toFixed(0)}, ${state.knownPx[1].toFixed(0)})`
      : '未标（平移未定）';
    $('knownBtn').className = state.mode === 'known' ? 'on' : '';

    // 沿用值
    $('chainInfo').textContent = state.chain.f
      ? `上一段沿用值：f=${state.chain.f.toFixed(1)} h=${state.chain.h.toFixed(3)}`
      : '尚无上一段解算值';

    // 解算结果
    const sol = state.sol;
    if (!sol) {
      $('solInfo').innerHTML = '<span class="dim">未解算。</span>';
      $('msgs').innerHTML = '';
      $('vpInfo').innerHTML = '';
    } else {
      const srcLabel = {
        independent: '独立重算', chained: '沿用上一段',
        'chained-fallback': '独立失败·回退沿用',
      }[sol.focal.source] || '';
      let html = '';
      html += `<div class="kv"><span>焦距 f</span><span>${sol.focal.value ? sol.focal.value.toFixed(1) + ' px' : '不可解'} ${srcLabel ? `<span class="dim">${srcLabel}</span>` : ''}</span></div>`;
      if (sol.angles) {
        html += `<div class="kv"><span>偏航 / 俯仰 / 滚转</span><span>${(sol.angles.yaw * DEG).toFixed(2)}° / ${(sol.angles.pitch * DEG).toFixed(2)}° / ${(sol.angles.roll * DEG).toFixed(2)}°</span></div>`;
      }
      if (sol.h !== null) {
        html += `<div class="kv"><span>相机高 h</span><span>${sol.h.toFixed(3)} m <span class="dim">${sol.hSource}</span></span></div>`;
      } else {
        html += '<div class="kv"><span>相机高 h</span><span class="warn">未定</span></div>';
      }
      if (sol.C) html += `<div class="kv"><span>相机位置</span><span>(${sol.C.map((v) => v.toFixed(2)).join(', ')})</span></div>`;
      $('solInfo').innerHTML = html;
      $('msgs').innerHTML = sol.messages.map((m) => `<li>${m}</li>`).join('');

      // 灭点状态
      let vpHtml = '';
      for (const fam of ['X', 'Y', 'Z']) {
        const v = sol.vps[fam];
        if (!v || !v.n) continue;
        let s;
        if (v.n === 1) s = '仅 1 条线（方向受约束但未定）';
        else if (v.infinite) s = `灭点在无穷远（${v.n} 线）`;
        else {
          const d = Math.hypot(v.px[0] - W / 2, v.px[1] - H / 2);
          s = `灭点 (${v.px[0].toFixed(0)}, ${v.px[1].toFixed(0)})` +
            (d > 2000 ? `，距主点 ${(d / 1000).toFixed(1)}k px 偏远` : '') + `（${v.n} 线）`;
        }
        vpHtml += `<div><i style="display:inline-block;width:8px;height:8px;background:${FAM_COLOR[fam]};margin-right:5px"></i>${fam}：${s}</div>`;
      }
      $('vpInfo').innerHTML = vpHtml || '尚未分组。';
    }

    updateRulerPanel();

    // 校验
    if (state.validation) {
      const v = state.validation;
      $('valInfo').innerHTML =
        `<div class="kv"><span>held-out 边数</span><span>${v.nHeld}</span></div>` +
        `<div class="kv"><span>重投影 RMS</span><span class="${v.rmsPx < 5 ? 'ok' : 'warn'}">${fmt(v.rmsPx)} px</span></div>` +
        `<div class="kv"><span>砖宽拟合误差</span><span class="${v.widthErr !== null && v.widthErr < 0.05 ? 'ok' : 'warn'}">${v.widthErr === null ? '—' : (v.widthErr * 100).toFixed(1) + ' cm'}</span></div>` +
        '<div class="dim">橙色线为被核对的地砖边；白色细线为预测网格。</div>';
    }

    // 对比表
    if (state.compare) {
      const c = state.compare;
      const cell = (sol, v, rm, key) => {
        if (!sol) return '<td>—</td>';
        if (key === 'f') return `<td>${sol.focal.value ? sol.focal.value.toFixed(1) : '不可解'}</td>`;
        if (key === 'h') return `<td>${sol.h !== null ? sol.h.toFixed(3) : '—'}</td>`;
        if (key === 'yaw') return `<td>${sol.angles ? (sol.angles.yaw * DEG).toFixed(2) + '°' : '—'}</td>`;
        if (key === 'd') return `<td>${rm && rm.d !== null ? rm.d.toFixed(3) : '—'}</td>`;
        if (key === 'rms') return `<td>${v && v.rmsPx !== null ? v.rmsPx.toFixed(2) : '—'}</td>`;
        return '<td>—</td>';
      };
      $('cmpInfo').innerHTML =
        '<table><tr><th></th><th>独立重算</th><th>沿用上一段</th></tr>' +
        `<tr><td>焦距 f</td>${cell(c.ind, null, null, 'f')}${cell(c.ch, null, null, 'f')}</tr>` +
        `<tr><td>相机高 h</td>${cell(c.ind, null, null, 'h')}${cell(c.ch, null, null, 'h')}</tr>` +
        `<tr><td>偏航</td>${cell(c.ind, null, null, 'yaw')}${cell(c.ch, null, null, 'yaw')}</tr>` +
        `<tr><td>尺测距离</td>${cell(c.ind, null, c.rmInd, 'd')}${cell(c.ch, null, c.rmCh, 'd')}</tr>` +
        `<tr><td>held-out RMS</td>${cell(c.ind, c.valInd, null, 'rms')}${cell(c.ch, c.valCh, null, 'rms')}</tr>` +
        '</table>' +
        (c.ch ? '' : '<div class="dim">沿用不可用：请先在前一机位成功解算。</div>');
    } else {
      $('cmpInfo').innerHTML = '';
    }

    // 重投漂移
    if (state.ghost && state.sol && state.sol.cam) {
      const drifts = state.ghost.map((G, i) => {
        const px = Geom.project(state.sol.cam, G);
        const handle = i === 0 ? state.ruler.p1 : state.ruler.p2;
        return px ? Math.hypot(px[0] - handle[0], px[1] - handle[1]) : null;
      });
      $('ghostInfo').innerHTML =
        `<span class="warn">已恢复横梁并重解。</span>旧尺端地面点在新解下重投（粉色×），` +
        `与当前尺端漂移：${drifts.map((d) => (d === null ? '—' : d.toFixed(2) + ' px')).join(' / ')}。<br>` +
        '<span class="dim">视觉上尺端仍贴在原来的地砖缝上，但重投位置说明旧测量基于错误焦距——贴边≠量对。</span>';
    } else if (state.restored) {
      $('ghostInfo').innerHTML = '';
    }
  }

  function updateRulerPanel() {
    const shot = shots[state.shotIdx];
    const rm = rulerResult();
    if (!rm) {
      $('rulerInfo').innerHTML = '<span class="dim">解算后可测量；拖动尺端手柄。</span>';
      return;
    }
    const truth = Estimate.rulerTruth(shot.cam, state.ruler.p1, state.ruler.p2);
    let html = '';
    rm.ends.forEach((e, i) => {
      if (e.status === 'ok') {
        html += `<div class="kv"><span>端点 ${i + 1}</span><span class="ok">贴地，擦地角 ${(e.grazing * DEG).toFixed(1)}°</span></div>`;
      } else if (e.status === 'grazing') {
        html += `<div class="kv"><span>端点 ${i + 1}</span><span class="warn">擦地角 ${(e.grazing * DEG).toFixed(1)}° &lt; 2.5°，不可测</span></div>`;
      } else {
        html += `<div class="kv"><span>端点 ${i + 1}</span><span class="bad">射线朝天，不与地面相交</span></div>`;
      }
    });
    if (rm.d !== null) {
      html += `<div class="kv"><span>测量距离</span><span class="${rm.ok ? 'ok' : 'warn'}">${rm.d.toFixed(3)} m${rm.ok ? '' : '（含不可测端）'}</span></div>`;
    } else {
      html += '<div class="kv"><span>测量距离</span><span class="bad">不可测</span></div>';
    }
    if (truth) {
      const diff = rm.d !== null ? Math.abs(rm.d - truth.d) : null;
      html += `<div class="kv"><span>真值（演示）</span><span>${truth.d.toFixed(3)} m</span></div>`;
      if (diff !== null) {
        html += `<div class="kv"><span>误差</span><span class="${diff < 0.05 ? 'ok' : 'warn'}">${(diff * 100).toFixed(1)} cm</span></div>`;
      }
    }
    if (rm.ends.some((e) => e.status === 'grazing')) {
      html += '<div class="warn">尺端落在红色不可测带内：视觉上贴着地面，但射线几乎与地面平行，距离读数不可靠。</div>';
    }
    $('rulerInfo').innerHTML = html;
  }

  // ---------- 交互 ----------
  function canvasPos(ev) {
    const r = canvas.getBoundingClientRect();
    return [
      (ev.clientX - r.left) * (canvas.width / r.width),
      (ev.clientY - r.top) * (canvas.height / r.height),
    ];
  }

  function nearestSegment(p) {
    let best = null, bestD = 9;
    for (const s of state.segments) {
      const d = Geom.pointPolylineDist(p, segDrawPoints(s));
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }

  canvas.addEventListener('mousedown', (ev) => {
    const p = canvasPos(ev);
    // 尺手柄优先
    if (state.ruler) {
      for (const [key, hp] of [['p1', state.ruler.p1], ['p2', state.ruler.p2]]) {
        if (Math.hypot(p[0] - hp[0], p[1] - hp[1]) < 12) {
          state.dragging = key;
          return;
        }
      }
    }
    if (state.mode === 'known') {
      state.knownPx = p;
      state.mode = 'select';
      state.sol = null; state.validation = null; state.compare = null;
      draw(); updatePanel();
      return;
    }
    const s = nearestSegment(p);
    state.selected = s ? s.id : null;
    draw(); updatePanel();
  });

  canvas.addEventListener('mousemove', (ev) => {
    const p = canvasPos(ev);
    if (state.dragging) {
      state.ruler[state.dragging] = p;
      draw();
      updateRulerPanel();
      return;
    }
    const s = nearestSegment(p);
    if ((s && s.id) !== state.hover) {
      state.hover = s ? s.id : null;
      canvas.style.cursor = s ? 'pointer' : 'crosshair';
      draw();
    }
  });

  window.addEventListener('mouseup', () => { state.dragging = null; });

  window.addEventListener('keydown', (ev) => {
    if (ev.ctrlKey && ev.key === 'z') { ev.preventDefault(); undo(); return; }
    if (!state.selected) return;
    const fam = FAM_KEY[ev.key];
    if (fam) {
      pushUndo();
      state.assignments[state.selected] = fam;
      state.sol = null; state.validation = null; state.compare = null;
      draw(); updatePanel();
    } else if (ev.key === '0' || ev.key === 'Delete' || ev.key === 'Backspace') {
      pushUndo();
      delete state.assignments[state.selected];
      state.sol = null; state.validation = null; state.compare = null;
      draw(); updatePanel();
    }
  });

  // ---------- 控件 ----------
  const sel = $('shotSel');
  shots.forEach((s, i) => {
    const o = document.createElement('option');
    o.value = i; o.textContent = s.def.name;
    sel.appendChild(o);
  });
  sel.addEventListener('change', () => loadShot(+sel.value));
  $('resetBtn').addEventListener('click', () => loadShot(state.shotIdx));
  $('autoBtn').addEventListener('click', () => {
    pushUndo();
    state.assignments = Object.assign({}, shots[state.shotIdx].autoAssignments);
    state.sol = null; state.validation = null; state.compare = null;
    draw(); updatePanel();
  });
  $('clearBtn').addEventListener('click', () => {
    pushUndo();
    state.assignments = {};
    state.sol = null; state.validation = null; state.compare = null;
    draw(); updatePanel();
  });
  $('undoBtn').addEventListener('click', undo);
  $('k1Btn').addEventListener('click', doEstimateK1);
  $('k1Apply').addEventListener('change', (ev) => {
    state.k1Applied = ev.target.checked && state.k1 !== null;
    if (ev.target.checked && state.k1 === null) {
      $('k1Info').innerHTML = '<span class="warn">请先估计畸变。</span>';
      ev.target.checked = false;
    }
    state.sol = null; state.validation = null; state.compare = null;
    draw(); updatePanel();
  });
  document.querySelectorAll('input[name=fmode]').forEach((r) =>
    r.addEventListener('change', () => { state.fMode = r.value; }));
  $('zeroRoll').addEventListener('change', (ev) => { state.zeroRoll = ev.target.checked; });
  $('knownBtn').addEventListener('click', () => {
    state.mode = state.mode === 'known' ? 'select' : 'known';
    updatePanel();
  });
  $('solveBtn').addEventListener('click', doSolve);
  $('valBtn').addEventListener('click', doValidate);
  $('cmpBtn').addEventListener('click', doCompare);
  $('restoreBtn').addEventListener('click', doRestore);
  [['showVps', 'vps'], ['showHorizon', 'horizon'], ['showBand', 'band'], ['showGrid', 'grid']]
    .forEach(([id, key]) => $(id).addEventListener('change', (ev) => {
      state.show[key] = ev.target.checked;
      draw();
    }));

  loadShot(0);
})();
