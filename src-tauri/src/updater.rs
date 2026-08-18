use std::{fs, path::PathBuf, process::Command};
use tauri::{AppHandle, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn valid_release_version(version: &str) -> bool {
    if version.is_empty() || version.len() > 32 {
        return false;
    }
    let parts = version.split('.').collect::<Vec<_>>();
    parts.len() == 3
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.bytes().all(|byte| byte.is_ascii_digit())
                && part.parse::<u32>().is_ok()
        })
}

#[cfg(windows)]
fn download_verified_installer(
    installer_path: PathBuf,
    checksum_path: PathBuf,
    installer_url: String,
    checksum_url: String,
) -> Result<PathBuf, String> {
    let temp_path = PathBuf::from(format!("{}.download", installer_path.to_string_lossy()));
    let script = r#"
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$installer = $env:MC_INSTALLER_PATH
$checksum = $env:MC_CHECKSUM_PATH
$temp = $env:MC_TEMP_PATH
Invoke-WebRequest -UseBasicParsing -Uri $env:MC_CHECKSUM_URL -OutFile $checksum
$checksumText = Get-Content -Raw -LiteralPath $checksum
$expected = ([regex]::Match($checksumText, '(?i)\b[a-f0-9]{64}\b')).Value.ToLowerInvariant()
if ($expected.Length -ne 64) { throw 'Release checksum file is invalid.' }
Invoke-WebRequest -UseBasicParsing -Uri $env:MC_INSTALLER_URL -OutFile $temp
$actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $temp).Hash.ToLowerInvariant()
if ($actual -ne $expected) {
  Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $temp
  throw 'Downloaded installer checksum does not match the release checksum.'
}
Move-Item -Force -LiteralPath $temp -Destination $installer
"#;

    let mut command = Command::new("powershell.exe");
    command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .env("MC_INSTALLER_PATH", &installer_path)
        .env("MC_CHECKSUM_PATH", &checksum_path)
        .env("MC_TEMP_PATH", &temp_path)
        .env("MC_INSTALLER_URL", installer_url)
        .env("MC_CHECKSUM_URL", checksum_url)
        .creation_flags(CREATE_NO_WINDOW);
    let status = command.status().map_err(|error| error.to_string())?;
    if !status.success() {
        return Err("下载或校验更新安装包失败，请稍后重试".to_string());
    }
    if !installer_path.exists() {
        return Err("更新安装包下载完成后未找到文件".to_string());
    }
    Ok(installer_path)
}

#[tauri::command]
pub async fn install_update(app: AppHandle, version: String) -> Result<(), String> {
    if !valid_release_version(&version) {
        return Err("更新版本号无效".to_string());
    }

    #[cfg(windows)]
    {
        let app_data = app.path().app_data_dir().map_err(|error| error.to_string())?;
        let updates_dir = app_data.join("updates");
        fs::create_dir_all(&updates_dir).map_err(|error| error.to_string())?;

        let installer_name = format!("Mail.Collector_{version}_x64-setup.exe");
        let installer_path = updates_dir.join(&installer_name);
        let checksum_path = updates_dir.join(format!("{installer_name}.sha256"));
        let base_url = format!(
            "https://github.com/ArronHC/MailCollector/releases/download/v{version}"
        );
        let installer_url = format!("{base_url}/{installer_name}");
        let checksum_url = format!("{installer_url}.sha256");

        let installer = tauri::async_runtime::spawn_blocking(move || {
            download_verified_installer(
                installer_path,
                checksum_path,
                installer_url,
                checksum_url,
            )
        })
        .await
        .map_err(|error| error.to_string())??;

        let launch_script = "Start-Sleep -Seconds 2; Start-Process -FilePath $env:MC_INSTALLER_PATH";
        let mut launcher = Command::new("powershell.exe");
        launcher
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-WindowStyle",
                "Hidden",
                "-Command",
                launch_script,
            ])
            .env("MC_INSTALLER_PATH", &installer)
            .creation_flags(CREATE_NO_WINDOW);
        launcher.spawn().map_err(|error| error.to_string())?;
        app.exit(0);
        return Ok(());
    }

    #[cfg(not(windows))]
    {
        let _ = app;
        Err("当前仅支持在 Windows 桌面客户端内自动安装更新".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::valid_release_version;

    #[test]
    fn validates_release_versions() {
        assert!(valid_release_version("0.9.0"));
        assert!(valid_release_version("10.12.3"));
        assert!(!valid_release_version("v0.9.0"));
        assert!(!valid_release_version("0.9"));
        assert!(!valid_release_version("0.9.0;calc"));
    }
}
