import assert from "node:assert/strict";
import test from "node:test";
import { agentDebuggerUrl, newestRecentSessionID, sessionUrl } from "../src/view.js";

test("view URL helpers target Agent Debugger routes", () => {
  assert.equal(agentDebuggerUrl(), "https://dash.distlang.com/agent-debugger");
  assert.equal(sessionUrl("session 1"), "https://dash.distlang.com/agent-debugger/sessions/session%201");
});

test("newestRecentSessionID picks the newest uploaded Claude session", () => {
  assert.equal(newestRecentSessionID({
    body: {
      sessions: [
        { id: "older", ended_at: "2026-05-16T04:00:00.000Z" },
        { id: "newer", ended_at: "2026-05-16T05:00:00.000Z" },
        { id: "started", started_at: "2026-05-16T04:30:00.000Z" },
      ],
    },
  }), "newer");
});
