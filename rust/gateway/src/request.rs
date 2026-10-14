use serde_json::{json, Map, Value};
use std::collections::HashSet;

pub struct Converted {
    pub body: Value,
    pub custom_tools: HashSet<String>,
}

fn string(v: &Value) -> String {
    v.as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| v.to_string())
}

fn text_content(v: &Value) -> Value {
    if v.is_null() {
        return Value::Null;
    }
    if v.is_string() {
        return v.clone();
    }
    let Some(parts) = v.as_array() else {
        return json!(string(v));
    };
    json!(parts
        .iter()
        .map(|p| match p["type"].as_str().unwrap_or("") {
            "input_text" | "output_text" | "text" => json!({"type":"text","text":p["text"]}),
            "refusal" => json!({"type":"text","text":p["refusal"]}),
            "input_image" => {
                let mut image = json!({"url": p["image_url"]});
                if let Some(detail) = p.get("detail") {
                    image["detail"] = detail.clone();
                }
                json!({"type":"image_url","image_url":image})
            }
            "input_file" => {
                let mut file = Map::new();
                for k in ["file_id", "file_data", "filename"] {
                    if let Some(x) = p.get(k) {
                        file.insert(k.into(), x.clone());
                    }
                }
                json!({"type":"file","file":file})
            }
            _ => p.clone(),
        })
        .collect::<Vec<_>>())
}

fn append_call(messages: &mut Vec<Value>, call: Value) {
    if let Some(last) = messages.last_mut() {
        if last["role"] == "assistant" {
            let calls = last
                .as_object_mut()
                .unwrap()
                .entry("tool_calls")
                .or_insert(json!([]));
            calls.as_array_mut().unwrap().push(call);
            return;
        }
    }
    messages.push(json!({"role":"assistant","content":null,"tool_calls":[call]}));
}

fn chat_tools(tools: &[Value], custom: &mut HashSet<String>) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    for tool in tools {
        match tool["type"].as_str().unwrap_or("") {
            "function" => {
                if tool.get("function").is_some() {
                    out.push(tool.clone());
                    continue;
                }
                let mut f = Map::new();
                for k in ["name", "description", "parameters", "strict"] {
                    if let Some(x) = tool.get(k) {
                        f.insert(k.into(), x.clone());
                    }
                }
                out.push(json!({"type":"function","function":f}));
            }
            "custom" => {
                let name = tool["name"].as_str().ok_or("Custom tool needs a name")?;
                custom.insert(name.into());
                let mut description = tool["description"].as_str().unwrap_or("").to_string();
                if let Some(grammar) = tool["format"]["definition"].as_str() {
                    description.push_str(&format!(
                        "\n\nFormat:\n```{}\n{}\n```",
                        tool["format"]["syntax"].as_str().unwrap_or(""),
                        grammar
                    ));
                }
                out.push(json!({"type":"function","function":{
                    "name":name,"description":description,
                    "parameters":{"type":"object","properties":{"content":{"type":"string","description":format!("The {name} content following the specified format")}},"required":["content"]}
                }}));
            }
            "namespace" => {
                let nested = tool["tools"]
                    .as_array()
                    .ok_or("Namespace tool needs tools")?;
                out.extend(chat_tools(nested, custom)?);
            }
            _ => return Err("Unsupported hosted tool for this provider".into()),
        }
    }
    Ok(out)
}

pub fn chat(request: &Value, model: &str) -> Result<Converted, String> {
    let mut messages = Vec::new();
    if let Some(instructions) = request.get("instructions").filter(|x| !x.is_null()) {
        messages.push(json!({"role":"system","content":instructions}));
    }
    match request.get("input") {
        Some(Value::String(s)) => messages.push(json!({"role":"user","content":s})),
        Some(Value::Array(items)) => {
            for item in items {
                match item["type"].as_str().unwrap_or("message") {
                    "message" => {
                        let mut message = json!({"role":item["role"].as_str().unwrap_or("user"),"content":text_content(&item["content"])});
                        for key in ["tool_calls", "reasoning_content"] {
                            if let Some(value) = item.get(key) {
                                message[key] = value.clone();
                            }
                        }
                        messages.push(message);
                    }
                    "function_call" | "custom_tool_call" => {
                        let args = if item["type"] == "custom_tool_call" {
                            json!({"content":item["input"]}).to_string()
                        } else {
                            item["arguments"].as_str().unwrap_or("{}").to_string()
                        };
                        append_call(
                            &mut messages,
                            json!({"id":item["call_id"],"type":"function","function":{"name":item["name"],"arguments":args}}),
                        );
                    }
                    "function_call_output" | "custom_tool_call_output" => {
                        let content = if item["output"].is_array() {
                            text_content(&item["output"])
                        } else {
                            json!(string(&item["output"]))
                        };
                        messages.push(
                            json!({"role":"tool","tool_call_id":item["call_id"],"content":content}),
                        );
                    }
                    "reasoning" => {
                        let summary = item["summary"]
                            .as_array()
                            .map(|xs| {
                                xs.iter()
                                    .filter_map(|p| p["text"].as_str())
                                    .collect::<String>()
                            })
                            .unwrap_or_default();
                        let signed = if let Some(raw) = item["encrypted_content"]
                            .as_str()
                            .and_then(|s| s.strip_prefix("codex-router-anthropic-v1:"))
                        {
                            let record: Value = serde_json::from_str(raw)
                                .map_err(|_| "Invalid signed reasoning context")?;
                            if record["model"] == request["model"] {
                                let blocks = record["blocks"]
                                    .as_array()
                                    .ok_or("Invalid signed reasoning blocks")?;
                                if !blocks
                                    .iter()
                                    .all(|b| b.is_object() && b["type"].is_string())
                                {
                                    return Err("Invalid signed reasoning block".into());
                                }
                                Some(json!(blocks))
                            } else {
                                None
                            }
                        } else {
                            None
                        };
                        if !summary.is_empty() || signed.is_some() {
                            let mut message = json!({"role":"assistant","content":null,"reasoning_content":summary});
                            if let Some(blocks) = signed {
                                message["anthropic_blocks"] = blocks;
                            }
                            messages.push(message);
                        }
                    }
                    _ => return Err("Unsupported Responses input item".into()),
                }
            }
        }
        _ => return Err("input must be a string or an array".into()),
    }
    let mut custom = HashSet::new();
    let tools = chat_tools(
        request["tools"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[]),
        &mut custom,
    )?;
    let mut body = json!({"model":model,"messages":messages,"stream":request["stream"].as_bool().unwrap_or(false)});
    if !tools.is_empty() {
        body["tools"] = json!(tools);
    }
    if let Some(choice) = request.get("tool_choice") {
        body["tool_choice"] = if choice.is_object() {
            json!({"type":"function","function":{"name":choice["name"]}})
        } else {
            choice.clone()
        };
    }
    for k in [
        "temperature",
        "top_p",
        "parallel_tool_calls",
        "metadata",
        "user",
        "service_tier",
    ] {
        if let Some(x) = request.get(k) {
            body[k] = x.clone();
        }
    }
    if let Some(limit) = request.get("max_output_tokens") {
        body["max_tokens"] = limit.clone();
    }
    if let Some(effort) = request["reasoning"].get("effort") {
        body["reasoning_effort"] = effort.clone();
    }
    if let Some(format) = request["text"].get("format") {
        if format["type"] == "json_schema" {
            let mut schema = format.clone();
            schema.as_object_mut().unwrap().remove("type");
            body["response_format"] = json!({"type":"json_schema","json_schema":schema});
        } else if format["type"] == "json_object" {
            body["response_format"] = format.clone();
        }
    }
    if body["stream"] == true {
        body["stream_options"] = json!({"include_usage":true});
    }
    Ok(Converted {
        body,
        custom_tools: custom,
    })
}

fn anthropic_content(content: &Value) -> Result<Vec<Value>, String> {
    if content.is_null() {
        return Ok(Vec::new());
    }
    if let Some(s) = content.as_str() {
        return Ok(vec![json!({"type":"text","text":s})]);
    }
    let mut blocks = Vec::new();
    for p in content.as_array().ok_or("Invalid message content")? {
        match p["type"].as_str().unwrap_or("") {
            "text" => blocks.push(p.clone()),
            "image_url" => {
                let url = p["image_url"]["url"].as_str().ok_or("Invalid image URL")?;
                let source = if let Some(data) = url.strip_prefix("data:") {
                    let (media, payload) = data
                        .split_once(";base64,")
                        .ok_or("Image data must be base64")?;
                    json!({"type":"base64","media_type":media,"data":payload})
                } else {
                    json!({"type":"url","url":url})
                };
                blocks.push(json!({"type":"image","source":source}));
            }
            "file" => {
                let data = p["file"]["file_data"]
                    .as_str()
                    .ok_or("File data is required for Messages providers")?;
                let data = data
                    .strip_prefix("data:application/pdf;base64,")
                    .unwrap_or(data);
                blocks.push(json!({"type":"document","source":{"type":"base64","media_type":"application/pdf","data":data}}));
            }
            _ => return Err("Unsupported Messages content type".into()),
        }
    }
    Ok(blocks)
}

pub fn anthropic(request: &Value, model: &str) -> Result<Converted, String> {
    let converted = chat(request, model)?;
    let chat = &converted.body;
    let mut system = Vec::new();
    let mut messages: Vec<Value> = Vec::new();
    let mut restored_assistant = false;
    for msg in chat["messages"].as_array().unwrap() {
        let role = msg["role"].as_str().unwrap_or("user");
        if let Some(blocks) = msg.get("anthropic_blocks") {
            // A signed thinking context contains the original assistant turn,
            // including interleaved tools. Its visible Responses siblings are
            // already represented here and must not duplicate the tool calls.
            messages.push(json!({"role":"assistant","content":blocks}));
            restored_assistant = true;
            continue;
        }
        if role == "assistant" && restored_assistant {
            continue;
        }
        restored_assistant = false;
        if role == "system" || role == "developer" {
            system.extend(anthropic_content(&msg["content"])?);
            continue;
        }
        let mut content = anthropic_content(&msg["content"])?;
        let role = if role == "tool" {
            content = vec![
                json!({"type":"tool_result","tool_use_id":msg["tool_call_id"],"content":content}),
            ];
            "user"
        } else {
            if let Some(calls) = msg["tool_calls"].as_array() {
                for call in calls {
                    let args: Value = serde_json::from_str(
                        call["function"]["arguments"].as_str().unwrap_or("{}"),
                    )
                    .map_err(|_| "Tool arguments must be JSON")?;
                    content.push(json!({"type":"tool_use","id":call["id"],"name":call["function"]["name"],"input":args}));
                }
            }
            if role == "assistant" {
                "assistant"
            } else {
                "user"
            }
        };
        if let Some(last) = messages.last_mut() {
            if last["role"] == role {
                last["content"].as_array_mut().unwrap().extend(content);
                continue;
            }
        }
        if !content.is_empty() {
            messages.push(json!({"role":role,"content":content}));
        }
    }
    let mut body = json!({"model":model,"messages":messages,"max_tokens":chat["max_tokens"].as_u64().unwrap_or(16384),"stream":chat["stream"]});
    if !system.is_empty() {
        body["system"] = json!(system);
    }
    for k in ["temperature", "top_p", "reasoning_effort"] {
        if let Some(x) = chat.get(k) {
            body[k] = x.clone();
        }
    }
    if let Some(tools) = chat["tools"].as_array() {
        body["tools"] = json!(tools.iter().map(|t|json!({"name":t["function"]["name"],"description":t["function"]["description"].as_str().unwrap_or(""),"input_schema":t["function"]["parameters"]})).collect::<Vec<_>>());
        let choice = match chat["tool_choice"].as_str() {
            Some("required") => json!({"type":"any"}),
            Some("none") => json!({"type":"none"}),
            _ if chat["tool_choice"].is_object() => {
                json!({"type":"tool","name":chat["tool_choice"]["function"]["name"]})
            }
            _ => json!({"type":"auto"}),
        };
        body["tool_choice"] = choice;
        if chat["parallel_tool_calls"] == false {
            body["tool_choice"]["disable_parallel_tool_use"] = json!(true);
        }
    }
    if let Some(format) = chat.get("response_format") {
        if format["type"] == "json_schema" {
            body["output_config"] =
                json!({"format":{"type":"json_schema","schema":format["json_schema"]["schema"]}});
        }
    }
    Ok(Converted {
        body,
        custom_tools: converted.custom_tools,
    })
}
