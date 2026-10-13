//! ModelGateway integration tests.
//!
//! Assumptions these tests encode:
//! - Ollama dialect: `GET {base}/api/tags` for models, `POST {base}/api/chat`
//!   (NDJSON lines) for chat; images travel as bare base64 in `images`.
//! - OpenAI-compatible dialect: `GET {base}/v1/models` (or `{base}/models`
//!   when the user's base URL already ends in `/v1`), `POST .../chat/completions`
//!   (SSE `data:` lines), Bearer auth when a key is configured, images as
//!   `image_url` content parts with the data URL intact.
//! - Probes (list_models) give up within ~3 s; clear error text either way.
//! - Aborting mid-stream stops quickly and returns the partial content with
//!   `aborted = true`; the stream connection is dropped (the mock sees the
//!   write fail), not left running to completion.
//!
//! "Server" here is the hand-rolled mock in `support/` — no external process.

mod support;

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use shaim_lib::gateway::{AbortFlag, ChatEvent, ChatOptions, ChatTurn, Endpoint, Gateway};
use shaim_lib::store::ServerKind;
use support::{MockResponse, MockServer};

fn endpoint(base: &str, kind: ServerKind, api_key: Option<&str>) -> Endpoint {
    Endpoint {
        kind,
        base_url: base.to_string(),
        api_key: api_key.map(str::to_string),
    }
}

fn gateway() -> Gateway {
    Gateway::new().expect("gateway should build")
}

// ---- listModels -------------------------------------------------------------

#[tokio::test]
async fn list_models_ollama_dialect_reads_names_from_api_tags() {
    let mock = MockServer::start(|request| {
        assert_eq!(request.method, "GET");
        assert_eq!(request.path, "/api/tags");
        MockResponse::json(r#"{"models":[{"name":"llama3:8b"},{"name":"qwen2.5:7b"}]}"#)
    });

    let models = gateway()
        .list_models(&endpoint(mock.base_url(), ServerKind::Ollama, None))
        .await
        .expect("ollama list_models should succeed");

    let ids: Vec<String> = models.into_iter().map(|m| m.id).collect();
    assert_eq!(ids, vec!["llama3:8b", "qwen2.5:7b"]);
}

#[tokio::test]
async fn list_models_openai_dialect_reads_ids_from_v1_models() {
    let mock = MockServer::start(|request| {
        assert_eq!(request.method, "GET");
        assert_eq!(request.path, "/v1/models");
        MockResponse::json(r#"{"data":[{"id":"gpt-4o-mini"},{"id":"qwen3"}]}"#)
    });

    let models = gateway()
        .list_models(&endpoint(
            mock.base_url(),
            ServerKind::OpenAiCompatible,
            None,
        ))
        .await
        .expect("openai list_models should succeed");

    let ids: Vec<String> = models.into_iter().map(|m| m.id).collect();
    assert_eq!(ids, vec!["gpt-4o-mini", "qwen3"]);
}

#[tokio::test]
async fn openai_base_url_ending_in_v1_is_not_doubled() {
    let mock = MockServer::start(|request| {
        // `/v1` from the user's base URL + `/models` — never `/v1/v1/models`.
        assert_eq!(request.path, "/v1/models");
        MockResponse::json(r#"{"data":[{"id":"qwen3"}]}"#)
    });

    let base = format!("{}/v1", mock.base_url());
    let models = gateway()
        .list_models(&endpoint(&base, ServerKind::OpenAiCompatible, None))
        .await
        .expect("list_models with /v1 suffix should succeed");
    assert_eq!(models.len(), 1);
}

#[tokio::test]
async fn openai_base_url_ending_in_api_is_not_doubled() {
    // Open WebUI-style servers expose the OpenAI dialect under `/api`;
    // entering `http://host:8080/api` must hit `/api/models`, not `/api/v1/...`.
    let mock = MockServer::start(|request| {
        assert_eq!(request.path, "/api/models");
        MockResponse::json(r#"{"data":[{"id":"llama3:latest"}]}"#)
    });

    let base = format!("{}/api", mock.base_url());
    let models = gateway()
        .list_models(&endpoint(&base, ServerKind::OpenAiCompatible, None))
        .await
        .expect("list_models with /api suffix should succeed");
    assert_eq!(models[0].id, "llama3:latest");
}

// ---- Failure modes ----------------------------------------------------------

#[tokio::test]
async fn unreachable_host_fails_fast_with_clear_error() {
    // Grab a port, then release it: connecting there is refused instantly.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);

    let started = Instant::now();
    let result = gateway()
        .list_models(&endpoint(
            &format!("http://127.0.0.1:{port}"),
            ServerKind::Ollama,
            None,
        ))
        .await;

    let error = result.expect_err("closed port must fail");
    assert!(elapsed_lt(started, Duration::from_millis(3000)), "must fail within 3 s, took {:?}", started.elapsed());
    let message = error.to_string();
    assert!(
        message.to_lowercase().contains("connection"),
        "error should say the connection failed, got: {message}"
    );
}

#[tokio::test]
async fn silent_host_times_out_within_budget() {
    let mock = MockServer::start(|_request| MockResponse::stall());

    let started = Instant::now();
    let result = gateway()
        .list_models(&endpoint(mock.base_url(), ServerKind::Ollama, None))
        .await;

    let error = result.expect_err("a silent host must time out");
    assert!(elapsed_lt(started, Duration::from_millis(4000)), "timeout must land near the 3 s budget, took {:?}", started.elapsed());
    assert!(
        error.to_string().contains("Timed out"),
        "error should name the timeout, got: {error}"
    );
}

#[tokio::test]
async fn invalid_url_is_rejected_without_touching_the_network() {
    let result = gateway()
        .list_models(&endpoint("not a url", ServerKind::Ollama, None))
        .await;
    let error = result.expect_err("invalid URL must fail");
    assert!(error.to_string().contains("Invalid server URL"), "got: {error}");
}

#[tokio::test]
async fn http_error_status_surfaces_status_and_body() {
    let mock = MockServer::start(|_request| MockResponse::json("unknown model").with_status(404));
    let result = gateway()
        .list_models(&endpoint(mock.base_url(), ServerKind::Ollama, None))
        .await;
    let error = result.expect_err("404 must fail");
    assert!(error.to_string().contains("404"), "error should carry the status, got: {error}");
}

// ---- Auth -------------------------------------------------------------------

#[tokio::test]
async fn keyed_openai_server_sends_bearer_header() {
    let mock = MockServer::start(|_request| MockResponse::json(r#"{"data":[{"id":"gpt-4o-mini"}]}"#));

    let models = gateway()
        .list_models(&endpoint(
            mock.base_url(),
            ServerKind::OpenAiCompatible,
            Some("sk-secret-42"),
        ))
        .await
        .expect("keyed list_models should succeed");
    assert_eq!(models.len(), 1);

    let request = mock.last_request();
    assert_eq!(
        request.header("authorization"),
        Some("Bearer sk-secret-42"),
        "OpenAI-compatible servers must authenticate with a Bearer header"
    );
}

#[tokio::test]
async fn ollama_kind_never_sends_bearer_even_with_key_present() {
    let mock = MockServer::start(|_request| MockResponse::json(r#"{"models":[{"name":"llama3"}]}"#));

    gateway()
        .list_models(&endpoint(mock.base_url(), ServerKind::Ollama, Some("ignored")))
        .await
        .expect("list_models should succeed");

    assert_eq!(mock.last_request().header("authorization"), None);
}

// ---- Streamed chat -----------------------------------------------------------

fn ollama_stream_chunks() -> Vec<(String, u64)> {
    vec![
        (
            r#"{"model":"m","message":{"role":"assistant","thinking":"Let me think…"}}"#.to_string()
                + "\n",
            0,
        ),
        (
            r#"{"model":"m","message":{"role":"assistant","content":"Hello"}}"#.to_string() + "\n",
            0,
        ),
        (
            r#"{"model":"m","message":{"role":"assistant","content":" world"}}"#.to_string() + "\n",
            0,
        ),
        (r#"{"model":"m","done":true}"#.to_string() + "\n", 0),
    ]
}

#[tokio::test]
async fn ollama_chat_streams_events_in_order() {
    let mock = MockServer::start(move |_request| {
        MockResponse::stream("application/x-ndjson", ollama_stream_chunks())
    });

    let events: Arc<Mutex<Vec<ChatEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let outcome = gateway()
        .chat(
            &endpoint(mock.base_url(), ServerKind::Ollama, None),
            "llama3:8b",
            &[ChatTurn {
                role: "user".into(),
                content: "hi".into(),
                images: vec![],
            }],
            &ChatOptions::default(),
            &AbortFlag::new(),
            move |event| sink.lock().unwrap().push(event),
        )
        .await
        .expect("streamed chat should succeed");

    let labels: Vec<String> = events
        .lock()
        .unwrap()
        .iter()
        .map(|event| match event {
            ChatEvent::Thinking { text } => format!("thinking:{text}"),
            ChatEvent::Content { text } => format!("content:{text}"),
        })
        .collect();
    assert_eq!(
        labels,
        vec!["thinking:Let me think…", "content:Hello", "content: world"],
        "deltas must arrive in server order"
    );
    assert_eq!(outcome.content, "Hello world");
    assert_eq!(outcome.thinking, "Let me think…");
    assert!(!outcome.aborted);
    assert!(outcome.error.is_none());

    // The request must have hit the Ollama chat endpoint with stream on.
    let request = mock.last_request();
    assert_eq!(request.path, "/api/chat");
    assert_eq!(request.json()["stream"], serde_json::json!(true));
}

#[tokio::test]
async fn openai_chat_streams_in_order_and_carries_bearer() {
    let mock = MockServer::start(move |_request| {
        MockResponse::stream(
            "text/event-stream",
            vec![
                ("data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"hmm\"}}]}\n\n".to_string(), 0),
                ("data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\n".to_string(), 0),
                ("data: {\"choices\":[{\"delta\":{\"content\":\" there\"}}]}\n\n".to_string(), 0),
                ("data: [DONE]\n\n".to_string(), 0),
            ],
        )
    });

    let events: Arc<Mutex<Vec<ChatEvent>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let outcome = gateway()
        .chat(
            &endpoint(mock.base_url(), ServerKind::OpenAiCompatible, Some("sk-key")),
            "qwen3",
            &[ChatTurn {
                role: "user".into(),
                content: "hi".into(),
                images: vec![],
            }],
            &ChatOptions::default(),
            &AbortFlag::new(),
            move |event| sink.lock().unwrap().push(event),
        )
        .await
        .expect("streamed chat should succeed");

    let labels: Vec<String> = events
        .lock()
        .unwrap()
        .iter()
        .map(|event| match event {
            ChatEvent::Thinking { text } => format!("thinking:{text}"),
            ChatEvent::Content { text } => format!("content:{text}"),
        })
        .collect();
    assert_eq!(labels, vec!["thinking:hmm", "content:Hello", "content: there"]);
    assert_eq!(outcome.content, "Hello there");

    let request = mock.last_request();
    assert_eq!(request.path, "/v1/chat/completions");
    assert_eq!(request.header("authorization"), Some("Bearer sk-key"));
    assert_eq!(request.json()["stream"], serde_json::json!(true));
}

#[tokio::test]
async fn aborting_mid_stream_stops_quickly_and_returns_partial() {
    // First delta immediately, then a long pause — the abort must land well
    // before the second delta is due.
    let mock = MockServer::start(|_request| {
        MockResponse::stream(
            "application/x-ndjson",
            vec![
                (
                    r#"{"model":"m","message":{"role":"assistant","content":"Hel"}}"#.to_string() + "\n",
                    0,
                ),
                (
                    r#"{"model":"m","message":{"role":"assistant","content":"lo after long pause"}}"#.to_string() + "\n",
                    1200,
                ),
            ],
        )
    });

    let abort = AbortFlag::new();
    let abort_in_callback = abort.clone();
    let saw_first_delta = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let flag = saw_first_delta.clone();
    let started = Instant::now();
    let outcome = gateway()
        .chat(
            &endpoint(mock.base_url(), ServerKind::Ollama, None),
            "llama3:8b",
            &[ChatTurn {
                role: "user".into(),
                content: "hi".into(),
                images: vec![],
            }],
            &ChatOptions::default(),
            &abort,
            move |event| {
                if matches!(event, ChatEvent::Content { .. }) {
                    abort_in_callback.abort();
                    flag.store(true, Ordering::SeqCst);
                }
            },
        )
        .await
        .expect("aborted stream should still return Ok with the partial");

    assert!(saw_first_delta.load(Ordering::SeqCst), "first delta must have been delivered");
    assert!(elapsed_lt(started, Duration::from_millis(900)), "abort must not wait for the next chunk, took {:?}", started.elapsed());
    assert!(outcome.aborted, "outcome must be marked aborted");
    assert_eq!(outcome.content, "Hel", "exactly the partial content seen so far");
    assert!(outcome.error.is_none());
}

// ---- Vision payloads ---------------------------------------------------------

const PNG_DATA_URL: &str = "data:image/png;base64,QUJDREVG";

#[tokio::test]
async fn ollama_vision_payload_sends_bare_base64_images() {
    let mock = MockServer::start(|_request| {
        MockResponse::stream(
            "application/x-ndjson",
            vec![(r#"{"model":"m","message":{"content":"I see text"},"done":false}"#.to_string() + "\n", 0)],
        )
    });

    gateway()
        .chat(
            &endpoint(mock.base_url(), ServerKind::Ollama, None),
            "llava",
            &[ChatTurn {
                role: "user".into(),
                content: "what is in this image?".into(),
                images: vec![PNG_DATA_URL.into()],
            }],
            &ChatOptions::default(),
            &AbortFlag::new(),
            |_| {},
        )
        .await
        .expect("vision chat should succeed");

    let payload = mock.last_request().json();
    let images = payload["messages"][0]["images"]
        .as_array()
        .expect("ollama payload must carry an images array");
    assert_eq!(
        images,
        &vec![serde_json::json!("QUJDREVG")],
        "ollama wants the base64 payload without the data: prefix"
    );
}

#[tokio::test]
async fn openai_vision_payload_sends_image_url_parts() {
    let mock = MockServer::start(|_request| {
        MockResponse::stream(
            "text/event-stream",
            vec![("data: [DONE]\n\n".to_string(), 0)],
        )
    });

    gateway()
        .chat(
            &endpoint(mock.base_url(), ServerKind::OpenAiCompatible, None),
            "gpt-4o-mini",
            &[ChatTurn {
                role: "user".into(),
                content: "what is in this image?".into(),
                images: vec![PNG_DATA_URL.into()],
            }],
            &ChatOptions::default(),
            &AbortFlag::new(),
            |_| {},
        )
        .await
        .expect("vision chat should succeed");

    let payload = mock.last_request().json();
    let content = payload["messages"][0]["content"]
        .as_array()
        .expect("openai payload must use content parts for vision turns");
    let has_image_part = content.iter().any(|part| {
        part["type"] == "image_url"
            && part["image_url"]["url"] == PNG_DATA_URL
    });
    assert!(
        has_image_part,
        "image must travel as an image_url part with the data URL intact, got: {content:?}"
    );
}

fn elapsed_lt(started: Instant, limit: Duration) -> bool {
    started.elapsed() < limit
}
