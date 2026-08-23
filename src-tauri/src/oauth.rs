use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::{rngs::OsRng, RngCore};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use url::Url;

const OAUTH_TIMEOUT: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopOAuthCredential {
    version: u8,
    provider: String,
    email: String,
    display_name: String,
    client_id: String,
    access_token: String,
    refresh_token: String,
    expires_at: u64,
    scope: String,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
    scope: Option<String>,
    id_token: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

struct OAuthProviderConfig {
    authorization_endpoint: &'static str,
    token_endpoint: &'static str,
    scopes: &'static [&'static str],
    redirect_host: &'static str,
}

fn provider_config(provider: &str) -> Result<OAuthProviderConfig, String> {
    match provider {
        "google" => Ok(OAuthProviderConfig {
            authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
            token_endpoint: "https://oauth2.googleapis.com/token",
            scopes: &["openid", "email", "profile", "https://mail.google.com/"],
            redirect_host: "127.0.0.1",
        }),
        "microsoft" => Ok(OAuthProviderConfig {
            authorization_endpoint:
                "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
            token_endpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
            scopes: &[
                "openid",
                "profile",
                "email",
                "offline_access",
                "https://outlook.office.com/IMAP.AccessAsUser.All",
                "https://outlook.office.com/SMTP.Send",
            ],
            redirect_host: "localhost",
        }),
        _ => Err("不支持的 OAuth 邮箱服务商".to_string()),
    }
}

fn random_base64_url(bytes: usize) -> String {
    let mut value = vec![0_u8; bytes];
    OsRng.fill_bytes(&mut value);
    URL_SAFE_NO_PAD.encode(value)
}

fn validate_client_id(value: String) -> Result<String, String> {
    let client_id = value.trim().to_string();
    if client_id.len() < 3 || client_id.len() > 512 || client_id.chars().any(char::is_whitespace) {
        return Err("OAuth Client ID 格式不正确".to_string());
    }
    Ok(client_id)
}

fn callback_response(stream: &mut TcpStream, success: bool) {
    let (title, message, color) = if success {
        (
            "授权已完成",
            "可以关闭此页面并返回 Mail Collector。",
            "#176b57",
        )
    } else {
        (
            "授权未完成",
            "请关闭此页面并返回 Mail Collector 重试。",
            "#b42318",
        )
    };
    let body = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>Mail Collector</title><style>body{{font-family:system-ui;margin:48px;line-height:1.6;color:#1f2937}}main{{max-width:560px;margin:auto}}h1{{font-size:24px;color:{color}}}</style><main><h1>{title}</h1><p>{message}</p></main>"
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

fn read_callback_request(stream: &mut TcpStream) -> Result<String, String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|error| error.to_string())?;
    let mut request = Vec::with_capacity(2048);
    let mut buffer = [0_u8; 2048];
    loop {
        let count = stream
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        request.extend_from_slice(&buffer[..count]);
        if request.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
        if request.len() > 16 * 1024 {
            return Err("OAuth 回调请求过大".to_string());
        }
    }
    let request = String::from_utf8(request).map_err(|_| "OAuth 回调格式不正确".to_string())?;
    let target = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .ok_or_else(|| "OAuth 回调请求不完整".to_string())?;
    Ok(target.to_string())
}

fn wait_for_callback(listener: TcpListener, expected_state: String) -> Result<String, String> {
    listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    let deadline = Instant::now() + OAUTH_TIMEOUT;
    loop {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let target = read_callback_request(&mut stream)?;
                let callback = Url::parse(&format!("http://localhost{target}"))
                    .map_err(|_| "OAuth 回调地址格式不正确".to_string())?;
                let state = callback
                    .query_pairs()
                    .find(|(name, _)| name == "state")
                    .map(|(_, value)| value.into_owned())
                    .unwrap_or_default();
                if state != expected_state {
                    callback_response(&mut stream, false);
                    return Err("OAuth state 校验失败，请重新授权".to_string());
                }
                if let Some(error) = callback
                    .query_pairs()
                    .find(|(name, _)| name == "error_description" || name == "error")
                    .map(|(_, value)| value.into_owned())
                {
                    callback_response(&mut stream, false);
                    return Err(format!("授权未完成：{error}"));
                }
                let code = callback
                    .query_pairs()
                    .find(|(name, _)| name == "code")
                    .map(|(_, value)| value.into_owned())
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| "授权服务器没有返回授权码".to_string())?;
                callback_response(&mut stream, true);
                return Ok(code);
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err("OAuth 授权等待超时，请重新尝试".to_string());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(error) => return Err(format!("OAuth 本地回调监听失败：{error}")),
        }
    }
}

fn jwt_payload(token: &str) -> Result<Value, String> {
    let payload = token
        .split('.')
        .nth(1)
        .ok_or_else(|| "OAuth 身份令牌格式不正确".to_string())?;
    let decoded = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| "OAuth 身份令牌无法解析".to_string())?;
    serde_json::from_slice(&decoded).map_err(|_| "OAuth 身份令牌无法解析".to_string())
}

fn claim<'a>(payload: &'a Value, names: &[&str]) -> &'a str {
    for name in names {
        if let Some(value) = payload.get(name).and_then(Value::as_str) {
            if !value.trim().is_empty() {
                return value.trim();
            }
        }
    }
    ""
}

fn audience_matches(payload: &Value, client_id: &str) -> bool {
    match payload.get("aud") {
        Some(Value::String(value)) => value == client_id,
        Some(Value::Array(values)) => values.iter().any(|value| value.as_str() == Some(client_id)),
        _ => false,
    }
}

async fn exchange_code(
    provider: &str,
    config: &OAuthProviderConfig,
    client_id: &str,
    redirect_uri: &str,
    verifier: &str,
    nonce: &str,
    code: &str,
) -> Result<DesktopOAuthCredential, String> {
    let scope = config.scopes.join(" ");
    let mut form = vec![
        ("client_id", client_id.to_string()),
        ("code", code.to_string()),
        ("code_verifier", verifier.to_string()),
        ("redirect_uri", redirect_uri.to_string()),
        ("grant_type", "authorization_code".to_string()),
    ];
    if provider == "microsoft" {
        form.push(("scope", scope.clone()));
    }
    let response = Client::new()
        .post(config.token_endpoint)
        .timeout(Duration::from_secs(20))
        .form(&form)
        .send()
        .await
        .map_err(|error| format!("OAuth 服务连接失败：{error}"))?;
    let status = response.status();
    let token: TokenResponse = response
        .json()
        .await
        .map_err(|_| "OAuth token 响应格式不正确".to_string())?;
    if !status.is_success() || token.error.is_some() {
        let message = token
            .error_description
            .or(token.error)
            .unwrap_or_else(|| format!("HTTP {status}"));
        return Err(format!("OAuth token 请求失败：{message}"));
    }
    let access_token = token
        .access_token
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "授权服务器没有返回 access token".to_string())?;
    let refresh_token = token
        .refresh_token
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "授权服务器没有返回 refresh token，请撤销旧授权后重试".to_string())?;
    let id_token = token
        .id_token
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "授权服务器没有返回身份令牌".to_string())?;
    let payload = jwt_payload(&id_token)?;
    if !audience_matches(&payload, client_id) {
        return Err("OAuth 身份令牌的客户端不匹配".to_string());
    }
    if claim(&payload, &["nonce"]) != nonce {
        return Err("OAuth 身份令牌 nonce 校验失败".to_string());
    }
    let issuer = claim(&payload, &["iss"]);
    if provider == "google"
        && issuer != "https://accounts.google.com"
        && issuer != "accounts.google.com"
    {
        return Err("Google OAuth 身份令牌签发方不正确".to_string());
    }
    if provider == "microsoft" && !issuer.starts_with("https://login.microsoftonline.com/") {
        return Err("Microsoft OAuth 身份令牌签发方不正确".to_string());
    }
    let email = claim(&payload, &["email", "preferred_username", "upn"]).to_string();
    if !email.contains('@') {
        return Err("无法从 OAuth 授权结果识别邮箱地址".to_string());
    }
    if provider == "google" && payload.get("email_verified") == Some(&Value::Bool(false)) {
        return Err("Google 账户邮箱地址尚未验证".to_string());
    }
    let display_name = {
        let name = claim(&payload, &["name"]);
        if name.is_empty() {
            email.split('@').next().unwrap_or(&email).to_string()
        } else {
            name.to_string()
        }
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "系统时间不正确".to_string())?
        .as_millis() as u64;
    Ok(DesktopOAuthCredential {
        version: 1,
        provider: provider.to_string(),
        email,
        display_name,
        client_id: client_id.to_string(),
        access_token,
        refresh_token,
        expires_at: now + token.expires_in.unwrap_or(3600).max(60) * 1000,
        scope: token.scope.unwrap_or(scope),
    })
}

#[tauri::command]
pub async fn authorize_mail_provider(
    provider: String,
    client_id: String,
) -> Result<DesktopOAuthCredential, String> {
    let config = provider_config(&provider)?;
    let client_id = validate_client_id(client_id)?;
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|error| format!("无法启动 OAuth 本地回调：{error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let redirect_uri = format!("http://{}:{port}", config.redirect_host);
    let state = random_base64_url(32);
    let nonce = random_base64_url(24);
    let verifier = random_base64_url(48);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let mut authorization_url =
        Url::parse(config.authorization_endpoint).map_err(|error| error.to_string())?;
    {
        let mut query = authorization_url.query_pairs_mut();
        query
            .append_pair("client_id", &client_id)
            .append_pair("response_type", "code")
            .append_pair("redirect_uri", &redirect_uri)
            .append_pair("response_mode", "query")
            .append_pair("scope", &config.scopes.join(" "))
            .append_pair("state", &state)
            .append_pair("nonce", &nonce)
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair(
                "prompt",
                if provider == "google" {
                    "consent select_account"
                } else {
                    "select_account"
                },
            );
        if provider == "google" {
            query.append_pair("access_type", "offline");
        }
    }
    crate::open_external_url(authorization_url.to_string())?;
    let callback_state = state.clone();
    let code =
        tauri::async_runtime::spawn_blocking(move || wait_for_callback(listener, callback_state))
            .await
            .map_err(|error| format!("OAuth 本地回调任务失败：{error}"))??;
    exchange_code(
        &provider,
        &config,
        &client_id,
        &redirect_uri,
        &verifier,
        &nonce,
        &code,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_configuration_keeps_native_loopback_redirects() {
        assert_eq!(
            provider_config("google").unwrap().redirect_host,
            "127.0.0.1"
        );
        assert_eq!(
            provider_config("microsoft").unwrap().redirect_host,
            "localhost"
        );
        assert!(provider_config("other").is_err());
    }

    #[test]
    fn client_id_rejects_whitespace_and_empty_values() {
        assert_eq!(
            validate_client_id(" valid-client ".to_string()).unwrap(),
            "valid-client"
        );
        assert!(validate_client_id("".to_string()).is_err());
        assert!(validate_client_id("invalid client".to_string()).is_err());
    }
}
