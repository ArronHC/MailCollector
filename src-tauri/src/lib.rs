mod secret_store;

use rand::{rngs::OsRng, RngCore};
use rusqlite::{backup::Backup, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const LEGACY_ROOT: &str = r"D:\OpenSpace\MailCollector";
const CREATE_NO_WINDOW: u32 = 0x08000000;
const SECRET_STORAGE_DPAPI: &str = "windows-dpapi-v1";

fn standard_windows_path(path: PathBuf) -> PathBuf {
    let value = path.to_string_lossy();
    PathBuf::from(value.strip_prefix(r"\\?\").unwrap_or(&value))
}

#[derive(Clone)]
struct RuntimeSettings {
    encryption_key: String,
    api_key: String,
    invite_code: String,
    allow_private_mail_hosts: String,
    sync_interval_minutes: String,
    initial_sync_limit: String,
    max_message_bytes: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredRuntimeSettings {
    secret_storage: String,
    encryption_key: String,
    api_key: String,
    invite_code: String,
    allow_private_mail_hosts: String,
    sync_interval_minutes: String,
    initial_sync_limit: String,
    max_message_bytes: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyRuntimeSettings {
    encryption_key: String,
    api_key: String,
    invite_code: String,
    allow_private_mail_hosts: String,
    sync_interval_minutes: String,
    initial_sync_limit: String,
    max_message_bytes: String,
}

struct SidecarProcess {
    child: Child,
    port: u16,
    shutdown_token: String,
}

fn random_hex(bytes: usize) -> String {
    let mut value = vec![0_u8; bytes];
    OsRng.fill_bytes(&mut value);
    value.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn read_environment(path: &Path) -> HashMap<String, String> {
    let Ok(content) = fs::read_to_string(path) else {
        return HashMap::new();
    };
    content
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            let (name, value) = line.split_once('=')?;
            Some((name.trim().to_string(), value.trim().to_string()))
        })
        .collect()
}

fn store_runtime_settings(path: &Path, settings: &RuntimeSettings) -> Result<(), String> {
    let stored = StoredRuntimeSettings {
        secret_storage: SECRET_STORAGE_DPAPI.to_string(),
        encryption_key: secret_store::protect(&settings.encryption_key)?,
        api_key: secret_store::protect(&settings.api_key)?,
        invite_code: secret_store::protect(&settings.invite_code)?,
        allow_private_mail_hosts: settings.allow_private_mail_hosts.clone(),
        sync_interval_minutes: settings.sync_interval_minutes.clone(),
        initial_sync_limit: settings.initial_sync_limit.clone(),
        max_message_bytes: settings.max_message_bytes.clone(),
    };
    let content = serde_json::to_string_pretty(&stored).map_err(|error| error.to_string())?;
    fs::write(path, format!("{content}\n")).map_err(|error| error.to_string())?;
    Ok(())
}

fn load_stored_runtime_settings(content: &str) -> Result<Option<RuntimeSettings>, String> {
    let Ok(stored) = serde_json::from_str::<StoredRuntimeSettings>(content) else {
        return Ok(None);
    };
    if stored.secret_storage != SECRET_STORAGE_DPAPI {
        return Err(format!("不支持的桌面密钥存储格式：{}", stored.secret_storage));
    }
    Ok(Some(RuntimeSettings {
        encryption_key: secret_store::unprotect(&stored.encryption_key)?,
        api_key: secret_store::unprotect(&stored.api_key)?,
        invite_code: secret_store::unprotect(&stored.invite_code)?,
        allow_private_mail_hosts: stored.allow_private_mail_hosts,
        sync_interval_minutes: stored.sync_interval_minutes,
        initial_sync_limit: stored.initial_sync_limit,
        max_message_bytes: stored.max_message_bytes,
    }))
}

fn runtime_settings(app_data: &Path) -> Result<RuntimeSettings, String> {
    let settings_path = app_data.join("runtime-settings.json");
    if settings_path.exists() {
        let content = fs::read_to_string(&settings_path).map_err(|error| error.to_string())?;
        if let Some(settings) = load_stored_runtime_settings(&content)? {
            return Ok(settings);
        }

        let legacy: LegacyRuntimeSettings =
            serde_json::from_str(&content).map_err(|error| error.to_string())?;
        let settings = RuntimeSettings {
            encryption_key: legacy.encryption_key,
            api_key: legacy.api_key,
            invite_code: legacy.invite_code,
            allow_private_mail_hosts: legacy.allow_private_mail_hosts,
            sync_interval_minutes: legacy.sync_interval_minutes,
            initial_sync_limit: legacy.initial_sync_limit,
            max_message_bytes: legacy.max_message_bytes,
        };
        store_runtime_settings(&settings_path, &settings)?;
        return Ok(settings);
    }

    let legacy = read_environment(&Path::new(LEGACY_ROOT).join(".env"));
    let encryption_key = legacy.get("ENCRYPTION_KEY").cloned().unwrap_or_default();
    let settings = RuntimeSettings {
        encryption_key: if encryption_key.len() == 64 {
            encryption_key
        } else {
            random_hex(32)
        },
        api_key: legacy
            .get("API_KEY")
            .filter(|value| value.len() >= 24)
            .cloned()
            .unwrap_or_else(|| random_hex(32)),
        invite_code: legacy
            .get("REGISTRATION_INVITE_CODE")
            .filter(|value| value.len() >= 12)
            .cloned()
            .unwrap_or_else(|| random_hex(8)),
        allow_private_mail_hosts: legacy
            .get("ALLOW_PRIVATE_MAIL_HOSTS")
            .cloned()
            .unwrap_or_else(|| "false".to_string()),
        sync_interval_minutes: legacy
            .get("SYNC_INTERVAL_MINUTES")
            .cloned()
            .unwrap_or_else(|| "5".to_string()),
        initial_sync_limit: legacy
            .get("INITIAL_SYNC_LIMIT")
            .cloned()
            .unwrap_or_else(|| "100".to_string()),
        max_message_bytes: legacy
            .get("MAX_MESSAGE_BYTES")
            .cloned()
            .unwrap_or_else(|| "10485760".to_string()),
    };
    store_runtime_settings(&settings_path, &settings)?;
    Ok(settings)
}

fn migrate_database(app_data: &Path, settings: &RuntimeSettings) -> Result<PathBuf, String> {
    let target_path = app_data.join("mail-collector.db");
    if target_path.exists() {
        return Ok(target_path);
    }
    let source_path = Path::new(LEGACY_ROOT)
        .join("data")
        .join("mail-collector.db");
    if !source_path.exists() {
        return Ok(target_path);
    }
    let legacy = read_environment(&Path::new(LEGACY_ROOT).join(".env"));
    if legacy.get("ENCRYPTION_KEY") != Some(&settings.encryption_key) {
        return Err("旧数据库的加密密钥不匹配，已停止迁移以保护邮箱凭据".to_string());
    }

    let source = Connection::open_with_flags(&source_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| error.to_string())?;
    let mut target = Connection::open(&target_path).map_err(|error| error.to_string())?;
    let backup = Backup::new(&source, &mut target).map_err(|error| error.to_string())?;
    backup
        .run_to_completion(32, Duration::from_millis(20), None)
        .map_err(|error| error.to_string())?;
    Ok(target_path)
}

fn available_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| error.to_string())?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| error.to_string())
}

fn wait_for_server(port: u16, child: &mut Child) -> Result<(), String> {
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(15) {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            return Err(format!("本地邮件服务提前退出：{status}"));
        }
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err("本地邮件服务启动超时".to_string())
}

fn start_sidecar(
    resource_dir: &Path,
    app_data: &Path,
    database_path: &Path,
    settings: &RuntimeSettings,
) -> Result<SidecarProcess, String> {
    let bundled_runtime = resource_dir.join("resources").join("runtime");
    let runtime_dir = if bundled_runtime.exists() {
        bundled_runtime
    } else {
        resource_dir.join("runtime")
    };
    let node_path = runtime_dir.join("node.exe");
    let server_path = runtime_dir.join("dist").join("server.js");
    if !node_path.exists() || !server_path.exists() {
        return Err("桌面运行时不完整，请重新安装 Mail Collector".to_string());
    }

    let port = available_port()?;
    let shutdown_token = random_hex(32);
    let stdout = OpenOptions::new()
        .create(true)
        .append(true)
        .open(app_data.join("mail-collector.out.log"))
        .map_err(|error| error.to_string())?;
    let stderr = OpenOptions::new()
        .create(true)
        .append(true)
        .open(app_data.join("mail-collector.err.log"))
        .map_err(|error| error.to_string())?;
    let mut command = Command::new(node_path);
    command
        .arg(server_path)
        .current_dir(&runtime_dir)
        .env("PORT", port.to_string())
        .env("HOST", "127.0.0.1")
        .env("DATABASE_PATH", database_path)
        .env("ENCRYPTION_KEY", &settings.encryption_key)
        .env("API_KEY", &settings.api_key)
        .env("MAIL_COLLECTOR_VERSION", env!("CARGO_PKG_VERSION"))
        .env("REGISTRATION_INVITE_CODE", &settings.invite_code)
        .env(
            "ALLOW_PRIVATE_MAIL_HOSTS",
            &settings.allow_private_mail_hosts,
        )
        .env("SYNC_INTERVAL_MINUTES", &settings.sync_interval_minutes)
        .env("INITIAL_SYNC_LIMIT", &settings.initial_sync_limit)
        .env("MAX_MESSAGE_BYTES", &settings.max_message_bytes)
        .env("DESKTOP_SHUTDOWN_TOKEN", &shutdown_token)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    wait_for_server(port, &mut child)?;
    Ok(SidecarProcess {
        child,
        port,
        shutdown_token,
    })
}

fn stop_sidecar(sidecar: &mut SidecarProcess) {
    if let Ok(mut stream) = TcpStream::connect(("127.0.0.1", sidecar.port)) {
        let request = format!(
            "POST /api/desktop/shutdown HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nX-Desktop-Shutdown-Token: {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            sidecar.port, sidecar.shutdown_token
        );
        let _ = stream.write_all(request.as_bytes());
        let mut response = [0_u8; 128];
        let _ = stream.read(&mut response);
    }
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(5) {
        if matches!(sidecar.child.try_wait(), Ok(Some(_))) {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
    let _ = sidecar.child.kill();
    let _ = sidecar.child.wait();
}

pub fn run() {
    let sidecar_state = Arc::new(Mutex::new(None::<SidecarProcess>));
    let setup_state = Arc::clone(&sidecar_state);
    let window_state = Arc::clone(&sidecar_state);
    let exit_state = Arc::clone(&sidecar_state);

    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![])
        .setup(move |app| {
            let app_data = app
                .path()
                .app_data_dir()
                .map_err(|error| error.to_string())?;
            fs::create_dir_all(&app_data)?;
            let settings = runtime_settings(&app_data)?;
            let database_path = migrate_database(&app_data, &settings)?;
            let resource_dir = standard_windows_path(
                app.path()
                    .resource_dir()
                    .map_err(|error| error.to_string())?,
            );
            let sidecar = start_sidecar(&resource_dir, &app_data, &database_path, &settings)?;
            let url = format!("http://127.0.0.1:{}", sidecar.port)
                .parse()
                .map_err(|error| format!("无效的本地地址：{error}"))?;
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Mail Collector")
                .inner_size(1440.0, 920.0)
                .min_inner_size(980.0, 680.0)
                .decorations(false)
                .build()?;
            *setup_state.lock().map_err(|_| "无法保存本地服务状态")? = Some(sidecar);
            Ok(())
        })
        .on_window_event(move |window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                if let Ok(mut state) = window_state.lock() {
                    if let Some(sidecar) = state.as_mut() {
                        stop_sidecar(sidecar);
                    }
                    *state = None;
                }
                window.app_handle().exit(0);
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Mail Collector");

    app.run(move |_app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            if let Ok(mut state) = exit_state.lock() {
                if let Some(sidecar) = state.as_mut() {
                    stop_sidecar(sidecar);
                }
                *state = None;
            }
        }
    });
}
