//! Bounded Debug Adapter Protocol framing over the adapter's standard streams.
use std::collections::{HashMap, VecDeque};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::{Event, PROTOCOL, TIMEOUT};
use tauri::ipc::Channel;

pub(super) struct Adapter {
    input: ChildStdin,
    reader: JoinHandle<()>,
    messages: mpsc::Receiver<Result<Value, String>>,
    sequence: u64,
    responses: HashMap<u64, Value>,
    pending: VecDeque<Value>,
    events: Channel<Event>,
}

impl Adapter {
    pub(super) fn new(input: ChildStdin, output: ChildStdout, events: Channel<Event>) -> Self {
        let (tx, messages) = mpsc::channel(32);
        let reader = tokio::spawn(async move {
            let mut output = BufReader::new(output);
            loop {
                let message = read(&mut output).await;
                let closed = message.is_err();
                if tx.send(message).await.is_err() || closed {
                    break;
                }
            }
        });
        Self {
            input,
            reader,
            messages,
            sequence: 0,
            responses: HashMap::new(),
            pending: VecDeque::new(),
            events,
        }
    }

    pub(super) fn emit(&self, event: Event) -> Result<(), String> {
        self.events.send(event).map_err(|_| PROTOCOL.into())
    }

    async fn write(&mut self, message: &Value) -> Result<(), String> {
        let body = serde_json::to_vec(message).map_err(|_| PROTOCOL)?;
        let header = format!("Content-Length: {}\r\n\r\n", body.len());
        self.input
            .write_all(header.as_bytes())
            .await
            .map_err(|_| PROTOCOL)?;
        self.input.write_all(&body).await.map_err(|_| PROTOCOL)?;
        Ok(())
    }

    pub(super) async fn send(&mut self, command: &str, arguments: Value) -> Result<u64, String> {
        self.sequence += 1;
        let sequence = self.sequence;
        self.write(&json!({"seq": sequence, "type": "request", "command": command, "arguments": arguments})).await?;
        Ok(sequence)
    }

    pub(super) async fn call(&mut self, command: &str, arguments: Value) -> Result<Value, String> {
        let seq = self.send(command, arguments).await?;
        self.response(seq).await
    }

    pub(super) async fn response(&mut self, seq: u64) -> Result<Value, String> {
        tokio::time::timeout(Duration::from_secs(20), async {
            while !self.responses.contains_key(&seq) {
                let message = self.receive().await?;
                self.ingest(message).await?;
            }
            result(self.responses.remove(&seq).ok_or(PROTOCOL)?)
        })
        .await
        .map_err(|_| TIMEOUT)?
    }

    pub(super) async fn initialized(&mut self, launch: u64) -> Result<(), String> {
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                let message = self.receive().await?;
                if message["type"] == "event" && message["event"] == "initialized" {
                    return Ok(());
                }
                if message["request_seq"].as_u64() == Some(launch) && message["success"] == false {
                    return result(message).map(|_| ());
                }
                self.ingest(message).await?;
            }
        })
        .await
        .map_err(|_| TIMEOUT)?
    }

    pub(super) async fn receive(&mut self) -> Result<Value, String> {
        self.messages.recv().await.ok_or(PROTOCOL)?
    }

    pub(super) fn event(&mut self) -> Option<Value> {
        self.pending.pop_front()
    }

    pub(super) async fn ingest(&mut self, message: Value) -> Result<(), String> {
        match message["type"].as_str() {
            Some("response") => {
                let seq = message["request_seq"].as_u64().ok_or(PROTOCOL)?;
                if self.responses.len() >= 16 {
                    return Err(PROTOCOL.into());
                }
                self.responses.insert(seq, message);
            }
            Some("request") => {
                self.sequence += 1;
                self.write(&json!({
                    "seq": self.sequence, "type": "response", "request_seq": message["seq"],
                    "command": message["command"], "success": false, "message": "Unsupported request"
                })).await?;
            }
            Some("event") => match message["event"].as_str() {
                Some("output") => {
                    let body = &message["body"];
                    if matches!(
                        body["category"].as_str(),
                        Some("stdout" | "stderr" | "console")
                    ) && let Some(text) = body["output"].as_str()
                    {
                        self.emit(Event::Output {
                            text: bounded_text(text, 4096),
                        })?;
                    }
                }
                Some("stopped" | "terminated") => {
                    if self.pending.len() >= 32 {
                        return Err(PROTOCOL.into());
                    }
                    self.pending.push_back(message);
                }
                _ => {}
            },
            _ => return Err(PROTOCOL.into()),
        }
        Ok(())
    }
}

impl Drop for Adapter {
    fn drop(&mut self) {
        self.reader.abort();
    }
}

pub(super) fn bounded_text(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

fn result(mut message: Value) -> Result<Value, String> {
    if message["success"].as_bool() == Some(true) {
        Ok(message["body"].take())
    } else {
        Err(message["message"]
            .as_str()
            .map_or_else(|| PROTOCOL.into(), |message| bounded_text(message, 400)))
    }
}

async fn read(input: &mut BufReader<ChildStdout>) -> Result<Value, String> {
    let mut header = String::new();
    let mut length = None;
    loop {
        header.clear();
        let count = input
            .take(512)
            .read_line(&mut header)
            .await
            .map_err(|_| PROTOCOL)?;
        match header.as_str() {
            "\r\n" => break,
            _ if count == 0 || count == 512 || !header.ends_with("\r\n") => {
                return Err(PROTOCOL.into());
            }
            _ => {}
        }
        if let Some(value) = header.strip_prefix("Content-Length:") {
            length = value
                .trim()
                .parse::<usize>()
                .ok()
                .filter(|size| *size <= 2 * 1024 * 1024);
        }
    }
    let mut body = vec![0; length.ok_or(PROTOCOL)?];
    input.read_exact(&mut body).await.map_err(|_| PROTOCOL)?;
    serde_json::from_slice(&body).map_err(|_| PROTOCOL.into())
}
