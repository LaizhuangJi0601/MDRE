// MDRE 0.3.0：PDF 查看器按范围读取文件，避免大文件一次性进入内存。
// 契约（由主界面接线）：
// - pdf_file_length(path) -> u64：文件字节数，用于建立 PDF 范围传输。
// - read_file_range(path, start, length) -> tauri::ipc::Response：返回原始字节（不经过 JSON 数组），
//   供前端 PDFDataRangeTransport 使用；调用方限制单次长度（建议 4 MiB 上限）。
// 安全约束：只允许绝对路径且扩展名为 .pdf（大小写不敏感）；单次读取 1..=4 MiB，超出文件尾时钳制。
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;

const MAX_RANGE_BYTES: u64 = 4 * 1024 * 1024;

fn validate_pdf_path(path: &str) -> Result<PathBuf, String> {
    let target = PathBuf::from(path);
    if !target.is_absolute() { return Err("需要绝对文件路径".into()); }
    match target.extension().and_then(|extension| extension.to_str()) {
        Some(extension) if extension.eq_ignore_ascii_case("pdf") => (),
        _ => return Err("只能读取 .pdf 文件".into()),
    }
    Ok(target)
}

fn pdf_file(path: &str) -> Result<(PathBuf, u64), String> {
    let target = validate_pdf_path(path)?;
    let metadata = std::fs::metadata(&target).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => "PDF 文件不存在".to_string(),
        _ => format!("无法读取 PDF 文件信息：{error}"),
    })?;
    if !metadata.is_file() { return Err("PDF 路径不是文件".into()); }
    Ok((target, metadata.len()))
}

// 请求长度先按协议校验，再按文件尾钳制；start 超过文件尾时返回空片段（等价于钳制到 0 字节）。
fn clamp_range(file_length: u64, start: u64, length: u64) -> Result<(u64, u64), String> {
    if !(1..=MAX_RANGE_BYTES).contains(&length) {
        return Err(format!("单次读取长度必须在 1 到 {MAX_RANGE_BYTES} 字节之间"));
    }
    let start = start.min(file_length);
    Ok((start, length.min(file_length - start)))
}

#[tauri::command]
pub fn pdf_file_length(path: String) -> Result<u64, String> {
    pdf_file(&path).map(|(_, length)| length)
}

#[tauri::command]
pub fn read_file_range(path: String, start: u64, length: u64) -> Result<tauri::ipc::Response, String> {
    let (target, file_length) = pdf_file(&path)?;
    let (start, length) = clamp_range(file_length, start, length)?;
    if length == 0 { return Ok(tauri::ipc::Response::new(Vec::new())); }
    let mut file = std::fs::File::open(&target).map_err(|error| format!("无法打开 PDF 文件：{error}"))?;
    file.seek(SeekFrom::Start(start)).map_err(|error| format!("无法定位 PDF 读取位置：{error}"))?;
    let mut buffer = vec![0u8; length as usize];
    file.read_exact(&mut buffer).map_err(|error| format!("读取 PDF 数据失败：{error}"))?;
    Ok(tauri::ipc::Response::new(buffer))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn range_is_validated_and_clamped() {
        assert_eq!(clamp_range(100, 0, 10), Ok((0, 10)));
        assert_eq!(clamp_range(100, 90, 10), Ok((90, 10)));
        assert_eq!(clamp_range(100, 95, 10), Ok((95, 5)));
        assert_eq!(clamp_range(100, 100, 10), Ok((100, 0)));
        assert_eq!(clamp_range(100, 500, 10), Ok((100, 0)));
        assert_eq!(clamp_range(0, 0, 1), Ok((0, 0)));
        assert!(clamp_range(100, 0, 0).is_err());
        assert!(clamp_range(100, 0, MAX_RANGE_BYTES + 1).is_err());
        assert_eq!(clamp_range(100, 0, MAX_RANGE_BYTES), Ok((0, 100)));
    }

    #[test]
    fn pdf_paths_require_absolute_pdf_extension() {
        let path = if cfg!(windows) { r"C:\tmp\文档.PDF" } else { "/tmp/文档.PDF" };
        assert!(validate_pdf_path(path).is_ok(), "扩展名应大小写不敏感");
        let wrong = if cfg!(windows) { r"C:\tmp\文档.txt" } else { "/tmp/文档.txt" };
        assert!(validate_pdf_path(wrong).is_err());
        let no_extension = if cfg!(windows) { r"C:\tmp\文档" } else { "/tmp/文档" };
        assert!(validate_pdf_path(no_extension).is_err());
        assert!(validate_pdf_path("relative.pdf").is_err());
        assert!(validate_pdf_path("").is_err());
    }
}
