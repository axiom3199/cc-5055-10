# 建筑匹配扩展：资产、重建与镜头跟踪窗口

本目录说明本次扩展的全部可重建资产与执行入口。所有内容由零依赖的 Node 脚本
（Node v22，无 npm 依赖）和浏览器 UMD 模块生成，**不依赖任何最终截图**——
截图只是预览，资产与结论都能从参数和内核重新生成。

## 1. 模块总览（`js/`）

| 模块 | 职责 |
| --- | --- |
| `facade.js` | 合成临街店招场景：已知相机/消失方向、简模线组、挑檐+封檐板+店招遮挡盒，三机位 A / B / B′，几何遮挡提取可见线与“直接投线”对照 |
| `street.js` | 街景标定内核：三向灭点 → 每对灭点一个**焦距候选**（病态对显式 `null` 带原因，不用默认值遮错）→ 对应相机与地面 → 跨镜头店招遮挡选解 |
| `replay.js` | 复演：只移动第二机位 B→B′ 时店招“藏檐后/露出”翻转，并固定机位 A 的已确认锚点；以及“直接投线 vs 几何遮挡提取线”的幻影线量化 |
| `ambiguity.js` | 焦距歧义室内对：`fB=fA·dB/dA` 使后墙投影逐像素重合，侧墙控制点末段解锁，两阶段求解由实际残差选模型 |
| `samples.js` | 线结构样例创作：少线组（纹理不足）与宽视角（含受遮挡平行线），保存来源/参数，用灭点方向夹角与投影残差核验 |
| `tracking.js` | 建筑匹配·镜头跟踪窗口的界面逻辑，只由 `street.js` 内核驱动，加载真实素材包 |

几何与相机约定沿用 `js/geom.js`：世界 x 右 / y 上 / z，相机 x 右 / y 下 / 前向 −Z，
图像 960×540、主点 (480,270)。

## 2. 素材包（`assets/packs/`，真实 JSON 文件）

由 `node tools/build-packs.cjs` 生成并回读校验：

- `street-facade.pack.json` — 双解街景（A/B/B′）：观测线、直接投线对照、简模线、
  遮挡盒、已知地面点、锚点、店招可见率与遮挡边界、相机高度先验。
- `ambiguity-indoor.pack.json` — 焦距歧义室内对：舞台参数、后墙/侧墙线、
  末段解锁的侧墙控制点 `controlTags`、两阶段求解约定。
- `line-samples.pack.json` — 少线组与宽视角样例：生成参数、世界线、观测线。

包结构约定（`reconstruct.cjs` 与 `tracking.js` 共同遵守）：

```
{ packVersion: 1, kind, createdAt, generator,
  provenance: { generator, sourceModules, params, truth: { cameras } },
  content: { ... 求解所需观测，不含真值相机 ... } }
```

真值相机只放在 `provenance.truth`，**仅供重建后符合性核验，不进入求解**。
任何必需字段缺失，加载/重建立即报错退出，不以默认值填充。

构建同时写出 `assets/evidence/build-evidence.json`，记录每次构建的执行证据：
每镜头焦距候选（含 null 原因）、线-灭点 RMS、遮挡选解边界误差与重投 RMS、
复演翻转与锚点保持、幻影线比例、歧义两阶段残差、样例灭点夹角与投影 RMS。

## 3. 重建脚本（`tools/`）

```bash
node tools/build-packs.cjs     # 重新生成三个素材包 + 构建证据（回读校验）
node tools/reconstruct.cjs     # 从包重建相机/线结构并做符合性断言（默认全部三包）
node tools/render-new-previews.cjs  # 软件光栅化预览 PNG 到 /tmp（仅人工目检，非测试依赖）
```

`reconstruct.cjs` 只用包内观测线/分组/已知点/先验驱动 `street.js`、`ambiguity.js`、
`samples.js` 内核；观测遮挡边界取自素材包观测证据（构建期由真实几何计算），
重建过程不读取真值相机。断言覆盖：有效焦距候选、显式 null 候选保留原因、
选中组合遮挡错误为 0 且边界误差 <0.05m、重建焦距与真值偏差、复演翻转、
A 锚点完整、幻影线存在、歧义两阶段解歧、样例灭点夹角 <1° 与投影 RMS <1.6σ、
来源参数逐像素重建。损坏/缺字段包会被显式拒绝。

## 4. 镜头跟踪窗口（界面，不止脚本）

页面：`tracking.html`（原有室内标定页仍是 `index.html`，两者独立、旧流程不受影响）。

### 启动方式

素材包通过 `fetch` 加载，浏览器在 `file://` 下会拦截本地 fetch，因此用静态服务器：

```bash
# 在仓库根目录任选其一
python3 -m http.server 8000
# 或 node（若已安装 npx）： npx --yes http-server -p 8000
```

然后浏览器打开 `http://localhost:8000/tracking.html`。
页面会自动 fetch `assets/packs/street-facade.pack.json`。

若直接以 `file://` 打开，自动载入会失败并在界面提示——此时用页面顶部
**“选择素材包”** 选取 `assets/packs/street-facade.pack.json` 即可（FileReader 不经网络）。

### 操作流程（全部由建筑匹配内核驱动）

1. 载入包后，左上角“素材包载入”显示 kind、镜头数、简模线数；结构不符会红色报错且求解按钮保持禁用。
2. 在画布点选建筑线，按 `1/2/3` 标为 横向 X / 竖向 Y / 纵深 Z，`0` 取消，`Ctrl+Z` 撤销；
   也可“自动分组/清除”。线族不足 2 条时，“内核未就绪”会指出缺失族。
3. 点 **运行内核求解**：面板列出三个灭点对的焦距候选，病态对显示 `null` 与原因；
   “焦距候选”下拉切换不同候选，预览区黄虚线即时叠加该候选相机对简模的投影，
   青 × 为已知地面点，框出的店招给遮挡可见率预测，并叠加三向灭点。
4. 点 **运行双镜头遮挡选解**：内核枚举候选组合，按遮挡错误/边界误差/重投 RMS 排序，
   回显保留的候选对、焦距、遮挡错误、边界误差与重投 RMS。
5. 失败反馈回建筑匹配界面：包损坏、错误 kind、线族不足、候选全 null、
   缺遮挡边界观测等都在面板内红字说明，按钮禁用态随内核就绪状态切换，不做静默兜底。

## 5. 测试与执行证据

```bash
node test/run.cjs            # 原有室内数学核心（保持通过，未改断言）
node test/ui-smoke.cjs       # 原有 index.html 界面冒烟（保持通过）
node test/street.cjs         # 街景双解/遮挡选解/复演/线源对比
node test/ambiguity.cjs      # 焦距歧义两阶段求解
node test/samples.cjs        # 少线组/宽视角样例 + 灭点方向/投影残差/可重建
node test/packs.cjs          # 素材包真实存在、结构约定、证据数值、端到端重建、损坏包拒绝
node test/tracking-ui.cjs    # 跟踪窗口 DOM 冒烟：载入/标注/求解/选解/失败反馈/控件禁用
```

灭点方向与投影残差均对应到可执行证据：样例的每族灭点反投影夹角、点到投影线
RMS 写入 `assets/evidence/build-evidence.json`，并由 `test/samples.cjs` 与
`test/packs.cjs` 断言；街景/歧义的候选与残差由 `test/street.cjs`、
`test/ambiguity.cjs` 断言。
