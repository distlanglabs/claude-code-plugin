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

Hook events are normalized to Distlang Agent Debugger `session`, `interaction`, and `step` records and uploaded to:

```text
POST https://api.distlang.com/agent-debugger/v1/ingest
```

## Token Limitations

Claude Code hooks do not expose exact model token accounting in the MVP. The plugin does not fake token counts.

Each captured step includes this metadata in `payload_json.token_usage`:

```json
{
  "quality": "missing",
  "source": "claude_hook"
}
```

If transcript or statusline parsing is added later, derived values must use `quality: "aggregate_estimate"`, not `"exact"`. Reasoning tokens must not be claimed as exact unless Claude Code exposes them directly.

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
git tag -a v0.1.0 -m "v0.1.0"
git push origin v0.1.0
```

5. Optional GitHub release:

```bash
gh release create v0.1.0 --title "v0.1.0"
```
