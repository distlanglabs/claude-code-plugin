import assert from "node:assert/strict";
import test from "node:test";

import { normalizeClaudeHookEvent } from "../src/normalize.js";
import { aggregateTranscriptRecords, extractLLMCalls } from "../src/transcript.js";

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
  assert.equal(result.flush, false);
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
  assert.equal(result.flush, false);
  result = normalizeClaudeHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "ses_end", prompt_id: "prompt-end", prompt: "Finish", timestamp: "2026-05-15T10:00:01Z" }, result.state);
  assert.equal(result.flush, false);
  result = normalizeClaudeHookEvent({ hook_event_name: "Stop", session_id: "ses_end", timestamp: "2026-05-15T10:00:03Z" }, result.state);
  assert.equal(result.flush, true);
  assert.equal(result.payload.interactions[0].status, "success");
  assert.equal(result.payload.session.status, "running");

  result = normalizeClaudeHookEvent({ hook_event_name: "SessionEnd", session_id: "ses_end", timestamp: "2026-05-15T10:00:10Z" }, result.state);
  assert.equal(result.flush, true);
  assert.equal(result.payload.session.status, "success");
  assert.equal(result.payload.session.ended_at, "2026-05-15T10:00:10.000Z");
});

test("only flushes on Stop, StopFailure, and SessionEnd", () => {
  const cases = [
    { name: "SessionStart", flush: false },
    { name: "UserPromptSubmit", flush: false },
    { name: "PreToolUse", flush: false },
    { name: "PostToolUse", flush: false },
    { name: "PostToolUseFailure", flush: false },
    { name: "Stop", flush: true },
    { name: "StopFailure", flush: true },
    { name: "SessionEnd", flush: true },
  ];
  for (const { name, flush } of cases) {
    const result = normalizeClaudeHookEvent({ hook_event_name: name, session_id: "ses_x", timestamp: "2026-05-15T10:00:00Z" });
    assert.equal(result.flush, flush, `${name} flush flag`);
  }
});

test("populates session token totals and models when transcript stats are provided", () => {
  let result = normalizeClaudeHookEvent({ hook_event_name: "SessionStart", session_id: "ses_tx", cwd: "/tmp/proj", timestamp: "2026-05-15T10:00:00Z" });
  result = normalizeClaudeHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "ses_tx", prompt_id: "p1", prompt: "Hello", timestamp: "2026-05-15T10:00:01Z" }, result.state);
  result = normalizeClaudeHookEvent(
    { hook_event_name: "Stop", session_id: "ses_tx", timestamp: "2026-05-15T10:00:05Z" },
    result.state,
    {
      available: true,
      input_tokens: 12,
      output_tokens: 34,
      cached_tokens: 100,
      cache_creation_tokens: 50,
      reasoning_tokens: 7,
      llm_call_count: 2,
      models_used: ["claude-opus-4-7"],
    },
  );

  assert.equal(result.flush, true);
  assert.equal(result.payload.session.input_tokens, 12);
  assert.equal(result.payload.session.output_tokens, 34);
  assert.equal(result.payload.session.cached_tokens, 100);
  assert.equal(result.payload.session.cache_creation_tokens, 50);
  assert.equal(result.payload.session.reasoning_tokens, 7);
  assert.equal(result.payload.session.llm_call_count, 2);
  assert.deepEqual(result.payload.session.models_used, ["claude-opus-4-7"]);
  assert.equal(result.payload.session.token_usage_source, "claude_transcript");
  assert.equal(result.payload.session.total_cost_usd, 0);

  const interaction = result.payload.interactions[0];
  assert.equal(interaction.input_tokens, 12);
  assert.equal(interaction.output_tokens, 34);
  assert.equal(interaction.llm_call_count, 2);
});

test("aggregateTranscriptRecords sums usage and dedupes by message id", () => {
  const stats = aggregateTranscriptRecords([
    { type: "permission-mode" },
    { type: "user", message: { role: "user", content: "hi" } },
    {
      type: "assistant",
      message: {
        id: "msg_a",
        model: "claude-opus-4-7",
        usage: { input_tokens: 5, output_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 3 },
      },
    },
    {
      type: "assistant",
      message: {
        id: "msg_a",
        model: "claude-opus-4-7",
        usage: { input_tokens: 5, output_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 3 },
      },
    },
    {
      type: "assistant",
      message: {
        id: "msg_b",
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 7, output_tokens: 0, cache_read_input_tokens: 0 },
      },
    },
    { type: "assistant", message: { model: "claude-opus-4-7" } },
  ]);

  assert.equal(stats.available, true);
  assert.equal(stats.input_tokens, 12);
  assert.equal(stats.output_tokens, 10);
  assert.equal(stats.cached_tokens, 20);
  assert.equal(stats.cache_creation_tokens, 3);
  assert.equal(stats.llm_call_count, 2);
  assert.deepEqual(stats.models_used.sort(), ["claude-opus-4-7", "claude-sonnet-4-6"]);
});

test("aggregateTranscriptRecords returns empty stats when no assistant usage present", () => {
  const stats = aggregateTranscriptRecords([{ type: "user", message: { role: "user" } }, { type: "system" }]);
  assert.equal(stats.available, false);
  assert.equal(stats.input_tokens, 0);
  assert.deepEqual(stats.models_used, []);
});

test("extractLLMCalls assigns each assistant usage record to the surrounding user promptId", () => {
  const calls = extractLLMCalls([
    { type: "user", promptId: "p1", message: { role: "user" }, timestamp: "2026-05-15T10:00:00Z" },
    {
      type: "assistant",
      timestamp: "2026-05-15T10:00:01Z",
      message: { id: "msg_a", model: "claude-opus-4-7", usage: { input_tokens: 5, output_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 3 } },
    },
    { type: "user", promptId: "p1", message: { role: "user", content: [{ type: "tool_result" }] }, timestamp: "2026-05-15T10:00:02Z" },
    {
      type: "assistant",
      timestamp: "2026-05-15T10:00:03Z",
      message: { id: "msg_b", model: "claude-opus-4-7", usage: { input_tokens: 7, output_tokens: 2 } },
    },
    { type: "user", promptId: "p2", message: { role: "user" }, timestamp: "2026-05-15T10:00:10Z" },
    {
      type: "assistant",
      timestamp: "2026-05-15T10:00:11Z",
      message: { id: "msg_c", model: "claude-sonnet-4-6", usage: { input_tokens: 4, output_tokens: 6 } },
    },
  ]);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].prompt_index, 0);
  assert.equal(calls[0].input_tokens, 5);
  assert.equal(calls[0].cached_tokens, 20);
  assert.equal(calls[0].cache_creation_tokens, 3);
  assert.equal(calls[1].prompt_index, 0);
  assert.equal(calls[2].prompt_index, 1);
  assert.equal(calls[2].model, "claude-sonnet-4-6");
});

test("normalizeClaudeHookEvent emits llm_call steps and per-interaction tokens from transcript calls", () => {
  let result = normalizeClaudeHookEvent({ hook_event_name: "SessionStart", session_id: "ses_calls", cwd: "/tmp/proj", timestamp: "2026-05-15T10:00:00Z" });
  result = normalizeClaudeHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "ses_calls", prompt_id: "p1", prompt: "Hello", timestamp: "2026-05-15T10:00:01Z" }, result.state);
  result = normalizeClaudeHookEvent(
    { hook_event_name: "Stop", session_id: "ses_calls", timestamp: "2026-05-15T10:00:05Z" },
    result.state,
    {
      stats: { available: true, input_tokens: 12, output_tokens: 34, cached_tokens: 100, cache_creation_tokens: 50, reasoning_tokens: 7, llm_call_count: 2, models_used: ["claude-opus-4-7"] },
      calls: [
        { message_id: "msg_a", prompt_index: 0, model: "claude-opus-4-7", started_at: "2026-05-15T10:00:02Z", input_tokens: 5, output_tokens: 24, cached_tokens: 60, cache_creation_tokens: 30, reasoning_tokens: 4 },
        { message_id: "msg_b", prompt_index: 0, model: "claude-opus-4-7", started_at: "2026-05-15T10:00:04Z", input_tokens: 7, output_tokens: 10, cached_tokens: 40, cache_creation_tokens: 20, reasoning_tokens: 3 },
      ],
    },
  );

  const interaction = result.payload.interactions[0];
  assert.equal(interaction.llm_call_count, 2);
  assert.equal(interaction.input_tokens, 12);
  assert.equal(interaction.output_tokens, 34);
  assert.equal(interaction.cached_tokens, 100);
  assert.equal(interaction.cache_creation_tokens, 50);
  assert.equal(interaction.reasoning_tokens, 7);

  const llmSteps = interaction.steps.filter((step) => step.kind === "llm_call");
  assert.equal(llmSteps.length, 2);
  assert.equal(llmSteps[0].id, "ses_calls:int:p1:step:llm:msg_a");
  assert.equal(llmSteps[0].model, "claude-opus-4-7");
  assert.equal(llmSteps[0].input_tokens, 5);
  assert.equal(llmSteps[0].context_size_tokens, 5 + 60 + 30);
  assert.equal(llmSteps[1].id, "ses_calls:int:p1:step:llm:msg_b");

  assert.equal(result.payload.session.input_tokens, 12);
  assert.equal(result.payload.session.output_tokens, 34);
  assert.equal(result.payload.session.llm_call_count, 2);
  assert.deepEqual(result.payload.session.models_used, ["claude-opus-4-7"]);
  assert.equal(result.payload.session.token_usage_source, "claude_transcript");
});
