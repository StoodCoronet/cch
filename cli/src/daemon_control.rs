//! Shared daemon control for cch and ccd.
//! Provides start/stop/status and the main daemon loop.

use anyhow::{Context, Result};
use crate::config;
use serde_json::json;
use std::process::Command;
use std::time::Duration;
use std::{env, fs};
use tokio::time;

pub fn hostname() -> String {
    Command::new("hostname").output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|_| "unknown".into())
}

pub fn token_cache_path() -> std::path::PathBuf {
    dirs::home_dir().unwrap_or_default().join(".cch").join("token")
}

pub fn pid_file() -> std::path::PathBuf {
    dirs::home_dir().unwrap_or_default().join(".cch").join("daemon.pid")
}

pub fn bootstrap(server: &str, token: &str) -> Result<String> {
    let client = reqwest::blocking::Client::builder().no_proxy().build().expect("reqwest");
    let resp = client.post(format!("{server}/v1/auth/bootstrap"))
        .json(&json!({ "token": token, "hostname": hostname() }))
        .timeout(Duration::from_secs(15)).send()
        .context("cannot reach server — is it running?")?;
    anyhow::ensure!(resp.status().is_success(), "bootstrap returned {} — token may be invalid", resp.status());
    Ok(resp.json::<serde_json::Value>()?["token"].as_str().unwrap().to_string())
}

pub fn get_or_bootstrap_auth(hc: &config::HappyConfig) -> Result<String> {
    match fs::read_to_string(token_cache_path()) {
        Ok(t) if t.starts_with(&hc.server) => Ok(t.split('|').nth(1).unwrap_or("").trim().to_string()),
        _ => {
            let tok = bootstrap(&hc.server, &hc.token)?;
            let _ = fs::create_dir_all(token_cache_path().parent().unwrap());
            let _ = fs::write(token_cache_path(), format!("{}|{}", hc.server, tok));
            Ok(tok)
        }
    }
}

/// Run the daemon loop: heartbeat + JSONL sync.
/// If `interactive` is true, also spawn bridge for bidirectional sync.
/// `session_dir` determines which tracking directory to monitor (cch or ccd isolation).
pub async fn run_daemon(interactive: bool, session_dir: &str) -> Result<()> {
    let hc = config::load_happy_config().context("Not connected. Run 'connect <url>' first.")?;
    let auth_token = get_or_bootstrap_auth(&hc)?;
    let machine = hostname();

    // Initial heartbeat
    let client = reqwest::blocking::Client::builder().no_proxy().build().unwrap();
    let _ = client.post(format!("{}/v1/machines/{machine}/heartbeat", hc.server))
        .header("Authorization", format!("Bearer {auth_token}"))
        .timeout(Duration::from_secs(5)).send();

    println!("daemon: online — {} (interactive={}, dir={})", machine, interactive, session_dir);

    let server = hc.server.clone();
    let auth = auth_token.clone();
    let mach = machine.clone();
    let mut heartbeat_tick = time::interval(Duration::from_secs(30));
    let mut sync_tick = time::interval(Duration::from_millis(500));
    let track_dir = dirs::home_dir().unwrap_or_default().join(session_dir);

    // Spawn bridge if interactive
    if interactive {
        tokio::spawn(async move {
            if let Err(e) = crate::bridge::run_bridge().await {
                eprintln!("bridge error: {e}");
            }
        });
    }

    loop {
        tokio::select! {
            _ = heartbeat_tick.tick() => {
                let srv = server.clone(); let tok = auth.clone(); let mid = mach.clone();
                tokio::task::spawn_blocking(move || {
                    let c = reqwest::blocking::Client::builder().no_proxy().build().unwrap();
                    let _ = c.post(format!("{srv}/v1/machines/{mid}/heartbeat"))
                        .header("Authorization", format!("Bearer {tok}"))
                        .timeout(Duration::from_secs(5)).send();
                }).await.ok();
            }
            _ = sync_tick.tick() => {
                let srv = server.clone(); let tok = auth.clone(); let dir = track_dir.clone();
                tokio::task::spawn_blocking(move || sync_jsonl(&srv, &tok, &dir)).await.ok();
            }
        }
    }
}

/// Extract text content from a Claude Code JSONL message.
/// Handles text blocks, tool_use blocks, and tool_result blocks.
fn extract_message_text(msg: &serde_json::Value) -> String {
    let content = &msg["message"]["content"];
    if let Some(arr) = content.as_array() {
        let mut parts = Vec::new();
        for block in arr {
            let block_type = block["type"].as_str().unwrap_or("");
            match block_type {
                "text" => {
                    if let Some(s) = block["text"].as_str() {
                        parts.push(s.to_string());
                    }
                }
                "tool_use" => {
                    let name = block["name"].as_str().unwrap_or("tool");
                    let input = block["input"].to_string();
                    parts.push(format!("[tool_use: {} {}]", name, input));
                }
                "tool_result" => {
                    let result = block["content"].as_str().unwrap_or("");
                    if !result.is_empty() {
                        parts.push(format!("[tool_result: {}]", truncate_for_display(result, 500)));
                    }
                }
                _ => {}
            }
        }
        parts.join("\n")
    } else if let Some(s) = content.as_str() {
        s.to_string()
    } else if let Some(s) = content["content"].as_str() {
        s.to_string()
    } else {
        String::new()
    }
}

fn truncate_for_display(s: &str, max_len: usize) -> String {
    if s.len() <= max_len {
        s.to_string()
    } else {
        format!("{}… +{} lines", &s[..max_len], s[max_len..].lines().count())
    }
}

/// Extract metadata from a Claude Code JSONL message for server storage.
/// Includes usage tokens, thinking content, and structured tool calls.
fn extract_message_metadata(msg: &serde_json::Value) -> serde_json::Value {
    let mut metadata = serde_json::json!({});

    // Usage tokens (only on assistant messages)
    if let Some(usage) = msg["message"]["usage"].as_object() {
        let input = usage["input_tokens"].as_u64().unwrap_or(0)
            + usage["cache_creation_input_tokens"].as_u64().unwrap_or(0)
            + usage["cache_read_input_tokens"].as_u64().unwrap_or(0);
        let output = usage["output_tokens"].as_u64().unwrap_or(0);
        metadata["tokens"] = serde_json::json!({
            "input": input,
            "output": output,
        });
    }

    // Thinking content
    if let Some(content) = msg["message"]["content"].as_array() {
        for block in content {
            if block["type"].as_str() == Some("thinking") {
                if let Some(thinking) = block["thinking"].as_str() {
                    metadata["thinking"] = serde_json::Value::String(thinking.to_string());
                }
            }
        }
    }

    // Structured tool calls from toolUseResult
    if let Some(tool_result) = msg["toolUseResult"].as_object() {
        let mut tool_calls = Vec::new();
        if let Some(name) = tool_result["name"].as_str() {
            tool_calls.push(serde_json::json!({
                "name": name,
                "result": tool_result["content"].as_str().unwrap_or(""),
            }));
        }
        if !tool_calls.is_empty() {
            metadata["toolCalls"] = serde_json::Value::Array(tool_calls);
        }
    }

    metadata
}

pub fn report_session_lazy(server: &str, auth: &str, cwd: &str, hostname: &str, claude_session_id: &str) -> Result<String> {
    let client = reqwest::blocking::Client::builder().no_proxy().build().unwrap();
    let tag = if claude_session_id.is_empty() {
        let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
        format!("{}-{}", cwd.replace('/', "-").trim_start_matches('-'), ts)
    } else {
        format!("{}--{}", cwd.replace('/', "-").trim_start_matches('-'), claude_session_id)
    };
    let resp = client
        .post(format!("{server}/v1/sessions"))
        .header("Authorization", format!("Bearer {auth}"))
        .json(&serde_json::json!({ "tag": tag, "metadata": hostname }))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .context("lazy session report failed")?;
    anyhow::ensure!(resp.status().is_success(), "lazy session report returned {}", resp.status());
    let data: serde_json::Value = resp.json()?;
    Ok(data["session"]["id"].as_str().unwrap_or("").to_string())
}

fn sync_jsonl(server: &str, auth: &str, track_dir: &std::path::Path) {
    if !track_dir.exists() { eprintln!("daemon: no track dir {:?}", track_dir); return; }
    let claude_dir = dirs::home_dir().unwrap_or_default().join(".claude").join("projects");
    let client = reqwest::blocking::Client::builder().no_proxy().build().unwrap();

    let latest_track = std::fs::read_dir(track_dir).into_iter().flatten()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|e| e == "json"))
        .max_by_key(|e| e.metadata().ok().and_then(|m| m.created().ok()).unwrap_or(std::time::UNIX_EPOCH));

    let entry = match latest_track { Some(e) => e, None => return };
    let path = entry.path();
    let offset_path = path.with_extension("offset");
    let track: serde_json::Value = match fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str(&s).ok()) {
        Some(v) => v, None => return
    };
    let session_id = track["sessionId"].as_str().unwrap_or("");
    let claude_session_id = track["claudeSessionId"].as_str().unwrap_or("");
    let cwd = track["cwd"].as_str().unwrap_or("");
    if cwd.is_empty() { return; }

    {
        let proj_name = cwd.replace(['/', '_'], "-");
        let proj_path = claude_dir.join(&proj_name);
        let mut jsonls: Vec<_> = match std::fs::read_dir(&proj_path) {
            Ok(entries) => entries
                .filter_map(|e| e.ok())
                .filter(|e| e.path().extension().is_some_and(|e| e == "jsonl"))
                .collect(),
            Err(e) => { eprintln!("daemon: read_dir error: {e}"); return }
        };
        let track_created = entry.metadata().ok().and_then(|m| m.created().ok()).unwrap_or(std::time::UNIX_EPOCH);
        jsonls.retain(|e| std::fs::metadata(e.path()).ok().and_then(|m| m.modified().ok()).unwrap_or(std::time::UNIX_EPOCH) >= track_created);
        jsonls.sort_by_key(|e| std::fs::metadata(e.path()).ok().and_then(|m| m.modified().ok()).unwrap_or(std::time::UNIX_EPOCH));
        jsonls.reverse();

        // Find the JSONL file that belongs to our claude session
        let jsonl = if !claude_session_id.is_empty() {
            jsonls.iter()
                .find(|e| e.file_name().to_string_lossy().starts_with(claude_session_id))
                .map(|e| e.path())
        } else {
            None
        };
        let jsonl = jsonl.or_else(|| jsonls.first().map(|e| e.path()));
        let jsonl = match jsonl {
            Some(j) => j,
            None => { eprintln!("daemon: no JSONL in {:?}", claude_dir.join(&proj_name)); return }
        };
        eprintln!("daemon: syncing {}", jsonl.display());

        // Discover claude sessionId from the JSONL file if we don't have it yet
        let mut effective_claude_id = claude_session_id.to_string();
        let offset: u64 = fs::read_to_string(&offset_path).ok().and_then(|s| s.trim().parse().ok()).unwrap_or(0);
        if let Ok(meta) = jsonl.metadata() {
            let size = meta.len();
            if size > offset {
                if let Ok(content) = fs::read(&jsonl) {
                    for line in content[offset as usize..].split(|&b| b == b'\n') {
                        if line.is_empty() { continue; }
                        if let Ok(msg) = serde_json::from_slice::<serde_json::Value>(line) {
                            // Capture claude sessionId from the first message
                            if effective_claude_id.is_empty() {
                                if let Some(sid) = msg["sessionId"].as_str() {
                                    effective_claude_id = sid.to_string();
                                    let mut new_track = track.clone();
                                    new_track["claudeSessionId"] = serde_json::Value::String(effective_claude_id.clone());
                                    let _ = fs::write(&path, new_track.to_string());
                                }
                            }

                            let role = msg["type"].as_str().unwrap_or("");
                            // Skip meta/compact messages
                            if msg["isMeta"].as_bool().unwrap_or(false) { continue; }
                            if msg["isCompactSummary"].as_bool().unwrap_or(false) { continue; }
                            // Only sync messages belonging to this claude session
                            if msg["sessionId"].as_str().unwrap_or("") != effective_claude_id { continue; }

                            let text = extract_message_text(&msg);
                            if !text.is_empty() && (role == "user" || role == "assistant") {
                                // Lazy server session creation on first message
                                let server_session_id = if session_id.is_empty() {
                                    match report_session_lazy(server, auth, cwd, track["hostname"].as_str().unwrap_or(""), &effective_claude_id) {
                                        Ok(id) => {
                                            let mut new_track = track.clone();
                                            new_track["sessionId"] = serde_json::Value::String(id.clone());
                                            new_track["claudeSessionId"] = serde_json::Value::String(effective_claude_id.clone());
                                            let _ = fs::write(&path, new_track.to_string());
                                            id
                                        }
                                        Err(e) => { eprintln!("daemon: lazy session report failed: {e}"); continue; }
                                    }
                                } else {
                                    session_id.to_string()
                                };

                                let metadata = extract_message_metadata(&msg);
                                let _ = client
                                    .post(format!("{server}/v1/sessions/{server_session_id}/plaintext-messages"))
                                    .header("Authorization", format!("Bearer {auth}"))
                                    .json(&json!({ "role": role, "content": text, "metadata": metadata })).send();
                            }
                        }
                    }
                    let _ = client
                        .post(format!("{server}/v1/sessions/{session_id}/activity"))
                        .header("Authorization", format!("Bearer {auth}"))
                        .timeout(Duration::from_secs(3)).send();
                    let _ = fs::write(&offset_path, size.to_string());
                }
            }
            if let Ok(meta) = jsonl.metadata() {
                if let Ok(m) = meta.modified() {
                    let age = std::time::SystemTime::now().duration_since(m).unwrap_or_default();
                    if age.as_secs() > 300 {
                        let _ = fs::remove_file(&path);
                        let _ = fs::remove_file(&offset_path);
                    }
                }
            }
        }
    }
}

pub fn start_background(interactive: bool, session_dir: &str) -> Result<()> {
    let pp = pid_file();
    if pp.exists() {
        let pid = fs::read_to_string(&pp).unwrap_or_default().trim().to_string();
        if !pid.is_empty() && Command::new("kill").arg("-0").arg(&pid).status().map(|s| s.success()).unwrap_or(false) {
            println!("daemon: already running (PID: {pid})"); return Ok(());
        }
    }
    let exe = env::current_exe()?;
    let mut cmd = Command::new(&exe);
    cmd.arg("foreground")
        .arg("--session-dir").arg(session_dir)
        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    if interactive {
        cmd.arg("--interactive");
    }
    let child = cmd.spawn()?;
    let _ = fs::create_dir_all(pp.parent().unwrap());
    fs::write(&pp, child.id().to_string())?;
    println!("daemon: started (PID: {}, interactive={}, dir={})", child.id(), interactive, session_dir);
    Ok(())
}

pub fn stop_daemon() -> Result<()> {
    let pp = pid_file();
    if !pp.exists() { println!("daemon: not running"); return Ok(()); }
    let pid = fs::read_to_string(&pp).unwrap_or_default().trim().to_string();
    if !pid.is_empty() { let _ = Command::new("kill").arg(&pid).status(); let _ = fs::remove_file(&pp); println!("daemon: stopped"); }
    Ok(())
}

pub fn show_status() -> Result<()> {
    match config::load_happy_config() {
        Some(hc) => {
            let m = if hc.token.len() > 8 { format!("{}...{}", &hc.token[..4], &hc.token[hc.token.len()-4..]) } else { "****".into() };
            println!("Server: {}\nToken:  {m}", hc.server);
        }
        None => println!("Server: not configured"),
    }
    let pp = pid_file();
    if !pp.exists() { println!("Daemon: not running"); return Ok(()); }
    let pid = fs::read_to_string(&pp).unwrap_or_default().trim().to_string();
    if Command::new("kill").arg("-0").arg(&pid).status().map(|s| s.success()).unwrap_or(false) {
        println!("Daemon: running (PID: {pid})\nMachine: {}", hostname());
    } else { println!("Daemon: stopped (stale PID)"); let _ = fs::remove_file(&pp); }
    Ok(())
}
