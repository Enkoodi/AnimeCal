// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, MouseButton, MouseButtonState},
    Emitter, Manager, WindowEvent, WebviewUrl, WebviewWindowBuilder,
};

#[derive(Default)]
struct AppState {
    close_to_tray: Mutex<bool>,
    /// 子窗口打开期间「为它临时取消了主窗口置顶」的标记，子窗口全部关闭后据此恢复
    topmost_suspended: Mutex<bool>,
}

#[tauri::command]
fn set_close_to_tray(state: tauri::State<'_, AppState>, value: bool) {
    *state.close_to_tray.lock().unwrap() = value;
}

/// 便携数据目录：exe 同目录下的 .data 文件夹，所有窗口共用，保证 localStorage 一致
fn portable_data_dir() -> Option<std::path::PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join(".data")))
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

#[tauri::command]
fn get_portable_data_dir() -> Option<String> {
    portable_data_dir().map(|p| p.to_string_lossy().to_string())
}

/// 向所有 webview 窗口广播 anime-data-changed 事件，解决多窗口 localStorage 不同步问题。
/// 子窗口直接 emit 的 Tauri 事件只在本窗口内传播，主窗口收不到；
/// 通过 Rust 后端用 AppHandle::emit 全局广播，可以确保 main / manager / following 任意窗口
/// 都能收到通知并重绘 UI。
#[tauri::command]
fn notify_all_windows(app: tauri::AppHandle) {
    if let Err(e) = app.emit("anime-data-changed", ()) {
        eprintln!("emit anime-data-changed failed: {}", e);
    }
}

const MANAGER_SIZE: (f64, f64) = (760.0, 680.0);
/// 「添加番剧」窗口内部不再整体滚动（只让番剧列表自己滚），
/// 因此给一个尺寸下限，避免窗口被拖得太小时筛选区 / 列表被裁掉。
const MANAGER_MIN_SIZE: (f64, f64) = (620.0, 520.0);
const FOLLOWING_SIZE: (f64, f64) = (460.0, 600.0);
/// 「自定义背景」裁剪窗口：要比主窗口大得多，取景框才看得清
const CROP_SIZE: (f64, f64) = (900.0, 640.0);
const CROP_MIN_SIZE: (f64, f64) = (680.0, 480.0);

/// 会用到「子窗口打开时临时取消主窗口置顶」的所有子窗口
const CHILD_LABELS: [&str; 5] = ["manager", "following", "crop-main", "crop-manager", "crop-following"];

fn any_child_open(app: &tauri::AppHandle) -> bool {
    CHILD_LABELS.iter().any(|label| app.get_webview_window(label).is_some())
}

/// 在 Rust 后端统一创建「添加番剧」子窗口，确保 data_directory 与主窗口一致。
/// 前端直接 new WebviewWindow 时，`dataDirectory` 选项在 Tauri v2 JS API 中可能被忽略，
/// 导致子窗口的 localStorage 仍落在系统 AppData，与主窗口的 exe 同目录 .data 不一致。
#[tauri::command]
async fn open_manager_window(app: tauri::AppHandle) -> Result<(), String> {
    // 必须是 async：同步命令会阻塞主线程，而 Windows 上 WebView2 的初始化依赖
    // 主线程消息泵，阻塞会导致子窗口永久白屏（见 DEVELOPMENT.md「子窗口白屏」坑点）。
    open_child_window(
        app,
        "manager",
        "manager.html",
        "添加番剧",
        MANAGER_SIZE,
        true,
        Some(MANAGER_MIN_SIZE),
    )
}

/// 在 Rust 后端统一创建「管理番剧」子窗口，确保 data_directory 与主窗口一致。
#[tauri::command]
async fn open_following_window(app: tauri::AppHandle) -> Result<(), String> {
    open_child_window(app, "following", "following.html", "管理番剧", FOLLOWING_SIZE, true, None)
}

/// 打开「自定义背景」裁剪窗口。
/// 用 crop-<target> 作为窗口 label，前端据此（getCurrentWindow().label）知道自己正在给哪个窗口裁剪，
/// 这样同一时刻可以分别给不同窗口开着裁剪窗口，也不需要传 query 参数。
#[tauri::command]
async fn open_crop_window(app: tauri::AppHandle, target: String) -> Result<(), String> {
    let label = match target.as_str() {
        "main" | "manager" | "following" => format!("crop-{}", target),
        _ => return Err(format!("未知的窗口标识: {}", target)),
    };
    open_child_window(app, &label, "crop.html", "自定义背景", CROP_SIZE, true, Some(CROP_MIN_SIZE))
}

/// 背景变化后广播给所有窗口，让各窗口立即换上新背景。
/// 与 notify_all_windows 分开，是因为「翻剧数据变了」不该让子窗口去重画列表。
#[tauri::command]
fn notify_background_changed(app: tauri::AppHandle) {
    if let Err(e) = app.emit("background-changed", ()) {
        eprintln!("emit background-changed failed: {}", e);
    }
}

/// 打开子窗口时临时取消主窗口置顶。
/// 只收回「本来就是置顶」的状态，用户自己没置顶时不碰；
/// 标记记在 AppState 里，避免把用户手动关掉的置顶又给他打开。
fn suspend_main_topmost(app: &tauri::AppHandle) {
    let Some(main) = app.get_webview_window("main") else {
        return;
    };
    if !main.is_always_on_top().unwrap_or(false) {
        return;
    }
    if main.set_always_on_top(false).is_ok() {
        if let Ok(mut flag) = app.state::<AppState>().topmost_suspended.lock() {
            *flag = true;
        }
    }
}

/// 子窗口全部关闭后，把主窗口恢复到之前被临时取消的置顶状态
fn restore_main_topmost(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let Ok(mut flag) = state.topmost_suspended.lock() else {
        return;
    };
    if !*flag {
        return;
    }
    // 还有别的子窗口开着就先不恢复
    if any_child_open(app) {
        return;
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.set_always_on_top(true);
    }
    *flag = false;
}

fn open_child_window(
    app: tauri::AppHandle,
    label: &str,
    url: &str,
    title: &str,
    size: (f64, f64),
    resizable: bool,
    min_size: Option<(f64, f64)>,
) -> Result<(), String> {
    // 子窗口与主窗口都是居中显示，若主窗口置顶，它会正好压住子窗口中央一大块（番剧列表），
    // 编辑时反而碍事 —— 先临时收回主窗口置顶，等子窗口全关了再恢复。
    suspend_main_topmost(&app);

    // 已存在则显示并聚焦
    if let Some(existing) = app.get_webview_window(label) {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    let mut wb = WebviewWindowBuilder::new(
        &app,
        label,
        WebviewUrl::App(url.into()),
    )
    .title(title)
    .inner_size(size.0, size.1)
    .resizable(resizable)
    .decorations(true)
    // 子窗口不置顶：编辑番剧时不该压在其他程序上面（主窗口是否置顶由自身的📌/设置决定）
    .always_on_top(false)
    .center()
    .focused(true)
    .visible(true);

    if let Some(min) = min_size {
        wb = wb.min_inner_size(min.0, min.1);
    }

    if let Some(dir) = portable_data_dir() {
        wb = wb.data_directory(dir);
    }

    wb.build().map_err(|e| e.to_string())?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![set_close_to_tray, get_portable_data_dir, notify_all_windows, notify_background_changed, open_manager_window, open_following_window, open_crop_window])
        .setup(|app| {
            // 便携数据目录：追番数据（localStorage / 封面缩略图）随 exe 一起携带，
            // 存到 exe 同目录下的 .data 文件夹，而非系统 AppData。
            let mut wb = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("番剧日历")
                .inner_size(400.0, 480.0)
                .min_inner_size(240.0, 48.0)
                .resizable(false)
                .maximizable(false)
                .minimizable(true)
                .closable(true)
                .center()
                .decorations(false)
                .focused(true)
                .visible(true);

            if let Some(dir) = portable_data_dir() {
                wb = wb.data_directory(dir);
            }

            let window = wb.build()?;
            let _ = window.set_always_on_top(false);
            
            let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let toggle_i = MenuItem::with_id(app, "toggle", "显示/隐藏", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&toggle_i, &quit_i])?;
            
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("番剧日历")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => { app.exit(0); }
                    "toggle" => {
                        if let Some(window) = app.get_webview_window("main") {
                            if window.is_visible().unwrap_or(true) {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            if window.is_visible().unwrap_or(true) {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;
            
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    // 主窗口关闭行为由「退出时最小化到托盘」设置决定；子窗口正常关闭
                    if window.label() == "main" {
                        let close_to_tray = *window.state::<AppState>().close_to_tray.lock().unwrap();
                        if close_to_tray {
                            let _ = window.hide();
                            api.prevent_close();
                        } else {
                            window.app_handle().exit(0);
                        }
                    }
                }
                WindowEvent::Destroyed => {
                    // 子窗口关闭：若已无其它子窗口，把主窗口置顶恢复回去
                    let label = window.label().to_string();
                    if CHILD_LABELS.contains(&label.as_str()) {
                        let app = window.app_handle();
                        if !any_child_open(app) {
                            restore_main_topmost(app);
                        }
                    }
                }
                _ => {}
            }
        })
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 已存在实例：显示并聚焦原本的主窗口
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
