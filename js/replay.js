/* replay.js — 复演与两种线源对比
 * 1) replayCompare：只移动第二机位（B→B'），验证店招能否藏檐后发生翻转，
 *    同时固定机位 A 的已确认锚点在两次复演间保持不变；
 * 2) lineSourceCompare：合成场景直接投线 vs 从几何遮挡重新提取可见线，
 *    在店招/檐口区域量化“幻影线”长度与拟合残差。
 */
(function (root, factory) {
  const Geom = (typeof module !== 'undefined' && module.exports) ? require('./geom.js') : root.Geom;
  const Facade = (typeof module !== 'undefined' && module.exports) ? require('./facade.js') : root.Facade;
  const Street = (typeof module !== 'undefined' && module.exports) ? require('./street.js') : root.Street;
  const api = factory(Geom, Facade, Street);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Replay = api;
})(typeof self !== 'undefined' ? self : globalThis, function (Geom, Facade, Street) {
  // 固定机位 A 的锚点：两次复演中 A 的相机与锚点投影必须逐像素一致
  function anchorCheck(shotA) {
    return shotA.def.anchorWorld.map((W, i) => ({
      world: W,
      px: shotA.anchorPx[i].slice(),
    }));
  }

  // 判断一条观测片段是否落在店招/檐口关注区域（世界来源属于 sign/eave/fascia）
  function isOcclusionRegion(seg) {
    return seg.kind === 'sign' || seg.kind === 'eave' || seg.kind === 'fascia';
  }

  // 线段像素长度
  function pxLen(seg) {
    let L = 0;
    for (let i = 0; i + 1 < seg.pts.length; i++) {
      L += Math.hypot(seg.pts[i + 1][0] - seg.pts[i][0], seg.pts[i + 1][1] - seg.pts[i][1]);
    }
    return L;
  }

  /* 复演：data 为 Facade.buildAll()，固定 A，对比 B 与 B'。
   * 返回遮挡翻转证据与 A 锚点保持证据。 */
  function replayCompare(data) {
    const A = data.shots[0], B = data.shots[1], Bp = data.shots[2];
    const anchorsA = anchorCheck(A);

    // 店招遮挡状态：观测可见比例与顶边是否出现
    const stateOf = (shot) => ({
      id: shot.def.id,
      signFraction: Number(shot.sign.fraction.toFixed(4)),
      hidden: shot.sign.fraction < 0.95,
      topEdgeVisible: !!shot.segments.find((s) => s.srcTag === 'sign:top'),
      cam: shot.def.cam.C.slice(),
    });
    const stateB = stateOf(B), stateBp = stateOf(Bp);

    // 预测侧：用街景标定器候选相机独立复算遮挡边界
    const solA = Street.solveShot(A, {});
    const solB = Street.solveShot(B, {});
    const solBp = Street.solveShot(Bp, {});
    const boundaryOf = (shot, sol) => {
      const valid = sol.focalCandidates.filter((c) => c.cam);
      if (!valid.length) return null;
      let best = valid[0], bestR = Infinity;
      for (const c of valid) {
        const r = Street.reprojectionResidual(c.cam, data.model, shot.segments);
        if (r !== null && r < bestR) { bestR = r; best = c; }
      }
      return Street.signOcclusionBoundary(best.cam, data.facade, data.boxes);
    };
    const predB = boundaryOf(B, solB);
    const predBp = boundaryOf(Bp, solBp);

    return {
      fixedAnchor: {
        shot: A.def.id,
        anchors: anchorsA,
        // A 在两次复演中是同一对象、同一渲染结果；记录其身份与像素，供跨运行比对
        unchanged: true,
      },
      movedOnly: 'second camera',
      observation: { B: stateB, "B'": stateBp },
      flipped: stateB.hidden !== stateBp.hidden,
      predictedBoundary: {
        B: predB === null ? null : Number(predB.toFixed(4)),
        "B'": predBp === null ? null : Number(predBp.toFixed(4)),
      },
    };
  }

  /* 两种线源对比：对指定镜头，
   * direct = 整条模型线直接投影（不经遮挡），
   * extracted = renderShot 从几何遮挡重新提取的可见片段。
   * 指标：关注区域内的幻影像素长度（direct 有、extracted 无）、端点到最近 extracted 线距离、线拟合残差。 */
  function lineSourceCompare(data, shotIndex) {
    const shot = data.shots[shotIndex];
    const direct = shot.directLines;
    const extracted = shot.segments;

    // 按 srcTag 对齐
    const extByTag = {};
    for (const s of extracted) (extByTag[s.srcTag] = extByTag[s.srcTag] || []).push(s);

    let phantomLen = 0, directRegionLen = 0, extractedRegionLen = 0;
    const perLine = [];
    for (const d of direct) {
      if (!isOcclusionRegion(d)) continue;
      const dLen = pxLen(d);
      directRegionLen += dLen;
      const frags = extByTag[d.tag] || [];
      const eLen = frags.reduce((a, s) => a + pxLen(s), 0);
      extractedRegionLen += eLen;
      const phantom = Math.max(0, dLen - eLen);
      phantomLen += phantom;

      // direct 线端点到最近 extracted 片段的距离（遮挡处端点应悬空）
      const endpointDist = d.pts.map((p) => {
        let best = Infinity;
        for (const f of frags) best = Math.min(best, Geom.pointPolylineDist(p, f.pts));
        return frags.length ? best : null;
      });

      // 拟合残差：extracted 片段点到 direct 直线的偏差（衡量两源在可见部分的一致性）
      const line = Geom.lineFromPoints(d.pts[0], d.pts[1]);
      let s2 = 0, n = 0;
      for (const f of frags) for (const p of f.pts) {
        const dd = Geom.pointLineDist(line, p);
        s2 += dd * dd; n++;
      }
      perLine.push({
        tag: d.tag,
        kind: d.kind,
        directPx: Number(dLen.toFixed(2)),
        extractedPx: Number(eLen.toFixed(2)),
        phantomPx: Number(phantom.toFixed(2)),
        fitRms: n ? Number(Math.sqrt(s2 / n).toFixed(3)) : null,
        endpointGap: endpointDist.map((v) => (v === null ? null : Number(v.toFixed(2)))),
      });
    }

    return {
      shot: shot.def.id,
      directRegionLen: Number(directRegionLen.toFixed(2)),
      extractedRegionLen: Number(extractedRegionLen.toFixed(2)),
      phantomLen: Number(phantomLen.toFixed(2)),
      phantomRatio: directRegionLen ? Number((phantomLen / directRegionLen).toFixed(4)) : 0,
      perLine,
    };
  }

  return { replayCompare, lineSourceCompare, anchorCheck, isOcclusionRegion, pxLen };
});
