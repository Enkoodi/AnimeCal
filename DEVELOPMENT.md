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

## 其他约定（简述）

- 番剧信息优先从 Bangumi 获取，失败回退 yuc.wiki；搜索时去除名称尾部的分段标识（P2 / Part.2）。
- 数据目录统一为 exe 同目录 `.data`，主窗口与管理/追番子窗口共用，保证 localStorage 一致。
- 子窗口（添加番剧 / 管理番剧）必须由 Rust 后端统一创建并设置 `data_directory`；
  前端 `new WebviewWindow(...)` 的 `dataDirectory` 选项在 Tauri v2 JS API 中不可靠/会被忽略，
  容易导致子窗口仍使用系统 AppData，造成「添加界面有记录、主界面/管理界面不显示」的数据分裂现象。