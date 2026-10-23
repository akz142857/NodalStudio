//! Shared OpenAI-compatible request options and completion handling.

use reqwest::Url;
use serde_json::{Value, json};

pub(crate) const TRUNCATED_OUTPUT: &str = "The model output was truncated at its token limit. No partial answer was used. Try a shorter question or a smaller context, then prepare a new request.";

pub(crate) fn request_body(
    endpoint: &Url,
    model: &str,
    system: &str,
    prompt: &str,
    max_tokens: Option<u32>,
) -> Value {
    let mut body = json!({
        "model": model,
        "messages": [{"role":"system","content":system},{"role":"user","content":prompt}],
        "temperature": 0.2,
    });
    if let Some(limit) = max_tokens {
        body["max_tokens"] = json!(limit);
    }
    // DeepSeek defaults to thinking/high, which can spend the entire bounded
    // output budget before producing JSON. Do not send this vendor extension
    // to other compatible services merely because their model name matches.
    if endpoint.scheme() == "https" && endpoint.host_str() == Some("api.deepseek.com") {
        body["thinking"] = json!({"type": "disabled"});
    }
    body
}

pub(crate) fn response_text(envelope: &Value) -> Result<String, String> {
    // Check before content parsing: a truncated answer can be empty, malformed
    // JSON, or even valid JSON that still omits part of the intended answer.
    if envelope
        .pointer("/choices/0/finish_reason")
        .and_then(Value::as_str)
        == Some("length")
    {
        return Err(TRUNCATED_OUTPUT.into());
    }
    envelope
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "The provider returned no textual explanation.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disables_thinking_only_for_the_official_deepseek_host() {
        for endpoint in [
            "https://api.deepseek.com/chat/completions",
            "https://api.deepseek.com/v1/chat/completions",
            "https://API.DEEPSEEK.COM/chat/completions",
        ] {
            // Both the bounded structured flow and the provider test use this builder.
            for budget in [Some(2048), None] {
                let body = request_body(
                    &Url::parse(endpoint).unwrap(),
                    "deepseek-flash",
                    "s",
                    "q",
                    budget,
                );
                assert_eq!(body["thinking"], json!({"type":"disabled"}));
                assert_eq!(
                    body.get("max_tokens").and_then(Value::as_u64),
                    budget.map(u64::from)
                );
            }
        }
        for endpoint in [
            "https://api.openai.com/v1/chat/completions",
            "https://api.deepseek.com.example/chat/completions",
            "https://proxy.example/api.deepseek.com/chat/completions",
            "http://127.0.0.1:11434/v1/chat/completions",
        ] {
            let body = request_body(
                &Url::parse(endpoint).unwrap(),
                "deepseek-flash",
                "s",
                "q",
                Some(2048),
            );
            assert_eq!(
                body,
                json!({"model":"deepseek-flash", "messages":[{"role":"system","content":"s"},{"role":"user","content":"q"}], "temperature":0.2, "max_tokens":2048})
            );
        }
    }

    #[test]
    fn truncation_rejects_empty_partial_and_valid_json_without_exposing_reasoning() {
        for content in [
            Value::Null,
            json!(""),
            json!("{\"interpretations\":"),
            json!("{\"interpretations\":[],\"unknowns\":[]}"),
        ] {
            let envelope = json!({"choices":[{"finish_reason":"length","message":{"content":content,"reasoning_content":"private reasoning"}}]});
            assert_eq!(response_text(&envelope), Err(TRUNCATED_OUTPUT.into()));
        }
    }

    #[test]
    fn complete_answers_remain_compatible_and_reasoning_is_never_an_answer() {
        for reason in [json!("stop"), Value::Null] {
            let envelope = json!({"choices":[{"finish_reason":reason,"message":{"content":"  complete answer  "}}]});
            assert_eq!(response_text(&envelope).unwrap(), "  complete answer  ");
        }
        let missing_reason = json!({"choices":[{"message":{"content":"compatible answer"}}]});
        assert_eq!(response_text(&missing_reason).unwrap(), "compatible answer");
        for content in [Value::Null, json!(" ")] {
            let envelope = json!({"choices":[{"finish_reason":"stop","message":{"content":content,"reasoning_content":"not an answer"}}]});
            assert_eq!(
                response_text(&envelope).unwrap_err(),
                "The provider returned no textual explanation."
            );
        }
    }
}
