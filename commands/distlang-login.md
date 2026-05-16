---
description: Sign in to Distlang via OAuth and enable Agent Debugger uploads
allowed-tools: Bash
---

!node "${CLAUDE_PLUGIN_ROOT}/bin/distlang-claude-code-status.js" login

Summarize the login result to the user in one sentence. If `logged_in` is true, confirm sign-in. If it is false or the command failed, report the error and suggest re-running `/distlang-login`.
