use serde::Serialize;
use std::{collections::HashMap, path::PathBuf};
use windows::core::PCWSTR;
use windows::Win32::{Graphics::Gdi::*, Storage::FileSystem::{FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL}, System::Com::*, UI::{Shell::*, WindowsAndMessaging::*}};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry { name: String, path: String, directory: bool, editable: bool, icon: Option<String> }

fn wide(value: &str) -> Vec<u16> { value.encode_utf16().chain(Some(0)).collect() }

// 从 Windows 文件关联获取小图标，而不是固定模拟文件类型图标。
fn system_icon(path: &str, directory: bool) -> Result<String, String> {
    unsafe {
        let mut file = SHFILEINFOW::default();
        let value = wide(path);
        let flags = if directory { FILE_ATTRIBUTE_DIRECTORY } else { FILE_ATTRIBUTE_NORMAL };
        if SHGetFileInfoW(PCWSTR(value.as_ptr()), flags, Some(&mut file), std::mem::size_of::<SHFILEINFOW>() as u32, SHGFI_ICON | SHGFI_SMALLICON | SHGFI_USEFILEATTRIBUTES) == 0 { return Err("系统图标不可用".into()); }
        let mut info = ICONINFO::default();
        if let Err(error) = GetIconInfo(file.hIcon, &mut info) { let _ = DestroyIcon(file.hIcon); return Err(error.to_string()); }
        let dc = GetDC(None);
        let result = (|| {
            let mut bitmap = BITMAP::default();
            if GetObjectW(info.hbmColor.into(), std::mem::size_of::<BITMAP>() as i32, Some((&mut bitmap as *mut BITMAP).cast())) == 0 { return Err("读取图标失败".to_string()); }
            let width = bitmap.bmWidth as u32; let height = bitmap.bmHeight as u32;
            let mut data = vec![0u8; (width * height * 4) as usize];
            let mut dib = BITMAPINFO::default();
            dib.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
            dib.bmiHeader.biWidth = width as i32; dib.bmiHeader.biHeight = -(height as i32);
            dib.bmiHeader.biPlanes = 1; dib.bmiHeader.biBitCount = 32; dib.bmiHeader.biCompression = BI_RGB.0;
            if GetDIBits(dc, info.hbmColor, 0, height, Some(data.as_mut_ptr().cast()), &mut dib, DIB_RGB_COLORS) == 0 { return Err("读取图标像素失败".into()); }
            let alpha = data.chunks_exact(4).any(|pixel| pixel[3] != 0);
            for pixel in data.chunks_exact_mut(4) { pixel.swap(0, 2); if !alpha { pixel[3] = 255; } }
            let mut bytes = Vec::new();
            { let mut encoder = png::Encoder::new(&mut bytes, width, height); encoder.set_color(png::ColorType::Rgba); encoder.set_depth(png::BitDepth::Eight);
              let mut writer = encoder.write_header().map_err(|error| error.to_string())?; writer.write_image_data(&data).map_err(|error| error.to_string())?; }
            Ok(format!("data:image/png;base64,{}", crate::persistence::encode_base64(&bytes)))
        })();
        let _ = ReleaseDC(None, dc); let _ = DeleteObject(info.hbmColor.into()); let _ = DeleteObject(info.hbmMask.into()); let _ = DestroyIcon(file.hIcon);
        result
    }
}

#[tauri::command]
pub fn list_directory(path: String) -> Result<Vec<Entry>, String> {
    let root = PathBuf::from(&path);
    if !root.is_absolute() || !root.is_dir() { return Err("需要存在的绝对文件夹路径".into()); }
    let mut result = Vec::new(); let mut icons = HashMap::new();
    for item in std::fs::read_dir(root).map_err(|error| error.to_string())? {
        let item = item.map_err(|error| error.to_string())?; let kind = item.file_type().map_err(|error| error.to_string())?;
        let directory = kind.is_dir();
        if !directory && !kind.is_file() { continue; }
        let extension = item.path().extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
        let editable = !directory && ["md", "markdown", "txt"].contains(&extension.as_str());
        let path = item.path().to_string_lossy().into_owned();
        let key = if directory { "folder".into() } else { extension };
        let icon = icons.entry(key).or_insert_with(|| system_icon(&path, directory).ok()).clone();
        result.push(Entry { name: item.file_name().to_string_lossy().into_owned(), path, directory, editable, icon });
    }
    result.sort_by(|a, b| b.directory.cmp(&a.directory).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(result)
}

// 只新建空文件，使用独占创建避免覆盖目录中已有的未命名文档。
#[tauri::command]
pub fn create_document(path: String) -> Result<String, String> {
    let root = PathBuf::from(path);
    if !root.is_absolute() || !root.is_dir() { return Err("需要存在的绝对文件夹路径".into()); }
    for number in 1.. {
        let name = if number == 1 { "未命名.md".to_string() } else { format!("未命名 {number}.md") };
        let target = root.join(name);
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&target) {
            Ok(_) => return Ok(target.to_string_lossy().into_owned()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("新建文件失败：{error}")),
        }
    }
    unreachable!()
}

#[tauri::command]
pub fn pick_folder(window: tauri::WebviewWindow) -> Result<Option<String>, String> {
    unsafe {
        let initialized = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
        let result = (|| {
            let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER).map_err(|error| error.to_string())?;
            dialog.SetOptions(FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_NOCHANGEDIR).map_err(|error| error.to_string())?;
            let title = wide(&crate::i18n::text("打开 Markdown 文件夹")); dialog.SetTitle(PCWSTR(title.as_ptr())).map_err(|error| error.to_string())?;
            let owner = window.hwnd().ok().map(|handle| windows::Win32::Foundation::HWND(handle.0 as _));
            if let Err(error) = dialog.Show(owner) { if error.code().0 as u32 == 0x800704c7 { return Ok(None); } return Err(error.to_string()); }
            let item = dialog.GetResult().map_err(|error| error.to_string())?;
            let path = item.GetDisplayName(SIGDN_FILESYSPATH).map_err(|error| error.to_string())?;
            let value = path.to_string().map_err(|error| error.to_string()); CoTaskMemFree(Some(path.0.cast()));
            value.map(Some)
        })();
        if initialized { CoUninitialize(); }
        result
    }
}
