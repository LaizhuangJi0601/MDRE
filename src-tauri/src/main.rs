#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod files;
mod explorer;
mod persistence;

use std::{path::PathBuf, sync::{Arc, Mutex}, time::{Duration, SystemTime, UNIX_EPOCH}};
use serde::Serialize;
use tauri::{WebviewUrl, WebviewWindowBuilder};
use tokio::sync::oneshot;
use webview2_com::{Microsoft::Web::WebView2::Win32::{ICoreWebView2Environment6, ICoreWebView2_7}, PrintToPdfCompletedHandler, WebMessageReceivedEventHandler};
use windows::core::{Interface, HSTRING, PWSTR};

#[derive(Serialize)]
struct PdfResult { path: String, bytes: u64, engine: &'static str }

// 文件快照避开 NavigateToString 的 2 MB 上限；任一返回路径都清理临时文件。
struct PdfSnapshot(PathBuf);
impl Drop for PdfSnapshot { fn drop(&mut self) { let _ = std::fs::remove_file(&self.0); } }

#[tauri::command]
async fn export_pdf(app: tauri::AppHandle, window: tauri::WebviewWindow, html: String, path: String) -> Result<PdfResult, String> {
    if window.label() != "main" { return Err("导出内容没有应用 IPC 权限".into()); }
    let output = PathBuf::from(&path);
    if !output.is_absolute() || !output.extension().and_then(|s| s.to_str()).is_some_and(|extension| extension.eq_ignore_ascii_case("pdf")) { return Err("需要绝对 .pdf 输出路径".into()); }
    std::fs::create_dir_all(output.parent().unwrap()).map_err(|e| e.to_string())?;
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos().to_string();
    let snapshot = PdfSnapshot(output.parent().unwrap().join(format!(".mdre-export-{nonce}.html")));
    std::fs::write(&snapshot.0, html).map_err(|e| e.to_string())?;
    let snapshot_url = tauri::Url::from_file_path(&snapshot.0).map_err(|_| "PDF 快照文件路径无效".to_string())?.to_string();
    let ready = format!("mdre-ready-{nonce}");
    let init = format!(r#"
      delete window.__TAURI_INTERNALS__; delete window.__TAURI__;
      window.addEventListener('DOMContentLoaded', async () => {{
        try {{
          await document.fonts.ready;
          await Promise.all(Array.from(document.images, image => image.decode()));
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          window.chrome.webview.postMessage('{ready}');
        }} catch(error) {{ window.chrome.webview.postMessage('mdre-error:' + String(error)); }}
      }}, {{once:true}});
    "#);
    let export = WebviewWindowBuilder::new(&app, format!("export-{nonce}"), WebviewUrl::External("about:blank".parse().unwrap()))
        .title("MDRE PDF 快照").visible(false).inner_size(900.0, 1000.0)
        .initialization_script(&init).build().map_err(|e| e.to_string())?;
    let (sender, receiver) = oneshot::channel::<Result<(), String>>();
    let completion = Arc::new(Mutex::new(Some(sender)));
    let start_completion = completion.clone();
    let print_path = path.clone();
    let setup = export.with_webview(move |platform| {
        let result: windows::core::Result<()> = (|| unsafe {
            let core = platform.controller().CoreWebView2()?;
            let printer: ICoreWebView2_7 = core.cast()?;
            let settings = platform.environment().cast::<ICoreWebView2Environment6>()?.CreatePrintSettings()?;
            settings.SetPageWidth(210.0 / 25.4)?; settings.SetPageHeight(297.0 / 25.4)?;
            settings.SetMarginTop(15.0 / 25.4)?; settings.SetMarginBottom(15.0 / 25.4)?;
            settings.SetMarginLeft(15.0 / 25.4)?; settings.SetMarginRight(15.0 / 25.4)?;
            settings.SetShouldPrintBackgrounds(true)?; settings.SetShouldPrintHeaderAndFooter(false)?;
            let callback_completion = completion.clone();
            let mut token = 0;
            core.add_WebMessageReceived(&WebMessageReceivedEventHandler::create(Box::new(move |_core, args| {
                let mut message = PWSTR::null();
                args.unwrap().TryGetWebMessageAsString(&mut message)?;
                let text = message.to_string()?;
                windows::Win32::System::Com::CoTaskMemFree(Some(message.0.cast()));
                if text == ready {
                    let finish = callback_completion.clone();
                    let callback = PrintToPdfCompletedHandler::create(Box::new(move |status, success| {
                        let result = status.map_err(|e| e.to_string()).and_then(|_| if success { Ok(()) } else { Err("WebView2 PrintToPdf 回调返回 false".into()) });
                        if let Some(sender) = finish.lock().unwrap().take() { let _ = sender.send(result); }
                        Ok(())
                    }));
                    if let Err(error) = printer.PrintToPdf(&HSTRING::from(&print_path), &settings, &callback) {
                        if let Some(sender) = callback_completion.lock().unwrap().take() { let _ = sender.send(Err(error.to_string())); }
                    }
                } else if text.starts_with("mdre-error:") {
                    if let Some(sender) = callback_completion.lock().unwrap().take() { let _ = sender.send(Err(text)); }
                }
                Ok(())
            })), &mut token)?;
            core.Navigate(&HSTRING::from(snapshot_url))?;
            Ok(())
        })();
        if let Err(error) = result { if let Some(sender) = start_completion.lock().unwrap().take() { let _ = sender.send(Err(error.to_string())); } }
    });
    if let Err(error) = setup { let _ = export.close(); return Err(error.to_string()); }
    let result = tokio::time::timeout(Duration::from_secs(90), receiver).await.map_err(|_| "原生 PDF 回调超时".to_string()).and_then(|r| r.map_err(|e| e.to_string())).and_then(|r| r);
    let _ = export.close();
    result?;
    let bytes = std::fs::read(&output).map_err(|e| e.to_string())?;
    if !bytes.starts_with(b"%PDF-") || !bytes.windows(5).any(|s| s == b"%%EOF") { return Err("回调完成但输出不是完整 PDF".into()); }
    Ok(PdfResult { path, bytes: bytes.len() as u64, engine: "WebView2 PrintToPdf / native callback" })
}

#[derive(Clone, serde::Serialize)]
struct LaunchPayload { args: Vec<String> }

// S-41：从命令行参数里取出第一个像文件路径的参数（跳过 exe 自身与开关）。
fn launch_path(args: &[String]) -> Option<String> {
    args.iter().skip(1).find(|value| !value.starts_with('-')).map(|value| {
        std::fs::canonicalize(value).map(|item| item.to_string_lossy().into_owned()).unwrap_or_else(|_| value.clone())
    })
}

// S-41：待打开文件用队列保存，前端在启动与获得焦点时主动取走。
// 用队列而不是「事件 + 标题」双通道，避免第二次启动早于前端监听就绪时丢请求。
#[derive(Default)]
struct PendingOpen(std::sync::Mutex<Vec<String>>);

#[tauri::command]
fn take_launch_path(state: tauri::State<PendingOpen>) -> Option<String> {
    let mut queue = state.0.lock().ok()?;
    if queue.is_empty() { return None; }
    Some(queue.remove(0))
}

fn push_open(state: &PendingOpen, path: String) {
    if let Ok(mut queue) = state.0.lock() {
        if !queue.iter().any(|item| item == &path) { queue.push(path); }
    }
}

fn main() {
    // 单实例：第二次启动（例如双击另一个 .md）把路径排队给已有窗口，而不是再开一个进程。
    let args: Vec<String> = std::env::args().collect();
    let launch = launch_path(&args);
    let pending = PendingOpen::default();
    if let Some(path) = launch.clone() { push_open(&pending, path); }
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            use tauri::Manager;
            if let Some(path) = launch_path(&argv) { push_open(&app.state::<PendingOpen>(), path); }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            let _ = tauri::Emitter::emit(app, "single-instance", LaunchPayload { args: argv });
        }))
        .manage(persistence::Storage::default())
        .manage(pending)
        .invoke_handler(tauri::generate_handler![
            take_launch_path,
            files::pick_images, files::clipboard_image_paths,
            explorer::pick_folder, explorer::list_directory, explorer::create_document,
            export_pdf,
            persistence::write_recovery, persistence::read_recovery, persistence::discard_recovery, persistence::discard_recovery_dir, persistence::save_image, persistence::read_image,
            files::read_text_file, files::write_text_file, files::rotate_backup, files::copy_resource, files::read_document_image, files::pick_file, files::pick_export, files::write_export, files::read_binary,
            files::read_settings, files::write_settings, files::open_external, files::rename_document, files::reveal_document,
            files::register_file_association, files::file_association_status, files::settings_directory, files::open_settings_directory
        ])
        .run(tauri::generate_context!()).expect("MDRE 桌面应用启动失败");
}
