// 使用系统文件通知，不轮询整篇正文；父目录监听也覆盖编辑器的临时文件原子替换。
use std::{path::PathBuf, sync::Mutex};
use notify::{Watcher, RecursiveMode, RecommendedWatcher};
use tauri::Emitter;
#[derive(Default)]
pub struct Watches(pub Mutex<Option<RecommendedWatcher>>);
#[tauri::command]
pub fn watch_files(app: tauri::AppHandle, window: tauri::WebviewWindow, state: tauri::State<Watches>, paths: Vec<String>, folder: Option<String>) -> Result<(), String> {
    if window.label() != "main" { return Err("该窗口不能监听文件".into()); }
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if paths.is_empty() && folder.is_none() { *guard = None; return Ok(()); }
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        match event {
            Ok(event) if !matches!(event.kind, notify::EventKind::Access(_)) => { let paths: Vec<String> = event.paths.iter().map(|p| p.to_string_lossy().into_owned()).collect(); let structural = matches!(event.kind, notify::EventKind::Create(_) | notify::EventKind::Remove(_) | notify::EventKind::Modify(notify::event::ModifyKind::Name(_))); let _ = app.emit_to("main", "disk-changed", serde_json::json!({"paths":paths,"structural":structural})); },
            Err(error) => { let _ = app.emit_to("main", "disk-watch-error", error.to_string()); }, _ => (),
        }
    }).map_err(|e| e.to_string())?;
    let root = folder.map(PathBuf::from).filter(|p| p.is_dir());
    if let Some(root) = &root { watcher.watch(root, RecursiveMode::Recursive).map_err(|e| e.to_string())?; }
    let mut parents = std::collections::HashSet::new();
    for path in paths {
        if let Some(parent) = PathBuf::from(path).parent() {
            if parent.is_dir() && !root.as_ref().is_some_and(|r| parent.starts_with(r)) && parents.insert(parent.to_path_buf()) {
                watcher.watch(parent, RecursiveMode::NonRecursive).map_err(|e| e.to_string())?;
            }
        }
    }
    *guard = Some(watcher); Ok(())
}
