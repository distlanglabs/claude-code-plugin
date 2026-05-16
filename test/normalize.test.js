import assert from "node:assert/strict";
import test from "node:test";

import { normalizeClaudeHookEvent } from "../src/normalize.js";

test("normalizes Claude Code session start into an ingest session", () => {
  const result = normalizeClaudeHookEvent({
    hook_event_name: "SessionStart",
    session_id: "ses_1",
    cwd: "/tmp/project-a",
    transcript_path: "/tmp/transcript.jsonl",
    timestamp: "2026-05-15T10:00:00.000Z",
  });

  assert.equal(result.payload.source, "claude-code");
  assert.equal(result.payload.project, "project-a");
  assert.equal(result.payload.session.id, "ses_1");
  assert.equal(result.payload.session.started_at, "2026-05-15T10:00:00.000Z");
  assert.deepEqual(result.payload.interactions, []);
});

test("normalizes user prompts with stable interaction ids and missing token usage", () => {
  let result = normalizeClaudeHookEvent({
    hook_event_name: "SessionStart",
    session_id: "ses_prompt",
    cwd: "/tmp/project-b",
    timestamp: "2026-05-15T10:00:00.000Z",
  });

  result = normalizeClaudeHookEvent({
    hook_event_name: "UserPromptSubmit",
    session_id: "ses_prompt",
    cwd: "/tmp/project-b",
    prompt_id: "prompt-1",
    prompt: "Fix the billing bug <system-reminder>SECRET</system-reminder>",
    timestamp: "2026-05-15T10:00:01.000Z",
  }, result.state);

  assert.equal(result.payload.interactions.length, 1);
  assert.equal(result.payload.interactions[0].id, "ses_prompt:int:prompt-1");
  assert.equal(result.payload.interactions[0].prompt, "Fix the billing bug");
  assert.equal(result.payload.session.input_tokens, 0);
  assert.equal(result.payload.session.reasoning_tokens, 0);
});

test("normalizes successful tool lifecycle with stable step id", () => {
  let result = normalizeClaudeHookEvent({ hook_event_name: "SessionStart", session_id: "ses_tool", cwd: "/tmp/proj", timestamp: "2026-05-15T10:00:00Z" });
  result = normalizeClaudeHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "ses_tool", prompt_id: "prompt-tool", prompt: "Read package", timestamp: "2026-05-15T10:00:01Z" }, result.state);
  result = normalizeClaudeHookEvent({
    hook_event_name: "PreToolUse",
    session_id: "ses_tool",
    tool_use_id: "tool-1",
    tool_name: "Read",
    tool_input: { file_path: "package.json" },
    timestamp: "2026-05-15T10:00:02Z",
  }, result.state);

  let step = result.payload.interactions[0].steps[0];
  assert.equal(step.id, "ses_tool:step:tool:tool-1");
  assert.equal(step.status, "started");
  assert.equal(step.tool_name, "Read");
  assert.equal(step.payload_json.token_usage.quality, "missing");
  assert.equal(step.payload_json.token_usage.source, "claude_hook");
  assert.equal(step.input_tokens, 0);
  assert.equal(step.output_tokens, 0);

  result = normalizeClaudeHookEvent({
    hook_event_name: "PostToolUse",
    session_id: "ses_tool",
    tool_use_id: "tool-1",
    tool_name: "Read",
    tool_input: { file_path: "package.json" },
    tool_response: { content: "{}" },
    timestamp: "2026-05-15T10:00:04Z",
  }, result.state);

  step = result.payload.interactions[0].steps[0];
  assert.equal(step.id, "ses_tool:step:tool:tool-1");
  assert.equal(step.status, "completed");
  assert.equal(step.duration_ms, 2000);
  assert.deepEqual(step.payload_json.tool_output, { content: "{}" });
});

test("normalizes failed tool and stop events", () => {
  let result = normalizeClaudeHookEvent({ hook_event_name: "SessionStart", session_id: "ses_fail", cwd: "/tmp/proj", timestamp: "2026-05-15T10:00:00Z" });
  result = normalizeClaudeHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "ses_fail", prompt_id: "prompt-fail", prompt: "Run command", timestamp: "2026-05-15T10:00:01Z" }, result.state);
  result = normalizeClaudeHookEvent({ hook_event_name: "PreToolUse", session_id: "ses_fail", tool_use_id: "tool-fail", tool_name: "Bash", tool_input: { command: "false" }, timestamp: "2026-05-15T10:00:02Z" }, result.state);
  result = normalizeClaudeHookEvent({ hook_event_name: "PostToolUseFailure", session_id: "ses_fail", tool_use_id: "tool-fail", tool_name: "Bash", error: "command failed", timestamp: "2026-05-15T10:00:03Z" }, result.state);

  assert.equal(result.payload.interactions[0].steps[0].status, "failed");
  assert.deepEqual(result.payload.interactions[0].steps[0].payload_json.error, { message: "command failed" });

  result = normalizeClaudeHookEvent({ hook_event_name: "StopFailure", session_id: "ses_fail", timestamp: "2026-05-15T10:00:05Z" }, result.state);
  assert.equal(result.payload.interactions[0].status, "error");
  assert.equal(result.payload.session.status, "error");
});

test("normalizes stop and session end", () => {
  let result = normalizeClaudeHookEvent({ hook_event_name: "SessionStart", session_id: "ses_end", cwd: "/tmp/proj", timestamp: "2026-05-15T10:00:00Z" });
  result = normalizeClaudeHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "ses_end", prompt_id: "prompt-end", prompt: "Finish", timestamp: "2026-05-15T10:00:01Z" }, result.state);
  result = normalizeClaudeHookEvent({ hook_event_name: "Stop", session_id: "ses_end", timestamp: "2026-05-15T10:00:03Z" }, result.state);
  assert.equal(result.payload.interactions[0].status, "success");
  assert.equal(result.payload.session.status, "running");

  result = normalizeClaudeHookEvent({ hook_event_name: "SessionEnd", session_id: "ses_end", timestamp: "2026-05-15T10:00:10Z" }, result.state);
  assert.equal(result.payload.session.status, "success");
  assert.equal(result.payload.session.ended_at, "2026-05-15T10:00:10.000Z");
});
