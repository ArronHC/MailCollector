mod updater;

use std::process::Command;
use updater::install_update;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn allowed_oauth_url(url: &str) -> bool {
    url.starts_with("https://accounts.google.com/")
        || url.starts_with("https://login.microsoftonline.com/")
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    if !allowed_oauth_url(&url) {
        return Err("只允许打开受信任的 OAuth 登录地址".to_string());
    }

    #[cfg(windows)]
    {
        let mut command = Command::new("explorer.exe");
        command.arg(&url).creation_flags(CREATE_NO_WINDOW);
        command.spawn().map_err(|error| error.to_string())?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|error| error.to_string())?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|error| error.to_string())?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    Err("当前平台不支持打开外部浏览器".to_string())
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![open_external_url, install_update])
        .run(tauri::generate_context!())
        .expect("error while running Mail Collector");
}
