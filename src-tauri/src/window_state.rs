// v0.2.7 需求 5.2：设置 / 帮助 / 快捷键等独立窗口记住上次显示位置。
// 使用独立的 window-state.json，避开 files.rs 的文档配置结构（由 settings 成员独占写入）。
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const FILE_NAME: &str = "window-state.json";
// 0.2.6 及更早只把设置窗口位置写在 settings-window.json；升级后仍沿用一次。
const LEGACY_SETTINGS_FILE: &str = "settings-window.json";

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Bounds {
    pub fn new(x: i32, y: i32, width: u32, height: u32) -> Self {
        Self { x, y, width, height }
    }

    // 过滤明显损坏或过大的记录，避免用非法尺寸创建窗口。
    pub fn is_valid(&self) -> bool {
        self.width >= 200 && self.height >= 120 && self.width <= 20000 && self.height <= 20000
    }

    fn right(&self) -> i64 {
        self.x as i64 + self.width as i64
    }

    fn bottom(&self) -> i64 {
        self.y as i64 + self.height as i64
    }
}

// 屏幕可见区域，物理像素，与 outer_position / inner_size 的坐标系一致。
#[derive(Clone, Copy, Debug)]
pub struct Screen {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Default, Serialize, Deserialize)]
struct FileState {
    #[serde(default)]
    windows: BTreeMap<String, Bounds>,
}

// 同一进程内多个窗口可能同时关闭；读改写串行化，避免互相覆盖。
static LOCK: Mutex<()> = Mutex::new(());

fn file_of(root: &Path) -> PathBuf {
    root.join(FILE_NAME)
}

fn read_file(root: &Path) -> FileState {
    std::fs::read(file_of(root))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn write_file(root: &Path, state: &FileState) -> Result<(), String> {
    let bytes = serde_json::to_vec(state).map_err(|error| error.to_string())?;
    crate::persistence::atomic_write(&file_of(root), &bytes)
}

/// 读取某个窗口上次的物理位置；记录缺失或损坏时返回 None（由调用方使用默认位置）。
pub fn load(root: &Path, label: &str) -> Option<Bounds> {
    let _guard = LOCK.lock().ok()?;
    if let Some(bounds) = read_file(root).windows.get(label).copied() {
        if bounds.is_valid() {
            return Some(bounds);
        }
    }
    if label == "settings" {
        let bytes = std::fs::read(root.join(LEGACY_SETTINGS_FILE)).ok()?;
        let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
        let bounds = Bounds::new(
            value["x"].as_i64()? as i32,
            value["y"].as_i64()? as i32,
            value["width"].as_u64()? as u32,
            value["height"].as_u64()? as u32,
        );
        if bounds.is_valid() {
            return Some(bounds);
        }
    }
    None
}

/// 记录窗口位置；只接受合法尺寸，写入失败不影响窗口本身。
pub fn store(root: &Path, label: &str, bounds: Bounds) {
    if !bounds.is_valid() {
        return;
    }
    let Ok(_guard) = LOCK.lock() else { return; };
    let mut state = read_file(root);
    state.windows.insert(label.to_owned(), bounds);
    if let Err(error) = write_file(root, &state) {
        eprintln!("MDRE 窗口位置保存失败：{error}");
    }
}

/// 把保存的位置钳制到当前可见屏幕内：换显示器、分辨率或 DPI 变化后不会跑到屏幕外。
pub fn clamp(bounds: Bounds, screens: &[Screen], min_width: u32, min_height: u32) -> Bounds {
    if screens.is_empty() {
        return Bounds {
            width: bounds.width.max(min_width),
            height: bounds.height.max(min_height),
            ..bounds
        };
    }
    let screen = choose_screen(bounds, screens);
    // 不允许超出目标屏幕，同时不小于窗口自身的最小尺寸。
    let width = bounds.width.max(min_width).min(screen.width.max(1));
    let height = bounds.height.max(min_height).min(screen.height.max(1));
    let max_x = screen.x as i64 + screen.width as i64 - width as i64;
    let max_y = screen.y as i64 + screen.height as i64 - height as i64;
    let x = (bounds.x as i64).clamp(screen.x as i64, max_x.max(screen.x as i64)) as i32;
    let y = (bounds.y as i64).clamp(screen.y as i64, max_y.max(screen.y as i64)) as i32;
    Bounds { x, y, width, height }
}

fn choose_screen(bounds: Bounds, screens: &[Screen]) -> Screen {
    let center_x = bounds.x as i64 + bounds.width as i64 / 2;
    let center_y = bounds.y as i64 + bounds.height as i64 / 2;
    if let Some(screen) = screens.iter().find(|screen| {
        center_x > screen.x as i64
            && center_x < screen.x as i64 + screen.width as i64
            && center_y > screen.y as i64
            && center_y < screen.y as i64 + screen.height as i64
    }) {
        return *screen;
    }
    // 中心点不在任何屏幕内（例如从副屏拔掉显示器后）：选重叠面积最大的屏幕。
    screens
        .iter()
        .copied()
        .max_by_key(|screen| overlap_area(bounds, *screen))
        .unwrap_or(screens[0])
}

fn overlap_area(bounds: Bounds, screen: Screen) -> u64 {
    let left = bounds.x.max(screen.x) as i64;
    let top = bounds.y.max(screen.y) as i64;
    let right = bounds.right().min(screen.x as i64 + screen.width as i64);
    let bottom = bounds.bottom().min(screen.y as i64 + screen.height as i64);
    if right <= left || bottom <= top {
        0
    } else {
        ((right - left) * (bottom - top)) as u64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn primary() -> Screen {
        Screen { x: 0, y: 0, width: 1920, height: 1080 }
    }

    #[test]
    fn keeps_window_inside_primary_screen() {
        let bounds = Bounds::new(300, 200, 960, 720);
        assert_eq!(clamp(bounds, &[primary()], 700, 500), bounds);
    }

    #[test]
    fn pulls_offscreen_window_back_into_view() {
        let bounds = Bounds::new(-4000, -3000, 960, 720);
        let clamped = clamp(bounds, &[primary()], 700, 500);
        assert_eq!(clamped, Bounds::new(0, 0, 960, 720));
        let far = clamp(Bounds::new(5000, 4000, 960, 720), &[primary()], 700, 500);
        assert_eq!(far, Bounds::new(960, 360, 960, 720));
    }

    #[test]
    fn keeps_window_on_secondary_monitor() {
        let screens = [primary(), Screen { x: 1920, y: 0, width: 1280, height: 1024 }];
        // 副屏内但右侧超出的窗口会被拉回副屏可见范围。
        let clamped = clamp(Bounds::new(3000, 300, 900, 640), &screens, 560, 420);
        assert_eq!(clamped, Bounds::new(2300, 300, 900, 640));
        let inside = Bounds::new(2000, 200, 900, 640);
        assert_eq!(clamp(inside, &screens, 560, 420), inside);
    }

    #[test]
    fn shrinks_size_larger_than_screen() {
        let clamped = clamp(Bounds::new(0, 0, 9000, 7000), &[primary()], 700, 500);
        assert_eq!(clamped, Bounds::new(0, 0, 1920, 1080));
    }

    #[test]
    fn minimal_size_applies_when_saved_too_small() {
        let clamped = clamp(Bounds::new(100, 100, 100, 100), &[primary()], 700, 500);
        assert_eq!(clamped, Bounds::new(100, 100, 700, 500));
    }

    #[test]
    fn empty_screen_list_still_returns_sane_size() {
        let clamped = clamp(Bounds::new(10, 10, 100, 100), &[], 700, 500);
        assert_eq!(clamped, Bounds::new(10, 10, 700, 500));
    }
}
