use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock, atomic::{AtomicU64, Ordering}};

use crate::window_state::{self, Bounds};

type ExitReply = tokio::sync::oneshot::Sender<Result<(), String>>;
#[derive(Default)]
pub struct SettingsExit { serial: AtomicU64, pending: Mutex<Option<(u64, ExitReply)>> }

const SETTINGS_MIN_SIZE: (u32, u32) = (700, 500);
const AUX_MIN_SIZE: (u32, u32) = (560, 420);
// 拖动 / 缩放时最多每秒落盘一次，避免频繁写文件。
const POSITION_SAVE_INTERVAL: std::time::Duration = std::time::Duration::from_millis(900);
// 关闭后 WebView 销毁需要一点时间；再次打开时最多等待这么久（轮询 50ms）。
const CLOSE_WAIT_LIMIT: std::time::Duration = std::time::Duration::from_millis(1500);
const CLOSE_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(50);
// 已存在窗口的聚焦分支：聚焦后轮询确认窗口没有在“关闭 → 立刻重开”的竞态中被销毁。
const EXISTING_WINDOW_PROBES: usize = 3;
const EXISTING_WINDOW_PROBE_INTERVAL: std::time::Duration = std::time::Duration::from_millis(100);

// 正在关闭的窗口 label：CloseRequested 时标记，Destroyed 时清除。窗口销毁前的短暂窗口内，
// get_webview_window 仍可能返回正在销毁的 WebView（聚焦无效），再次打开必须等它真正消失。
fn closing_labels() -> &'static Mutex<BTreeSet<&'static str>> {
    static CLOSING: OnceLock<Mutex<BTreeSet<&'static str>>> = OnceLock::new();
    CLOSING.get_or_init(|| Mutex::new(BTreeSet::new()))
}

fn mark_closing(label: &'static str) {
    if let Ok(mut labels) = closing_labels().lock() { labels.insert(label); }
}

fn clear_closing(label: &'static str) {
    if let Ok(mut labels) = closing_labels().lock() { labels.remove(label); }
}

fn is_closing(label: &str) -> bool {
    closing_labels().lock().map(|labels| labels.contains(label)).unwrap_or(false)
}

// 打开窗口前等待同名窗口完成销毁；超时则返回可读错误而不是静默聚焦一个已销毁的 WebView。
async fn wait_before_open(label: &'static str) -> Result<(), String> {
    let started = std::time::Instant::now();
    while is_closing(label) {
        if started.elapsed() >= CLOSE_WAIT_LIMIT { return Err("窗口仍在关闭，请稍后重试。".into()); }
        tokio::time::sleep(CLOSE_POLL_INTERVAL).await;
    }
    Ok(())
}

// 同名窗口已存在时聚焦它；返回 true 表示窗口仍存活（调用方直接返回 Ok），
// false 表示它正在/已经被销毁（调用方继续创建新窗口）。
// 覆盖“关闭后同一事件循环内立刻重开”：打开请求可能先于 CloseRequested 到达 Rust，
// 此时窗口还活着且尚未标记 closing，只 focus 会返回假成功，随后窗口才销毁 → 用户点了没反应。
async fn focus_existing(app: &tauri::AppHandle, label: &'static str) -> Result<bool, String> {
    let Some(window) = app.get_webview_window(label) else { return Ok(false); };
    let _ = window.unminimize();
    if let Err(error) = window.set_focus() {
        // 窗口正在销毁时聚焦会失败；若它已经消失则交给调用方创建新窗口。
        if app.get_webview_window(label).is_none() { return Ok(false); }
        return Err(error.to_string());
    }
    for _ in 0..EXISTING_WINDOW_PROBES {
        tokio::time::sleep(EXISTING_WINDOW_PROBE_INTERVAL).await;
        if is_closing(label) {
            // 关闭请求在聚焦后才到达：等它真正销毁，改为创建新窗口。
            wait_before_open(label).await?;
            return Ok(false);
        }
        if app.get_webview_window(label).is_none() { return Ok(false); }
    }
    Ok(true)
}

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
        if let Some((_, send))=pending.take(){let _ = send.send(error.map_or(Ok(()), Err));}
    }
    Ok(())
}

// v0.2.7 需求 5.2：设置 / 帮助 / 快捷键窗口在关闭或移动后记住物理位置与尺寸。
fn screens(app: &tauri::AppHandle) -> Vec<window_state::Screen> {
    app.available_monitors().unwrap_or_default().iter().map(|monitor| {
        let position = monitor.position();
        let size = monitor.size();
        window_state::Screen { x: position.x, y: position.y, width: size.width, height: size.height }
    }).collect()
}

// 恢复上次位置；多显示器 / 分辨率变化时钳制到当前可见屏幕内。
fn restore_bounds(window: &tauri::WebviewWindow, root: &Path, label: &str, minimum: (u32, u32)) {
    let Some(saved) = window_state::load(root, label) else { return; };
    let bounds = window_state::clamp(saved, &screens(&window.app_handle()), minimum.0, minimum.1);
    let _ = window.set_size(tauri::PhysicalSize::new(bounds.width, bounds.height));
    let _ = window.set_position(tauri::PhysicalPosition::new(bounds.x, bounds.y));
}

// 移动 / 缩放 / 关闭时记录位置；CloseRequested 一定落盘，移动过程做节流。
// 同时维护“正在关闭”标记：关闭请求到窗口销毁之间，重复打开必须等待。
fn remember_bounds(window: &tauri::WebviewWindow, root: PathBuf, label: &'static str) {
    let target = window.clone();
    let last_save = Mutex::new(std::time::Instant::now() - POSITION_SAVE_INTERVAL);
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) { clear_closing(label); return; }
        let closing = matches!(event, tauri::WindowEvent::CloseRequested { .. });
        if closing { mark_closing(label); }
        if !closing && !matches!(event, tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)) { return; }
        if !closing {
            let Ok(mut last) = last_save.lock() else { return; };
            if last.elapsed() < POSITION_SAVE_INTERVAL { return; }
            *last = std::time::Instant::now();
        }
        if let (Ok(position), Ok(size)) = (target.outer_position(), target.inner_size()) {
            window_state::store(&root, label, Bounds::new(position.x, position.y, size.width, size.height));
        }
    });
}

// 设置使用独立轻量入口；关闭即释放 WebView，不预载编辑器与论文资源。
#[tauri::command]
pub async fn open_settings_window(app: tauri::AppHandle) -> Result<(), String> {
    wait_before_open("settings").await?;
    if focus_existing(&app, "settings").await? { return Ok(()); }
    let main = app.get_webview_window("main").ok_or("主窗口不存在")?;
    let root = crate::persistence::app_root(&app, &main)?;
    let window = WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App("settings.html".into()))
        .title(crate::i18n::text("MDRE 设置")).inner_size(960.0, 720.0).min_inner_size(SETTINGS_MIN_SIZE.0 as f64, SETTINGS_MIN_SIZE.1 as f64).build().map_err(|e| e.to_string())?;
    restore_bounds(&window, &root, "settings", SETTINGS_MIN_SIZE);
    remember_bounds(&window, root, "settings");
    Ok(())
}

// 帮助和快捷键沿用设置的轻量入口，系统提供标题栏、最小化、最大化与四边缩放。
#[tauri::command]
pub async fn open_aux_window(app: tauri::AppHandle, kind: String) -> Result<(), String> {
    if !["help", "shortcuts"].contains(&kind.as_str()) { return Err("Unknown window".into()); }
    let label: &'static str = if kind == "help" { "help" } else { "shortcuts" };
    wait_before_open(label).await?;
    if focus_existing(&app, label).await? { return Ok(()); }
    let main=app.get_webview_window("main").ok_or("Main window unavailable")?;
    let language=crate::files::read_settings(app.clone(),main.clone()).map(|s|s.language).unwrap_or_default();
    let title=match (kind.as_str(),language.as_str()){("help","en")=>"MDRE Help",("shortcuts","en")=>"MDRE Keyboard Shortcuts",("help",_)=>"MDRE 帮助",_=>"MDRE 快捷键设置"};
    let root=crate::persistence::app_root(&app,&main)?;
    let window=WebviewWindowBuilder::new(&app,&kind,WebviewUrl::App(format!("settings.html?view={kind}").into()))
      .title(title).inner_size(1040.0,760.0).min_inner_size(AUX_MIN_SIZE.0 as f64, AUX_MIN_SIZE.1 as f64).build().map_err(|e|e.to_string())?;
    restore_bounds(&window, &root, label, AUX_MIN_SIZE);
    remember_bounds(&window, root, label);
    Ok(())
}

fn close_auxiliary(app:&tauri::AppHandle){for label in ["help","shortcuts"]{if let Some(window)=app.get_webview_window(label){let _=window.close();}}}
