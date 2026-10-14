use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

#[derive(Clone, Debug, Default)]
struct UsageState {
    input_tokens: u64,
    output_tokens: u64,
    total_tokens: Option<u64>,
    cached_tokens: u64,
    reasoning_tokens: u64,
    known: bool,
}

impl UsageState {
    fn value(&self) -> Value {
        json!({
            "input_tokens": self.input_tokens,
            "input_tokens_details": {"cached_tokens": self.cached_tokens},
            "output_tokens": self.output_tokens,
            "output_tokens_details": {"reasoning_tokens": self.reasoning_tokens},
            "total_tokens": self.total_tokens.unwrap_or(self.input_tokens + self.output_tokens),
        })
    }
}

#[derive(Clone, Debug)]
struct MessageState {
    id: String,
    output_index: usize,
    text: String,
    text_done: bool,
    part_done: bool,
    item_done: bool,
}

#[derive(Clone, Debug)]
struct ReasoningState {
    id: String,
    output_index: usize,
    text: String,
    encrypted_content: Option<String>,
    text_done: bool,
    part_done: bool,
    item_done: bool,
}

#[derive(Clone, Debug)]
struct ToolState {
    id: String,
    output_index: usize,
    name: String,
    arguments: String,
    custom: bool,
    item_done: bool,
}

#[derive(Clone, Debug)]
struct PendingTool {
    key: i64,
    id: String,
    name: String,
    arguments: String,
}

#[derive(Clone, Debug)]
enum ItemState {
    Message(MessageState),
    Reasoning(ReasoningState),
    Tool(ToolState),
}

impl ItemState {
    fn value(&self) -> Value {
        match self {
            Self::Message(x) => json!({
                "id": x.id,
                "type": "message",
                "status": if x.item_done { "completed" } else { "in_progress" },
                "role": "assistant",
                "content": [{"type":"output_text","text":x.text,"annotations":[]}],
            }),
            Self::Reasoning(x) => {
                let mut object = json!({
                    "id": x.id,
                    "type": "reasoning",
                    "status": if x.item_done { "completed" } else { "in_progress" },
                    "summary": [{"type":"summary_text","text":x.text}],
                });
                if let Some(encrypted_content) = &x.encrypted_content {
                    object["encrypted_content"] = json!(encrypted_content);
                }
                object
            }
            Self::Tool(x) if x.custom => json!({
                "type": "custom_tool_call",
                "id": x.id,
                "call_id": x.id,
                "name": x.name,
                "status": if x.item_done { "completed" } else { "in_progress" },
                "input": if x.item_done { unwrap_custom_arguments(&x.arguments) } else { String::new() },
            }),
            Self::Tool(x) => json!({
                "type": "function_call",
                "id": x.id,
                "call_id": x.id,
                "name": x.name,
                "arguments": x.arguments,
                "status": if x.item_done { "completed" } else { "in_progress" },
            }),
        }
    }
}

fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn new_id(prefix: &str) -> String {
    format!("{}{}", prefix, Uuid::new_v4().simple())
}

fn number(value: Option<&Value>) -> Option<u64> {
    value.and_then(|v| {
        v.as_u64()
            .or_else(|| v.as_i64().filter(|n| *n >= 0).map(|n| n as u64))
    })
}

fn string(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).unwrap_or("").to_owned()
}

fn merge_fragment(current: &mut String, fragment: &str) {
    if fragment.is_empty() {
        return;
    }
    if current.is_empty() {
        *current = fragment.to_owned();
    } else if fragment.starts_with(current.as_str()) {
        *current = fragment.to_owned();
    } else if current.starts_with(fragment) || current.ends_with(fragment) {
        // Providers sometimes repeat the first or last identifier fragment.
    } else {
        current.push_str(fragment);
    }
}

fn unwrap_custom_arguments(arguments: &str) -> String {
    if arguments.is_empty() {
        return String::new();
    }
    match serde_json::from_str::<Value>(arguments) {
        Ok(Value::Object(object)) => object
            .get("content")
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| value.to_string())
            })
            .unwrap_or_else(|| arguments.to_owned()),
        _ => arguments.to_owned(),
    }
}

fn request_custom_tools(request: &Value) -> HashSet<String> {
    request
        .get("tools")
        .and_then(Value::as_array)
        .map(|tools| {
            tools
                .iter()
                .filter(|tool| tool.get("type").and_then(Value::as_str) == Some("custom"))
                .filter_map(|tool| tool.get("name").and_then(Value::as_str).map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// Converts Chat Completions and Anthropic message events into Responses API
/// event objects. The parent gateway owns SSE framing; this type only emits
/// JSON values and keeps all response state needed by the final snapshot.
pub struct ResponseBuilder {
    model: String,
    custom_tools: HashSet<String>,
    request: Value,
    response_id: String,
    created_at: i64,
    sequence_number: u64,
    status: String,
    started: bool,
    finished: bool,
    length_limited: bool,
    error: Option<Value>,
    usage: UsageState,
    items: Vec<ItemState>,
    message_position: Option<usize>,
    reasoning_position: Option<usize>,
    tool_by_index: HashMap<i64, usize>,
    tool_by_id: HashMap<String, usize>,
    pending_tools: HashMap<i64, PendingTool>,
    pending_tool_order: Vec<i64>,
    anthropic_blocks: BTreeMap<i64, Value>,
    anthropic_tool_inputs: HashMap<i64, String>,
    next_output_index: usize,
    anthropic_message_id: Option<String>,
}

impl ResponseBuilder {
    pub fn new(model: String, custom_tools: HashSet<String>, request: Value) -> Self {
        let custom_tools = if custom_tools.is_empty() {
            let from_request = request_custom_tools(&request);
            if from_request.is_empty() {
                custom_tools
            } else {
                from_request
            }
        } else {
            custom_tools
        };
        Self {
            model,
            custom_tools,
            request,
            response_id: new_id("resp_"),
            created_at: now_seconds(),
            sequence_number: 0,
            status: "in_progress".to_owned(),
            started: false,
            finished: false,
            length_limited: false,
            error: None,
            usage: UsageState::default(),
            items: Vec::new(),
            message_position: None,
            reasoning_position: None,
            tool_by_index: HashMap::new(),
            tool_by_id: HashMap::new(),
            pending_tools: HashMap::new(),
            pending_tool_order: Vec::new(),
            anthropic_blocks: BTreeMap::new(),
            anthropic_tool_inputs: HashMap::new(),
            next_output_index: 0,
            anthropic_message_id: None,
        }
    }

    fn event(&mut self, event_type: &str, mut body: Value) -> Value {
        if let Some(object) = body.as_object_mut() {
            object.insert("type".to_owned(), Value::String(event_type.to_owned()));
            object.insert("sequence_number".to_owned(), json!(self.sequence_number));
        }
        self.sequence_number = self.sequence_number.saturating_add(1);
        body
    }

    fn response_value_with_status(&self, status: &str) -> Value {
        let mut object = Map::new();
        object.insert("id".to_owned(), json!(self.response_id));
        object.insert("object".to_owned(), json!("response"));
        object.insert("created_at".to_owned(), json!(self.created_at));
        object.insert("model".to_owned(), json!(self.model));
        object.insert("status".to_owned(), json!(status));
        object.insert(
            "output".to_owned(),
            Value::Array(self.items.iter().map(ItemState::value).collect()),
        );
        object.insert(
            "usage".to_owned(),
            if self.usage.known {
                self.usage.value()
            } else {
                Value::Null
            },
        );
        object.insert("store".to_owned(), json!(false));
        object.insert(
            "error".to_owned(),
            self.error.clone().unwrap_or(Value::Null),
        );
        object.insert(
            "incomplete_details".to_owned(),
            if status == "incomplete" {
                json!({"reason":"max_output_tokens"})
            } else {
                Value::Null
            },
        );
        object.insert(
            "parallel_tool_calls".to_owned(),
            self.request
                .get("parallel_tool_calls")
                .cloned()
                .unwrap_or_else(|| json!(true)),
        );

        let metadata = self
            .request
            .get("metadata")
            .cloned()
            .unwrap_or_else(|| json!({}));
        object.insert("metadata".to_owned(), metadata);
        object.insert(
            "tools".to_owned(),
            self.request
                .get("tools")
                .cloned()
                .unwrap_or_else(|| json!([])),
        );
        object.insert(
            "tool_choice".to_owned(),
            self.request
                .get("tool_choice")
                .cloned()
                .unwrap_or_else(|| json!("auto")),
        );
        object.insert(
            "text".to_owned(),
            self.request
                .get("text")
                .cloned()
                .unwrap_or_else(|| json!({"format":{"type":"text"}})),
        );
        for key in [
            "instructions",
            "reasoning",
            "temperature",
            "top_p",
            "max_output_tokens",
            "truncation",
            "user",
            "previous_response_id",
        ] {
            if let Some(value) = self.request.get(key) {
                object.insert(key.to_owned(), value.clone());
            }
        }
        Value::Object(object)
    }

    fn response_event(&mut self, event_type: &str, status: &str) -> Value {
        self.event(
            event_type,
            json!({"response": self.response_value_with_status(status)}),
        )
    }

    pub fn start(&mut self) -> Vec<Value> {
        if self.started || self.finished {
            return Vec::new();
        }
        self.started = true;
        vec![
            self.response_event("response.created", "in_progress"),
            self.response_event("response.in_progress", "in_progress"),
        ]
    }

    fn ensure_started(&mut self, events: &mut Vec<Value>) {
        if !self.started && !self.finished {
            events.extend(self.start());
        }
    }

    fn fail_stream(&mut self, message: &str) -> Result<Vec<Value>, String> {
        self.mark_failed(
            "stream_error",
            "The upstream stream could not be converted.",
        );
        Err(message.to_owned())
    }

    fn mark_failed(&mut self, code: &str, message: &str) {
        if self.status == "failed" {
            return;
        }
        let safe_code = if code.is_empty() {
            "gateway_error"
        } else {
            code
        };
        self.error = Some(json!({"code":safe_code,"message":message}));
        self.status = "failed".to_owned();
        self.finished = true;
    }

    fn ensure_message(&mut self, events: &mut Vec<Value>) {
        if self.message_position.is_some() {
            return;
        }
        let id = self
            .anthropic_message_id
            .clone()
            .unwrap_or_else(|| new_id("msg_"));
        let output_index = self.next_output_index;
        self.next_output_index += 1;
        let position = self.items.len();
        self.items.push(ItemState::Message(MessageState {
            id: id.clone(),
            output_index,
            text: String::new(),
            text_done: false,
            part_done: false,
            item_done: false,
        }));
        self.message_position = Some(position);
        events.push(self.event(
            "response.output_item.added",
            json!({"output_index":output_index,"item":{
                "id":id,"type":"message","status":"in_progress","role":"assistant","content":[]
            }}),
        ));
        events.push(self.event(
            "response.content_part.added",
            json!({"item_id":id,"output_index":output_index,"content_index":0,
                "part":{"type":"output_text","text":"","annotations":[]}}),
        ));
    }

    fn ensure_reasoning(&mut self, events: &mut Vec<Value>) {
        if self.reasoning_position.is_some() {
            return;
        }
        let id = new_id("rs_");
        let output_index = self.next_output_index;
        self.next_output_index += 1;
        let position = self.items.len();
        self.items.push(ItemState::Reasoning(ReasoningState {
            id: id.clone(),
            output_index,
            text: String::new(),
            encrypted_content: None,
            text_done: false,
            part_done: false,
            item_done: false,
        }));
        self.reasoning_position = Some(position);
        events.push(self.event(
            "response.output_item.added",
            json!({"output_index":output_index,"item":{
                "id":id,"type":"reasoning","status":"in_progress","summary":[]
            }}),
        ));
        events.push(self.event(
            "response.reasoning_summary_part.added",
            json!({"item_id":id,"output_index":output_index,"summary_index":0,
                "part":{"type":"summary_text","text":""}}),
        ));
    }

    fn append_message_text(&mut self, text: &str, events: &mut Vec<Value>) {
        if text.is_empty() {
            return;
        }
        self.ensure_message(events);
        let Some(position) = self.message_position else {
            return;
        };
        let (id, output_index) = match &mut self.items[position] {
            ItemState::Message(item) => {
                item.text.push_str(text);
                (item.id.clone(), item.output_index)
            }
            _ => return,
        };
        events.push(self.event(
            "response.output_text.delta",
            json!({"item_id":id,"output_index":output_index,"content_index":0,"delta":text}),
        ));
    }

    fn append_reasoning_text(&mut self, text: &str, events: &mut Vec<Value>) {
        if text.is_empty() {
            return;
        }
        self.ensure_reasoning(events);
        let Some(position) = self.reasoning_position else {
            return;
        };
        let (id, output_index) = match &mut self.items[position] {
            ItemState::Reasoning(item) => {
                item.text.push_str(text);
                (item.id.clone(), item.output_index)
            }
            _ => return,
        };
        events.push(self.event(
            "response.reasoning_summary_text.delta",
            json!({"item_id":id,"output_index":output_index,"summary_index":0,"delta":text}),
        ));
    }

    fn append_anthropic_block_field(&mut self, index: i64, field: &str, fragment: &str) {
        if fragment.is_empty() {
            return;
        }
        let block = self
            .anthropic_blocks
            .entry(index)
            .or_insert_with(|| json!({"type":"thinking"}));
        let Some(object) = block.as_object_mut() else {
            return;
        };
        let current = object.get(field).and_then(Value::as_str).unwrap_or("");
        let mut value = current.to_owned();
        value.push_str(fragment);
        object.insert(field.to_owned(), Value::String(value));
    }

    fn anthropic_has_thinking(&self) -> bool {
        self.anthropic_blocks.values().any(|block| {
            matches!(
                block.get("type").and_then(Value::as_str),
                Some("thinking") | Some("redacted_thinking")
            )
        })
    }

    fn anthropic_encrypted_content(&self) -> Option<String> {
        if !self.anthropic_has_thinking() {
            return None;
        }
        let blocks: Vec<Value> = self.anthropic_blocks.values().cloned().collect();
        Some(format!(
            "codex-router-anthropic-v1:{}",
            json!({"model":self.model,"blocks":blocks})
        ))
    }

    fn capture_anthropic_block(&mut self, index: i64, block: &Value) {
        self.anthropic_blocks.insert(index, block.clone());
    }

    fn start_anthropic_tool_input(&mut self, index: i64, block: &Value) {
        let value = block.get("input").cloned().unwrap_or_else(|| json!({}));
        let initial = if value.as_object().is_some_and(Map::is_empty) {
            String::new()
        } else {
            value.to_string()
        };
        self.anthropic_tool_inputs.insert(index, initial);
    }

    fn append_anthropic_tool_input(&mut self, index: i64, fragment: &str) {
        self.anthropic_tool_inputs
            .entry(index)
            .or_default()
            .push_str(fragment);
    }

    fn finalize_anthropic_tool_inputs(&mut self) -> Result<(), String> {
        let inputs: Vec<(i64, String)> = self
            .anthropic_tool_inputs
            .iter()
            .map(|(index, input)| (*index, input.clone()))
            .collect();
        for (index, input) in inputs {
            let source = if input.is_empty() {
                "{}"
            } else {
                input.as_str()
            };
            let parsed: Value = serde_json::from_str(source)
                .map_err(|_| "Anthropic tool input is not valid JSON")?;
            if !parsed.is_object() {
                return Err("Anthropic tool input must be a JSON object".to_owned());
            }
            let block = self
                .anthropic_blocks
                .entry(index)
                .or_insert_with(|| json!({"type":"tool_use"}));
            if let Some(object) = block.as_object_mut() {
                object.insert("input".to_owned(), parsed);
            }
        }
        Ok(())
    }

    fn tool_position(&self, key: i64, id: &str) -> Option<usize> {
        if !id.is_empty() {
            if let Some(position) = self.tool_by_id.get(id) {
                return Some(*position);
            }
        }
        self.tool_by_index.get(&key).copied()
    }

    fn add_tool_item(&mut self, pending: PendingTool, events: &mut Vec<Value>) -> Option<usize> {
        if pending.name.is_empty() || pending.id.is_empty() {
            self.store_pending_tool(pending);
            return None;
        }
        let id = pending.id.clone();
        let custom = self.custom_tools.contains(&pending.name);
        let output_index = self.next_output_index;
        self.next_output_index += 1;
        let position = self.items.len();
        self.items.push(ItemState::Tool(ToolState {
            id: id.clone(),
            output_index,
            name: pending.name,
            arguments: pending.arguments.clone(),
            custom,
            item_done: false,
        }));
        self.tool_by_index.insert(pending.key, position);
        self.tool_by_id.insert(id.clone(), position);
        let mut added_item = Map::new();
        added_item.insert(
            "type".to_owned(),
            json!(if custom {
                "custom_tool_call"
            } else {
                "function_call"
            }),
        );
        added_item.insert("id".to_owned(), json!(id));
        added_item.insert("call_id".to_owned(), json!(id));
        added_item.insert("name".to_owned(), json!(self.tool_name(position)));
        added_item.insert("status".to_owned(), json!("in_progress"));
        if custom {
            added_item.insert("input".to_owned(), json!(""));
        } else {
            added_item.insert("arguments".to_owned(), json!(""));
        }
        events.push(self.event(
            "response.output_item.added",
            json!({"output_index":output_index,"item":Value::Object(added_item)}),
        ));
        if !custom && !pending.arguments.is_empty() {
            events.push(self.event(
                "response.function_call_arguments.delta",
                json!({"item_id":id,"output_index":output_index,"delta":pending.arguments}),
            ));
        }
        self.pending_tools.remove(&pending.key);
        self.pending_tool_order.retain(|key| *key != pending.key);
        Some(position)
    }

    fn store_pending_tool(&mut self, pending: PendingTool) {
        if !self.pending_tools.contains_key(&pending.key) {
            self.pending_tool_order.push(pending.key);
        }
        self.pending_tools.insert(pending.key, pending);
    }

    fn name_may_be_custom_fragment(&self, name: &str) -> bool {
        !name.is_empty()
            && self
                .custom_tools
                .iter()
                .any(|candidate| candidate != name && candidate.starts_with(name))
    }

    fn tool_name(&self, position: usize) -> String {
        match &self.items[position] {
            ItemState::Tool(item) => item.name.clone(),
            _ => String::new(),
        }
    }

    fn append_tool(
        &mut self,
        key: i64,
        id_fragment: &str,
        name_fragment: &str,
        argument_fragment: &str,
        events: &mut Vec<Value>,
    ) {
        if let Some(position) = self.tool_position(key, id_fragment) {
            let (id, output_index, custom, delta) = match &mut self.items[position] {
                ItemState::Tool(item) => {
                    if item.id.is_empty() {
                        item.id = id_fragment.to_owned();
                    }
                    merge_fragment(&mut item.name, name_fragment);
                    item.arguments.push_str(argument_fragment);
                    (
                        item.id.clone(),
                        item.output_index,
                        item.custom,
                        argument_fragment.to_owned(),
                    )
                }
                _ => return,
            };
            if !custom && !delta.is_empty() {
                events.push(self.event(
                    "response.function_call_arguments.delta",
                    json!({"item_id":id,"output_index":output_index,"delta":delta}),
                ));
            }
            return;
        }

        let mut pending = self.pending_tools.remove(&key).unwrap_or(PendingTool {
            key,
            id: String::new(),
            name: String::new(),
            arguments: String::new(),
        });
        merge_fragment(&mut pending.id, id_fragment);
        merge_fragment(&mut pending.name, name_fragment);
        pending.arguments.push_str(argument_fragment);
        if pending.name.is_empty()
            || pending.id.is_empty()
            || pending.arguments.is_empty()
            || self.name_may_be_custom_fragment(&pending.name)
        {
            self.store_pending_tool(pending);
            return;
        }
        self.add_tool_item(pending, events);
    }

    fn chat_tool(&mut self, tool: &Value, fallback_index: usize, events: &mut Vec<Value>) {
        let index = tool
            .get("index")
            .and_then(|value| value.as_i64())
            .unwrap_or(fallback_index as i64);
        let id = string(tool.get("id"));
        let function = tool.get("function").unwrap_or(&Value::Null);
        let name = string(function.get("name"));
        let arguments = string(function.get("arguments"));
        let key = if !id.is_empty() {
            self.tool_by_id
                .get(&id)
                .and_then(|position| match &self.items[*position] {
                    ItemState::Tool(_) => Some(index),
                    _ => None,
                })
                .unwrap_or(index)
        } else {
            index
        };
        self.append_tool(key, &id, &name, &arguments, events);
    }

    fn observe_chat_usage(&mut self, usage: &Value) {
        if usage.is_null() || !usage.is_object() {
            return;
        }
        self.usage.known = true;
        if let Some(value) = number(usage.get("prompt_tokens")) {
            self.usage.input_tokens = value;
        }
        if let Some(value) = number(usage.get("completion_tokens")) {
            self.usage.output_tokens = value;
        }
        if let Some(value) = number(usage.get("total_tokens")) {
            self.usage.total_tokens = Some(value);
        }
        if let Some(value) = number(usage["prompt_tokens_details"].get("cached_tokens")) {
            self.usage.cached_tokens = value;
        }
        if let Some(value) = number(usage["completion_tokens_details"].get("reasoning_tokens")) {
            self.usage.reasoning_tokens = value;
        }
    }

    fn process_chat_message(&mut self, message: &Value, events: &mut Vec<Value>) {
        if let Some(reasoning) = message.get("reasoning_content").and_then(Value::as_str) {
            self.append_reasoning_text(reasoning, events);
        }
        if let Some(content) = message.get("content") {
            match content {
                Value::String(text) => self.append_message_text(text, events),
                Value::Array(parts) => {
                    for part in parts {
                        if let Some(text) = part.get("text").and_then(Value::as_str) {
                            self.append_message_text(text, events);
                        }
                    }
                }
                _ => {}
            }
        }
        if let Some(tool_calls) = message.get("tool_calls").and_then(Value::as_array) {
            for (index, tool) in tool_calls.iter().enumerate() {
                self.chat_tool(tool, index, events);
            }
        }
    }

    pub fn chat_chunk(&mut self, chunk: &Value) -> Result<Vec<Value>, String> {
        if self.finished || self.status == "failed" {
            return Err("response builder is closed".to_owned());
        }
        let mut events = Vec::new();
        self.ensure_started(&mut events);
        if chunk.get("error").is_some() {
            return self.fail_stream("upstream Chat Completions stream error");
        }
        let Some(choices) = chunk.get("choices").and_then(Value::as_array) else {
            return self.fail_stream("Chat Completions chunk has no choices");
        };
        if let Some(usage) = chunk.get("usage") {
            self.observe_chat_usage(usage);
        }
        let Some(choice) = choices.first() else {
            return Ok(events);
        };
        if let Some(message) = choice.get("message") {
            if message.is_object() {
                self.process_chat_message(message, &mut events);
            }
        } else if let Some(delta) = choice.get("delta") {
            if !delta.is_object() {
                return self.fail_stream("Chat Completions delta is not an object");
            }
            if let Some(text) = delta.get("content").and_then(Value::as_str) {
                self.append_message_text(text, &mut events);
            }
            if let Some(reasoning) = delta.get("reasoning_content").and_then(Value::as_str) {
                self.append_reasoning_text(reasoning, &mut events);
            }
            if let Some(tool_calls) = delta.get("tool_calls").and_then(Value::as_array) {
                for (index, tool) in tool_calls.iter().enumerate() {
                    self.chat_tool(tool, index, &mut events);
                }
            }
        } else {
            return self.fail_stream("Chat Completions choice has no message or delta");
        }
        if choice
            .get("finish_reason")
            .and_then(Value::as_str)
            .is_some_and(|reason| reason == "length" || reason == "max_tokens")
        {
            self.length_limited = true;
        }
        Ok(events)
    }

    fn observe_anthropic_usage(&mut self, usage: &Value, message_start: bool) {
        if !usage.is_object() {
            return;
        }
        self.usage.known = true;
        if message_start {
            let input = number(usage.get("input_tokens")).unwrap_or(0);
            let read = number(usage.get("cache_read_input_tokens")).unwrap_or(0);
            let create = number(usage.get("cache_creation_input_tokens")).unwrap_or(0);
            self.usage.input_tokens = input + read + create;
            self.usage.cached_tokens = read;
        }
        if let Some(output) = number(usage.get("output_tokens")) {
            self.usage.output_tokens = output;
        }
    }

    fn anthropic_tool_start(&mut self, index: i64, block: &Value, events: &mut Vec<Value>) {
        let id = string(block.get("id"));
        let name = string(block.get("name"));
        let arguments = block
            .get("input")
            .filter(|value| {
                !value.is_null()
                    && !(value.is_object() && value.as_object().is_some_and(Map::is_empty))
            })
            .map(|value| value.to_string())
            .unwrap_or_default();
        self.append_tool(index, &id, &name, &arguments, events);
    }

    fn anthropic_full_message(&mut self, message: &Value, events: &mut Vec<Value>) {
        if let Some(id) = message.get("id").and_then(Value::as_str) {
            self.anthropic_message_id = Some(id.to_owned());
        }
        if let Some(usage) = message.get("usage") {
            self.observe_anthropic_usage(usage, true);
        }
        if let Some(content) = message.get("content").and_then(Value::as_array) {
            for (index, block) in content.iter().enumerate() {
                self.capture_anthropic_block(index as i64, block);
                match block.get("type").and_then(Value::as_str).unwrap_or("") {
                    "text" => {
                        if let Some(text) = block.get("text").and_then(Value::as_str) {
                            self.append_message_text(text, events);
                        }
                    }
                    "thinking" | "redacted_thinking" => {
                        self.ensure_reasoning(events);
                        if let Some(text) = block.get("thinking").and_then(Value::as_str) {
                            self.append_reasoning_text(text, events);
                        }
                    }
                    "tool_use" => {
                        self.start_anthropic_tool_input(index as i64, block);
                        self.anthropic_tool_start(index as i64, block, events);
                    }
                    _ => {}
                }
            }
        }
        if message
            .get("stop_reason")
            .and_then(Value::as_str)
            .is_some_and(|reason| reason == "max_tokens" || reason == "length")
        {
            self.length_limited = true;
        }
    }

    pub fn anthropic_chunk(&mut self, chunk: &Value) -> Result<Vec<Value>, String> {
        if self.finished || self.status == "failed" {
            return Err("response builder is closed".to_owned());
        }
        let mut events = Vec::new();
        self.ensure_started(&mut events);
        if chunk.get("error").is_some() {
            return self.fail_stream("upstream Anthropic stream error");
        }
        if chunk.get("type").and_then(Value::as_str) == Some("message") {
            self.anthropic_full_message(chunk, &mut events);
            return Ok(events);
        }
        let kind = chunk.get("type").and_then(Value::as_str).unwrap_or("");
        match kind {
            "message_start" => {
                if let Some(message) = chunk.get("message") {
                    if let Some(id) = message.get("id").and_then(Value::as_str) {
                        self.anthropic_message_id = Some(id.to_owned());
                    }
                    if let Some(usage) = message.get("usage") {
                        self.observe_anthropic_usage(usage, true);
                    }
                }
            }
            "content_block_start" => {
                let index = number(chunk.get("index")).unwrap_or(0) as i64;
                if let Some(block) = chunk.get("content_block") {
                    self.capture_anthropic_block(index, block);
                    match block.get("type").and_then(Value::as_str).unwrap_or("") {
                        "text" => {
                            self.ensure_message(&mut events);
                            if let Some(text) = block.get("text").and_then(Value::as_str) {
                                self.append_message_text(text, &mut events);
                            }
                        }
                        "thinking" | "redacted_thinking" => {
                            self.ensure_reasoning(&mut events);
                            if let Some(text) = block.get("thinking").and_then(Value::as_str) {
                                self.append_reasoning_text(text, &mut events);
                            }
                        }
                        "tool_use" => {
                            self.start_anthropic_tool_input(index, block);
                            self.anthropic_tool_start(index, block, &mut events);
                        }
                        _ => {}
                    }
                }
            }
            "content_block_delta" => {
                let index = number(chunk.get("index")).unwrap_or(0) as i64;
                let delta = chunk.get("delta").unwrap_or(&Value::Null);
                match delta.get("type").and_then(Value::as_str).unwrap_or("") {
                    "text_delta" => {
                        if let Some(text) = delta.get("text").and_then(Value::as_str) {
                            self.append_anthropic_block_field(index, "text", text);
                            self.append_message_text(text, &mut events);
                        }
                    }
                    "thinking_delta" => {
                        if let Some(text) = delta.get("thinking").and_then(Value::as_str) {
                            self.append_anthropic_block_field(index, "thinking", text);
                            self.append_reasoning_text(text, &mut events);
                        }
                    }
                    "signature_delta" => {
                        if let Some(signature) = delta.get("signature").and_then(Value::as_str) {
                            self.append_anthropic_block_field(index, "signature", signature);
                        }
                    }
                    "input_json_delta" => {
                        let partial = string(delta.get("partial_json"));
                        self.append_anthropic_tool_input(index, &partial);
                        self.append_tool(index, "", "", &partial, &mut events);
                    }
                    _ => {}
                }
            }
            "message_delta" => {
                if let Some(usage) = chunk.get("usage") {
                    self.observe_anthropic_usage(usage, false);
                }
                if chunk["delta"]
                    .get("stop_reason")
                    .and_then(Value::as_str)
                    .is_some_and(|reason| reason == "max_tokens" || reason == "length")
                {
                    self.length_limited = true;
                }
            }
            "message_stop" => {}
            _ => {}
        }
        Ok(events)
    }

    fn close_message(&mut self, position: usize, events: &mut Vec<Value>) {
        let (id, output_index, text, text_done, part_done, item_done) = match &self.items[position]
        {
            ItemState::Message(item) => (
                item.id.clone(),
                item.output_index,
                item.text.clone(),
                item.text_done,
                item.part_done,
                item.item_done,
            ),
            _ => return,
        };
        if !text_done {
            events.push(self.event(
                "response.output_text.done",
                json!({"item_id":id,"output_index":output_index,"content_index":0,"text":text}),
            ));
            if let ItemState::Message(item) = &mut self.items[position] {
                item.text_done = true;
            }
        }
        if !part_done {
            events.push(self.event(
                "response.content_part.done",
                json!({"item_id":id,"output_index":output_index,"content_index":0,
                    "part":{"type":"output_text","text":text,"annotations":[]}}),
            ));
            if let ItemState::Message(item) = &mut self.items[position] {
                item.part_done = true;
            }
        }
        if !item_done {
            if let ItemState::Message(item) = &mut self.items[position] {
                item.item_done = true;
            }
            let item = self.items[position].value();
            events.push(self.event(
                "response.output_item.done",
                json!({"output_index":output_index,"item":item}),
            ));
        }
    }

    fn close_reasoning(&mut self, position: usize, events: &mut Vec<Value>) {
        if let Some(encrypted_content) = self.anthropic_encrypted_content() {
            if let ItemState::Reasoning(item) = &mut self.items[position] {
                item.encrypted_content = Some(encrypted_content);
            }
        }
        let (id, output_index, text, text_done, part_done, item_done) = match &self.items[position]
        {
            ItemState::Reasoning(item) => (
                item.id.clone(),
                item.output_index,
                item.text.clone(),
                item.text_done,
                item.part_done,
                item.item_done,
            ),
            _ => return,
        };
        if !text_done {
            events.push(self.event(
                "response.reasoning_summary_text.done",
                json!({"item_id":id,"output_index":output_index,"summary_index":0,"text":text}),
            ));
            if let ItemState::Reasoning(item) = &mut self.items[position] {
                item.text_done = true;
            }
        }
        if !part_done {
            events.push(self.event(
                "response.reasoning_summary_part.done",
                json!({"item_id":id,"output_index":output_index,"summary_index":0,
                    "part":{"type":"summary_text","text":text}}),
            ));
            if let ItemState::Reasoning(item) = &mut self.items[position] {
                item.part_done = true;
            }
        }
        if !item_done {
            if let ItemState::Reasoning(item) = &mut self.items[position] {
                item.item_done = true;
            }
            let item = self.items[position].value();
            events.push(self.event(
                "response.output_item.done",
                json!({"output_index":output_index,"item":item}),
            ));
        }
    }

    fn close_tool(&mut self, position: usize, events: &mut Vec<Value>) {
        let (id, output_index, arguments, custom, item_done) = match &self.items[position] {
            ItemState::Tool(item) => (
                item.id.clone(),
                item.output_index,
                item.arguments.clone(),
                item.custom,
                item.item_done,
            ),
            _ => return,
        };
        if !item_done {
            let arguments = if !custom && arguments.is_empty() {
                "{}".to_owned()
            } else {
                arguments
            };
            if !custom {
                if let ItemState::Tool(item) = &mut self.items[position] {
                    item.arguments = arguments.clone();
                }
            }
            if custom {
                events.push(self.event(
                    "response.custom_tool_call_input.done",
                    json!({"item_id":id,"output_index":output_index,"input":unwrap_custom_arguments(&arguments)}),
                ));
            } else {
                events.push(self.event(
                    "response.function_call_arguments.done",
                    json!({"item_id":id,"output_index":output_index,"arguments":arguments}),
                ));
            }
            if let ItemState::Tool(item) = &mut self.items[position] {
                item.item_done = true;
            }
            let item = self.items[position].value();
            events.push(self.event(
                "response.output_item.done",
                json!({"output_index":output_index,"item":item}),
            ));
        }
    }

    pub fn finish(&mut self) -> Vec<Value> {
        if self.finished || self.status == "failed" {
            return Vec::new();
        }
        let mut events = self.start();
        if self.finalize_anthropic_tool_inputs().is_err() {
            self.mark_failed(
                "invalid_tool_input",
                "The upstream Anthropic tool input was invalid.",
            );
            let response = self.result();
            events.push(self.event("response.failed", json!({"response":response})));
            return events;
        }
        let pending_keys = self.pending_tool_order.clone();
        for key in pending_keys {
            let Some(pending) = self.pending_tools.remove(&key) else {
                continue;
            };
            if pending.name.is_empty() || pending.id.is_empty() {
                self.store_pending_tool(pending);
                self.mark_failed(
                    "invalid_tool_call",
                    "The upstream tool call was missing a name or id.",
                );
                let response = self.result();
                events.push(self.event("response.failed", json!({"response":response})));
                return events;
            }
            self.add_tool_item(pending, &mut events);
        }
        self.pending_tool_order.clear();
        for position in 0..self.items.len() {
            match self.items[position] {
                ItemState::Message(_) => self.close_message(position, &mut events),
                ItemState::Reasoning(_) => self.close_reasoning(position, &mut events),
                ItemState::Tool(_) => self.close_tool(position, &mut events),
            }
        }
        self.status = if self.length_limited {
            "incomplete"
        } else {
            "completed"
        }
        .to_owned();
        self.finished = true;
        let final_type = if self.length_limited {
            "response.incomplete"
        } else {
            "response.completed"
        };
        events.push(self.response_event(final_type, &self.status.clone()));
        events
    }

    pub fn result(&self) -> Value {
        self.response_value_with_status(&self.status)
    }

    pub fn failed(&mut self, code: &str, message: &str) -> Value {
        self.mark_failed(code, message);
        let response = self.result();
        self.event("response.failed", json!({"response":response}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn builder(request: Value) -> ResponseBuilder {
        ResponseBuilder::new("test-model".into(), HashSet::new(), request)
    }

    fn types(events: &[Value]) -> Vec<String> {
        events
            .iter()
            .filter_map(|event| event["type"].as_str().map(str::to_owned))
            .collect()
    }

    #[test]
    fn text_deltas_have_stable_sequence_and_full_finish() {
        let mut b = builder(json!({}));
        let mut events = b.start();
        events.extend(
            b.chat_chunk(&json!({"choices":[{"delta":{"content":"こんにちは"}}]}))
                .unwrap(),
        );
        events.extend(b.chat_chunk(&json!({"choices":[{"delta":{"content":"世界"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}})).unwrap());
        events.extend(b.finish());
        assert_eq!(events[0]["type"], "response.created");
        for (n, event) in events.iter().enumerate() {
            assert_eq!(event["sequence_number"], n);
        }
        assert_eq!(
            b.result()["output"][0]["content"][0]["text"],
            "こんにちは世界"
        );
        assert_eq!(b.result()["status"], "completed");
        assert_eq!(b.result()["usage"]["total_tokens"], 5);
    }

    #[test]
    fn tool_fragments_are_concatenated_and_indices_are_independent() {
        let mut b = builder(json!({}));
        b.start();
        let first: Value = serde_json::from_str(
            r#"{"choices":[{"delta":{"tool_calls":[
            {"index":0,"id":"call_a","function":{"name":"read","arguments":"{\"a\":"}},
            {"index":1,"id":"call_b","function":{"name":"write","arguments":"{\"b\":"}}
        ]}}]}"#,
        )
        .unwrap();
        let second: Value = serde_json::from_str(
            r#"{"choices":[{"delta":{"tool_calls":[
            {"index":0,"function":{"arguments":"1}"}},
            {"index":1,"function":{"arguments":"2}"}}
        ]}}]}"#,
        )
        .unwrap();
        let first = b.chat_chunk(&first).unwrap();
        let second = b.chat_chunk(&second).unwrap();
        let mut all = first;
        all.extend(second);
        all.extend(b.finish());
        let result = b.result();
        let a = result["output"].as_array().unwrap();
        assert_eq!(a.len(), 2);
        assert_eq!(a[0]["arguments"], "{\"a\":1}");
        assert_eq!(a[1]["arguments"], "{\"b\":2}");
        assert!(types(&all).contains(&"response.function_call_arguments.delta".into()));
    }

    #[test]
    fn custom_tool_unwraps_content_and_hides_function_deltas() {
        let mut custom = HashSet::new();
        custom.insert("apply_patch".into());
        let mut b = ResponseBuilder::new("m".into(), custom, json!({}));
        b.start();
        let first: Value = serde_json::from_str(r#"{"choices":[{"delta":{"tool_calls":[
            {"index":0,"id":"call_patch","function":{"name":"apply_patch","arguments":"{\"content\":\"*** Begin "}}
        ]}}]}"#).unwrap();
        let events = b.chat_chunk(&first).unwrap();
        assert!(!types(&events).contains(&"response.function_call_arguments.delta".into()));
        let second: Value = serde_json::from_str(
            r#"{"choices":[{"delta":{"tool_calls":[
            {"index":0,"function":{"arguments":"Patch\"}"}}
        ]}}]}"#,
        )
        .unwrap();
        b.chat_chunk(&second).unwrap();
        let finished = b.finish();
        assert!(types(&finished).contains(&"response.custom_tool_call_input.done".into()));
        assert_eq!(b.result()["output"][0]["type"], "custom_tool_call");
        assert_eq!(b.result()["output"][0]["input"], "*** Begin Patch");
    }

    #[test]
    fn failed_is_a_typed_terminal_event() {
        let mut b = builder(json!({}));
        b.start();
        let event = b.failed("upstream_error", "safe static message");
        assert_eq!(event["type"], "response.failed");
        assert_eq!(event["response"]["status"], "failed");
        assert_eq!(event["response"]["error"]["code"], "upstream_error");
        assert_eq!(event["sequence_number"], 2);
        assert!(b.finish().is_empty());
    }

    #[test]
    fn reaching_max_output_tokens_with_stop_is_completed() {
        let mut b = builder(json!({"max_output_tokens":1}));
        b.start();
        b.chat_chunk(&json!({"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}],"usage":{"completion_tokens":1}})).unwrap();
        let events = b.finish();
        assert_eq!(events.last().unwrap()["type"], "response.completed");
        assert_eq!(b.result()["status"], "completed");
    }

    #[test]
    fn fragmented_custom_name_waits_for_full_name() {
        let mut custom = HashSet::new();
        custom.insert("apply_patch".to_owned());
        let mut b = ResponseBuilder::new("m".into(), custom, json!({}));
        b.start();
        let first: Value = serde_json::from_str(
            r#"{"choices":[{"delta":{"tool_calls":[
            {"index":0,"id":"call_frag","function":{"name":"apply_","arguments":"{\"content\":\"x"}}
        ]}}]}"#,
        )
        .unwrap();
        let first_events = b.chat_chunk(&first).unwrap();
        assert!(!types(&first_events).contains(&"response.output_item.added".into()));
        let second: Value = serde_json::from_str(
            r#"{"choices":[{"delta":{"tool_calls":[
            {"index":0,"function":{"name":"patch","arguments":"\"}"}}
        ]}}]}"#,
        )
        .unwrap();
        let second_events = b.chat_chunk(&second).unwrap();
        assert!(types(&second_events).contains(&"response.output_item.added".into()));
        assert!(!types(&second_events).contains(&"response.function_call_arguments.delta".into()));
        b.finish();
        let result = b.result();
        assert_eq!(result["output"][0]["type"], "custom_tool_call");
        assert_eq!(result["output"][0]["name"], "apply_patch");
        assert_eq!(result["output"][0]["input"], "x");
    }

    #[test]
    fn empty_arguments_tool_flushes_at_finish() {
        let mut b = builder(json!({}));
        b.start();
        let events = b
            .chat_chunk(&json!({"choices":[{"delta":{"tool_calls":[
            {"index":0,"id":"call_empty","function":{"name":"empty_args","arguments":""}}
        ]},"finish_reason":"stop"}]}))
            .unwrap();
        assert!(!types(&events).contains(&"response.output_item.added".into()));
        let final_events = b.finish();
        assert!(types(&final_events).contains(&"response.function_call_arguments.done".into()));
        assert_eq!(b.result()["output"][0]["arguments"], "{}");
    }

    #[test]
    fn chat_nonstream_reasoning_precedes_message_and_tool() {
        let mut b = builder(json!({}));
        b.start();
        b.chat_chunk(&json!({"choices":[{"message":{
            "reasoning_content":"think","content":"answer",
            "tool_calls":[{"id":"call_order","index":0,"function":{"name":"tool","arguments":"{}"}}]
        }}]}))
        .unwrap();
        let output = b.result()["output"].clone();
        assert_eq!(output[0]["type"], "reasoning");
        assert_eq!(output[1]["type"], "message");
        assert_eq!(output[2]["type"], "function_call");
    }

    #[test]
    fn nonstream_anthropic_thinking_signature_and_tool_are_opaque() {
        let mut b = builder(json!({}));
        b.start();
        let blocks = json!([
            {"type":"thinking","thinking":"考察","signature":"sig-1"},
            {"type":"tool_use","id":"call-1","name":"lookup","input":{"q":"x"}}
        ]);
        b.anthropic_chunk(&json!({
            "type":"message","id":"msg-full","content":blocks,
            "stop_reason":"end_turn"
        }))
        .unwrap();
        b.finish();
        let result = b.result();
        let encrypted = result["output"][0]["encrypted_content"].as_str().unwrap();
        let payload: Value = serde_json::from_str(
            encrypted
                .strip_prefix("codex-router-anthropic-v1:")
                .unwrap(),
        )
        .unwrap();
        assert_eq!(payload["model"], "test-model");
        assert_eq!(payload["blocks"], blocks);
        assert_eq!(result["output"][1]["arguments"], "{\"q\":\"x\"}");
    }

    #[test]
    fn streaming_anthropic_preserves_interleaved_signatures_redacted_and_tools() {
        let mut b = builder(json!({}));
        b.start();
        b.anthropic_chunk(&json!({"type":"content_block_start","index":0,
            "content_block":{"type":"thinking","thinking":"seed","signature":""}}))
            .unwrap();
        b.anthropic_chunk(&json!({"type":"content_block_delta","index":0,
            "delta":{"type":"thinking_delta","thinking":"-a"}}))
            .unwrap();
        b.anthropic_chunk(&json!({"type":"content_block_delta","index":0,
            "delta":{"type":"signature_delta","signature":"sig-a"}}))
            .unwrap();
        b.anthropic_chunk(&json!({"type":"content_block_delta","index":0,
            "delta":{"type":"signature_delta","signature":"-b"}}))
            .unwrap();
        b.anthropic_chunk(&json!({"type":"content_block_start","index":1,
            "content_block":{"type":"tool_use","id":"call-1","name":"one","input":{}}}))
            .unwrap();
        b.anthropic_chunk(&json!({"type":"content_block_delta","index":1,
            "delta":{"type":"input_json_delta","partial_json":"{\"x\":"}}))
            .unwrap();
        b.anthropic_chunk(&json!({"type":"content_block_delta","index":1,
            "delta":{"type":"input_json_delta","partial_json":"1}"}}))
            .unwrap();
        b.anthropic_chunk(&json!({"type":"content_block_start","index":2,
            "content_block":{"type":"redacted_thinking","data":"opaque"}}))
            .unwrap();
        b.anthropic_chunk(&json!({"type":"content_block_start","index":3,
            "content_block":{"type":"tool_use","id":"call-2","name":"two","input":{}}}))
            .unwrap();
        let events = b.finish();
        assert!(types(&events).contains(&"response.completed".into()));
        let result = b.result();
        let output = result["output"].as_array().unwrap();
        let encrypted = output
            .iter()
            .find(|item| item["type"] == "reasoning")
            .unwrap()["encrypted_content"]
            .as_str()
            .unwrap();
        let payload: Value = serde_json::from_str(
            encrypted
                .strip_prefix("codex-router-anthropic-v1:")
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            payload["blocks"],
            json!([
                {"type":"thinking","thinking":"seed-a","signature":"sig-a-b"},
                {"type":"tool_use","id":"call-1","name":"one","input":{"x":1}},
                {"type":"redacted_thinking","data":"opaque"},
                {"type":"tool_use","id":"call-2","name":"two","input":{}}
            ])
        );
        assert_eq!(
            output.iter().find(|item| item["id"] == "call-2").unwrap()["arguments"],
            "{}"
        );
    }

    #[test]
    fn reasoning_and_anthropic_usage_are_preserved() {
        let mut b = builder(json!({"max_output_tokens":10}));
        b.start();
        b.anthropic_chunk(&json!({"type":"message_start","message":{"id":"msg_anthropic","usage":{"input_tokens":4,"cache_read_input_tokens":2,"cache_creation_input_tokens":1}}})).unwrap();
        b.anthropic_chunk(&json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}})).unwrap();
        b.anthropic_chunk(&json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"考える"}})).unwrap();
        b.anthropic_chunk(&json!({"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}})).unwrap();
        b.anthropic_chunk(&json!({"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"答え"}})).unwrap();
        b.anthropic_chunk(&json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}})).unwrap();
        b.finish();
        assert_eq!(b.result()["output"][0]["type"], "reasoning");
        assert_eq!(b.result()["usage"]["input_tokens"], 7);
        assert_eq!(
            b.result()["usage"]["input_tokens_details"]["cached_tokens"],
            2
        );
        assert_eq!(b.result()["usage"]["output_tokens"], 3);
    }

    #[test]
    fn nonstream_anthropic_and_length_error_are_safe_and_idempotent() {
        let mut b = builder(json!({"max_output_tokens":1}));
        b.start();
        b.anthropic_chunk(&json!({"type":"message","id":"msg_full","content":[{"type":"text","text":"full"},{"type":"tool_use","id":"call_x","name":"x","input":{"v":1}}],"stop_reason":"max_tokens","usage":{"input_tokens":1,"output_tokens":1}})).unwrap();
        let first = b.finish();
        let second = b.finish();
        assert!(!first.is_empty());
        assert!(second.is_empty());
        assert_eq!(b.result()["status"], "incomplete");
        let mut error_builder = builder(json!({}));
        let result = error_builder.chat_chunk(&json!({"error":{"message":"bad"}}));
        assert!(result.is_err());
        assert_eq!(error_builder.result()["status"], "failed");
        assert_eq!(error_builder.finish().len(), 0);
    }
}
