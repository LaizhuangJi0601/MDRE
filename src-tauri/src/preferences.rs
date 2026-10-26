use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use std::sync::{Mutex, atomic::{AtomicU64, Ordering}};

type ExitReply = tokio::sync::oneshot::Sender<Result<(), String>>;
#[derive(Default)]
pub struct SettingsExit { serial: AtomicU64, pending: Mutex<Option<(u64, ExitReply)>> }

// 主窗口确认文档关闭后，等待设置页验证并落盘，成功才关闭独立 WebView。
#[tauri::command]
pub async fn prepare_settings_shutdown(app: tauri::AppHandle, window: tauri::WebviewWindow, state: tauri::State<'_, SettingsExit>) -> Result<(), String> {
    if window.label() != "main" { return Err("仅主窗口可发起退出".into()); }
    let Some(settings) = app.get_webview_window("settings") else { close_auxiliary(&app); return Ok(()); };
    let id = state.serial.fetch_add(1, Ordering::Relaxed) + 1;
    let (send, receive) = tokio::sync::oneshot::channel();
    *state.pending.lock().map_err(|e| e.to_string())? = Some((id, send));
    settings.emit("settings-shutdown", id).map_err(|e| e.to_string())?;
    let result = tokio::time::timeout(std::time::Duration::from_secs(10), receive).await;
    *state.pending.lock().map_err(|e| e.to_string())? = None;
    match result {
        Ok(Ok(Ok(()))) => { if let Some(settings) = app.get_webview_window("settings") { settings.close().map_err(|e| e.to_string())?; } close_auxiliary(&app); Ok(()) },
        other => {
            let _ = settings.unminimize(); let _ = settings.set_focus();
            match other { Ok(Ok(Err(message))) => Err(message), _ => Err("设置页未完成保存，请检查设置后重试退出。".into()) }
        }
    }
}

#[tauri::command]
pub fn settings_shutdown_result(window: tauri::WebviewWindow, state: tauri::State<SettingsExit>, id: u64, error: Option<String>) -> Result<(), String> {
    if window.label() != "settings" { return Err("仅设置页可确认保存".into()); }
    let mut pending=state.pending.lock().map_err(|e| e.to_string())?;
    if pending.as_ref().map(|item| item.0) == Some(id) {
        if let Some((_, send))=pending.take(){let _=send.send(error.map_or(Ok(()), Err));}
    }
    Ok(())
}
// 设置使用独立轻量入口；关闭即释放 WebView，不预载编辑器与论文资源。
#[tauri::command]
pub async fn open_settings_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("settings") { window.unminimize().map_err(|e| e.to_string())?; return window.set_focus().map_err(|e| e.to_string()); }
    let main = app.get_webview_window("main").ok_or("主窗口不存在")?;
    let root = crate::persistence::app_root(&app, &main)?;
    let record = root.join("settings-window.json");
    let window = WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App("settings.html".into()))
        .title(crate::i18n::text("MDRE 设置")).inner_size(960.0, 720.0).min_inner_size(700.0, 500.0).build().map_err(|e| e.to_string())?;
    if let Ok(bytes) = std::fs::read(&record) {
        if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
            if let (Some(x), Some(y), Some(w), Some(h)) = (value["x"].as_i64(), value["y"].as_i64(), value["width"].as_u64(), value["height"].as_u64()) {
                let visible = window.available_monitors().unwrap_or_default().iter().any(|monitor| {
                    let p = monitor.position(); let s = monitor.size();
                    x >= p.x as i64 && y >= p.y as i64 && x + 200 < p.x as i64 + s.width as i64 && y + 80 < p.y as i64 + s.height as i64
                });
                if visible && (700..=5000).contains(&w) && (500..=4000).contains(&h) {
                    let _ = window.set_size(tauri::PhysicalSize::new(w as u32, h as u32));
                    let _ = window.set_position(tauri::PhysicalPosition::new(x as i32, y as i32));
                }
            }
        }
    }
    let target = window.clone();
    window.on_window_event(move |event| if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
        if let (Ok(position), Ok(size)) = (target.outer_position(), target.inner_size()) {
            let value = serde_json::json!({"x":position.x,"y":position.y,"width":size.width,"height":size.height});
            let _ = crate::persistence::atomic_write(&record, value.to_string().as_bytes());
        }
    });
    Ok(())
}

// 帮助和快捷键沿用设置的轻量入口，系统提供标题栏、最小化、最大化与四边缩放。
#[tauri::command]
pub async fn open_aux_window(app: tauri::AppHandle, kind: String) -> Result<(), String> {
    if !["help", "shortcuts"].contains(&kind.as_str()) { return Err("Unknown window".into()); }
    if let Some(window)=app.get_webview_window(&kind){let _=window.unminimize();return window.set_focus().map_err(|e|e.to_string());}
    let main=app.get_webview_window("main").ok_or("Main window unavailable")?;
    let language=crate::files::read_settings(app.clone(),main).map(|s|s.language).unwrap_or_default();
    let title=match (kind.as_str(),language.as_str()){("help","en")=>"MDRE Help",("shortcuts","en")=>"MDRE Keyboard Shortcuts",("help",_)=>"MDRE 帮助",_=>"MDRE 快捷键设置"};
    WebviewWindowBuilder::new(&app,&kind,WebviewUrl::App(format!("settings.html?view={kind}").into()))
      .title(title).inner_size(1040.0,760.0).min_inner_size(560.0,420.0).build().map_err(|e|e.to_string())?;
    Ok(())
}

fn close_auxiliary(app:&tauri::AppHandle){for label in ["help","shortcuts"]{if let Some(window)=app.get_webview_window(label){let _=window.close();}}}
