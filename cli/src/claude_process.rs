//! Spawn-based claude process using stream-json protocol for bidirectional control.
//! Supports persistent multi-turn sessions via stdin/stdout JSON lines.

use anyhow::{Context, Result};
use crate::config::Profile;
use serde_json::json;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::{Duration, Instant};

pub enum ClaudeEvent {
    Init { session_id: String },
    Assistant { text: String, tool_uses: Vec<serde_json::Value>, usage: Option<serde_json::Value> },
    Result { text: String, usage: Option<serde_json::Value>, cost: Option<f64> },
    Retry { message: String },
    Unknown { raw: serde_json::Value },
}

pub struct ClaudeProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    pub session_id: String,
    last_activity: Instant,
}

impl ClaudeProcess {
    /// Spawn claude with stream-json protocol for persistent multi-turn session.
    /// If `resume_session_id` is provided, resumes that conversation.
    pub fn spawn(profile: &Profile, cwd: &str, resume_session_id: Option<&str>) -> Result<Self> {
        let mut cmd = Command::new("claude");
        cmd.args(["-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose"])
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());

        // Inject profile env vars
        if let Some(env_map) = &profile.env {
            for (k, v) in env_map {
                cmd.env(k, v);
            }
        }

        if let Some(model) = &profile.model {
            cmd.arg("--model").arg(model);
        }
        if profile.skip_permissions.unwrap_or(false) {
            cmd.arg("--dangerously-skip-permissions");
        }
        if let Some(extra) = &profile.extra_args {
            cmd.args(extra);
        }
        if let Some(sid) = resume_session_id {
            cmd.arg("--resume").arg(sid);
        }

        let mut child = cmd.spawn().context("failed to spawn claude")?;
        let stdin = child.stdin.take().context("failed to open stdin")?;
        let stdout = child.stdout.take().context("failed to open stdout")?;
        let stdout = BufReader::new(stdout);

        Ok(Self {
            child,
            stdin,
            stdout,
            session_id: String::new(),
            last_activity: Instant::now(),
        })
    }

    /// Send a user message to claude via stream-json stdin.
    pub fn send_message(&mut self, text: &str) -> Result<()> {
        let msg = json!({
            "type": "user",
            "message": {"role": "user", "content": text},
            "session_id": if self.session_id.is_empty() { "default" } else { &self.session_id },
            "parent_tool_use_id": null,
        });
        let line = serde_json::to_string(&msg).context("failed to serialize message")?;
        writeln!(self.stdin, "{}", line).context("failed to write to claude stdin")?;
        self.stdin.flush().context("failed to flush stdin")?;
        self.last_activity = Instant::now();
        Ok(())
    }

    /// Read the next stream-json event from claude stdout.
    /// Returns None on EOF (process exited).
    pub fn read_event(&mut self) -> Result<Option<ClaudeEvent>> {
        let mut line = String::new();
        let n = self.stdout.read_line(&mut line).context("failed to read from claude stdout")?;
        if n == 0 {
            return Ok(None); // EOF
        }
        self.last_activity = Instant::now();
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return Ok(Some(ClaudeEvent::Unknown { raw: json!({}) }));
        }
        let v: serde_json::Value = serde_json::from_str(trimmed).context("failed to parse stream-json line")?;
        let event_type = v["type"].as_str().unwrap_or("");

        match event_type {
            "system" => {
                if v["subtype"].as_str() == Some("init") {
                    let sid = v["session_id"].as_str().unwrap_or("").to_string();
                    if !sid.is_empty() {
                        self.session_id = sid.clone();
                    }
                    return Ok(Some(ClaudeEvent::Init { session_id: sid }));
                }
                Ok(Some(ClaudeEvent::Unknown { raw: v }))
            }
            "assistant" => {
                let mut text = String::new();
                let mut tool_uses = Vec::new();
                if let Some(content) = v["message"]["content"].as_array() {
                    for block in content {
                        match block["type"].as_str() {
                            Some("text") => {
                                if let Some(t) = block["text"].as_str() {
                                    text.push_str(t);
                                }
                            }
                            Some("tool_use") => {
                                tool_uses.push(block.clone());
                            }
                            _ => {}
                        }
                    }
                }
                let usage = v["message"]["usage"].as_object().map(|u| serde_json::Value::Object(u.clone()));
                Ok(Some(ClaudeEvent::Assistant { text, tool_uses, usage }))
            }
            "result" => {
                let text = v["result"].as_str().unwrap_or("").to_string();
                let usage = v["usage"].as_object().map(|u| serde_json::Value::Object(u.clone()));
                let cost = v["total_cost_usd"].as_f64();
                Ok(Some(ClaudeEvent::Result { text, usage, cost }))
            }
            _ => Ok(Some(ClaudeEvent::Unknown { raw: v })),
        }
    }

    /// Read events until a Result event is received, collecting assistant text.
    /// Returns the final response text and collected metadata.
    pub fn read_response(&mut self) -> Result<Option<(String, serde_json::Value)>> {
        let mut full_text = String::new();
        let mut metadata = json!({});
        let mut tool_calls = Vec::new();

        loop {
            match self.read_event()? {
                Some(ClaudeEvent::Init { session_id }) => {
                    if !session_id.is_empty() {
                        self.session_id = session_id;
                    }
                }
                Some(ClaudeEvent::Assistant { text, tool_uses, usage }) => {
                    full_text.push_str(&text);
                    tool_calls.extend(tool_uses);
                    if let Some(u) = usage {
                        metadata["tokens"] = u;
                    }
                }
                Some(ClaudeEvent::Result { text, usage, cost }) => {
                    if full_text.is_empty() {
                        full_text = text;
                    }
                    if let Some(u) = usage {
                        metadata["tokens"] = u;
                    }
                    if let Some(c) = cost {
                        metadata["cost"] = json!(c);
                    }
                    if !tool_calls.is_empty() {
                        metadata["toolCalls"] = json!(tool_calls);
                    }
                    return Ok(Some((full_text, metadata)));
                }
                Some(ClaudeEvent::Unknown { .. }) => {}
                Some(ClaudeEvent::Retry { .. }) => {}
                None => return Ok(None), // EOF
            }

            // Watchdog: 120s timeout
            if self.last_activity.elapsed() > Duration::from_secs(120) {
                self.kill().ok();
                anyhow::bail!("claude response timeout (120s)");
            }
        }
    }

    /// Check if the claude process is still running.
    pub fn is_running(&mut self) -> bool {
        self.child.try_wait().map(|s| s.is_none()).unwrap_or(false)
    }

    /// Kill the claude process.
    pub fn kill(&mut self) -> Result<()> {
        self.child.kill().context("failed to kill claude")?;
        Ok(())
    }
}

impl Drop for ClaudeProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}
