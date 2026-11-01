// v0.2.7 需求 5.3：读取本机已安装字体，供设置页的“正文字体 / 等宽字体”选择。
// 直接枚举注册表值名（Unicode，避开控制台代码页问题），去样式后缀后按名称去重排序。
use std::sync::OnceLock;

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Registry::{
    RegCloseKey, RegEnumValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE,
    KEY_READ, REG_SZ,
};

const FONT_KEYS: [(HKEY, &str); 2] = [
    (
        HKEY_LOCAL_MACHINE,
        "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts",
    ),
    (
        HKEY_CURRENT_USER,
        "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts",
    ),
];

// 字体注册表值名的样式后缀（“Arial Bold Italic (TrueType)” → “Arial”）。
const STYLE_SUFFIXES: [&str; 6] = ["Bold Italic", "Bold Oblique", "Bold", "Italic", "Oblique", "Regular"];

/// 进程内缓存：字体安装列表在一次运行中不会变化，设置页多次打开不重复枚举。
pub fn system_fonts() -> Vec<String> {
    static CACHE: OnceLock<Vec<String>> = OnceLock::new();
    CACHE.get_or_init(collect).clone()
}

/// 枚举本机字体族名；结果去重、忽略样式变体并按名称排序。
#[tauri::command]
pub async fn list_system_fonts() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(system_fonts)
        .await
        .map_err(|error| error.to_string())
}

fn collect() -> Vec<String> {
    let mut raw = Vec::new();
    for (root, subkey) in FONT_KEYS {
        raw.extend(enum_value_names(root, subkey));
    }
    family_names(&raw)
}

/// 读取某个字体注册表键下所有 REG_SZ 值的名称（名称即“字体名 (类型)”）。
fn enum_value_names(root: HKEY, subkey: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut key = HKEY::default();
    let wide: Vec<u16> = subkey.encode_utf16().chain(std::iter::once(0)).collect();
    // SAFETY: 只读打开注册表键，缓冲区与长度参数均指向本地有效内存。
    unsafe {
        if RegOpenKeyExW(root, PCWSTR(wide.as_ptr()), Some(0), KEY_READ, &mut key) != ERROR_SUCCESS {
            return names;
        }
        let mut index = 0u32;
        loop {
            let mut buffer = [0u16; 512];
            let mut length = buffer.len() as u32;
            let mut value_type = REG_SZ.0;
            let status = RegEnumValueW(
                key,
                index,
                Some(PWSTR(buffer.as_mut_ptr())),
                &mut length,
                None,
                Some(&mut value_type),
                None,
                None,
            );
            if status != ERROR_SUCCESS {
                break;
            }
            index += 1;
            if value_type != REG_SZ.0 || length == 0 || length as usize > buffer.len() {
                continue;
            }
            names.push(String::from_utf16_lossy(&buffer[..length as usize]));
        }
        let _ = RegCloseKey(key);
    }
    names
}

/// 把注册表值名规范成可选的字体族名（纯函数，便于单元测试）。
fn family_names(raw: &[String]) -> Vec<String> {
    let mut families: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for name in raw {
        let base = strip_type_suffix(name);
        if base.is_empty() {
            continue;
        }
        // “Microsoft YaHei & Microsoft YaHei UI (TrueType)” 这类值名包含多个字体族。
        for part in base.split('&') {
            let family = strip_style(part.trim());
            if family.is_empty()
                || family.len() > 80
                || family.contains(',')
                || family.contains('\\')
                || family.starts_with('@')
            {
                continue;
            }
            if seen.insert(family.to_lowercase()) {
                families.push(family);
            }
        }
    }
    families.sort_by(|left, right| left.to_lowercase().cmp(&right.to_lowercase()));
    families
}

/// 去掉值名末尾的 “(TrueType) / (OpenType) / (All res)” 等安装类型说明。
fn strip_type_suffix(name: &str) -> String {
    let trimmed = name.trim();
    if let Some(start) = trimmed.rfind('(') {
        if trimmed.ends_with(')') {
            return trimmed[..start].trim().to_owned();
        }
    }
    trimmed.to_owned()
}

/// 去掉样式后缀；“Arial Black”“Calibri Light”等是独立字体族，不在剥离列表中。
fn strip_style(name: &str) -> String {
    let mut family = name.trim().to_owned();
    for _ in 0..4 {
        let lower = family.to_lowercase();
        let Some(style) = STYLE_SUFFIXES
            .iter()
            .find(|style| lower.ends_with(&format!(" {}", style.to_lowercase())))
        else {
            break;
        };
        family.truncate(family.len() - style.len() - 1);
        family = family.trim_end().to_owned();
    }
    family
}
