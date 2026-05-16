---
description: Sign in to Distlang and enable Agent Debugger uploads
allowed-tools: Bash
---

!node "${CLAUDE_PLUGIN_ROOT}/bin/distlang-claude-code-status.js" start

Summarize the start result to the user in one sentence. If `logged_in` is true, confirm Agent Debugger uploads are enabled. If it is false or the command failed, report the error and suggest re-running `/distlang-start`.
