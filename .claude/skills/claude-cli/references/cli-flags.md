# Claude CLI Flags — Complete Reference

All flags for `claude -p` (non-interactive/headless mode). Current as of v2.1.88.

## Core

| Flag | Type | Default | Description |
|-|-|-|-|
| `-p` / `--print` | boolean | false | Non-interactive mode. Required for all headless use. |
| `--output-format` | `text\|json\|stream-json` | `text` | Output format. `json` = single JSON result. `stream-json` = NDJSON events. |
| `--json-schema` | string (JSON) | none | Force structured JSON output matching schema. Only with `--output-format json`. Result in `structured_output` field. |
| `--model` | string | sonnet | Model alias (`haiku`, `sonnet`, `opus`) or full ID (`claude-sonnet-4-6`). |
| `--effort` | `low\|medium\|high\|max` | `high` | Thinking depth. `max` requires Opus. |
| `--fallback-model` | string | none | Auto-fallback when primary model is overloaded. |

## Permissions

| Flag | Type | Default | Description |
|-|-|-|-|
| `--permission-mode` | enum | `default` | `default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions` |
| `--dangerously-skip-permissions` | boolean | false | Equivalent to `--permission-mode bypassPermissions`. |
| `--allow-dangerously-skip-permissions` | boolean | false | Adds bypassPermissions to mode cycle without activating it. |
| `--permission-prompt-tool` | string | none | Delegates permission prompts to an MCP tool (non-interactive). |

## Tools

| Flag | Type | Default | Description |
|-|-|-|-|
| `--allowedTools` | string[] | none | Tools auto-approved without prompting. Supports glob: `"Bash(git log *)"`. |
| `--disallowedTools` | string[] | none | Block tools entirely from context. Higher precedence than allow. |
| `--tools` | string | all | Restrict available tools: `""` (none), `"default"` (all), `"Bash,Read"` (specific). |

## Sessions

| Flag | Type | Default | Description |
|-|-|-|-|
| `--resume` / `-r` | string | none | Resume session by UUID or name. |
| `--continue` / `-c` | boolean | false | Resume most recent session in CWD. |
| `--fork-session` | boolean | false | Branch from session without modifying original. Use with `--resume`. |
| `--session-id` | string (UUID) | auto | Force specific session UUID. |
| `--name` / `-n` | string | auto | Display name for session. Can resume by name. |
| `--no-session-persistence` | boolean | false | Don't save session to disk. |

## Limits

| Flag | Type | Default | Description |
|-|-|-|-|
| `--max-turns` | number | unlimited | Max agentic turns. Exits with `error_max_turns`. |
| `--max-budget-usd` | number | unlimited | Spending cap in USD. Exits with `error_max_budget_usd`. |

## Context & Settings

| Flag | Type | Default | Description |
|-|-|-|-|
| `--append-system-prompt` | string | none | Append text to default system prompt. |
| `--append-system-prompt-file` | string (path) | none | Append from file. |
| `--system-prompt` | string | none | Replace entire system prompt. |
| `--system-prompt-file` | string (path) | none | Replace from file. Mutually exclusive with `--system-prompt`. |
| `--setting-sources` | comma-separated | all | `user,project,local` — which settings files to load. |
| `--settings` | string (path or JSON) | none | Additional settings file. |
| `--plugin-dir` | string (path) | none | Load plugins from directory. Repeatable. |
| `--add-dir` | string[] (paths) | none | Grant access to additional directories. |
| `--bare` | boolean | false | Minimal mode. Skips hooks, skills, plugins, MCP, CLAUDE.md. Forces API key auth. |

## MCP

| Flag | Type | Default | Description |
|-|-|-|-|
| `--mcp-config` | string (path or JSON) | auto | Additional MCP server configurations. JSON must have `mcpServers` key — `{}` is invalid, use `'{"mcpServers": {}}'` for empty. |
| `--strict-mcp-config` | boolean | false | Only use MCP from `--mcp-config`, ignore all others. Use with `--mcp-config '{"mcpServers": {}}'` to prevent inner sessions from loading any MCP servers (avoids circular MCP loops). |

## Streaming

| Flag | Type | Default | Description |
|-|-|-|-|
| `--verbose` | boolean | false | Full turn-by-turn output. |
| `--include-partial-messages` | boolean | false | Emit `stream_event` with token-level deltas. Requires `stream-json`. |
| `--include-hook-events` | boolean | false | Include hook lifecycle events in stream. |
| `--input-format` | `text\|stream-json` | `text` | Stdin format. `stream-json` for piped NDJSON input. |
| `--replay-user-messages` | boolean | false | Echo stdin messages back on stdout. Requires `stream-json` I/O. |

## Other

| Flag | Type | Default | Description |
|-|-|-|-|
| `--worktree` / `-w` | string | none | Run in git worktree at `.claude/worktrees/<name>`. |
| `--agents` | string (JSON) | none | Define subagents inline. |
| `--agent` | string | none | Specify agent for this session. |
| `--disable-slash-commands` | boolean | false | Disable all skills/commands. |
| `--betas` | string[] | none | Beta headers for API requests. API key only. |
| `--chrome` / `--no-chrome` | boolean | settings | Enable/disable Chrome browser integration. |
| `--ide` | boolean | false | Auto-connect to IDE. |
| `--debug` | string | disabled | Debug logging with optional category filter. |
| `--debug-file` | string (path) | none | Write debug logs to file. |

## Permission Mode Details

| Mode | Reads | Edits | Shell/Network | Notes |
|-|-|-|-|-|
| `default` | auto | prompt | prompt | Standard interactive |
| `acceptEdits` | auto | auto | prompt | File edits approved |
| `plan` | auto | deny | deny | Read-only analysis |
| `auto` | auto | classifier | classifier | Requires Sonnet/Opus, API plan |
| `dontAsk` | allow-ruled | allow-ruled | allow-ruled | Fully non-interactive |
| `bypassPermissions` | auto | auto | auto | All approved (except protected paths) |

Protected paths (never auto-approved in any mode): `.git/`, `.vscode/`, `.claude/`, `.gitconfig`, shell rc files.
