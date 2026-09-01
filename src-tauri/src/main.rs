// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, MouseButton, MouseButtonState},
    Manager, WindowEvent,
};

#[derive(Default)]
struct AppState {
    close_to_tray: Mutex<bool>,
}

#[tauri::command]
fn set_close_to_tray(state: tauri::State<'_, AppState>, value: bool) {
    *state.close_to_tray.lock().unwrap() = value;
}

fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![set_close_to_tray])
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();
            let _ = window.set_always_on_top(true);
            
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
        .plugin(tauri_plugin_shell::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
