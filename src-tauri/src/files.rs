use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use windows::core::PCWSTR;
use windows::Win32::Globalization::{MultiByteToWideChar, WideCharToMultiByte, MB_ERR_INVALID_CHARS};
use windows::Win32::UI::Controls::Dialogs::{
    GetOpenFileNameW, GetSaveFileNameW, OFN_EXPLORER, OFN_FILEMUSTEXIST, OFN_NOCHANGEDIR, OFN_OVERWRITEPROMPT, OFN_PATHMUSTEXIST, OPENFILENAMEW,
};

const GBK_CODEPAGE: u32 = 936;
const UTF8_BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];
const RECENT_LIMIT: usize = 5;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile { path: String, text: String, encoding: String, bom: bool, newline: String, fingerprint: String, bytes: u64 }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextWrite { path: String, text: String, encoding: String, bom: bool, expected_fingerprint: Option<String>, #[serde(default)] overwrite: bool }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WrittenText { path: String, fingerprint: String, bytes: u64 }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteFailure { kind: String, message: String, disk_fingerprint: Option<String>, exists: bool }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopiedResource { relative_path: String, absolute_path: String, bytes: u64 }
#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Settings {
    theme: String,
    code_theme: String,
    #[serde(alias = "defaultMode")]
    default_mode: String,
    #[serde(default = "default_split")]
    split: f64,
    #[serde(default, alias = "fontBody")]
    font_body: String,
    #[serde(default, alias = "fontMono")]
    font_mono: String,
    #[serde(default = "default_font_size", alias = "fontSize")]
    font_size: f64,
    #[serde(default = "default_line_height", alias = "lineHeight")]
    line_height: f64,
    #[serde(default)]
    recent: Vec<String>,
    #[serde(default = "default_backup_count", alias = "backupCount")]
    backup_count: u32,
    #[serde(default)]
    shortcuts: std::collections::BTreeMap<String, String>,
}
fn default_split() -> f64 { 50.0 }
fn default_font_size() -> f64 { 15.0 }
fn default_line_height() -> f64 { 1.85 }
fn default_backup_count() -> u32 { 0 }
impl Default for Settings {
    fn default() -> Self {
        Settings {
            theme: "system".into(), code_theme: "light".into(), default_mode: "edit".into(), split: default_split(),
            font_body: String::new(), font_mono: String::new(), font_size: default_font_size(), line_height: default_line_height(),
            recent: Vec::new(), backup_count: default_backup_count(), shortcuts: std::collections::BTreeMap::new(),
        }
    }
}

pub fn fingerprint_bytes(bytes: &[u8]) -> String {
    let value = bytes.iter().fold(0xcbf29ce484222325u64, |value, byte| (value ^ u64::from(*byte)).wrapping_mul(0x100000001b3));
    format!("{value:016x}")
}
pub fn newline_of(text: &str) -> String {
    if text.contains("\r\n") { "\r\n".into() } else if text.contains('\r') { "\r".into() } else { "\n".into() }
}
fn wide(text: &str) -> Vec<u16> { text.encode_utf16().chain(Some(0)).collect() }
fn gbk_decode(bytes: &[u8]) -> Result<String, String> {
    let mut buffer = vec![0u16; bytes.len() + 1];
    let written = unsafe { MultiByteToWideChar(GBK_CODEPAGE, MB_ERR_INVALID_CHARS, bytes, Some(&mut buffer)) };
    if written <= 0 { return Err("无法按 GBK 解码该文件".into()); }
    String::from_utf16(&buffer[..written as usize]).map_err(|_| "GBK 解码结果不是合法 UTF-16".to_string())
}
fn gbk_encode(text: &str) -> Result<Vec<u8>, String> {
    let source: Vec<u16> = text.encode_utf16().collect();
    let mut used_default = windows::core::BOOL(0);
    let mut buffer = vec![0u8; source.len() * 2 + 1];
    let written = unsafe { WideCharToMultiByte(GBK_CODEPAGE, 0, &source, Some(&mut buffer), None, Some(&mut used_default)) };
    if written <= 0 { return Err("无法按 GBK 编码当前内容".into()); }
    if used_default.as_bool() { return Err("当前内容包含 GBK 无法表示的字符，请先转换 UTF-8 或另存为".into()); }
    buffer.truncate(written as usize);
    Ok(buffer)
}
// E-6：UTF-8（含 BOM）优先；否则尝试 GBK；两者都不成立时明确报错，不用替换字符继续编辑。
// BOM 字符保留在文本里，与编辑器/模型对首行 BOM 的处理一致。
fn decode(bytes: &[u8]) -> Result<(String, String, bool), String> {
    if bytes.starts_with(&UTF8_BOM) {
        return String::from_utf8(bytes.to_vec()).map(|text| (text, "utf-8".into(), true)).map_err(|_| "UTF-8 BOM 文件解码失败".into());
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        if bytes.len() % 2 != 0 { return Err("UTF-16LE 文件末尾存在不完整码元".into()); }
        let units: Vec<u16> = bytes[2..].chunks_exact(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect();
        let mut text = vec![0xFEFFu16];
        text.extend(units);
        return String::from_utf16(&text).map(|text| (text, "utf-16le".into(), true)).map_err(|_| "UTF-16LE 文件解码失败".into());
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        if bytes.len() % 2 != 0 { return Err("UTF-16BE 文件末尾存在不完整码元".into()); }
        let units: Vec<u16> = bytes[2..].chunks_exact(2).map(|pair| u16::from_be_bytes([pair[0], pair[1]])).collect();
        let mut text = vec![0xFEFFu16];
        text.extend(units);
        return String::from_utf16(&text).map(|text| (text, "utf-16be".into(), true)).map_err(|_| "UTF-16BE 文件解码失败".into());
    }
    match std::str::from_utf8(bytes) {
        Ok(text) => Ok((text.to_string(), "utf-8".into(), false)),
        Err(_) => gbk_decode(bytes).map(|text| (text, "gbk".into(), false)),
    }
}
// BOM 字符属于源码文本本身（解码时保留），因此按文本原样编码，不额外追加。
fn encode(text: &str, encoding: &str, _bom: bool) -> Result<Vec<u8>, String> {
    match encoding {
        "utf-8" => Ok(text.as_bytes().to_vec()),
        "utf-16le" => Ok(text.encode_utf16().flat_map(u16::to_le_bytes).collect()),
        "utf-16be" => Ok(text.encode_utf16().flat_map(u16::to_be_bytes).collect()),
        "gbk" => gbk_encode(text),
        other => Err(format!("暂不支持按 {other} 保存")),
    }
}
fn disk_state(path: &Path) -> Result<(Option<String>, bool), String> {
    match std::fs::read(path) {
        Ok(bytes) => Ok((Some(fingerprint_bytes(&bytes)), true)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok((None, false)),
        Err(error) => Err(error.to_string()),
    }
}
// E-6/E-7：读文件返回编码、BOM、换行与磁盘指纹，供保存前冲突比对。
#[tauri::command]
pub fn read_text_file(path: String) -> Result<TextFile, String> {
    let target = PathBuf::from(&path);
    if !target.is_absolute() { return Err("需要绝对文件路径".into()); }
    let bytes = std::fs::read(&target).map_err(|error| error.to_string())?;
    if bytes.len() > 32 * 1024 * 1024 { return Err("文件超过 32 MB，未打开".into()); }
    let (text, encoding, bom) = decode(&bytes)?;
    Ok(TextFile {
        path: target.to_string_lossy().into_owned(), newline: newline_of(&text), fingerprint: fingerprint_bytes(&bytes),
        bytes: bytes.len() as u64, text, encoding, bom,
    })
}
// E.1：保存前比对磁盘指纹，冲突不覆盖；同目录临时文件刷新后原子替换。
#[tauri::command]
pub fn write_text_file(state: tauri::State<crate::persistence::Storage>, request: TextWrite) -> Result<WrittenText, WriteFailure> {
    let _serial = state.0.lock().map_err(|error| WriteFailure { kind: "io".into(), message: error.to_string(), disk_fingerprint: None, exists: false })?;
    let target = PathBuf::from(&request.path);
    if !target.is_absolute() { return Err(WriteFailure { kind: "io".into(), message: "需要绝对文件路径".into(), disk_fingerprint: None, exists: false }); }
    let (disk, exists) = disk_state(&target).map_err(|message| WriteFailure { kind: "io".into(), message, disk_fingerprint: None, exists: false })?;
    if let Some(expected) = &request.expected_fingerprint {
        match &disk {
            Some(current) if current == expected => (),
            Some(current) => return Err(WriteFailure { kind: "conflict".into(), message: "文件已被其他程序修改，未覆盖".into(), disk_fingerprint: Some(current.clone()), exists }),
            None => return Err(WriteFailure { kind: "conflict".into(), message: "文件已被移走或删除，未新建覆盖".into(), disk_fingerprint: None, exists: false }),
        }
    } else if exists && !request.overwrite {
        return Err(WriteFailure { kind: "conflict".into(), message: "目标文件已存在，未覆盖".into(), disk_fingerprint: disk, exists });
    }
    let bytes = encode(&request.text, &request.encoding, request.bom).map_err(|message| WriteFailure { kind: "encoding".into(), message, disk_fingerprint: disk.clone(), exists })?;
    crate::persistence::atomic_write(&target, &bytes).map_err(|message| WriteFailure { kind: "io".into(), message, disk_fingerprint: disk, exists })?;
    Ok(WrittenText { path: target.to_string_lossy().into_owned(), fingerprint: fingerprint_bytes(&bytes), bytes: bytes.len() as u64 })
}
// E-8：正式保存前轮转 `.bak` 副本；0 表示关闭备份。任何一步失败都向上报错，不静默跳过。
#[tauri::command]
pub fn rotate_backup(path: String, copies: u32) -> Result<Option<String>, String> {
    if copies == 0 { return Ok(None); }
    let target = PathBuf::from(&path);
    if !target.is_absolute() { return Err("需要绝对文件路径".into()); }
    if !target.exists() { return Ok(None); }
    let directory = target.parent().ok_or("文件目录无效")?;
    let name = target.file_name().ok_or("文件名称无效")?.to_string_lossy().into_owned();
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|error| error.to_string())?.as_millis();
    let backup = directory.join(format!("{name}.{stamp}.bak"));
    std::fs::copy(&target, &backup).map_err(|error| format!("写入备份失败：{error}"))?;
    // 保留最近 copies 份；多余的最旧备份删除。
    let prefix = format!("{name}.");
    let mut existing: Vec<PathBuf> = std::fs::read_dir(directory).map_err(|error| error.to_string())?
        .filter_map(|entry| entry.ok().map(|item| item.path()))
        .filter(|item| item.file_name().map(|file| { let text = file.to_string_lossy(); text.starts_with(&prefix) && text.ends_with(".bak") }).unwrap_or(false))
        .collect();
    existing.sort();
    while existing.len() > copies as usize {
        let oldest = existing.remove(0);
        std::fs::remove_file(&oldest).map_err(|error| format!("清理旧备份失败：{error}"))?;
    }
    Ok(Some(backup.to_string_lossy().into_owned()))
}
// S-41：在 HKCU 注册 `.md` 文件关联，双击用本程序打开；不需要管理员权限。
// 已存在 HKCU 关联时先备份到 `.mdre-backup`，便于撤销。
#[tauri::command]
pub fn register_file_association(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<String, String> {
    use windows::Win32::System::Registry::HKEY_CURRENT_USER;
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let exe = exe.to_string_lossy().into_owned();
    // 独立文档图标避免 Windows 继续复用旧 exe 的小图标缓存；随应用内嵌、无需联网。
    let icon = crate::persistence::app_root(&app, &window)?.join("mdre-document-v2.ico");
    crate::persistence::atomic_write(&icon, include_bytes!("../icons/icon.ico"))?;
    let existing = read_registry_string(HKEY_CURRENT_USER, r"Software\Classes\.md", "")
        .ok()
        .flatten();
    let mut note = String::new();
    if let Some(prog_id) = existing.as_deref() {
        if !prog_id.starts_with(".mdre") {
            let _ = set_registry_string(HKEY_CURRENT_USER, r"Software\Classes\.mdre-backup", "", prog_id);
            note = format!("已记录原有 .md 关联（{prog_id}）到 .mdre-backup");
        }
    }
    set_registry_string(HKEY_CURRENT_USER, r"Software\Classes\.mdre.md", "", "MDRE Markdown 文档")?;
    set_registry_string(HKEY_CURRENT_USER, r"Software\Classes\.mdre.md\DefaultIcon", "", &format!("\"{}\",0", icon.display()))?;
    set_registry_string(HKEY_CURRENT_USER, r"Software\Classes\.mdre.md\shell\open\command", "", &format!("\"{exe}\" \"%1\""))?;
    set_registry_string(HKEY_CURRENT_USER, r"Software\Classes\.md", "", ".mdre.md")?;
    // 告知资源管理器重新读取关联图标，不删除全局缓存或重启 Explorer。
    unsafe { windows::Win32::UI::Shell::SHChangeNotify(windows::Win32::UI::Shell::SHCNE_ASSOCCHANGED, windows::Win32::UI::Shell::SHCNF_IDLIST, None, None); }
    Ok(if note.is_empty() { format!("已注册 .md 文件关联：{exe}") } else { format!("已注册 .md 文件关联：{exe}；{note}") })
}
#[tauri::command]
pub fn settings_directory(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<String, String> {
    Ok(crate::persistence::app_root(&app, &window)?.to_string_lossy().into_owned())
}
// 配置目录由应用自身确定，不经网页外链接口，也不接受任意路径。
#[tauri::command]
pub fn open_settings_directory(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    let directory = crate::persistence::app_root(&app, &window)?;
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    std::process::Command::new("explorer.exe").arg(&directory).creation_flags(0x08000000)
        .spawn().map_err(|error| format!("无法打开配置目录：{error}"))?;
    Ok(directory.to_string_lossy().into_owned())
}
#[tauri::command]
pub fn file_association_status() -> Result<Option<String>, String> {
    use windows::Win32::System::Registry::HKEY_CURRENT_USER;
    let current = read_registry_string(HKEY_CURRENT_USER, r"Software\Classes\.md", "")?;
    let command = read_registry_string(HKEY_CURRENT_USER, r"Software\Classes\.mdre.md\shell\open\command", "")?;
    if current.as_deref() == Some(".mdre.md") { return Ok(command); }
    Ok(None)
}
fn registry_key(path: &str) -> Vec<u16> { path.encode_utf16().chain(Some(0)).collect() }
fn read_registry_string(root: windows::Win32::System::Registry::HKEY, path: &str, name: &str) -> Result<Option<String>, String> {
    use windows::Win32::System::Registry::{RegCloseKey, RegOpenKeyExW, RegQueryValueExW, KEY_READ, REG_SZ};
    let subkey = registry_key(path);
    let mut handle = windows::Win32::System::Registry::HKEY::default();
    if unsafe { RegOpenKeyExW(root, windows::core::PCWSTR(subkey.as_ptr()), Some(0), KEY_READ, &mut handle) }.is_err() { return Ok(None); }
    let value_name = registry_key(name);
    let mut kind = REG_SZ;
    let mut size = 0u32;
    let status = unsafe { RegQueryValueExW(handle, windows::core::PCWSTR(value_name.as_ptr()), None, Some(&mut kind), None, Some(&mut size)) };
    if status.is_err() || size == 0 { unsafe { let _ = RegCloseKey(handle); } return Ok(None); }
    let mut buffer = vec![0u16; (size as usize + 1) / 2];
    let status = unsafe { RegQueryValueExW(handle, windows::core::PCWSTR(value_name.as_ptr()), None, None, Some(buffer.as_mut_ptr() as *mut u8), Some(&mut size)) };
    unsafe { let _ = RegCloseKey(handle); }
    if status.is_err() { return Err("读取注册表失败".into()); }
    let text = String::from_utf16_lossy(&buffer);
    Ok(Some(text.trim_end_matches('\0').to_string()))
}
fn set_registry_string(root: windows::Win32::System::Registry::HKEY, path: &str, name: &str, value: &str) -> Result<(), String> {
    use windows::Win32::System::Registry::{RegCloseKey, RegCreateKeyExW, RegSetValueExW, KEY_WRITE, REG_OPTION_NON_VOLATILE, REG_SZ};
    let subkey = registry_key(path);
    let mut handle = windows::Win32::System::Registry::HKEY::default();
    let status = unsafe { RegCreateKeyExW(root, windows::core::PCWSTR(subkey.as_ptr()), Some(0), None, REG_OPTION_NON_VOLATILE, KEY_WRITE, None, &mut handle, None) };
    if status.is_err() { return Err(format!("打开注册表项失败：{path}")); }
    let value_name = registry_key(name);
    let bytes: Vec<u8> = value.encode_utf16().chain(Some(0)).flat_map(|unit| unit.to_le_bytes()).collect();
    let status = unsafe { RegSetValueExW(handle, windows::core::PCWSTR(value_name.as_ptr()), Some(0), REG_SZ, Some(&bytes)) };
    unsafe { let _ = RegCloseKey(handle); }
    if status.is_err() { return Err(format!("写入注册表失败：{path}")); }
    Ok(())
}
// D.1：首次保存/另存为时把被引用图片复制到目标 assets/，复制成功后才允许写 .md。
#[tauri::command]
pub fn copy_resource(source: String, relative: String, directory: String) -> Result<CopiedResource, String> {
    let relative = relative.replace('\\', "/");
    let rel = Path::new(&relative);
    if rel.components().any(|part| !matches!(part, std::path::Component::Normal(_) | std::path::Component::CurDir)) { return Err("图片相对路径无效".into()); }
    let bytes = std::fs::read(&source).map_err(|error| format!("读取资源失败 {source}: {error}"))?;
    let target = PathBuf::from(&directory).join(rel);
    std::fs::create_dir_all(target.parent().ok_or("资源目标目录无效")?).map_err(|error| error.to_string())?;
    if let Ok(existing) = std::fs::read(&target) {
        if existing == bytes {
            return Ok(CopiedResource { relative_path: relative, absolute_path: target.to_string_lossy().into_owned(), bytes: bytes.len() as u64 });
        }
        return Err(format!("图片名称冲突，目标已有不同内容：{}", target.display()));
    }
    crate::persistence::atomic_write(&target, &bytes)?;
    let written = std::fs::read(&target).map_err(|error| error.to_string())?;
    if written != bytes { return Err("资源复制校验失败，未绑定目标文件".into()); }
    Ok(CopiedResource { relative_path: relative, absolute_path: target.to_string_lossy().into_owned(), bytes: bytes.len() as u64 })
}
#[tauri::command]
pub fn read_document_image(window: tauri::WebviewWindow, path: String, relative: String) -> Result<String, String> {
    let document = PathBuf::from(path);
    if !document.is_absolute() || Path::new(&relative).is_absolute() || relative.contains(':') { return Err("图片路径无效".into()); }
    let target = document.parent().ok_or("文档目录无效")?.join(relative);
    let parent = target.parent().ok_or("图片目录无效")?.to_string_lossy().into_owned();
    let name = target.file_name().ok_or("图片名称无效")?.to_string_lossy().into_owned();
    crate::persistence::read_image(window, parent, name)
}
fn dialog(filter_index: u32, title: &str, suggested: Option<&str>, save: bool, extension: &str, owner: Option<windows::Win32::Foundation::HWND>) -> Option<String> {
    let filter_text = match extension { "html" => "HTML\0*.html;*.htm\0所有文件\0*.*\0\0", "pdf" => "PDF\0*.pdf\0所有文件\0*.*\0\0", _ => "Markdown\0*.md;*.markdown;*.txt\0所有文件\0*.*\0\0" };
    let filter: Vec<u16> = filter_text.encode_utf16().collect();
    let mut name: Vec<u16> = suggested.unwrap_or("").encode_utf16().chain(Some(0)).collect();
    name.resize(1024, 0);
    let title = wide(title);
    let extension = wide(extension);
    let mut options = OPENFILENAMEW {
        lStructSize: std::mem::size_of::<OPENFILENAMEW>() as u32,
        hwndOwner: owner.unwrap_or_default(),
        lpstrFilter: PCWSTR(filter.as_ptr()), nFilterIndex: filter_index,
        lpstrFile: windows::core::PWSTR(name.as_mut_ptr()), nMaxFile: name.len() as u32,
        lpstrTitle: PCWSTR(title.as_ptr()), lpstrDefExt: PCWSTR(extension.as_ptr()),
        Flags: OFN_EXPLORER | OFN_NOCHANGEDIR | OFN_PATHMUSTEXIST | if save { OFN_OVERWRITEPROMPT } else { OFN_FILEMUSTEXIST },
        ..Default::default()
    };
    let accepted = unsafe { if save { GetSaveFileNameW(&mut options) } else { GetOpenFileNameW(&mut options) } };
    if !accepted.as_bool() { return None; }
    let length = name.iter().position(|unit| *unit == 0).unwrap_or(0);
    if length == 0 { return None; }
    Some(String::from_utf16_lossy(&name[..length]))
}
// D-1：系统级拖入的图片按路径读取，交给渲染端走同一条落盘路径。
#[tauri::command]
pub fn read_binary(path: String) -> Result<String, String> {
    let target = PathBuf::from(&path);
    if !target.is_absolute() { return Err("需要绝对文件路径".into()); }
    let metadata = std::fs::metadata(&target).map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > 32 * 1024 * 1024 { return Err("文件不存在或超过 32 MB".into()); }
    let bytes = std::fs::read(&target).map_err(|error| error.to_string())?;
    Ok(format!("data:application/octet-stream;base64,{}", crate::persistence::encode_base64(&bytes)))
}
// E-1：系统文件选择器；取消返回 null，不改变任何文档状态。
#[tauri::command]
pub fn pick_file(window: tauri::WebviewWindow, save: bool, suggested: Option<String>) -> Option<String> {
    let owner = window.hwnd().ok().map(|handle| windows::Win32::Foundation::HWND(handle.0 as _));
    dialog(1, if save { "保存 Markdown 文件" } else { "打开 Markdown 文件" }, suggested.as_deref(), save, "md", owner)
}
#[tauri::command]
pub fn pick_export(window: tauri::WebviewWindow, format: String, suggested: Option<String>) -> Result<Option<String>, String> {
    if format != "html" && format != "pdf" { return Err("导出格式无效".into()); }
    let owner = window.hwnd().ok().map(|handle| windows::Win32::Foundation::HWND(handle.0 as _));
    Ok(dialog(1, if format == "html" { "导出 HTML" } else { "导出 PDF" }, suggested.as_deref(), true, &format, owner))
}
#[tauri::command]
pub fn write_export(path: String, html: String) -> Result<u64, String> {
    let target = PathBuf::from(&path);
    if !target.is_absolute() || !matches!(target.extension().and_then(|s| s.to_str()).map(|s| s.to_ascii_lowercase()).as_deref(), Some("html" | "htm")) { return Err("需要绝对 .html 或 .htm 路径".into()); }
    crate::persistence::atomic_write(&target, html.as_bytes())?;
    Ok(html.len() as u64)
}
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if !["https://", "http://", "mailto:"].iter().any(|prefix| lower.starts_with(prefix)) || url.chars().any(char::is_control) { return Err("外链协议无效".into()); }
    let verb = wide("open");
    let url = wide(&url);
    let result = unsafe { windows::Win32::UI::Shell::ShellExecuteW(None, PCWSTR(verb.as_ptr()), PCWSTR(url.as_ptr()), None, None, windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL) };
    if result.0 as usize <= 32 { return Err("系统浏览器未能打开链接".into()); }
    Ok(())
}
fn valid_filename(name: &str) -> bool {
    let base = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    !name.is_empty() && name != "." && name != ".." && !name.ends_with(['.', ' '])
        && !name.chars().any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
        && !["CON", "PRN", "AUX", "NUL"].contains(&base.as_str())
        && !(base.len() == 4 && (base.starts_with("COM") || base.starts_with("LPT")) && matches!(base.as_bytes()[3], b'1'..=b'9'))
}
// 同目录改名，不替换已有文件；磁盘变化时保留两边内容。
#[tauri::command]
pub fn rename_document(path: String, name: String, expected_fingerprint: String) -> Result<TextFile, String> {
    if !valid_filename(&name) { return Err("文件名包含 Windows 不支持的字符或保留名称".into()); }
    let old = PathBuf::from(&path);
    if !old.is_absolute() { return Err("需要绝对文件路径".into()); }
    let mut result = read_text_file(path.clone())?;
    if result.fingerprint != expected_fingerprint { return Err("磁盘内容已变化，请重新加载或另存为后再重命名".into()); }
    let new = old.parent().ok_or("文件目录无效")?.join(&name);
    if old != new {
        let from = wide(&path); let to = wide(&new.to_string_lossy());
        unsafe { windows::Win32::Storage::FileSystem::MoveFileExW(PCWSTR(from.as_ptr()), PCWSTR(to.as_ptr()), windows::Win32::Storage::FileSystem::MOVEFILE_WRITE_THROUGH) }.map_err(|error| format!("重命名失败（目标可能已存在）：{error}"))?;
    }
    result.path = new.to_string_lossy().into_owned();
    Ok(result)
}
#[tauri::command]
pub fn reveal_document(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.is_absolute() || !target.is_file() { return Err("文件不存在或路径无效".into()); }
    use std::os::windows::process::CommandExt;
    // 分开传递开关与文件名，由 Windows 参数编码处理中文、空格及引号。
    std::process::Command::new("explorer.exe").arg("/select,").arg(path.replace('/', "\\")).creation_flags(0x08000000).spawn().map_err(|error| error.to_string())?;
    Ok(())
}
// I-4/I-7：配置持久化（主题 + 默认启动模式）。
#[tauri::command]
pub fn read_settings(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<Settings, String> {
    let path = crate::persistence::app_root(&app, &window)?.join("settings.json");
    if !path.exists() { return Ok(Settings::default()); }
    let bytes = std::fs::read(&path).map_err(|error| error.to_string())?;
    match serde_json::from_slice::<Settings>(&bytes) {
        Ok(mut settings) => { settings.recent.truncate(RECENT_LIMIT); Ok(settings) },
        // 兼容 M1–M5 的纯字符串主题记录。
        Err(_) => serde_json::from_slice::<String>(&bytes).map(|theme| Settings { theme, ..Settings::default() }).map_err(|error| error.to_string()),
    }
}
#[tauri::command]
pub fn write_settings(app: tauri::AppHandle, window: tauri::WebviewWindow, state: tauri::State<crate::persistence::Storage>, settings: Settings) -> Result<(), String> {
    let _serial = state.0.lock().map_err(|error| error.to_string())?;
    if !["system", "light", "dark"].contains(&settings.theme.as_str()) { return Err("主题配置无效".into()); }
    if !["light", "dark"].contains(&settings.code_theme.as_str()) { return Err("代码块主题配置无效".into()); }
    if !["edit", "read"].contains(&settings.default_mode.as_str()) { return Err("默认启动模式无效".into()); }
    if !(20.0..=80.0).contains(&settings.split) { return Err("分栏比例需在 20%–80% 之间".into()); }
    if !(10.0..=32.0).contains(&settings.font_size) { return Err("正文字号需在 10–32 之间".into()); }
    if !(1.0..=3.0).contains(&settings.line_height) { return Err("行距需在 1.0–3.0 之间".into()); }
    if settings.backup_count > 20 { return Err("备份份数不能超过 20".into()); }
    if settings.recent.len() > RECENT_LIMIT { return Err("最近打开最多 5 条".into()); }
    crate::persistence::atomic_write(&crate::persistence::app_root(&app, &window)?.join("settings.json"), &serde_json::to_vec(&settings).map_err(|error| error.to_string())?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn settings_bridge_and_legacy_keys() {
        let defaults = serde_json::to_value(Settings::default()).unwrap();
        assert_eq!(defaults["backup_count"], 0);
        assert_eq!(defaults["default_mode"], "edit");
        assert!(defaults.get("backupCount").is_none());
        for json in [
            r#"{"default_mode":"read","backup_count":4,"font_body":"中文字体","font_mono":"Consolas","font_size":18,"line_height":2.0}"#,
            r#"{"defaultMode":"read","backupCount":4,"fontBody":"中文字体","fontMono":"Consolas","fontSize":18,"lineHeight":2.0}"#,
        ] {
            let settings: Settings = serde_json::from_str(json).unwrap();
            let output = serde_json::to_value(settings).unwrap();
            assert_eq!(output["default_mode"], "read");
            assert_eq!(output["backup_count"], 4);
            assert_eq!(output["font_body"], "中文字体");
            assert_eq!(output["font_size"], 18.0);
            assert_eq!(output["line_height"], 2.0);
        }
    }
    #[test]
    fn filename_validation() {
        for name in ["", ".", "..", "a/b.md", "a\\b.md", "a:.md", "CON.md", "LPT1.txt", "NUL", "x.", "x "] { assert!(!valid_filename(name), "{name}"); }
        for name in ["中文 文件.md", "a.md", "CONtext.md", "COM10.md"] { assert!(valid_filename(name), "{name}"); }
    }
    #[test]
    fn encoding_detection_and_roundtrip() {
        let (text, encoding, bom) = decode("中文".as_bytes()).unwrap();
        assert_eq!((text.as_str(), encoding.as_str(), bom), ("中文", "utf-8", false));
        let mut with_bom = vec![0xEF, 0xBB, 0xBF];
        with_bom.extend_from_slice("中文".as_bytes());
        let (text, encoding, bom) = decode(&with_bom).unwrap();
        assert!(bom && encoding == "utf-8" && text.starts_with('\u{feff}'));
        assert_eq!(encode(&text, "utf-8", bom).unwrap(), with_bom);
        let gbk = gbk_encode("中文").unwrap();
        assert_eq!(gbk, vec![0xD6, 0xD0, 0xCE, 0xC4]);
        let (text, encoding, bom) = decode(&gbk).unwrap();
        assert_eq!((text.as_str(), encoding.as_str(), bom), ("中文", "gbk", false));
        assert!(gbk_encode("😀").is_err());
        for encoding in ["utf-16le", "utf-16be"] {
            let original = "\u{feff}中文 😀\r\n";
            let bytes = encode(original, encoding, true).unwrap();
            let (text, detected, bom) = decode(&bytes).unwrap();
            assert_eq!((text.as_str(), detected.as_str(), bom), (original, encoding, true));
            assert_eq!(encode(&text, &detected, bom).unwrap(), bytes);
            let mut truncated = bytes.clone(); truncated.pop(); assert!(decode(&truncated).is_err());
        }
        assert_eq!(newline_of("a\r\nb"), "\r\n");
        assert_eq!(newline_of("a\nb"), "\n");
        assert_eq!(newline_of("abc"), "\n");
        assert_eq!(fingerprint_bytes(b"abc"), fingerprint_bytes(b"abc"));
        assert_ne!(fingerprint_bytes(b"abc"), fingerprint_bytes(b"abd"));
    }
}


