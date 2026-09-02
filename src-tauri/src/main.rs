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
const FOLLOWING_SIZE: (f64, f64) = (460.0, 600.0);

/// 在 Rust 后端统一创建「添加番剧」子窗口，确保 data_directory 与主窗口一致。
/// 前端直接 new WebviewWindow 时，`dataDirectory` 选项在 Tauri v2 JS API 中可能被忽略，
/// 导致子窗口的 localStorage 仍落在系统 AppData，与主窗口的 exe 同目录 .data 不一致。
#[tauri::command]
async fn open_manager_window(app: tauri::AppHandle) -> Result<(), String> {
    // 必须是 async：同步命令会阻塞主线程，而 Windows 上 WebView2 的初始化依赖
    // 主线程消息泵，阻塞会导致子窗口永久白屏（见 DEVELOPMENT.md「子窗口白屏」坑点）。
    open_child_window(app, "manager", "manager.html", "添加番剧", MANAGER_SIZE, true)
}

/// 在 Rust 后端统一创建「管理番剧」子窗口，确保 data_directory 与主窗口一致。
#[tauri::command]
async fn open_following_window(app: tauri::AppHandle) -> Result<(), String> {
    open_child_window(app, "following", "following.html", "管理番剧", FOLLOWING_SIZE, true)
}

fn open_child_window(
    app: tauri::AppHandle,
    label: &str,
    url: &str,
    title: &str,
    size: (f64, f64),
    resizable: bool,
) -> Result<(), String> {
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
    .always_on_top(true)
    .center()
    .focused(true)
    .visible(true);

    if let Some(dir) = portable_data_dir() {
        wb = wb.data_directory(dir);
    }

    wb.build().map_err(|e| e.to_string())?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![set_close_to_tray, get_portable_data_dir, notify_all_windows, open_manager_window, open_following_window])
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
            if let WindowEvent::CloseRequested { api, .. } = event {
                // 主窗口关闭行为由「退出时最小化到托盘」设置决定；管理窗口正常关闭
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
