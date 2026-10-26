use serde::{Deserialize, Serialize};
use std::{fs, io::Write, path::{Path, PathBuf}, sync::Mutex, time::{SystemTime, UNIX_EPOCH}};
use tauri::Manager;
use windows::{core::PCWSTR, Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH}};

#[derive(Default)]
pub struct Storage(pub Mutex<()>);
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    schema: u8, id: String, title: String, path: Option<String>, source: String, original_text: String,
    revision: u64, encoding: String, bom: bool, saved_fingerprint: String, disk_fingerprint: Option<String>,
    selection: Selection, reading_anchor: Option<Anchor>, source_scroll: Scroll, resource_owners: Vec<String>, updated_at: u64,
    #[serde(default)]
    recovery_root: Option<String>,
    // 正式保存后的基准文本；旧记录没有该字段时退回 original_text。
    #[serde(default)]
    saved_text: Option<String>,
}
#[derive(Serialize, Deserialize)]
struct Selection { source: Range, render: Range, active: String }
#[derive(Serialize, Deserialize)]
struct Range { from: usize, to: usize }
#[derive(Serialize, Deserialize)]
struct Anchor { block: String, source: usize, offset: f64 }
#[derive(Serialize, Deserialize)]
struct Scroll { top: f64, left: f64 }
#[derive(Serialize)]
pub struct Written { root: String, revision: u64 }
#[derive(Serialize)]
pub struct RecoveryRead { root: String, snapshots: Vec<Snapshot>, errors: Vec<String> }

fn fingerprint(text: &str) -> String {
    let value = text.as_bytes().iter().fold(0xcbf29ce484222325u64, |value, byte| (value ^ u64::from(*byte)).wrapping_mul(0x100000001b3));
    format!("{value:016x}")
}
fn validate(record: &Snapshot) -> Result<(), String> {
    if record.schema != 1 || record.encoding != "utf-8" || record.id.is_empty() || record.id.len() > 256 || record.revision > 9_007_199_254_740_991 {
        return Err("不支持的恢复记录格式".into());
    }
    let baseline = record.saved_text.as_deref().unwrap_or(&record.original_text);
    if record.saved_fingerprint != fingerprint(baseline) || record.bom != baseline.starts_with('\u{feff}') {
        return Err("恢复记录的原始字节基准不一致".into());
    }
    let length = record.source.encode_utf16().count();
    if record.selection.source.from > length || record.selection.source.to > length || !["source", "render"].contains(&record.selection.active.as_str()) {
        return Err("恢复记录选区无效".into());
    }
    Ok(())
}
fn root(app: &tauri::AppHandle, window: &tauri::WebviewWindow) -> Result<PathBuf, String> {
    if window.label() != "main" { return Err("该窗口没有持久化 IPC 权限".into()); }
    // 验收脚本用 MDRE_DATA_DIR 指定隔离的数据目录，避免影响日常使用的恢复记录与配置。
    if let Some(directory) = std::env::var_os("MDRE_DATA_DIR") {
        if !directory.is_empty() { return Ok(PathBuf::from(directory)); }
    }
    app.path().app_data_dir().map_err(|e| e.to_string())
}
pub fn app_root(app: &tauri::AppHandle, window: &tauri::WebviewWindow) -> Result<PathBuf, String> { root(app, window) }
// 临时文件与目标在同一目录；刷新后原子替换，失败保留原记录并明确返回错误。
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
    let temporary = path.with_extension(format!("{nonce}.pending"));
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|e| e.to_string())?;
    file.write_all(bytes).and_then(|_| file.sync_all()).map_err(|e| e.to_string())?;
    drop(file);
    let wide = |p: &Path| p.as_os_str().encode_wide().chain(Some(0)).collect::<Vec<u16>>();
    use std::os::windows::ffi::OsStrExt;
    let from = wide(&temporary); let to = wide(path);
    unsafe { MoveFileExW(PCWSTR(from.as_ptr()), PCWSTR(to.as_ptr()), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) }.map_err(|e| e.to_string())
}
fn latest(directory: &Path) -> Result<Option<Snapshot>, String> {
    if !directory.exists() { return Ok(None); }
    let mut paths = fs::read_dir(directory).map_err(|e| e.to_string())?.map(|entry| entry.map(|e| e.path())).collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    paths.retain(|path| path.extension().and_then(|s| s.to_str()) == Some("json")); paths.sort();
    match paths.last() {
        None => Ok(None),
        Some(path) => {
            let record: Snapshot = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?).map_err(|e| format!("{}: {e}", path.display()))?;
            validate(&record)?; Ok(Some(record))
        }
    }
}
#[tauri::command]
pub fn write_recovery(app: tauri::AppHandle, window: tauri::WebviewWindow, state: tauri::State<Storage>, snapshot: Snapshot) -> Result<Written, String> {
    let _serial = state.0.lock().map_err(|e| e.to_string())?;
    validate(&snapshot)?;
    let root = root(&app, &window)?.join("recovery");
    let directory = root.join(fingerprint(&snapshot.id));
    if let Some(previous) = latest(&directory)? {
        if previous.id != snapshot.id { return Err("恢复记录 ID 冲突".into()); }
        if previous.revision > snapshot.revision { return Err("拒绝旧版本恢复快照".into()); }
    }
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
    let path = directory.join(format!("{:020}-{nonce}.json", snapshot.revision));
    atomic_write(&path, &serde_json::to_vec(&snapshot).map_err(|e| e.to_string())?)?;
    Ok(Written { root: directory.to_string_lossy().into_owned(), revision: snapshot.revision })
}
#[tauri::command]
pub fn read_recovery(app: tauri::AppHandle, window: tauri::WebviewWindow, state: tauri::State<Storage>) -> Result<RecoveryRead, String> {
    let _serial = state.0.lock().map_err(|e| e.to_string())?;
    let root = root(&app, &window)?.join("recovery");
    let mut result = RecoveryRead { root: root.to_string_lossy().into_owned(), snapshots: vec![], errors: vec![] };
    if root.exists() {
        for entry in fs::read_dir(&root).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            if !path.is_dir() { continue; }
            match latest(&path) {
                Ok(Some(mut record)) => { record.recovery_root = Some(path.to_string_lossy().into_owned()); result.snapshots.push(record); }, Ok(None) => (), Err(e) => result.errors.push(format!("恢复失败 {}: {e}", path.display())),
            }
        }
    }
    result.snapshots.sort_by_key(|record| record.updated_at);
    Ok(result)
}
// E.1：只清理明确被用户放弃的临时文档记录。
#[tauri::command]
pub fn discard_recovery(app: tauri::AppHandle, window: tauri::WebviewWindow, state: tauri::State<Storage>, doc_id: String) -> Result<(), String> {
    let _serial = state.0.lock().map_err(|e| e.to_string())?;
    if doc_id.is_empty() { return Err("文档 ID 无效".into()); }
    let directory = root(&app, &window)?.join("recovery").join(fingerprint(&doc_id));
    if directory.exists() { fs::remove_dir_all(&directory).map_err(|e| e.to_string())?; }
    Ok(())
}
// 合并重复恢复快照时按目录删除：只允许删 recovery 根目录的直接子目录，避免误删其他路径。
#[tauri::command]
pub fn discard_recovery_dir(app: tauri::AppHandle, window: tauri::WebviewWindow, state: tauri::State<Storage>, directory: String) -> Result<(), String> {
    let _serial = state.0.lock().map_err(|e| e.to_string())?;
    let root = root(&app, &window)?.join("recovery");
    let target = PathBuf::from(&directory);
    let parent_ok = target.parent().map(|parent| parent == root).unwrap_or(false);
    if !parent_ok { return Err("拒绝删除 recovery 目录之外的路径".into()); }
    if target.exists() { fs::remove_dir_all(&target).map_err(|e| e.to_string())?; }
    Ok(())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageRequest { doc_id: String, base64: String, extension: String, directory: Option<String> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedImage { relative_path: String, absolute_path: String, resource_root: String, bytes: u64, hash: String, deduplicated: bool, fallback: bool }

pub(crate) fn image_type(extension: &str) -> Option<&'static str> {
    match extension.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"), "jpg" | "jpeg" => Some("image/jpeg"), "gif" => Some("image/gif"),
        "webp" => Some("image/webp"), "bmp" => Some("image/bmp"), "svg" => Some("image/svg+xml"), _ => None,
    }
}
const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
pub fn encode_base64(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let value = (u32::from(chunk[0]) << 16) | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8) | u32::from(*chunk.get(2).unwrap_or(&0));
        output.push(BASE64[(value >> 18) as usize & 63] as char);
        output.push(BASE64[(value >> 12) as usize & 63] as char);
        output.push(if chunk.len() > 1 { BASE64[(value >> 6) as usize & 63] as char } else { '=' });
        output.push(if chunk.len() > 2 { BASE64[value as usize & 63] as char } else { '=' });
    }
    output
}
fn decode_base64(text: &str) -> Result<Vec<u8>, String> {
    let mut output = Vec::with_capacity(text.len() / 4 * 3);
    let mut buffer = 0u32;
    let mut bits = 0u32;
    for byte in text.bytes() {
        if byte == b'=' || byte == b'\n' || byte == b'\r' { continue; }
        let value = BASE64.iter().position(|candidate| *candidate == byte).ok_or("图片数据不是合法 base64")? as u32;
        buffer = (buffer << 6) | value; bits += 6;
        if bits >= 8 { bits -= 8; output.push((buffer >> bits) as u8); }
    }
    if output.is_empty() { return Err("图片数据为空".into()); }
    Ok(output)
}
// D.1：无路径文档的图片归属恢复区 <docId>/assets；有路径文档写入同级 assets。
#[tauri::command]
pub fn save_image(app: tauri::AppHandle, window: tauri::WebviewWindow, state: tauri::State<Storage>, request: ImageRequest) -> Result<SavedImage, String> {
    let _serial = state.0.lock().map_err(|e| e.to_string())?;
    if request.doc_id.is_empty() || request.doc_id.len() > 256 { return Err("文档 ID 无效".into()); }
    let extension = request.extension.to_ascii_lowercase();
    if image_type(&extension).is_none() { return Err(format!("不支持的图片扩展名：{extension}")) }
    let bytes = decode_base64(&request.base64)?;
    if bytes.len() > 20 * 1024 * 1024 { return Err("图片超过 20 MB，未写入".into()); }
    let data_root = root(&app, &window)?;
    match store_image(&data_root.join("images"), &bytes, &extension, false) {
        Ok(saved) => Ok(saved),
        Err(primary) => {
            let assets = request.directory.map(|directory| PathBuf::from(directory).join("assets"))
                .unwrap_or_else(|| data_root.join("recovery").join(fingerprint(&request.doc_id)).join("assets"));
            store_image(&assets, &bytes, &extension, true).map_err(|fallback| format!("图片目录写入失败：{primary}；assets 兜底失败：{fallback}"))
        }
    }
}

fn store_image(directory: &Path, bytes: &[u8], extension: &str, fallback: bool) -> Result<SavedImage, String> {
    fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let hash = format!("{:016x}", bytes.iter().fold(0xcbf29ce484222325u64, |value, byte| (value ^ u64::from(*byte)).wrapping_mul(0x100000001b3)));
    let name = format!("{hash}.{extension}"); let target = directory.join(&name);
    let existing = fs::read(&target).ok();
    if existing.as_deref().is_some_and(|old| old != bytes) { return Err("图片名称冲突，原文件未覆盖".into()); }
    let deduplicated = existing.is_some();
    if !deduplicated { atomic_write(&target, bytes)?; }
    Ok(SavedImage { relative_path: if fallback { format!("assets/{name}") } else { String::new() }, absolute_path: target.to_string_lossy().into_owned(), resource_root: directory.to_string_lossy().into_owned(), bytes: bytes.len() as u64, hash, deduplicated, fallback })
}
// 预览与导出按文档的资源根解析相对路径；只读取该根目录内的图片文件。
#[tauri::command]
pub fn read_image(window: tauri::WebviewWindow, resource_root: String, relative: String) -> Result<String, String> {
    if window.label() != "main" { return Err("该窗口没有资源读取权限".into()); }
    let assets = PathBuf::from(&resource_root).canonicalize().map_err(|e| e.to_string())?;
    let name = relative.strip_prefix("assets/").unwrap_or(&relative);
    if name.contains('/') || name.contains('\\') || name.contains("..") { return Err("图片相对路径无效".into()); }
    let path = assets.join(name);
    let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > 32 * 1024 * 1024 { return Err("图片不存在或超过 32 MB".into()); }
    let canonical = path.canonicalize().map_err(|e| e.to_string())?;
    if !canonical.starts_with(&assets) { return Err("图片路径超出资源根".into()); }
    let bytes = fs::read(&canonical).map_err(|e| e.to_string())?;
    let mime = image_type(canonical.extension().and_then(|s| s.to_str()).unwrap_or("")).ok_or("不支持的图片类型")?;
    Ok(format!("data:{mime};base64,{}", encode_base64(&bytes)))
}
