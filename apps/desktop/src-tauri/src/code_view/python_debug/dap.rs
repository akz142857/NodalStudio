//! Bounded Debug Adapter Protocol framing over the adapter's standard streams.
use std::collections::{HashMap, VecDeque};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStderr, ChildStdin, ChildStdout};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::{Event, PROTOCOL, TIMEOUT};
use tauri::ipc::Channel;

const MAX_STDERR_BYTES: u64 = 4096;

pub(super) struct Adapter {
    input: ChildStdin,
    reader: JoinHandle<()>,
    stderr_reader: Option<JoinHandle<()>>,
    messages: mpsc::Receiver<Result<Value, String>>,
    sequence: u64,
    responses: HashMap<u64, Value>,
    pending: VecDeque<Value>,
    events: Channel<Event>,
}

impl Adapter {
    pub(super) fn new(
        input: ChildStdin,
        output: ChildStdout,
        stderr: Option<ChildStderr>,
        events: Channel<Event>,
    ) -> Self {
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
        let stderr_reader = stderr.map(|stderr| {
            let events = events.clone();
            tokio::spawn(async move {
                let mut buffer = Vec::new();
                if stderr
                    .take(MAX_STDERR_BYTES)
                    .read_to_end(&mut buffer)
                    .await
                    .is_ok()
                    && !buffer.is_empty()
                {
                    let text = String::from_utf8_lossy(&buffer);
                    let _ = events.send(Event::Output {
                        text: bounded_text(&text, 4096),
                    });
                }
            })
        });
        Self {
            input,
            reader,
            stderr_reader,
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
        if let Some(handle) = &self.stderr_reader {
            handle.abort();
        }
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

async fn read<R: AsyncBufRead + Unpin>(input: &mut R) -> Result<Value, String> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[tokio::test]
    async fn reads_framed_json_messages_and_ignores_extra_headers() {
        let payload = br#"{"seq":1,"type":"event","event":"initialized"}"#;
        let frame = format!(
            "X-Custom: ignore\r\nContent-Length: {}\r\n\r\n{}",
            payload.len(),
            std::str::from_utf8(payload).unwrap()
        );
        let mut reader = BufReader::new(Cursor::new(frame.into_bytes()));
        let message = read(&mut reader).await.unwrap();
        assert_eq!(message["event"], "initialized");
    }

    #[tokio::test]
    async fn rejects_oversized_content_length_and_malformed_headers() {
        let oversized = b"Content-Length: 3000000\r\n\r\n{}".to_vec();
        assert_eq!(
            read(&mut BufReader::new(Cursor::new(oversized)))
                .await
                .unwrap_err(),
            PROTOCOL
        );
        let missing_crlf = b"Content-Length: 2\n\n{}".to_vec();
        assert_eq!(
            read(&mut BufReader::new(Cursor::new(missing_crlf)))
                .await
                .unwrap_err(),
            PROTOCOL
        );
    }

    #[test]
    fn extracts_response_body_or_bounded_error_message() {
        let ok = result(json!({"success": true, "body": {"threads": []}})).unwrap();
        assert_eq!(ok["threads"], json!([]));
        let long_msg = "x".repeat(500);
        let err = result(json!({"success": false, "message": long_msg})).unwrap_err();
        assert_eq!(err.chars().count(), 400);
    }
}
