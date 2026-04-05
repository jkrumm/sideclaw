# NDJSON Stream Format (`--output-format stream-json`)

Each line is a complete JSON object. Parse with `JSON.parse(line)` per line.
Always buffer partial lines — don't parse until you hit `\n`.

## Event Types

### `system` / `init` — Session Initialization (always first)

```json
{
  "type": "system",
  "subtype": "init",
  "uuid": "<uuid>",
  "session_id": "<uuid>",
  "claude_code_version": "2.1.88",
  "model": "claude-sonnet-4-6",
  "cwd": "/path/to/project",
  "tools": ["Bash", "Read", "Edit", "Glob", "Grep"],
  "mcp_servers": [{ "name": "my-server", "status": "connected" }],
  "permissionMode": "default"
}
```

Capture `session_id` here for `--resume` usage.

### `assistant` — Complete Assistant Turn

```json
{
  "type": "assistant",
  "uuid": "<uuid>",
  "session_id": "<uuid>",
  "parent_tool_use_id": null,
  "message": {
    "id": "msg_...",
    "role": "assistant",
    "content": [
      { "type": "text", "text": "Here is the result..." },
      {
        "type": "tool_use",
        "id": "toolu_...",
        "name": "Bash",
        "input": { "command": "ls -la" }
      }
    ],
    "model": "claude-sonnet-4-6",
    "stop_reason": "tool_use",
    "usage": { "input_tokens": 1000, "output_tokens": 200, "cache_read_input_tokens": 0 }
  }
}
```

- `content[]` contains `text` and/or `tool_use` items
- `stop_reason`: `"tool_use"` (will continue) or `"end_turn"` (final response)
- `parent_tool_use_id`: non-null if from a subagent

### `user` — Tool Results

```json
{
  "type": "user",
  "uuid": "<uuid>",
  "session_id": "<uuid>",
  "message": {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "toolu_...",
        "content": [{ "type": "text", "text": "file1.txt\nfile2.txt" }]
      }
    ]
  }
}
```

### `result` — Final Completion (always last)

**Success:**
```json
{
  "type": "result",
  "subtype": "success",
  "session_id": "<uuid>",
  "duration_ms": 4521,
  "duration_api_ms": 3800,
  "is_error": false,
  "num_turns": 3,
  "result": "Here is the final answer...",
  "stop_reason": "end_turn",
  "total_cost_usd": 0.0042,
  "usage": {
    "input_tokens": 5000,
    "output_tokens": 400,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 4200
  },
  "structured_output": null
}
```

**Error subtypes:**

| `subtype` | Cause |
|-|-|
| `error_max_turns` | `--max-turns` limit reached |
| `error_during_execution` | Unhandled exception or tool failure |
| `error_max_budget_usd` | `--max-budget-usd` exceeded |
| `error_max_structured_output_retries` | `--json-schema` validation failed |

Error results have `is_error: true` and `errors: string[]` instead of `result`.

### `system` / `api_retry` — API Retry Event

```json
{
  "type": "system",
  "subtype": "api_retry",
  "attempt": 1,
  "max_retries": 3,
  "retry_delay_ms": 1000,
  "error_status": 529,
  "error": "rate_limit"
}
```

Error categories: `authentication_failed`, `billing_error`, `rate_limit`, `invalid_request`,
`server_error`, `max_output_tokens`, `unknown`.

### `system` / `compact_boundary` — Context Compaction

```json
{
  "type": "system",
  "subtype": "compact_boundary",
  "compact_metadata": {
    "trigger": "auto",
    "pre_tokens": 180000
  }
}
```

### `stream_event` — Token-level Streaming (requires `--include-partial-messages`)

```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_delta",
    "index": 0,
    "delta": { "type": "text_delta", "text": "Here is " }
  }
}
```

Inner `event.type` values:

| `event.type` | Meaning |
|-|-|
| `message_start` | New API message |
| `content_block_start` | New content block (`text` or `tool_use`) |
| `content_block_delta` | Incremental: `text_delta` or `input_json_delta` |
| `content_block_stop` | Block complete |
| `message_delta` | Stop reason, cumulative usage |
| `message_stop` | Full message done |

## Extracting Content from Stream

```typescript
function extractTextFromStream(streamOutput: string): string {
  const lines = streamOutput.split("\n");
  let content = "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "assistant" && event.message?.content) {
        for (const item of event.message.content) {
          if (item.type === "text" && item.text) content += item.text;
        }
      }
    } catch { /* skip */ }
  }
  return content.trim();
}
```

## Detecting Tool Usage

In `assistant` events, scan `message.content[]` for entries with `type === "tool_use"`:

```typescript
for (const item of event.message.content) {
  if (item.type === "tool_use") {
    console.error(`Tool: ${item.name}`, item.input);
  }
}
```

## Session ID Extraction (for --resume)

```typescript
// From stream-json
if (event.type === "system" && event.subtype === "init") {
  sessionId = event.session_id;
}

// From json output
const result = JSON.parse(stdout);
sessionId = result.session_id;
```
