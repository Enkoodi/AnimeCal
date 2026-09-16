# 开发与构建日志

> 给后续程序员 / AI 的构建注意事项。构建本项目前必读。

## 1. 生产构建必须启用 `custom-protocol` 特性（重要）

- **现象**：直接 `cargo build --release` 打出来的 exe，运行时白屏并提示
  “localhost 拒绝连接 / ERR_CONNECTION_REFUSED”。
- **根因**：Tauri v2 通过 `cfg!(not(feature = "custom-protocol"))` 判定开发/生产模式
  （位于 `tauri-macros` 的 `context.rs`：`dev: cfg!(not(feature = "custom-protocol"))`）。
  不启用该特性时 `dev = true` → 不打入前端资源 → 改为加载 `devUrl`（`http://localhost:1420`）
  → 没有 vite 开发服务器 → 连接被拒绝。此问题已被反复触发多次。
- **正确构建命令（二选一）**：
  - `cargo build --release --features custom-protocol`
  - `npm run tauri build -- --no-bundle`
- **禁止**：裸跑 `cargo build --release`（会漏掉该特性）。

## 2. 不需要 NSIS 安装包

- 本应用只需裸 exe（`src-tauri/target/release/anime-cal.exe`）即可运行，
  前端资源已内嵌，数据以“便携模式”存到 exe 同目录的 `.data` 文件夹，不使用系统 AppData。
- `npm run tauri build` 默认会触发 NSIS 打包（下载 NSIS、耗时久、且非必需）。
- 只需要 exe 时：用 `--no-bundle`，或直接 `cargo build --release --features custom-protocol`。

## 3. 子窗口白屏 / 按钮失效（同步命令阻塞主线程）

- **现象**：点击设置里的「添加番剧」出现纯白窗口且关不掉、「管理番剧」点击无效；
  主窗口正常。
- **根因**：Windows 上 Tauri 用 WebView2 控件，其初始化是异步的，且依赖主线程的消息泵
  （event loop）来派发完成回调。若把 `WebviewWindowBuilder::build()` 写进**同步**的
  `#[tauri::command] fn ...`（同步命令默认在主线程执行），`build()` 会阻塞主线程等
  WebView2 就绪，而 WebView2 又等主线程的消息泵 → 死锁 → 子窗口永远停留在空白态，
  JS 也不加载，窗口里的「关闭」按钮自然失效。
- **修复**：负责创建子窗口的命令必须是 `async fn`（`open_manager_window` /
  `open_following_window`），让 `build()` 跑到异步线程池，主线程消息泵保持运转。
- **参考**：https://github.com/muizidn/NetworkSpy/wiki/Windows-Sub-Window

## 4. 自定义背景（个性化）—— canvas 尺寸必须显式给

- 结构：设置 → 个性化 → 三个窗口各一行（主窗口 / 添加番剧 / 管理番剧），点行进裁剪窗口。
- 数据：`localStorage['anime_cal_backgrounds'] = { scrim, windows: { [target]: { data: dataURL, updatedAt, crop? } } }`，
  图片按目标窗口比例裁剪成 JPEG（窗口逻辑尺寸 ×2，长边封顶 1280）后存 data URL。
  相关模块：`src/background.js`（读写 + 广播）、`public/bg-boot.js`（首屏同步应用）、
  `crop.html` + `src/crop.js/crop.css`（裁剪界面）、Rust 侧 `open_crop_window` / `notify_background_changed`。
- **坑（已修）**：`<canvas>` 是替换元素，只写 `position:absolute; inset:0` **不会**被拉伸到容器大小——
  它的 CSS 尺寸会取自 `width` 属性，也就是按 `舞台宽 × devicePixelRatio` 设置的背面像素数。
  结果：在 125% / 150% 缩放的屏幕（本机就是）上，画布 CSS 盒子比舞台宽出 1.25 倍，
  画在 canvas 上的暗色遮罩被整体放大右移，与 DOM 取景框错位最多一百多像素。
  **必须**在 CSS 里给 canvas 显式 `width/height: 100%`。
  注意 `src/crop.js` 里所有几何量（frame / view / 拖拽 / 滚轮锚点）都在 **CSS 像素**空间，
  背面的 devicePixelRatio 只通过 `ctx.setTransform(dpr,...)` 参与，两者不能混。
- 验证这类对齐问题不能只看 `getImageData`（背面像素）：还要按
  `canvas.getBoundingClientRect().width / canvas.width` 换算成屏幕 CSS 像素再与 DOM 取景框比对，
  否则「画布盒子尺寸错了」这种 bug 会被漏掉（DPR=1 时两者恰好相等，所以必须用
  `Emulation.setDeviceMetricsOverride({ deviceScaleFactor: 1.25 })` 这类非 1 缩放复现）。

- **坑（已修）**：`src-tauri/capabilities/default.json` 的 `windows` 是**白名单**，
  新建窗口的 label 不加进去，该窗口就**没有** `core:window:allow-close` / `core:event:allow-listen` 等权限：
  `getCurrentWindow().close()` 会被静默拒绝（Promise reject），表现为「点了保存，背景确实存下来了，但窗口关不掉」。
  新建任何窗口（含裁剪窗口 `crop-main` / `crop-manager` / `crop-following`）都要同步这个文件，
  改完必须重新构建才生效（权限会被编译进应用）。构建后可在
  `src-tauri/gen/schemas/capabilities.json` 里核对 label 是否进去了。
- 原图另存于 **IndexedDB**（`src/bg-store.js`，库 `anime_cal_media`，按 target 存 Blob）：
  重新打开裁剪窗口时优先取回**未裁剪的原图**，取不到才退回已裁剪结果。
  用 IndexedDB 而不是 localStorage，是因为原图几 MB、base64 还要再膨胀 33%，
  塞进 localStorage 会和三张裁剪结果一起逼近 5MB 配额。入库前长边超 3000px 会等比缩小重编码，
  否则原样保留（不重编码）。「移除背景」（设置页每行右侧的 ×）会连原图一起删，避免下次看到一张用不上的旧图。
  取原图后转成 data URL 再喂给 `<img>`：CSP 的 `img-src` 没放行 `blob:`。
- **裁剪范围会记住**：保存时把取景框覆盖的原图范围按宽高归一化成 `{u, v, w, h}` 写进同一条记录
  （`setBackground(target, dataUrl, crop)`）；重新打开时 `applySavedCrop()` 用 `w` 反推 `view.scale`、
  用 `u/v` 反推位移，于是接着上次的大小和位置继续调，而不是回到默认的铺满居中。
  存比例而非像素，所以裁剪窗口尺寸/显示器缩放变了也照样对得上。
  **换新图时不能套用旧范围**（那是上一张图的坐标）：`useImage(image, restoreCrop)` 只在从 IndexedDB 取回原图时传 true。
- **裁剪窗口没有「移除背景」按钮**（用户要求删掉，连带 `removeBtn` / `clearBackground()` / `.crop-btn.danger` 一起清）。
  移除背景只保留设置页「个性化」每行右侧的 ×，它会同时删除原图。

## 5. UI 文案约定：不要写「说明文本」给用户看（用户明确要求）

- 界面上只保留**操作本身必需**的文字：标题、按钮名、字段名、空状态、错误反馈（toast）。
- **不要**加解释用法、讲原理、交代机制的句子。反例（都已被要求删掉，别再写回去）：
  - 裁剪窗口右侧的「拖动图片调整位置，滚轮或滑杆缩放」及其同类提示（`#crop-hint`）
  - 裁剪空状态下的「支持 JPG / PNG / WebP，建议宽度 1000px 以上」
  - 设置「个性化」栏末尾的「每个窗口可单独选择图片与裁剪范围；图片按各窗口比例裁剪…」
  - 「这是你上次选的原图，可以重新裁剪」/「原图已不可用，当前基于已保存的裁剪结果调整」
- 需要说明「怎么操作」时，优先让交互本身自解释（图标、悬停 `title`、禁用态），而不是加一段文字。
- 例外：会变化的状态信息（如设置里「上次更新：3 小时前」）和出错反馈不算说明文本，可以保留。

- **交互**（`bindPointer` + `hitTest`）：四角（22px）与四边（10px 带，框外一点也算）是把手，
  **拖动把手改变取景框本身的大小**（框跟着指针走，图片保持原位），框内拖动平移图片，框外不响应。
  - 取景框大小的状态是 `frameScale`（占舞台适配尺寸的比例，0.25 ~ 1），
    `measure()` 只算「舞台适配尺寸」`fitFrame`，实际框 = `fitFrame × frameScale`（始终居中）。
    角把手的映射是「指针到框中心的距离 / fitFrame 半对角线」，边把手按对应轴算 —— 这样把手正好落在指针下。
  - 放大框时受覆盖约束：`maxFrameScaleForCoverage()` 保证框仍完全落在图片矩形内（否则输出会出现空白）。
  - 缩放百分比的基准是 `fitCoverScale`（图片刚好铺满**最大**框），**不是**当前框的覆盖比例：
    否则缩小框会让百分比乱跳、并且小框时最大缩放被框卡住。滑杆的 `min` 随框大小动态下移（可低到 25%），
    `max` 固定 400%。上限 `maxScale()` 也以 `fitCoverScale × MAX_ZOOM` 为准。
  - ⚠️ 曾经写成「拖把手 = 按框中心缩放图片」，是死路：**向内拖等于缩小，而 100%（图片刚好铺满框）就是缩放下限，
    所以最自然的向内拖手势完全没反应**，用户直接反馈「拖了没反应」。已改为改变框大小。
  - 存进 localStorage 的 `crop` 里多一个 `s`（= `frameScale`），重新打开时连框大小一起还原。

  - 光标由 JS 写在 `canvas.style.cursor`：把手=对应方向的缩放光标、框内=`grab`/`grabbing`、框外=`default`；
    CSS 里只留 `cursor: default`，**不要再写 `cursor: grab`**，否则会盖住命中判定。
  - 命中判定用舞台坐标（`stagePoint()`，与 `frame`/`view` 同一坐标系），别混用 clientX/Y。
  - 验证这类交互**必须用 CDP 真实鼠标事件**（`Input.dispatchMouseEvent`），
    合成 `PointerEvent` 会漏掉「向内拖到下限没反应」这类只在真实手势下才暴露的问题。

## 其他约定（简述）

- 番剧信息优先从 Bangumi 获取，失败回退 yuc.wiki；搜索时去除名称尾部的分段标识（P2 / Part.2）。
- 数据目录统一为 exe 同目录 `.data`，主窗口与管理/追番子窗口共用，保证 localStorage 一致。
- 子窗口（添加番剧 / 管理番剧）必须由 Rust 后端统一创建并设置 `data_directory`；
  前端 `new WebviewWindow(...)` 的 `dataDirectory` 选项在 Tauri v2 JS API 中不可靠/会被忽略，
  容易导致子窗口仍使用系统 AppData，造成「添加界面有记录、主界面/管理界面不显示」的数据分裂现象。