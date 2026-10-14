mod request;
mod response;

use axum::{
    body::Body,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    response::{
        sse::{Event, Sse},
        IntoResponse, Response,
    },
    routing::{get, post},
    Json, Router,
};
use futures_util::StreamExt;
use response::ResponseBuilder;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    convert::Infallible,
    sync::Arc,
    time::Duration,
};

#[derive(Clone, Deserialize)]
struct Model {
    model_name: String,
    model: String,
    protocol: String,
    api_base: String,
}
#[derive(Deserialize)]
struct Config {
    models: Vec<Model>,
}
struct App {
    models: HashMap<String, Model>,
    key: String,
    client: reqwest::Client,
}

fn authenticated(headers: &HeaderMap, key: &str) -> bool {
    let supplied = headers
        .get("authorization")
        .and_then(|x| x.to_str().ok())
        .and_then(|x| x.strip_prefix("Bearer "))
        .unwrap_or("")
        .as_bytes();
    let expected = key.as_bytes();
    let mut difference = supplied.len() ^ expected.len();
    for (index, value) in expected.iter().enumerate() {
        difference |= (*value ^ supplied.get(index).copied().unwrap_or(0)) as usize;
    }
    difference == 0
}
fn error(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(json!({"error":{"type":"invalid_request_error","code":code,"message":message}})),
    )
        .into_response()
}
async fn health(State(app): State<Arc<App>>, headers: HeaderMap) -> Response {
    if !authenticated(&headers, &app.key) {
        return error(
            StatusCode::UNAUTHORIZED,
            "invalid_api_key",
            "Invalid gateway credential",
        );
    }
    Json(json!({"ok":true,"status":"ok","service":"codex-router-gateway","backend":"rust"}))
        .into_response()
}
async fn models(State(app): State<Arc<App>>, headers: HeaderMap) -> Response {
    if !authenticated(&headers, &app.key) {
        return error(
            StatusCode::UNAUTHORIZED,
            "invalid_api_key",
            "Invalid gateway credential",
        );
    }
    let mut ids = app.models.keys().collect::<Vec<_>>();
    ids.sort();
    Json(json!({"object":"list","data":ids.into_iter().map(|id|json!({"id":id,"object":"model","owned_by":"codex-router"})).collect::<Vec<_>>()})).into_response()
}

// Frame bytes before decoding UTF-8: network chunks can split both codepoints
// and CRLF. Multiline SSE data and comments are supported without buffering the
// complete response. The bound applies to one event, not a long-running stream.
#[derive(Default)]
struct Frames {
    bytes: Vec<u8>,
}
impl Frames {
    fn feed(&mut self, chunk: &[u8]) -> Result<Vec<String>, ()> {
        self.bytes.extend_from_slice(chunk);
        let mut out = Vec::new();
        loop {
            let lf = self
                .bytes
                .windows(2)
                .position(|x| x == b"\n\n")
                .map(|i| (i, 2));
            let crlf = self
                .bytes
                .windows(4)
                .position(|x| x == b"\r\n\r\n")
                .map(|i| (i, 4));
            let found = match (lf, crlf) {
                (Some(a), Some(b)) => Some(if a.0 < b.0 { a } else { b }),
                (a, b) => a.or(b),
            };
            let Some((end, delimiter)) = found else {
                break;
            };
            if end > 8 * 1024 * 1024 {
                return Err(());
            }
            let frame =
                String::from_utf8(self.bytes.drain(..end + delimiter).collect()).map_err(|_| ())?;
            let data = frame
                .lines()
                .filter_map(|line| {
                    line.strip_prefix("data:")
                        .map(|x| x.strip_prefix(' ').unwrap_or(x))
                })
                .collect::<Vec<_>>()
                .join("\n");
            if !data.is_empty() {
                out.push(data);
            }
        }
        if self.bytes.len() > 8 * 1024 * 1024 {
            return Err(());
        }
        Ok(out)
    }
}
fn event(value: Value) -> Event {
    Event::default()
        .event(value["type"].as_str().unwrap_or("error").to_string())
        .data(value.to_string())
}
fn response_headers(source: &HeaderMap, target: &mut HeaderMap) {
    for (name, value) in source {
        if name.as_str() == "retry-after"
            || name.as_str().starts_with("x-ratelimit-")
            || name.as_str().starts_with("x-request-")
        {
            target.insert(name.clone(), value.clone());
        }
    }
}

async fn responses(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Response {
    if !authenticated(&headers, &app.key) {
        return error(
            StatusCode::UNAUTHORIZED,
            "invalid_api_key",
            "Invalid gateway credential",
        );
    }
    let Some(name) = payload["model"].as_str() else {
        return error(
            StatusCode::BAD_REQUEST,
            "missing_model",
            "model is required",
        );
    };
    let Some(route) = app.models.get(name) else {
        return error(
            StatusCode::BAD_REQUEST,
            "unknown_model",
            "Unknown gateway model",
        );
    };
    let streaming = payload["stream"].as_bool().unwrap_or(false);
    let (body, custom, endpoint) = match route.protocol.as_str() {
        "openai-responses" => {
            let mut body = payload.clone();
            body["model"] = json!(route.model);
            (body, HashSet::new(), "/responses")
        }
        "anthropic" => match request::anthropic(&payload, &route.model) {
            Ok(x) => (x.body, x.custom_tools, "/messages"),
            Err(message) => return error(StatusCode::BAD_REQUEST, "invalid_input", &message),
        },
        _ => match request::chat(&payload, &route.model) {
            Ok(x) => (x.body, x.custom_tools, "/chat/completions"),
            Err(message) => return error(StatusCode::BAD_REQUEST, "invalid_input", &message),
        },
    };
    let upstream = match app
        .client
        .post(format!(
            "{}{endpoint}",
            route.api_base.trim_end_matches('/')
        ))
        .bearer_auth(&app.key)
        .header(
            "accept",
            if streaming {
                "text/event-stream"
            } else {
                "application/json"
            },
        )
        .json(&body)
        .send()
        .await
    {
        Ok(x) => x,
        Err(_) => {
            return error(
                StatusCode::BAD_GATEWAY,
                "upstream_unavailable",
                "Upstream request failed",
            )
        }
    };
    let status = upstream.status();
    let upstream_headers = upstream.headers().clone();
    if !status.is_success() {
        // No raw provider response body is emitted: it can echo private request
        // contents. HTTP status and rate-limit headers still reach the caller.
        let mut reply = error(status, "upstream_error", "Upstream rejected the request");
        response_headers(&upstream_headers, reply.headers_mut());
        return reply;
    }
    if route.protocol == "openai-responses" {
        let mut reply = Response::new(Body::from_stream(upstream.bytes_stream()));
        *reply.status_mut() = status;
        if let Some(content_type) = upstream_headers.get("content-type") {
            reply
                .headers_mut()
                .insert("content-type", content_type.clone());
        }
        response_headers(&upstream_headers, reply.headers_mut());
        return reply;
    }
    let anthropic = route.protocol == "anthropic";
    let mut builder = ResponseBuilder::new(name.to_string(), custom, payload);
    if !streaming {
        let value: Value = match upstream.json().await {
            Ok(x) => x,
            Err(_) => {
                return error(
                    StatusCode::BAD_GATEWAY,
                    "invalid_upstream_response",
                    "Upstream returned invalid JSON",
                )
            }
        };
        let converted = if anthropic {
            builder.anthropic_chunk(&value)
        } else {
            builder.chat_chunk(&value)
        };
        if converted.is_err() {
            return error(
                StatusCode::BAD_GATEWAY,
                "invalid_upstream_response",
                "Upstream returned an invalid response",
            );
        }
        builder.finish();
        let mut reply = Json(builder.result()).into_response();
        response_headers(&upstream_headers, reply.headers_mut());
        return reply;
    }
    let stream = async_stream::stream! {
        for value in builder.start() { yield Ok::<_, Infallible>(event(value)); }
        let mut bytes = upstream.bytes_stream();
        let mut frames = Frames::default();
        let mut terminal = false;
        let mut failed = false;
        while let Some(chunk) = bytes.next().await {
            let chunk = match chunk { Ok(x) => x, Err(_) => { failed=true; break; } };
            let data = match frames.feed(&chunk) { Ok(x) => x, Err(_) => {failed=true; break;} };
            for frame in data {
                if frame == "[DONE]" { terminal = true; continue; }
                let value: Value = match serde_json::from_str(&frame) {Ok(x)=>x,Err(_)=>{failed=true;break;}};
                if value.get("error").is_some() || value["type"] == "error" {failed=true; break;}
                if anthropic {
                    if value["type"] == "message_stop" {terminal=true;}
                } else if value["choices"].as_array().is_some_and(|xs|xs.iter().any(|x|!x["finish_reason"].is_null())) {terminal=true;}
                let events = if anthropic { builder.anthropic_chunk(&value) } else {builder.chat_chunk(&value)};
                match events { Ok(xs) => for x in xs {yield Ok(event(x));}, Err(_) => {failed=true;break;} }
            }
            if failed {break;}
        }
        if failed || !terminal || !frames.bytes.iter().all(u8::is_ascii_whitespace) {
            yield Ok(event(builder.failed("upstream_stream_error","Upstream stream ended without a complete response")));
        } else { for value in builder.finish() {yield Ok(event(value));} }
    };
    let mut reply = Sse::new(stream).into_response();
    response_headers(&upstream_headers, reply.headers_mut());
    reply
}

async fn shutdown() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).unwrap();
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let option = |key: &str| args.windows(2).find(|p| p[0] == key).map(|p| p[1].clone());
    let path = option("--config").ok_or("--config is required")?;
    let host = option("--host").unwrap_or_else(|| "127.0.0.1".into());
    if host != "127.0.0.1" {
        return Err("Gateway must bind to IPv4 loopback".into());
    }
    let port = option("--port")
        .unwrap_or_else(|| "4100".into())
        .parse::<u16>()?;
    let key = std::env::var("CODEX_ROUTER_INTERNAL_KEY").map_err(|_| "Internal key is missing")?;
    if key.is_empty() {
        return Err("Internal key is empty".into());
    }
    let config: Config = serde_json::from_slice(&std::fs::read(path)?)
        .map_err(|_| "Gateway configuration is invalid")?;
    let mut routes = HashMap::new();
    for model in config.models {
        let url = reqwest::Url::parse(&model.api_base).map_err(|_| "Invalid gateway route URL")?;
        if url.scheme() != "http"
            || !matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("Gateway routes must target local credential forwarders".into());
        }
        if !matches!(
            model.protocol.as_str(),
            "openai" | "anthropic" | "openai-responses"
        ) {
            return Err("Invalid gateway protocol".into());
        }
        if routes.insert(model.model_name.clone(), model).is_some() {
            return Err("Duplicate gateway route".into());
        }
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(600))
        .build()?;
    let app = Arc::new(App {
        models: routes,
        key,
        client,
    });
    let router = Router::new()
        .route("/health/liveliness", get(health))
        .route("/health", get(health))
        .route("/v1/models", get(models))
        .route("/models", get(models))
        .route("/v1/responses", post(responses))
        .route("/responses", post(responses))
        .layer(DefaultBodyLimit::max(64 * 1024 * 1024))
        .with_state(app);
    let listener = tokio::net::TcpListener::bind((host.as_str(), port)).await?;
    println!("codex-router Rust gateway listening on loopback port {port}");
    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown())
        .await?;
    Ok(())
}
