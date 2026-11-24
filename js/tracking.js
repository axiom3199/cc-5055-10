/* tracking.js — 建筑匹配·镜头跟踪窗口
 * 数据只来自素材包（assets/packs/*.pack.json，由 tools/build-packs.cjs 生成）。
 * 流程全部由建筑匹配内核（street.js）驱动，本文件只做交互与绘制：
 *   载入包 → 用户标注建筑线（1/2/3/0，可撤销/自动分组）→ 运行内核解算
 *   → 预览区叠加观测线结构、灭点、选中候选相机的模型投影与店招遮挡预测；
 *   → 双镜头遮挡选解；失败（线族不足/候选全 null/包损坏）反馈到界面，不做默认值兜底。
 */
(function () {
  const FAM_COLOR = { X: '#e74c3c', Y: '#2ecc71', Z: '#3498db' };
  const FAM_KEY = { 1: 'X', 2: 'Y', 3: 'Z' };
  const FAMILIES = ['X', 'Y', 'Z'];
  const $ = (id) => document.getElementById(id);

  const state = {
    pack: null,
    W: 960, H: 540,
    shotIdx: 0,
    shots: [],          // 适配后的镜头（含 segments/knownPointPx/def）
    assignments: {},
    undoStack: [],
    selected: null,
    hover: null,
    sol: null,          // 当前镜头内核解
    ranking: null,      // 双镜头遮挡选解
    selCand: 0,         // 选中的焦距候选下标
    show: { obs: true, model: true, vps: true, sign: true },
    loadError: null,
  };

  const canvas = $('view');
  const ctx = canvas.getContext('2d');

  // ---------- 素材包 → 内核 shot 适配（不读 provenance.truth）----------
  function adaptPack(pack) {
    if (!pack || pack.packVersion !== 1 || !pack.content || !pack.provenance) {
      throw new Error('素材包结构不符合约定（需 packVersion=1 且含 content/provenance）');
    }
    if (pack.kind !== 'street-facade') {
      throw new Error(`镜头跟踪窗口当前仅支持 street-facade 包，收到 kind=${pack.kind}`);
    }
    const c = pack.content;
    if (!Array.isArray(c.shots) || c.shots.length < 2) throw new Error('素材包镜头不足 2 个');
    if (!Array.isArray(c.modelLines) || !Array.isArray(c.boxes) || !c.facade) {
      throw new Error('素材包缺少 modelLines/boxes/facade');
    }
    const shots = c.shots.map((sh) => {
      if (!sh.observedLines || !sh.observedLines.length) throw new Error(`镜头 ${sh.id} 无观测线`);
      if (!sh.knownPoint || !sh.knownPoint.px || !sh.knownPoint.world) {
        throw new Error(`镜头 ${sh.id} 缺已知地面点`);
      }
      if (!sh.signObserved || typeof sh.signObserved.occlusionBoundaryY !== 'number') {
        throw new Error(`镜头 ${sh.id} 缺 signObserved.occlusionBoundaryY（遮挡选解所需观测证据）`);
      }
      const segments = sh.observedLines.map((l) => ({
        id: l.id, pts: l.pts, family: l.family, srcTag: l.srcTag,
        kind: l.kind, occluded: l.occluded, fragCount: l.fragCount,
      }));
      return {
        id: sh.id, name: sh.name || sh.id, desc: sh.desc || '',
        def: {
          id: sh.id,
          cam: { cx: sh.image.cx, cy: sh.image.cy },
          knownPointWorld: sh.knownPoint.world,
        },
        knownPointPx: sh.knownPoint.px.slice(),
        segments,
        // 内核 occlusionRanking 读取 shot.sign.fraction
        sign: {
          total: sh.signObserved.total,
          visible: sh.signObserved.visible,
          fraction: sh.signObserved.fraction,
        },
        signFraction: sh.signObserved ? sh.signObserved.fraction : null,
        occlusionBoundaryY: sh.signObserved ? sh.signObserved.occlusionBoundaryY : null,
      };
    });
    return {
      shots,
      model: c.modelLines.map((m) => ({
        tag: m.tag, p1: m.p1, p2: m.p2, family: m.family, kind: m.kind,
      })),
      boxes: c.boxes, facade: c.facade,
      W: c.shots[0].image.W, H: c.shots[0].image.H,
      obsBoundaries: c.shots.map((s) => s.occlusionBoundaryY),
    };
  }

  // ---------- 载入 ----------
  async function loadPack(pack) {
    try {
      const adapted = adaptPack(pack);
      state.pack = pack;
      state.shots = adapted.shots;
      state.model = adapted.model;
      state.boxes = adapted.boxes;
      state.facade = adapted.facade;
      state.W = adapted.W; state.H = adapted.H;
      canvas.width = state.W; canvas.height = state.H;
      state.loadError = null;
      buildShotSelector();
      loadShot(0);
      $('loadInfo').innerHTML = `<span class="ok">已载入：${pack.kind}（${state.shots.length} 镜头，` +
        `${state.model.length} 简模线，v${pack.packVersion}）</span>`;
      setKernelControls();
    } catch (e) {
      state.loadError = e.message;
      state.pack = null;
      $('loadInfo').innerHTML = `<span class="bad">载入失败：${e.message}</span>`;
      setKernelControls();
    }
  }

  function buildShotSelector() {
    const sel = $('shotSel');
    sel.innerHTML = '';
    state.shots.forEach((s, i) => {
      const o = document.createElement('option');
      o.value = i; o.textContent = s.id + (s.name ? ' · ' + s.name : '');
      sel.appendChild(o);
    });
  }

  function loadShot(i) {
    state.shotIdx = i;
    state.assignments = {};
    state.undoStack = [];
    state.selected = null;
    state.sol = null;
    state.ranking = null;
    state.selCand = 0;
    autoAssign(); // 默认按包内 family 真值预分组，用户可改
    draw();
    updatePanel();
    setKernelControls();
  }

  // ---------- 分组 ----------
  function pushUndo() {
    state.undoStack.push(Object.assign({}, state.assignments));
    if (state.undoStack.length > 60) state.undoStack.shift();
  }
  function undo() {
    const prev = state.undoStack.pop();
    if (prev) { state.assignments = prev; invalidateSolve(); draw(); updatePanel(); }
  }
  function autoAssign() {
    const shot = state.shots[state.shotIdx];
    state.assignments = {};
    for (const s of shot.segments) state.assignments[s.id] = s.family;
    invalidateSolve();
  }
  function clearAssign() {
    pushUndo();
    state.assignments = {};
    invalidateSolve(); draw(); updatePanel();
  }
  function invalidateSolve() {
    state.sol = null; state.ranking = null; state.selCand = 0;
    setKernelControls();
  }

  // ---------- 内核驱动：控件启用/禁用与失败反馈 ----------
  function assignedCount() {
    const cnt = { X: 0, Y: 0, Z: 0 };
    for (const id in state.assignments) cnt[state.assignments[id]]++;
    return cnt;
  }
  function familyReady() {
    const cnt = assignedCount();
    return FAMILIES.map((f) => ({ f, n: cnt[f], enough: cnt[f] >= 2 }));
  }
  function setKernelControls() {
    const loaded = !!state.pack;
    $('autoBtn').disabled = !loaded;
    $('clearBtn').disabled = !loaded;
    $('undoBtn').disabled = !loaded;
    $('solveBtn').disabled = !loaded;
    $('rankBtn').disabled = !loaded || state.shots.length < 2;
    $('candSel').disabled = true;
    if (!loaded) {
      $('kernelState').innerHTML = state.loadError
        ? `<span class="bad">${state.loadError}</span>`
        : '<span class="dim">未载入素材包。</span>';
      return;
    }
    const ready = familyReady();
    const missing = ready.filter((r) => !r.enough).map((r) => `${r.f}(${r.n})`);
    if (missing.length) {
      $('kernelState').innerHTML =
        `<span class="warn">内核未就绪：线族不足 2 条 → ${missing.join('、')}；求解会给出缺失/病态候选而非默认值。</span>`;
    } else {
      $('kernelState').innerHTML = '<span class="ok">内核就绪：三向线族均可求灭点。</span>';
    }
    if (state.sol) {
      const valid = state.sol.focalCandidates.filter((c) => c.cam);
      $('candSel').disabled = valid.length < 2;
    }
  }

  // ---------- 运行内核 ----------
  function runSolve() {
    if (!state.pack) return;
    const shot = state.shots[state.shotIdx];
    try {
      state.sol = Street.solveShot(shot, { assignments: state.assignments });
      state.selCand = 0;
      const firstValid = state.sol.focalCandidates.findIndex((c) => c.cam);
      if (firstValid >= 0) state.selCand = firstValid;
      buildCandSelector();
    } catch (e) {
      state.sol = null;
      $('kernelState').innerHTML = `<span class="bad">内核求解异常：${e.message}</span>`;
    }
    draw(); updatePanel(); setKernelControls();
  }

  function buildCandSelector() {
    const sel = $('candSel');
    sel.innerHTML = '';
    state.sol.focalCandidates.forEach((c, i) => {
      const o = document.createElement('option');
      o.value = i;
      o.textContent = c.f === null
        ? `${c.pair}：不可用（${c.reason}）`
        : `${c.pair}：f=${c.f.toFixed(1)}px${c.cam ? '' : '（无相机）'}`;
      sel.appendChild(o);
    });
    sel.value = String(state.selCand);
  }

  function runRanking() {
    if (!state.pack) return;
    try {
      const sols = state.shots.map((s) => Street.solveShot(s, {}));
      const anyValid = sols.every((sol) => sol.focalCandidates.some((c) => c.cam));
      if (!anyValid) {
        $('rankInfo').innerHTML = '<span class="bad">遮挡选解失败：存在镜头没有任何可构造相机的焦距候选。</span>';
        return;
      }
      // 观测边界取自素材包观测证据；若缺失则显式失败，不用默认值
      if (state.shots.slice(0, 2).some((s) => typeof s.occlusionBoundaryY !== 'number')) {
        $('rankInfo').innerHTML = '<span class="bad">遮挡选解失败：素材包缺 signObserved.occlusionBoundaryY。</span>';
        return;
      }
      state.ranking = Street.occlusionRanking(
        sols.slice(0, 2), state.shots.slice(0, 2),
        state.facade, state.boxes, state.model,
        state.shots.slice(0, 2).map((s) => s.occlusionBoundaryY));
      $('rankInfo').innerHTML =
        `<span class="ok">选中候选对 ${state.ranking.selected.pair.join(' / ')}，` +
        `f=${state.ranking.selected.f.map((v) => v.toFixed(1)).join(' / ')}，` +
        `遮挡错误 ${state.ranking.selected.occErrors}，边界误差 ${state.ranking.selected.boundaryErr}m，` +
        `重投 RMS ${state.ranking.selected.reprRms}px。</span>`;
    } catch (e) {
      state.ranking = null;
      $('rankInfo').innerHTML = `<span class="bad">遮挡选解异常：${e.message}</span>`;
    }
    draw();
  }

  // ---------- 绘制 ----------
  function line(p1, p2, color, width, dash) {
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash || []);
    ctx.beginPath(); ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); ctx.stroke();
    ctx.setLineDash([]);
  }

  function selectedCandidate() {
    if (!state.sol) return null;
    const c = state.sol.focalCandidates[state.selCand];
    return c && c.cam ? c : state.sol.focalCandidates.find((x) => x.cam) || null;
  }

  function draw() {
    if (!state.pack) {
      ctx.fillStyle = '#101218'; ctx.fillRect(0, 0, state.W, state.H);
      ctx.fillStyle = '#8a90a0'; ctx.font = '15px sans-serif';
      ctx.fillText('请先载入 assets/packs/street-facade.pack.json', 24, state.H / 2);
      return;
    }
    ctx.fillStyle = '#101218'; ctx.fillRect(0, 0, state.W, state.H);
    const shot = state.shots[state.shotIdx];

    // 1) 观测线结构（用户标注/包内线）
    if (state.show.obs) {
      for (const s of shot.segments) {
        const fam = state.assignments[s.id];
        let color = fam ? FAM_COLOR[fam] : '#5a6070';
        let width = fam ? 2 : 1.2;
        if (s.id === state.selected) { color = '#ffffff'; width = 3; }
        else if (s.id === state.hover) width += 1;
        line(s.pts[0], s.pts[1], color, width, s.occluded ? [6, 4] : null);
      }
    }

    // 2) 选中候选相机的模型投影（相机投影叠加层）
    const cand = selectedCandidate();
    if (state.show.model && cand) {
      const cam = cand.cam;
      for (const m of state.model) {
        const q1 = Geom.project(cam, m.p1), q2 = Geom.project(cam, m.p2);
        if (!q1 || !q2) continue;
        const pts = Geom.clipPtsToRect([q1, q2], state.W, state.H);
        if (pts.length < 2) continue;
        line(pts[0], pts[1], 'rgba(255,214,90,0.85)', 1.4, [4, 3]);
      }
      // 已知地面点
      ctx.strokeStyle = '#3fd6d6'; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(shot.knownPointPx[0] - 6, shot.knownPointPx[1] - 6);
      ctx.lineTo(shot.knownPointPx[0] + 6, shot.knownPointPx[1] + 6);
      ctx.moveTo(shot.knownPointPx[0] + 6, shot.knownPointPx[1] - 6);
      ctx.lineTo(shot.knownPointPx[0] - 6, shot.knownPointPx[1] + 6);
      ctx.stroke();
    }

    // 3) 灭点
    if (state.show.vps && state.sol) drawVps();

    // 4) 店招遮挡预测区域
    if (state.show.sign && cand) drawSignPrediction(cand);

    // 角标
    ctx.fillStyle = 'rgba(216,220,230,0.85)'; ctx.font = '12px sans-serif';
    ctx.fillText(`镜头 ${shot.id}｜实线=观测线结构 黄虚线=候选相机模型投影 青×=已知地面点`, 10, state.H - 10);
  }

  function drawVps() {
    ctx.font = '12px sans-serif';
    for (const fam of FAMILIES) {
      const v = state.sol.vps[fam];
      if (!v || !v.px) continue;
      const [u, vv] = v.px;
      const cu = Math.max(8, Math.min(state.W - 8, u));
      const cv = Math.max(8, Math.min(state.H - 8, vv));
      ctx.strokeStyle = FAM_COLOR[fam]; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(cu, cv, 5, 0, 2 * Math.PI); ctx.stroke();
      ctx.fillStyle = FAM_COLOR[fam];
      ctx.fillText(`VP-${fam}${u !== cu || vv !== cv ? '（画面外）' : ''}`, cu + 8, cv - 8);
    }
  }

  function drawSignPrediction(cand) {
    const pred = Street.predictedSignVisibility(cand.cam, state.facade, state.boxes);
    const S = state.facade.sign;
    const corners = [
      [S.min[0], S.min[1], S.max[2] + 0.02],
      [S.max[0], S.min[1], S.max[2] + 0.02],
      [S.max[0], S.max[1], S.max[2] + 0.02],
      [S.min[0], S.max[1], S.max[2] + 0.02],
    ].map((P) => Geom.project(cand.cam, P));
    if (corners.some((q) => !q)) return;
    ctx.strokeStyle = pred.fraction < 0.95 ? 'rgba(240,163,94,0.95)' : 'rgba(46,204,113,0.95)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(corners[0][0], corners[0][1]);
    for (let i = 1; i < 4; i++) ctx.lineTo(corners[i][0], corners[i][1]);
    ctx.closePath(); ctx.stroke();
    ctx.fillStyle = ctx.strokeStyle; ctx.font = '12px sans-serif';
    ctx.fillText(`店招可见率预测 ${(pred.fraction * 100).toFixed(0)}%`, corners[0][0], corners[0][1] - 8);
  }

  // ---------- 面板 ----------
  function updatePanel() {
    if (!state.pack) return;
    const cnt = assignedCount();
    $('grpCount').textContent =
      `已分组 ${cnt.X + cnt.Y + cnt.Z} 段（X:${cnt.X} Y:${cnt.Y} Z:${cnt.Z}），共 ${state.shots[state.shotIdx].segments.length} 段`;
    const shot = state.shots[state.shotIdx];
    $('shotDesc').textContent =
      (shot.desc || '') + `｜观测店招可见率=${shot.signFraction === null ? 'n/a' : shot.signFraction}`;

    if (!state.sol) {
      $('solInfo').innerHTML = '<span class="dim">尚未运行内核求解。</span>';
      $('candSel').innerHTML = '';
      $('residInfo').innerHTML = '';
      return;
    }
    // 候选表（含显式 null 与原因）
    let html = '<table><tr><th>灭点对</th><th>焦距 f</th><th>状态/原因</th></tr>';
    state.sol.focalCandidates.forEach((c) => {
      html += `<tr><td>${c.pair}</td><td>${c.f === null ? 'null' : c.f.toFixed(1)}</td>` +
        `<td style="text-align:left">${c.cam ? '可构造相机+地面' : '<span class="bad">' + c.reason + '</span>'}</td></tr>`;
    });
    html += '</table>';
    $('solInfo').innerHTML = html;

    const cand = selectedCandidate();
    if (cand && cand.angles) {
      const a = cand.angles;
      html = `<div class="kv"><span>选中候选</span><span>${cand.pair} f=${cand.f.toFixed(1)}</span></div>` +
        `<div class="kv"><span>偏航/俯仰/滚转</span><span>${(a.yaw * 180 / Math.PI).toFixed(2)}° / ` +
        `${(a.pitch * 180 / Math.PI).toFixed(2)}° / ${(a.roll * 180 / Math.PI).toFixed(2)}°</span></div>` +
        `<div class="kv"><span>相机位置</span><span>(${cand.cam.C.map((v) => v.toFixed(2)).join(', ')})</span></div>` +
        `<div class="kv"><span>地面 nCam</span><span>(${cand.ground.nCam.map((v) => v.toFixed(2)).join(', ')})</span></div>`;
      $('solInfo').innerHTML += html;
    }
    const r = state.sol.residual;
    $('residInfo').innerHTML =
      `线-灭点 RMS=<b>${r.rms === null ? '不可计算' : r.rms.toFixed(4) + 'px'}</b>` +
      '｜各族：' + FAMILIES.map((f) => `${f}=${r.perFam[f] === null ? 'n/a' : r.perFam[f].toFixed(4)}`).join(' ');
  }

  // ---------- 交互 ----------
  function canvasPos(ev) {
    const r = canvas.getBoundingClientRect();
    return [
      (ev.clientX - r.left) * (canvas.width / r.width),
      (ev.clientY - r.top) * (canvas.height / r.height),
    ];
  }
  function nearest(p) {
    let best = null, bestD = 9;
    for (const s of state.shots[state.shotIdx].segments) {
      const d = Geom.pointPolylineDist(p, s.pts);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }
  canvas.addEventListener('mousedown', (ev) => {
    if (!state.pack) return;
    const s = nearest(canvasPos(ev));
    state.selected = s ? s.id : null;
    draw(); updatePanel();
  });
  canvas.addEventListener('mousemove', (ev) => {
    if (!state.pack) return;
    const s = nearest(canvasPos(ev));
    if ((s && s.id) !== state.hover) {
      state.hover = s ? s.id : null;
      canvas.style.cursor = s ? 'pointer' : 'crosshair';
      draw();
    }
  });
  window.addEventListener('keydown', (ev) => {
    if (!state.pack) return;
    if (ev.ctrlKey && ev.key === 'z') { ev.preventDefault(); undo(); return; }
    if (!state.selected) return;
    const fam = FAM_KEY[ev.key];
    if (fam) {
      pushUndo();
      state.assignments[state.selected] = fam;
      invalidateSolve(); draw(); updatePanel();
    } else if (ev.key === '0' || ev.key === 'Delete' || ev.key === 'Backspace') {
      pushUndo();
      delete state.assignments[state.selected];
      invalidateSolve(); draw(); updatePanel();
    }
  });

  $('shotSel').addEventListener('change', (e) => loadShot(+e.target.value));
  $('autoBtn').addEventListener('click', () => { pushUndo(); autoAssign(); draw(); updatePanel(); setKernelControls(); });
  $('clearBtn').addEventListener('click', clearAssign);
  $('undoBtn').addEventListener('click', undo);
  $('solveBtn').addEventListener('click', runSolve);
  $('rankBtn').addEventListener('click', runRanking);
  $('candSel').addEventListener('change', (e) => { state.selCand = +e.target.value; draw(); updatePanel(); });
  [['showObs', 'obs'], ['showModel', 'model'], ['showVps', 'vps'], ['showSign', 'sign']]
    .forEach(([id, key]) => $(id).addEventListener('change', (e) => {
      state.show[key] = e.target.checked; draw();
    }));

  // 文件选择载入（本地包）
  $('filePicker').addEventListener('change', (ev) => {
    const f = ev.target.files && ev.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try { loadPack(JSON.parse(reader.result)); }
      catch (e) { $('loadInfo').innerHTML = `<span class="bad">JSON 解析失败：${e.message}</span>`; }
    };
    reader.readAsText(f);
  });

  // 自动载入默认包（经 http 服务时 fetch 可用；file:// 下改用文件选择）
  const DEFAULT_PACK = 'assets/packs/street-facade.pack.json';
  async function tryAutoLoad() {
    try {
      const resp = await fetch(DEFAULT_PACK);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      await loadPack(await resp.json());
    } catch (e) {
      $('loadInfo').innerHTML = '<span class="warn">自动载入默认包失败（可能以 file:// 打开）。' +
        '请用“选择素材包”载入 assets/packs/street-facade.pack.json，或经静态服务器打开本页。</span>';
      setKernelControls();
    }
  }
  tryAutoLoad();

  // 暴露给冒烟测试
  globalThis.__tracking = { loadPack, adaptPack, state, runSolve, runRanking, familyReady };
})();
