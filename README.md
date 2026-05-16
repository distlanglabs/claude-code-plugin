# @distlang/claude-code-plugin

Claude Code hooks for capturing Agent Debugger sessions and uploading them to Distlang.

## Install

The recommended installer is served from Distlang:

```bash
curl -fsSL https://distlang.com/agent-debugger-claude-code | bash
```

The installer creates a managed npm install and writes Distlang hook entries to `~/.claude/settings.json`.

## Status

After installation, check local state and auth with:

```bash
~/.cache/distlang/claude-code-plugin/package/node_modules/.bin/distlang-claude-code-status
```

Enable uploads and sign in:

```bash
~/.cache/distlang/claude-code-plugin/package/node_modules/.bin/distlang-claude-code-status start
```

Disable uploads and sign out:

```bash
~/.cache/distlang/claude-code-plugin/package/node_modules/.bin/distlang-claude-code-status stop
```

## Slash Commands

Once the plugin is installed, two commands are available inside Claude Code:

- `/distlang-login` — runs the Distlang OAuth login flow (delegates to `distlang helpers login`) and enables uploads.
- `/distlang-view [session-id]` — opens the Agent Debugger dashboard for the current Claude Code session. With no argument, it resolves the session from `CLAUDE_SESSION_ID` or the most recent session in local state, and opens `https://dash.distlang.com/agent-debugger/sessions/<id>`. Override the base with `DISTLANG_DASHBOARD_URL`.

## Auth

This package uses the same Distlang CLI-managed auth flow as the OpenCode plugin. It does not ask you to paste an API token into Claude Code config.

Resolution order for the `distlang` binary:

1. `DISTLANG_BIN`
2. `distlang` on `PATH`
3. managed binary at `~/.cache/distlang/claude-code-plugin/bin/distlang`
4. auto-install into the managed binary path

## Captured Events

The integration configures these Claude Code hooks:

- `SessionStart`
- `UserPromptSubmit`
- `PreToolUse`
- `PostToolUse`
- `PostToolUseFailure`
- `Stop`
- `StopFailure`
- `SessionEnd`

Hook events are normalized to Distlang Agent Debugger `session`, `interaction`, and `step` records and uploaded **on every hook event** (not buffered) to:

```text
POST https://api.distlang.com/agent-debugger/v1/ingest
```

The local state file at `~/.config/claude/distlang-plugin.json` is the source of truth for in-flight sessions; each hook event refreshes it and then immediately pushes the full session+interactions+steps payload upstream, so the dashboard shows live progress as the session runs. `Stop`, `StopFailure`, and `SessionEnd` hooks have a 60s timeout to absorb large-transcript parses; all other hooks have a 15s timeout.

## Token Accounting

On flush events (`Stop`, `StopFailure`, `SessionEnd`) the plugin parses the Claude Code session transcript at `transcript_path` and emits one `llm_call` step per assistant message that has a `usage` block. Each `llm_call` step carries `input_tokens`, `output_tokens`, `cached_tokens`, `cache_creation_input_tokens` (in `payload_json`), and `context_size_tokens = input + cached + cache_creation`, with `model` set from the transcript record. LLM calls are grouped to interactions by the user `promptId` they follow, so per-interaction tokens and session totals match what the model actually consumed.

`tool_call` steps still carry no model token usage:

```json
{ "quality": "missing", "source": "claude_hook" }
```

`llm_call` steps mark their usage as exact:

```json
{ "quality": "exact", "source": "claude_transcript" }
```

If the transcript is unreadable at flush time, the plugin uploads with token totals at zero rather than estimating.

## Debugging

Useful overrides:

```bash
DISTLANG_CLAUDE_CODE_DEBUG=1 claude
DISTLANG_CLAUDE_CODE_LOG_FILE=/tmp/distlang-claude-code.log claude
DISTLANG_BIN=/path/to/distlang claude
DISTLANG_CLAUDE_CODE_STATE_FILE=/tmp/distlang-claude-state.json claude
DISTLANG_STORE_BASE_URL=https://api-staging.distlang.com claude
DISTLANG_AUTH_BASE_URL=https://auth-staging.distlang.com claude
```

## Development

```bash
npm test
```

## Release

This repo uses a manual release flow.

1. Verify the package locally:

```bash
npm run release
```

2. Push the release commit:

```bash
git push origin main
```

3. Publish to npm:

```bash
npm run publish:public
```

4. Create and push the release tag:

```bash
git tag -a v0.5.0 -m "v0.5.0"
git push origin v0.5.0
```

5. Optional GitHub release:

```bash
gh release create v0.5.0 --title "v0.5.0"
```
