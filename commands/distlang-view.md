---
description: Open the Distlang Agent Debugger dashboard for the current session
argument-hint: "[session-id]"
allowed-tools: Bash
---

!node "${CLAUDE_PLUGIN_ROOT}/bin/distlang-claude-code-view.js" $ARGUMENTS

Report the dashboard URL to the user on one line. If `opened` is true, mention the browser was opened; if false, ask the user to open the URL manually. If no session id was found, tell the user to run a Claude Code session first or pass a session id (e.g. `/distlang-view <session-id>`).
