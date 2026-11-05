// MDRE 0.3.0：桌面版检查更新与便携 EXE 自替换。
// 契约（由主界面接线）：
// - check_latest_release(app) -> UpdateCheck：请求 GitHub Releases latest，比较当前版本。
// - download_update(app, asset_url, sha_url, version) -> StagedUpdate：下载 mdre.exe、校验 SHA-256、替换当前 EXE（旧文件改名 .old）。
// - restart_after_update(app)：延迟重启到新 EXE；带单实例插件时不能立即启动新进程。
// - cleanup_stale_update()：启动后清理上次替换留下的 .old 文件。
// 网络全部走系统 WinHTTP（自动使用系统代理），SHA-256 由 BCrypt 计算，不引入额外 crate。
use serde::Serialize;
use std::cmp::Ordering;
use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::ptr;
use windows::core::{w, PCWSTR};
use windows::Win32::Networking::WinHttp::{
    WinHttpCloseHandle, WinHttpConnect, WinHttpOpen, WinHttpOpenRequest, WinHttpQueryDataAvailable,
    WinHttpQueryHeaders, WinHttpReadData, WinHttpReceiveResponse, WinHttpSendRequest, WinHttpSetOption,
    WinHttpSetTimeouts, WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_FLAG_SECURE, WINHTTP_OPTION_REDIRECT_POLICY,
    WINHTTP_OPTION_REDIRECT_POLICY_ALWAYS, WINHTTP_QUERY_CONTENT_LENGTH, WINHTTP_QUERY_FLAG_NUMBER,
    WINHTTP_QUERY_STATUS_CODE,
};
use windows::Win32::Security::Cryptography::{
    BCryptCloseAlgorithmProvider, BCryptCreateHash, BCryptDestroyHash, BCryptFinishHash, BCryptGetProperty,
    BCryptHashData, BCryptOpenAlgorithmProvider, BCRYPT_ALG_HANDLE, BCRYPT_HASH_HANDLE, BCRYPT_OBJECT_LENGTH,
    BCRYPT_OPEN_ALGORITHM_PROVIDER_FLAGS, BCRYPT_SHA256_ALGORITHM,
};

const RELEASES_API: &str = "https://api.github.com/repos/LaizhuangJi0601/MDRE/releases/latest";
const RELEASES_PAGE: &str = "https://github.com/LaizhuangJi0601/MDRE/releases";
const EXE_ASSET: &str = "mdre.exe";
const CHECKSUM_ASSET: &str = "SHA256SUMS.txt";
const UPDATE_DIR: &str = "updates";
const API_MAX_BYTES: u64 = 4 * 1024 * 1024;
const CHECKSUMS_MAX_BYTES: u64 = 1024 * 1024;
const UPDATE_MAX_BYTES: u64 = 256 * 1024 * 1024;
const HTTP_TIMEOUT_MS: i32 = 10_000;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    pub current_version: String,
    pub latest_version: String,
    pub tag: String,
    pub html_url: String,
    pub published_at: String,
    pub notes: String,
    pub asset_url: String,
    pub asset_size: u64,
    pub sha256_url: String,
    pub update_available: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedUpdate {
    pub version: String,
    pub path: String,
}

fn wide(text: &str) -> Vec<u16> { text.encode_utf16().chain(Some(0)).collect() }

// WinHTTP 句柄统一走 Drop，提前返回时按声明逆序关闭 request → connect → session。
struct HttpHandle(*mut c_void);
impl Drop for HttpHandle {
    fn drop(&mut self) {
        if !self.0.is_null() { unsafe { let _ = WinHttpCloseHandle(self.0); } }
    }
}

fn http_error(action: &str, error: windows::core::Error) -> String {
    let code = error.code().0 as u32;
    let hint = match code {
        0x80072EE7 => "无法解析更新服务器域名，请检查网络或代理设置",
        0x80072EE2 => "连接更新服务器超时，请检查网络或代理设置",
        0x80072EFD => "无法连接更新服务器，请检查网络或代理设置",
        _ => "请检查网络或代理设置后再试",
    };
    format!("{action}失败：{hint}（{error}）")
}

// 发布 API 地址；验收脚本可用 MDRE_UPDATE_API_URL 指向本地 mock（与允许 HTTP 的测试开关配合）。
fn releases_api() -> String {
    std::env::var("MDRE_UPDATE_API_URL").ok().filter(|value| !value.trim().is_empty()).unwrap_or_else(|| RELEASES_API.to_string())
}
// 正常只允许 HTTPS；本地验收用 MDRE_UPDATE_ALLOW_HTTP=1 临时允许 HTTP。
fn update_http_allowed() -> bool { std::env::var("MDRE_UPDATE_ALLOW_HTTP").ok().as_deref() == Some("1") }

// 只允许 HTTPS：GitHub 资产地址会 302 到 objects.githubusercontent.com，由 WinHTTP 自动跟随。
fn http_get(url: &str, headers: &[(&str, &str)], max_bytes: u64) -> Result<Vec<u8>, String> {
    let parsed = tauri::Url::parse(url).map_err(|_| "更新下载地址无效".to_string())?;
    let secure = parsed.scheme() == "https" || (parsed.scheme() == "http" && update_http_allowed());
    if !secure { return Err("更新下载地址必须使用 HTTPS".into()); }
    if !parsed.username().is_empty() || parsed.password().is_some() { return Err("更新下载地址不能包含账号信息".into()); }
    let host = parsed.host_str().ok_or("更新下载地址缺少主机名")?.to_string();
    let port = parsed.port_or_known_default().unwrap_or(443);
    let mut object = parsed.path().to_string();
    if let Some(query) = parsed.query() { object.push('?'); object.push_str(query); }
    let host_wide = wide(&host);
    let object_wide = wide(&object);
    let header_text: String = headers.iter().map(|(name, value)| format!("{name}: {value}\r\n")).collect();
    let header_wide = wide(&header_text);
    unsafe {
        let session = HttpHandle(WinHttpOpen(w!("MDRE-updater"), WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, PCWSTR::null(), PCWSTR::null(), 0));
        if session.0.is_null() { return Err("无法初始化 WinHTTP 会话".into()); }
        WinHttpSetTimeouts(session.0, HTTP_TIMEOUT_MS, HTTP_TIMEOUT_MS, HTTP_TIMEOUT_MS, HTTP_TIMEOUT_MS)
            .map_err(|error| http_error("设置网络超时", error))?;
        let connect = HttpHandle(WinHttpConnect(session.0, PCWSTR(host_wide.as_ptr()), port, 0));
        if connect.0.is_null() { return Err(format!("无法连接更新服务器：{host}")); }
        let flags = if parsed.scheme() == "https" { WINHTTP_FLAG_SECURE } else { windows::Win32::Networking::WinHttp::WINHTTP_OPEN_REQUEST_FLAGS(0) };
        let request = HttpHandle(WinHttpOpenRequest(
            connect.0, w!("GET"), PCWSTR(object_wide.as_ptr()), PCWSTR::null(), PCWSTR::null(), ptr::null(), flags,
        ));
        if request.0.is_null() { return Err("无法创建更新请求".into()); }
        let redirect = WINHTTP_OPTION_REDIRECT_POLICY_ALWAYS.to_ne_bytes();
        WinHttpSetOption(Some(request.0 as *const c_void), WINHTTP_OPTION_REDIRECT_POLICY, Some(&redirect))
            .map_err(|error| http_error("设置跟随重定向", error))?;
        let header_slice = if header_wide.len() > 1 { Some(&header_wide[..header_wide.len() - 1]) } else { None };
        WinHttpSendRequest(request.0, header_slice, None, 0, 0, 0).map_err(|error| http_error("发送更新请求", error))?;
        WinHttpReceiveResponse(request.0, ptr::null_mut()).map_err(|error| http_error("等待更新响应", error))?;
        let mut status = 0u32;
        let mut status_length = 4u32;
        WinHttpQueryHeaders(
            request.0, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, PCWSTR::null(),
            Some(&mut status as *mut u32 as *mut c_void), &mut status_length, ptr::null_mut(),
        ).map_err(|error| http_error("读取更新响应状态", error))?;
        match status {
            200 => (),
            403 | 429 => return Err(format!("GitHub 接口访问受限（HTTP {status}），请稍后重试或打开发布页手动下载")),
            404 => return Err("没有找到对应的 GitHub 发布".into()),
            _ => return Err(format!("更新服务器返回 HTTP {status}")),
        }
        let mut declared = 0u32;
        let mut declared_length = 4u32;
        let _ = WinHttpQueryHeaders(
            request.0, WINHTTP_QUERY_CONTENT_LENGTH | WINHTTP_QUERY_FLAG_NUMBER, PCWSTR::null(),
            Some(&mut declared as *mut u32 as *mut c_void), &mut declared_length, ptr::null_mut(),
        );
        if u64::from(declared) > max_bytes { return Err("更新文件超过允许的大小，已取消更新".into()); }
        let mut body: Vec<u8> = Vec::new();
        if declared > 0 { body.reserve(declared as usize); }
        loop {
            let mut available = 0u32;
            WinHttpQueryDataAvailable(request.0, &mut available).map_err(|error| http_error("读取更新数据", error))?;
            if available == 0 { break; }
            let take = available.min(64 * 1024);
            let mut buffer = vec![0u8; take as usize];
            let mut read = 0u32;
            WinHttpReadData(request.0, buffer.as_mut_ptr() as *mut c_void, take, &mut read)
                .map_err(|error| http_error("读取更新数据", error))?;
            if read == 0 { break; }
            body.extend_from_slice(&buffer[..read as usize]);
            if body.len() as u64 > max_bytes { return Err("更新文件超过允许的大小，已取消更新".into()); }
        }
        if body.is_empty() { return Err("更新服务器返回了空响应".into()); }
        Ok(body)
    }
}

// 用 BCrypt（CNG）计算 SHA-256，返回 64 位小写十六进制。
fn sha256_bytes(bytes: &[u8]) -> Result<String, String> {
    unsafe {
        let mut algorithm = BCRYPT_ALG_HANDLE::default();
        if BCryptOpenAlgorithmProvider(
            &mut algorithm, BCRYPT_SHA256_ALGORITHM, PCWSTR::null(), BCRYPT_OPEN_ALGORITHM_PROVIDER_FLAGS(0),
        ).is_err() {
            return Err("无法初始化 SHA-256 校验".into());
        }
        let result = (|| -> Result<String, String> {
            let mut object_length_bytes = [0u8; 4];
            let mut written = 0u32;
            if BCryptGetProperty(
                algorithm.into(), BCRYPT_OBJECT_LENGTH, Some(&mut object_length_bytes), &mut written, 0,
            ).is_err() || written != 4 {
                return Err("无法读取 SHA-256 工作区大小".into());
            }
            let object_length = u32::from_ne_bytes(object_length_bytes);
            let mut object = vec![0u8; object_length as usize];
            let mut hash = BCRYPT_HASH_HANDLE::default();
            if BCryptCreateHash(algorithm, &mut hash, Some(&mut object), None, 0).is_err() {
                return Err("无法创建 SHA-256 计算上下文".into());
            }
            let mut digest = [0u8; 32];
            let hashed = BCryptHashData(hash, bytes, 0).is_ok() && BCryptFinishHash(hash, &mut digest, 0).is_ok();
            let _ = BCryptDestroyHash(hash);
            if !hashed { return Err("SHA-256 计算失败".into()); }
            Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
        })();
        let _ = BCryptCloseAlgorithmProvider(algorithm, 0);
        result
    }
}

// 去掉 v/V 前缀后必须是合法 X.Y.Z[-预发布][+构建]；返回给前端展示的纯版本号。
fn normalize_version(text: &str) -> Option<String> {
    let trimmed = text.trim();
    let stripped = trimmed.strip_prefix('v').or_else(|| trimmed.strip_prefix('V')).unwrap_or(trimmed);
    parse_version(stripped).map(|_| stripped.to_string())
}

// 版本号解析：容忍 v/V 前缀、预发布后缀和构建元数据；除前三段数字外不接受其他格式。
fn parse_version(text: &str) -> Option<ParsedVersion> {
    let trimmed = text.trim();
    let stripped = trimmed.strip_prefix('v').or_else(|| trimmed.strip_prefix('V')).unwrap_or(trimmed);
    let stripped = stripped.split_once('+').map(|(core, _build)| core).unwrap_or(stripped);
    let (core, prerelease) = match stripped.split_once('-') {
        Some((core, pre)) if !pre.is_empty() => (core, Some(pre.to_string())),
        Some(_) => return None,
        None => (stripped, None),
    };
    let mut parts = core.split('.');
    let major = parts.next()?.parse::<u64>().ok()?;
    let minor = parts.next()?.parse::<u64>().ok()?;
    let patch = parts.next()?.parse::<u64>().ok()?;
    if parts.next().is_some() { return None; }
    Some(ParsedVersion { major, minor, patch, prerelease })
}

struct ParsedVersion { major: u64, minor: u64, patch: u64, prerelease: Option<String> }

fn compare_versions(left: &str, right: &str) -> Option<Ordering> {
    let left = parse_version(left)?;
    let right = parse_version(right)?;
    Some(
        left.major.cmp(&right.major)
            .then(left.minor.cmp(&right.minor))
            .then(left.patch.cmp(&right.patch))
            .then_with(|| compare_prerelease(left.prerelease.as_deref(), right.prerelease.as_deref())),
    )
}

// 语义化比较：正式版大于同号预发布；预发布标识按段比较，纯数字按数值、数字小于字母。
fn compare_prerelease(left: Option<&str>, right: Option<&str>) -> Ordering {
    match (left, right) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(left), Some(right)) => {
            let left_ids: Vec<&str> = left.split('.').collect();
            let right_ids: Vec<&str> = right.split('.').collect();
            for (left_id, right_id) in left_ids.iter().zip(right_ids.iter()) {
                let ordering = match (left_id.parse::<u64>(), right_id.parse::<u64>()) {
                    (Ok(left), Ok(right)) => left.cmp(&right),
                    (Ok(_), Err(_)) => Ordering::Less,
                    (Err(_), Ok(_)) => Ordering::Greater,
                    (Err(_), Err(_)) => left_id.cmp(right_id),
                };
                if ordering != Ordering::Equal { return ordering; }
            }
            left_ids.len().cmp(&right_ids.len())
        }
    }
}

// SHA256SUMS.txt 每行形如 `<hash>  mdre.exe`（也可能带 * 二进制标记或子目录路径）。
fn parse_checksums(text: &str) -> Vec<(String, String)> {
    text.lines().filter_map(|line| {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') { return None; }
        let mut parts = line.split_whitespace();
        let hash = parts.next()?;
        if hash.len() != 64 || !hash.chars().all(|character| character.is_ascii_hexdigit()) { return None; }
        let name = parts.next()?.trim_start_matches('*');
        if name.is_empty() { return None; }
        Some((hash.to_ascii_lowercase(), name.to_string()))
    }).collect()
}

fn expected_sha256(text: &str, file_name: &str) -> Option<String> {
    parse_checksums(text).into_iter().find_map(|(hash, name)| {
        let base = name.rsplit(|character| character == '/' || character == '\\').next().unwrap_or(&name);
        base.eq_ignore_ascii_case(file_name).then_some(hash)
    })
}

// 解析 GitHub release JSON；缺少 mdre.exe / SHA256SUMS.txt 时仍返回结果，前端可回退到打开发布页。
fn parse_release(text: &str, current_version: &str) -> Result<UpdateCheck, String> {
    let value: serde_json::Value = serde_json::from_str(text).map_err(|error| format!("解析 GitHub 发布信息失败：{error}"))?;
    let tag = value.get("tag_name").and_then(|item| item.as_str()).ok_or("GitHub 发布信息缺少版本标签")?;
    let latest = normalize_version(tag).ok_or_else(|| format!("无法解析最新版本号：{tag}"))?;
    let ordering = compare_versions(&latest, current_version)
        .ok_or_else(|| format!("无法比较版本号：{current_version}"))?;
    let mut asset_url = String::new();
    let mut asset_size = 0u64;
    let mut sha256_url = String::new();
    for asset in value.get("assets").and_then(|item| item.as_array()).into_iter().flatten() {
        let Some(name) = asset.get("name").and_then(|item| item.as_str()) else { continue; };
        let url = asset.get("browser_download_url").and_then(|item| item.as_str()).unwrap_or_default();
        if name.eq_ignore_ascii_case(EXE_ASSET) {
            asset_url = url.to_string();
            asset_size = asset.get("size").and_then(|item| item.as_u64()).unwrap_or(0);
        } else if name.eq_ignore_ascii_case(CHECKSUM_ASSET) {
            sha256_url = url.to_string();
        }
    }
    Ok(UpdateCheck {
        current_version: current_version.to_string(),
        latest_version: latest,
        tag: tag.to_string(),
        html_url: value.get("html_url").and_then(|item| item.as_str()).unwrap_or(RELEASES_PAGE).to_string(),
        published_at: value.get("published_at").and_then(|item| item.as_str()).unwrap_or_default().to_string(),
        notes: value.get("body").and_then(|item| item.as_str()).unwrap_or_default().to_string(),
        asset_url,
        asset_size,
        sha256_url,
        update_available: ordering == Ordering::Greater,
    })
}

fn check_latest_release_blocking(app: &tauri::AppHandle) -> Result<UpdateCheck, String> {
    let body = http_get(
        &releases_api(),
        &[("Accept", "application/vnd.github+json"), ("X-GitHub-Api-Version", "2022-11-28")],
        API_MAX_BYTES,
    )?;
    let text = String::from_utf8(body).map_err(|_| "GitHub 响应不是 UTF-8 编码".to_string())?;
    parse_release(&text, &app.package_info().version.to_string())
}

// 更新缓存目录里的版本段必须是纯文件名，防止版本参数带路径穿越。
fn version_segment(version: &str) -> Result<String, String> {
    let trimmed = version.trim();
    let stripped = trimmed.strip_prefix('v').or_else(|| trimmed.strip_prefix('V')).unwrap_or(trimmed);
    if stripped.is_empty() || stripped.len() > 64 {
        return Err("更新版本号无效".into());
    }
    if !stripped.chars().all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '+' | '_'))
        || stripped.contains("..")
    {
        return Err("更新版本号包含非法字符".into());
    }
    Ok(stripped.to_string())
}

fn validate_download_url(url: &str) -> Result<(), String> {
    let parsed = tauri::Url::parse(url).map_err(|_| "更新下载地址无效".to_string())?;
    let secure = parsed.scheme() == "https" || (parsed.scheme() == "http" && update_http_allowed());
    if !secure || parsed.host_str().is_none()
        || !parsed.username().is_empty() || parsed.password().is_some()
    {
        return Err("更新下载地址无效：只允许 HTTPS 地址".into());
    }
    Ok(())
}

// 把新 EXE 替换到当前程序路径：先复制同目录 .new（目录不可写会立刻报错），
// 再把当前 EXE 改名 .old（Windows 允许重命名正在运行的自身文件），最后 .new 改名到位；失败回滚。
fn install_update(staged: &Path) -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|error| format!("无法确定当前程序路径：{error}"))?;
    replace_executable(&exe, staged)?;
    Ok(exe)
}

// 替换逻辑单独抽出，便于用临时目录做单元测试（不触碰真实程序）。
fn replace_executable(exe: &Path, staged: &Path) -> Result<(), String> {
    let directory = exe.parent().ok_or("当前程序目录无效")?;
    let file_name = exe.file_name().ok_or("当前程序文件名无效")?.to_os_string();
    let mut new_name = file_name.clone();
    new_name.push(".new");
    let new_path = directory.join(new_name);
    let mut old_name = file_name;
    old_name.push(".old");
    let old_path = directory.join(old_name);
    std::fs::copy(staged, &new_path)
        .map_err(|error| format!("无法写入程序目录（可能只读、无权限或被安全软件拦截）：{error}"))?;
    match std::fs::remove_file(&old_path) {
        Ok(()) => (),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(error) => {
            let _ = std::fs::remove_file(&new_path);
            return Err(format!("无法清理旧版本文件（可能仍被占用）：{error}"));
        }
    }
    if let Err(error) = std::fs::rename(exe, &old_path) {
        let _ = std::fs::remove_file(&new_path);
        return Err(format!("无法替换当前程序（目录可能只读或被安全软件拦截）：{error}"));
    }
    if let Err(error) = std::fs::rename(&new_path, exe) {
        let _ = std::fs::rename(&old_path, exe);
        return Err(format!("无法启用新版本程序，已回滚：{error}"));
    }
    Ok(())
}

fn download_update_blocking(app: &tauri::AppHandle, asset_url: &str, sha_url: &str, version: &str) -> Result<StagedUpdate, String> {
    use tauri::Manager;
    let segment = version_segment(version)?;
    validate_download_url(asset_url)?;
    validate_download_url(sha_url)?;
    let directory = app.path().app_local_data_dir()
        .map_err(|error| format!("无法确定更新缓存目录：{error}"))?
        .join(UPDATE_DIR)
        .join(&segment);
    std::fs::create_dir_all(&directory).map_err(|error| format!("无法创建更新缓存目录：{error}"))?;
    let staged = directory.join(EXE_ASSET);
    let temporary = directory.join(format!("{EXE_ASSET}.part"));
    let result = (|| -> Result<PathBuf, String> {
        let checksums = http_get(sha_url, &[], CHECKSUMS_MAX_BYTES)?;
        let checksums = String::from_utf8(checksums).map_err(|_| "SHA256SUMS.txt 不是 UTF-8 文件".to_string())?;
        let expected = expected_sha256(&checksums, EXE_ASSET)
            .ok_or_else(|| "SHA256SUMS.txt 中没有 mdre.exe 的 SHA-256 记录".to_string())?;
        let bytes = http_get(asset_url, &[], UPDATE_MAX_BYTES)?;
        let actual = sha256_bytes(&bytes)?;
        if !actual.eq_ignore_ascii_case(&expected) {
            return Err(format!("SHA-256 校验失败：期望 {expected}，实际 {actual}，已取消更新"));
        }
        std::fs::write(&temporary, &bytes).map_err(|error| format!("写入更新文件失败：{error}"))?;
        std::fs::rename(&temporary, &staged).map_err(|error| {
            let _ = std::fs::remove_file(&temporary);
            format!("保存更新文件失败：{error}")
        })?;
        install_update(&staged)
    })();
    let installed = match result {
        Ok(path) => path,
        Err(error) => {
            let _ = std::fs::remove_file(&temporary);
            let _ = std::fs::remove_file(&staged);
            let _ = std::fs::remove_dir(&directory);
            return Err(error);
        }
    };
    let _ = std::fs::remove_file(&staged);
    let _ = std::fs::remove_dir(&directory);
    Ok(StagedUpdate { version: segment, path: installed.to_string_lossy().into_owned() })
}

#[tauri::command]
pub async fn check_latest_release(app: tauri::AppHandle) -> Result<UpdateCheck, String> {
    tauri::async_runtime::spawn_blocking(move || check_latest_release_blocking(&app))
        .await
        .map_err(|error| format!("检查更新任务异常：{error}"))?
}

#[tauri::command]
pub async fn download_update(
    app: tauri::AppHandle,
    asset_url: String,
    sha_url: String,
    version: String,
) -> Result<StagedUpdate, String> {
    tauri::async_runtime::spawn_blocking(move || download_update_blocking(&app, &asset_url, &sha_url, &version))
        .await
        .map_err(|error| format!("下载更新任务异常：{error}"))?
}

// 单实例插件会把新进程的参数转交给旧进程再退出，因此不能直接 spawn 当前 EXE：
// 交给 cmd 延迟启动，让当前进程先退出并释放单实例，再由新进程接管。
// timeout 在无控制台环境可能立即失败，所以补一次 ping 保证至少约 1 秒延迟。
#[tauri::command]
pub fn restart_after_update(app: tauri::AppHandle) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let exe = std::env::current_exe().map_err(|error| format!("无法确定当前程序路径：{error}"))?;
    let command = format!(
        "timeout /t 1 /nobreak >nul & ping -n 2 127.0.0.1 >nul & start \"\" \"{}\"",
        exe.display()
    );
    std::process::Command::new("cmd")
        .arg("/C")
        .raw_arg(command)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|error| format!("无法启动新版本程序：{error}"))?;
    app.exit(0);
    Ok(())
}

// 启动时清理上次替换留下的 `.exe.old`；被占用等情况静默忽略，下次启动再试。
fn cleanup_old_files(directory: &Path) {
    let Ok(entries) = std::fs::read_dir(directory) else { return; };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() { continue; }
        let name = path.file_name().map(|item| item.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
        if name.ends_with(".exe.old") { let _ = std::fs::remove_file(&path); }
    }
}

#[tauri::command]
pub fn cleanup_stale_update() -> Result<(), String> {
    let Ok(exe) = std::env::current_exe() else { return Ok(()); };
    if let Some(directory) = exe.parent() { cleanup_old_files(directory); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_compare_handles_prefix_and_prerelease() {
        assert_eq!(compare_versions("v0.3.0", "0.2.7"), Some(Ordering::Greater));
        assert_eq!(compare_versions("0.2.7", "v0.2.7"), Some(Ordering::Equal));
        assert_eq!(compare_versions("0.2.10", "0.2.9"), Some(Ordering::Greater));
        assert_eq!(compare_versions("1.0.0", "0.99.99"), Some(Ordering::Greater));
        assert_eq!(compare_versions("0.2.7", "0.2.7-beta"), Some(Ordering::Greater));
        assert_eq!(compare_versions("0.2.7-beta.2", "0.2.7-beta.1"), Some(Ordering::Greater));
        assert_eq!(compare_versions("0.2.7-beta.10", "0.2.7-beta.2"), Some(Ordering::Greater));
        assert_eq!(compare_versions("0.2.7-alpha", "0.2.7-beta"), Some(Ordering::Less));
        assert_eq!(compare_versions("0.2.7-1", "0.2.7-alpha"), Some(Ordering::Less));
        assert_eq!(compare_versions("0.2.7+build.9", "0.2.7"), Some(Ordering::Equal));
        assert_eq!(compare_versions("V0.2.8", "0.2.8"), Some(Ordering::Equal));
        assert_eq!(compare_versions("0.2", "0.2.0"), None);
        assert_eq!(compare_versions("0.2.7.1", "0.2.7"), None);
        assert_eq!(compare_versions("", "0.2.7"), None);
    }

    #[test]
    fn version_segment_rejects_path_traversal() {
        assert_eq!(version_segment("v0.3.0").unwrap(), "0.3.0");
        assert_eq!(version_segment(" 0.3.0 ").unwrap(), "0.3.0");
        assert_eq!(version_segment("0.3.0-beta.1").unwrap(), "0.3.0-beta.1");
        assert!(version_segment("..").is_err());
        assert!(version_segment("0.3.0/../evil").is_err());
        assert!(version_segment("0.3.0\\evil").is_err());
        assert!(version_segment("").is_err());
    }

    #[test]
    fn checksums_parse_common_formats() {
        let text = "# 注释\r\n\
            BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD  mdre.exe\r\n\
            0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef *mdre-vscode-0.3.0.vsix\r\n\
            短行  mdre.exe\r\n";
        let records = parse_checksums(text);
        assert_eq!(records.len(), 2);
        assert_eq!(expected_sha256(text, "MDRE.EXE").unwrap(), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(expected_sha256(text, "mdre-vscode-0.3.0.vsix").unwrap(), "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
        assert!(expected_sha256(text, "other.exe").is_none());
        // 文件名带子目录时按最后一段匹配。
        let nested = format!("{}  dist/mdre.exe\n", "a".repeat(64));
        assert_eq!(expected_sha256(&nested, "mdre.exe").unwrap(), "a".repeat(64));
    }

    #[test]
    fn sha256_known_vector() {
        let digest = sha256_bytes(b"abc").expect("SHA-256 应可用");
        assert_eq!(digest, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(
            sha256_bytes(b"").expect("SHA-256 应可用"),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn release_json_parse_and_compare() {
        let json = r#"{
            "tag_name": "v0.3.0",
            "body": "更新说明",
            "html_url": "https://github.com/LaizhuangJi0601/MDRE/releases/tag/v0.3.0",
            "published_at": "2026-01-01T00:00:00Z",
            "assets": [
                {"name": "mdre.exe", "size": 12345, "browser_download_url": "https://github.com/LaizhuangJi0601/MDRE/releases/download/v0.3.0/mdre.exe"},
                {"name": "SHA256SUMS.txt", "size": 80, "browser_download_url": "https://github.com/LaizhuangJi0601/MDRE/releases/download/v0.3.0/SHA256SUMS.txt"}
            ]
        }"#;
        let check = parse_release(json, "0.2.7").expect("发布信息应可解析");
        assert_eq!(check.current_version, "0.2.7");
        assert_eq!(check.latest_version, "0.3.0");
        assert_eq!(check.tag, "v0.3.0");
        assert_eq!(check.notes, "更新说明");
        assert_eq!(check.asset_size, 12345);
        assert!(check.asset_url.ends_with("/mdre.exe"));
        assert!(check.sha256_url.ends_with("/SHA256SUMS.txt"));
        assert!(check.update_available);

        let current = parse_release(json, "0.3.0").expect("同版本应可解析");
        assert!(!current.update_available);

        // 缺少资产时仍返回信息，由前端回退到打开发布页。
        let bare = r#"{"tag_name":"v0.3.0","html_url":"https://github.com/LaizhuangJi0601/MDRE/releases/tag/v0.3.0"}"#;
        let bare = parse_release(bare, "0.2.7").expect("缺少资产也应可解析");
        assert!(bare.asset_url.is_empty());
        assert!(bare.sha256_url.is_empty());
        assert!(bare.update_available);
        assert_eq!(bare.published_at, "");
    }

    #[test]
    fn download_urls_require_https() {
        assert!(validate_download_url("https://github.com/a/mdre.exe").is_ok());
        assert!(validate_download_url("http://github.com/a/mdre.exe").is_err());
        assert!(validate_download_url("file:///C:/mdre.exe").is_err());
        assert!(validate_download_url("https://user:pass@github.com/a/mdre.exe").is_err());
        assert!(validate_download_url("not a url").is_err());
    }

    // 临时目录独立于工程目录，测试结束自动删除。
    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir().join(format!("mdre-updater-{}-{tag}", std::process::id()));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).expect("应能创建临时目录");
            Self(path)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
    }

    #[test]
    fn executable_replacement_swaps_and_keeps_old() {
        let root = TempDir::new("replace");
        let exe = root.0.join("MDRE.exe");
        let staged = root.0.join("staged").join("mdre.exe");
        std::fs::create_dir_all(staged.parent().unwrap()).unwrap();
        std::fs::write(&exe, b"old").unwrap();
        std::fs::write(&staged, b"new").unwrap();
        replace_executable(&exe, &staged).expect("替换应成功");
        assert_eq!(std::fs::read(&exe).unwrap(), b"new");
        assert_eq!(std::fs::read(root.0.join("MDRE.exe.old")).unwrap(), b"old");
        assert!(!root.0.join("MDRE.exe.new").exists());
        // 第二次替换先清理上一次的 .old。
        std::fs::write(&staged, b"newer").unwrap();
        replace_executable(&exe, &staged).expect("再次替换应成功");
        assert_eq!(std::fs::read(&exe).unwrap(), b"newer");
        assert_eq!(std::fs::read(root.0.join("MDRE.exe.old")).unwrap(), b"new");
    }

    #[test]
    fn executable_replacement_keeps_original_on_failure() {
        let root = TempDir::new("missing");
        let exe = root.0.join("MDRE.exe");
        std::fs::write(&exe, b"old").unwrap();
        let error = replace_executable(&exe, &root.0.join("nope").join("mdre.exe")).unwrap_err();
        assert!(error.contains("程序目录"), "错误应可读：{error}");
        assert_eq!(std::fs::read(&exe).unwrap(), b"old");
        assert!(!root.0.join("MDRE.exe.old").exists());
        assert!(!root.0.join("MDRE.exe.new").exists());
    }

    #[test]
    fn cleanup_removes_only_old_executables() {
        let root = TempDir::new("cleanup");
        let old_executable = root.0.join("MDRE.exe.old");
        let untouched = root.0.join("notes.txt");
        let nested = root.0.join("sub");
        std::fs::write(&old_executable, b"old").unwrap();
        std::fs::write(&untouched, b"keep").unwrap();
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("MDRE.exe.old"), b"keep").unwrap();
        cleanup_old_files(&root.0);
        assert!(!old_executable.exists(), "应删除旧 EXE 备份");
        assert!(untouched.exists(), "不应删除其他文件");
        assert!(nested.join("MDRE.exe.old").exists(), "不应递归删除子目录");
    }

    // 手工联网验证（cargo test live_github -- --ignored --nocapture）：覆盖 WinHTTP、重定向、SHA-256 全链路。
    #[test]
    #[ignore = "需要联网，手工运行以验证 GitHub 检查与下载校验"]
    fn live_github_release_check_and_download() {
        let body = http_get(
            RELEASES_API,
            &[("Accept", "application/vnd.github+json"), ("X-GitHub-Api-Version", "2022-11-28")],
            API_MAX_BYTES,
        ).expect("GitHub API 应可访问");
        let check = parse_release(&String::from_utf8(body).unwrap(), "0.2.7").expect("发布信息应可解析");
        println!("latest={} tag={} available={} size={}", check.latest_version, check.tag, check.update_available, check.asset_size);
        assert!(!check.asset_url.is_empty(), "应包含 mdre.exe 资产");
        assert!(!check.sha256_url.is_empty(), "应包含 SHA256SUMS.txt 资产");
        let checksums = http_get(&check.sha256_url, &[], CHECKSUMS_MAX_BYTES).expect("SHA256SUMS.txt 应可下载");
        let expected = expected_sha256(std::str::from_utf8(&checksums).unwrap(), EXE_ASSET).expect("应有 mdre.exe 校验值");
        let asset = http_get(&check.asset_url, &[], UPDATE_MAX_BYTES).expect("mdre.exe 应可通过重定向下载");
        assert_eq!(asset.len() as u64, check.asset_size, "下载大小应与资产列表一致");
        assert_eq!(sha256_bytes(&asset).unwrap(), expected, "下载文件的 SHA-256 应与 SHA256SUMS.txt 一致");
    }
}
