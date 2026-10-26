// 0.2.6：只调用本机 Pandoc，不下载、不随包附带，也不经 shell 拼接命令。
use std::{fs, path::{Path, PathBuf}, process::{Command, Stdio}, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
use std::os::windows::process::CommandExt;
use serde::Serialize;

#[derive(Serialize)]
pub struct Tool { path: String, version: String }
#[derive(Serialize)]
pub struct Converted { pub path: String, bytes: u64, warnings: String }
struct Temporary(PathBuf);
impl Drop for Temporary { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
fn nonce() -> String { SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos().to_string() }
fn temporary() -> Result<Temporary, String> {
    let path = std::env::temp_dir().join(format!("mdre-word-{}-{}", std::process::id(), nonce()));
    fs::create_dir(&path).map_err(|e| e.to_string())?; Ok(Temporary(path))
}
fn run(exe: &Path, args: &[String], cwd: Option<&Path>, seconds: u64) -> Result<(String, String), String> {
    let temp = temporary()?;
    let out = temp.0.join("stdout" ); let err = temp.0.join("stderr");
    let mut command = Command::new(exe);
    command.args(args).creation_flags(0x08000000).stdin(Stdio::null())
        .stdout(fs::File::create(&out).map_err(|e| e.to_string())?).stderr(fs::File::create(&err).map_err(|e| e.to_string())?);
    if let Some(cwd) = cwd { command.current_dir(cwd); }
    let mut child = command.spawn().map_err(|e| format!("无法启动 Pandoc：{e}"))?;
    let start = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? { break status; }
        if start.elapsed() > Duration::from_secs(seconds) { let _ = child.kill(); let _ = child.wait(); return Err("Pandoc 执行超时，已停止转换，原文件未改动。".into()); }
        std::thread::sleep(Duration::from_millis(20));
    };
    let stdout = fs::read_to_string(out).unwrap_or_default();
    let stderr = fs::read_to_string(err).unwrap_or_default();
    if !status.success() { return Err(format!("Pandoc 转换失败：{}", stderr.chars().take(4000).collect::<String>())); }
    Ok((stdout, stderr))
}
fn detect(configured: &str) -> Result<Tool, String> {
    let mut candidates = Vec::new();
    if !configured.trim().is_empty() {
        let path = PathBuf::from(configured.trim().trim_matches('"'));
        if !path.is_absolute() || !path.file_name().is_some_and(|s| s.to_string_lossy().eq_ignore_ascii_case("pandoc.exe")) {
            return Err("请填写完整的 pandoc.exe 绝对路径，不能只填写所在文件夹。".into());
        }
        candidates.push(path);
    } else {
        if let Some(paths) = std::env::var_os("PATH") { candidates.extend(std::env::split_paths(&paths).map(|p| p.join("pandoc.exe"))); }
        for (key, suffix) in [("LOCALAPPDATA", "Pandoc/pandoc.exe"), ("LOCALAPPDATA", "Programs/Pandoc/pandoc.exe"), ("ProgramFiles", "Pandoc/pandoc.exe"), ("CONDA_PREFIX", "Scripts/pandoc.exe"), ("USERPROFILE", "scoop/apps/pandoc/current/pandoc.exe"), ("USERPROFILE", "anaconda3/Scripts/pandoc.exe")] {
            if let Some(root) = std::env::var_os(key) { candidates.push(PathBuf::from(root).join(suffix)); }
        }
    }
    let mut failure = String::new();
    for path in candidates.into_iter().filter(|p| p.is_file()) {
        match run(&path, &["--version".into()], None, 5) {
            Ok((text, _)) if text.starts_with("pandoc") => return Ok(Tool { path: path.to_string_lossy().into_owned(), version: text.lines().next().unwrap_or_default().into() }),
            Ok(_) => failure = "所选程序不是 Pandoc".into(), Err(e) => failure = e,
        }
    }
    Err(format!("未找到可用 Pandoc。请在设置中填写到 pandoc.exe 的完整路径。{failure}"))
}
#[tauri::command]
pub async fn detect_pandoc(tool: String) -> Result<Tool, String> {
    tauri::async_runtime::spawn_blocking(move || detect(&tool)).await.map_err(|e| e.to_string())?
}
fn absolute(path: &str, extension: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    if !path.is_absolute() || !path.extension().is_some_and(|s| s.to_string_lossy().eq_ignore_ascii_case(extension)) { return Err(format!("需要绝对 .{extension} 文件路径")); }
    Ok(path)
}
#[tauri::command]
pub async fn word_convert(window: tauri::WebviewWindow, direction: String, tool: String, path: String, html: Option<String>, input: Option<String>, reference: Option<String>) -> Result<Converted, String> {
    if window.label() != "main" { return Err("请在文档窗口中执行转换".into()); }
    tauri::async_runtime::spawn_blocking(move || {
        let tool = detect(&tool)?;
        let temp = temporary()?;
        let mut args: Vec<String> = Vec::new();
        let output;
        let mut assets: Option<PathBuf> = None;
        if direction == "export" {
            output = absolute(&path, "docx")?;
            let source = temp.0.join("document.html");
            let text = html.ok_or("缺少导出内容")?;
            if text.len() > 128 * 1024 * 1024 { return Err("导出内容超过 128 MiB".into()); }
            fs::write(&source, text).map_err(|e| e.to_string())?;
            args.extend([source.to_string_lossy().into(), "--from=html".into(), "--to=docx".into()]);
            if let Some(reference) = reference.filter(|s| !s.trim().is_empty()) { let reference = absolute(&reference, "docx")?; if !reference.is_file() { return Err("参考 DOCX 不存在".into()); } args.push(format!("--reference-doc={}", reference.display())); }
        } else if direction == "import" {
            output = absolute(&path, "md")?;
            if output.exists() { return Err("导入请使用新的 Markdown 文件名，避免覆盖已有文件。".into()); }
            let source = absolute(&input.ok_or("缺少 Word 文件")?, "docx")?;
            let asset = output.parent().unwrap().join(format!("{}.assets-{}", output.file_stem().unwrap().to_string_lossy(), nonce()));
            args.extend([source.to_string_lossy().into(), "--from=docx".into(), "--to=gfm+tex_math_dollars".into(), "--wrap=none".into(), format!("--extract-media={}", asset.file_name().unwrap().to_string_lossy())]);
            assets = Some(asset);
        } else { return Err("不支持的转换方向".into()); }
        if !output.parent().unwrap().is_dir() { return Err("输出目录不存在".into()); }
        let staged = temp.0.join(if direction == "export" { "result.docx" } else { "result.md" });
        args.extend(["--output".into(), staged.to_string_lossy().into()]);
        let result = (|| {
            let (_, warnings) = run(Path::new(&tool.path), &args, output.parent(), 90)?;
            let bytes = fs::read(&staged).map_err(|e| e.to_string())?;
            if direction == "export" {
                if !bytes.starts_with(b"PK") { return Err("Pandoc 未生成有效 DOCX".into()); }
                crate::persistence::atomic_write(&output, &bytes)?;
            } else {
                // 导入始终新建，使用排他创建防止选择后出现同名文件的竞争覆盖。
                use std::io::Write;
                let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&output).map_err(|e| e.to_string())?;
                file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|e| e.to_string())?;
            }
            Ok(Converted { path, bytes: bytes.len() as u64, warnings })
        })();
        if result.is_err() { if let Some(asset) = assets { if asset.parent() == output.parent() && asset.file_name().is_some_and(|s| s.to_string_lossy().contains(".assets-")) { let _ = fs::remove_dir_all(asset); } } }
        result
    }).await.map_err(|e| e.to_string())?
}
