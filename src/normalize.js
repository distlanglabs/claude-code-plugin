import { createHash } from "node:crypto";
import { basename } from "node:path";

const source = "claude-code";
const anthropicPricingVersion = "2026-05-08";
const anthropicPricing = {
  "opus-4.7": { input: 5, cachedInput: 0.5, output: 25 },
  "opus-4.6": { input: 5, cachedInput: 0.5, output: 25 },
  "opus-4.5": { input: 5, cachedInput: 0.5, output: 25 },
  "sonnet-4.6": { input: 3, cachedInput: 0.3, output: 15 },
  "sonnet-4.5": { input: 3, cachedInput: 0.3, output: 15 },
  "haiku-4.5": { input: 1, cachedInput: 0.1, output: 5 },
};

function pricingKeyForAnthropicModel(rawModel) {
  const lower = configuredValue(rawModel, "").toLowerCase();
  if (!lower) return "";
  return lower.replace(/^claude-/, "").replace(/-(\d+)-(\d+)$/, "-$1.$2");
}

function estimateAnthropicCostUsd(call) {
  const pricing = anthropicPricing[pricingKeyForAnthropicModel(call.model)];
  if (!pricing) return 0;
  const uncachedInput = Math.max(0, call.input_tokens - call.cached_tokens);
  return (
    (uncachedInput / 1_000_000) * pricing.input +
    (call.cached_tokens / 1_000_000) * pricing.cachedInput +
    (call.cache_creation_tokens / 1_000_000) * pricing.input +
    ((call.output_tokens + call.reasoning_tokens) / 1_000_000) * pricing.output
  );
}

export function normalizeClaudeHookEvent(event, previousState = {}, transcript = null) {
  const input = event && typeof event === "object" ? event : {};
  const hookEventName = configuredValue(input.hook_event_name, configuredValue(input.hookEventName, "unknown"));
  const timestamp = normalizeDateTime(input.timestamp, new Date().toISOString());
  const sessionID = safeID(configuredValue(input.session_id, configuredValue(input.sessionId, "claude-session-unknown")));
  const cwd = configuredValue(input.cwd, configuredValue(process.env.CLAUDE_PROJECT_DIR, process.cwd()));
  const project = projectName(cwd);
  const state = normalizeState(previousState);
  const session = ensureSessionState(state, sessionID, timestamp, cwd, project, input.transcript_path);
  const transcriptData = readTranscriptInput(transcript);
  const stats = transcriptData.stats;
  const calls = transcriptData.calls;
  const flush = true;

  const result = {
    state,
    payload: null,
    flush,
    event: { hook_event_name: hookEventName, session_id: sessionID, timestamp },
  };

  if (hookEventName === "SessionStart") {
    session.status = "running";
    session.started_at = minDateTime(session.started_at, timestamp);
    session.cwd = cwd;
    session.project = project;
    session.transcript_path = configuredValue(input.transcript_path, session.transcript_path);
    result.payload = buildPayload(session, timestamp, stats, calls);
    return result;
  }

  if (hookEventName === "UserPromptSubmit") {
    const prompt = sanitizeText(configuredValue(input.prompt, "Claude Code prompt"));
    const interactionID = interactionIDForPrompt(sessionID, input, prompt, timestamp);
    const interaction = ensureInteractionState(session, interactionID, timestamp, prompt);
    interaction.prompt = prompt || interaction.prompt;
    interaction.summary = summarize(interaction.prompt, `Interaction ${interaction.index}`);
    interaction.status = "running";
    interaction.hook_event_name = hookEventName;
    session.current_interaction_id = interaction.id;
    result.payload = buildPayload(session, timestamp, stats, calls);
    return result;
  }

  if (hookEventName === "PreToolUse") {
    const interaction = ensureCurrentInteraction(session, timestamp);
    const stepID = stepIDForTool(sessionID, input, timestamp);
    const step = ensureStepState(interaction, stepID, timestamp, input.tool_name);
    step.status = "started";
    step.started_at = minDateTime(step.started_at, timestamp);
    step.ended_at = null;
    step.duration_ms = 0;
    step.tool_name = configuredValue(input.tool_name, step.tool_name || "unknown");
    step.title = `Run ${step.tool_name}`;
    step.payload_json = stepPayload(input, {
      distlang_status: "started",
      tool_input: safeJSONValue(input.tool_input),
    });
    session.current_interaction_id = interaction.id;
    result.payload = buildPayload(session, timestamp, stats, calls);
    return result;
  }

  if (hookEventName === "PostToolUse" || hookEventName === "PostToolUseFailure") {
    const failed = hookEventName === "PostToolUseFailure";
    const interaction = ensureCurrentInteraction(session, timestamp);
    const stepID = stepIDForTool(sessionID, input, timestamp);
    const step = ensureStepState(interaction, stepID, timestamp, input.tool_name);
    step.status = failed ? "failed" : "completed";
    step.ended_at = timestamp;
    step.duration_ms = durationMs(step.started_at, step.ended_at);
    step.tool_name = configuredValue(input.tool_name, step.tool_name || "unknown");
    step.title = `Run ${step.tool_name}`;
    step.payload_json = stepPayload(input, {
      distlang_status: step.status,
      tool_input: safeJSONValue(input.tool_input),
      tool_output: safeJSONValue(input.tool_response ?? input.tool_output ?? input.response ?? input.result),
      error: safeError(input),
    });
    interaction.status = failed ? "error" : interaction.status === "running" ? "success" : interaction.status;
    interaction.ended_at = timestamp;
    session.current_interaction_id = interaction.id;
    result.payload = buildPayload(session, timestamp, stats, calls);
    return result;
  }

  if (hookEventName === "Stop" || hookEventName === "StopFailure") {
    const failed = hookEventName === "StopFailure";
    const interaction = ensureCurrentInteraction(session, timestamp);
    interaction.status = failed ? "error" : "success";
    interaction.ended_at = timestamp;
    interaction.summary = summarize(interaction.prompt, `Interaction ${interaction.index}`);
    session.status = failed ? "error" : "running";
    result.payload = buildPayload(session, timestamp, stats, calls);
    return result;
  }

  if (hookEventName === "SessionEnd") {
    session.status = "success";
    session.ended_at = timestamp;
    for (const interaction of session.interactions) {
      if (interaction.status === "running") {
        interaction.status = "success";
        interaction.ended_at = timestamp;
      }
    }
    result.payload = buildPayload(session, timestamp, stats, calls);
    return result;
  }

  result.payload = buildPayload(session, timestamp, stats);
  return result;
}

function normalizeState(value) {
  const state = value && typeof value === "object" ? { ...value } : {};
  state.sessions = Array.isArray(state.sessions) ? state.sessions : [];
  return state;
}

function ensureSessionState(state, sessionID, timestamp, cwd, project, transcriptPath) {
  let session = state.sessions.find((entry) => entry.id === sessionID);
  if (!session) {
    session = {
      id: sessionID,
      source,
      project,
      cwd,
      transcript_path: configuredValue(transcriptPath, ""),
      started_at: timestamp,
      ended_at: null,
      status: "running",
      summary: `Claude Code session ${sessionID}`,
      current_interaction_id: "",
      interactions: [],
    };
    state.sessions.push(session);
  }
  session.source = source;
  session.project = configuredValue(session.project, project);
  session.cwd = configuredValue(session.cwd, cwd);
  session.transcript_path = configuredValue(session.transcript_path, configuredValue(transcriptPath, ""));
  session.started_at = normalizeDateTime(session.started_at, timestamp);
  session.interactions = Array.isArray(session.interactions) ? session.interactions : [];
  return session;
}

function ensureInteractionState(session, interactionID, timestamp, prompt) {
  let interaction = session.interactions.find((entry) => entry.id === interactionID);
  if (!interaction) {
    interaction = {
      id: interactionID,
      index: session.interactions.length + 1,
      prompt: sanitizeText(configuredValue(prompt, `Claude Code interaction ${session.interactions.length + 1}`)),
      mode: "build",
      started_at: timestamp,
      ended_at: null,
      status: "running",
      summary: "",
      steps: [],
    };
    session.interactions.push(interaction);
  }
  interaction.steps = Array.isArray(interaction.steps) ? interaction.steps : [];
  interaction.started_at = minDateTime(interaction.started_at, timestamp);
  return interaction;
}

function ensureCurrentInteraction(session, timestamp) {
  const current = session.current_interaction_id
    ? session.interactions.find((entry) => entry.id === session.current_interaction_id)
    : null;
  if (current) {
    return current;
  }
  const interactionID = `${session.id}:int:${session.interactions.length + 1}`;
  return ensureInteractionState(session, interactionID, timestamp, `Claude Code interaction ${session.interactions.length + 1}`);
}

function ensureStepState(interaction, stepID, timestamp, toolName) {
  let step = interaction.steps.find((entry) => entry.id === stepID);
  if (!step) {
    step = {
      id: stepID,
      index: interaction.steps.length + 1,
      kind: "tool_call",
      phase: interaction.mode || "build",
      title: `Run ${configuredValue(toolName, "unknown")}`,
      started_at: timestamp,
      ended_at: null,
      duration_ms: 0,
      status: "started",
      tool_name: configuredValue(toolName, "unknown"),
      payload_json: {},
    };
    interaction.steps.push(step);
  }
  return step;
}

function buildPayload(session, now, stats = null, calls = []) {
  const aggregated = sanitizeTranscriptStats(stats);
  const sanitizedCalls = sanitizeLLMCalls(calls);
  const callsByInteraction = groupCallsByInteraction(sanitizedCalls, session.interactions.length);
  const interactions = session.interactions.map((interaction, index, all) => {
    const interactionCalls = callsByInteraction.get(index) ?? [];
    const fallback = sanitizedCalls.length === 0 && index === all.length - 1 ? aggregated : null;
    return buildInteraction(interaction, now, interactionCalls, fallback);
  });
  const allSteps = interactions.flatMap((interaction) => interaction.steps);
  const endedAt = session.ended_at || now;
  const sessionTotals = sessionTotalsFromInteractions(interactions, aggregated, sanitizedCalls);
  return {
    source,
    project: session.project || projectName(session.cwd),
    session: {
      id: session.id,
      started_at: normalizeDateTime(session.started_at, now),
      ended_at: normalizeDateTime(endedAt, now),
      duration_ms: durationMs(session.started_at, endedAt),
      status: session.status === "error" ? "error" : session.status === "success" ? "success" : "running",
      summary: sessionSummary(session, interactions),
      total_cost_usd: interactions.reduce((sum, item) => sum + (Number(item.cost_usd) || 0), 0),
      input_tokens: sessionTotals.input_tokens,
      output_tokens: sessionTotals.output_tokens,
      reasoning_tokens: sessionTotals.reasoning_tokens,
      cached_tokens: sessionTotals.cached_tokens,
      cache_creation_tokens: sessionTotals.cache_creation_tokens,
      llm_call_count: sessionTotals.llm_call_count,
      context_size_tokens_p50: 0,
      context_size_tokens_p95: 0,
      context_size_tokens_max: 0,
      models_used: sessionTotals.models_used,
      files_changed_count: fileEditCount(allSteps),
      retry_count: 0,
      token_usage_source: sessionTotals.available ? "claude_transcript" : "missing",
    },
    interactions,
  };
}

function buildInteraction(interaction, now, llmCalls = [], fallbackSessionStats = null) {
  const endedAt = interaction.ended_at || now;
  const toolSteps = interaction.steps.map((step) => buildStep(step));
  const llmSteps = llmCalls.map((call, index) => buildLLMStep(call, interaction.id, toolSteps.length + index + 1));
  const steps = orderStepsByTime([...toolSteps, ...llmSteps]);
  const interactionTotals = totalsFromLLMCalls(llmCalls);
  const fallback = sanitizeTranscriptStats(fallbackSessionStats);
  const useFallback = llmCalls.length === 0 && fallback.available;
  return {
    id: interaction.id,
    index: Math.max(1, Number(interaction.index) || 1),
    prompt: configuredValue(sanitizeText(interaction.prompt), `Interaction ${interaction.index || 1}`),
    mode: allowedMode(interaction.mode),
    started_at: normalizeDateTime(interaction.started_at, now),
    ended_at: normalizeDateTime(endedAt, now),
    duration_ms: durationMs(interaction.started_at, endedAt),
    status: interaction.status === "error" ? "error" : interaction.status === "running" ? "running" : "success",
    summary: configuredValue(sanitizeText(interaction.summary), summarize(interaction.prompt, `Interaction ${interaction.index || 1}`)),
    llm_call_count: useFallback ? fallback.llm_call_count : interactionTotals.llm_call_count,
    cost_usd: useFallback ? 0 : interactionTotals.cost_usd,
    input_tokens: useFallback ? fallback.input_tokens : interactionTotals.input_tokens,
    output_tokens: useFallback ? fallback.output_tokens : interactionTotals.output_tokens,
    reasoning_tokens: useFallback ? fallback.reasoning_tokens : interactionTotals.reasoning_tokens,
    cached_tokens: useFallback ? fallback.cached_tokens : interactionTotals.cached_tokens,
    cache_creation_tokens: useFallback ? fallback.cache_creation_tokens : interactionTotals.cache_creation_tokens,
    context_size_tokens_p50: 0,
    context_size_tokens_p95: 0,
    context_size_tokens_max: 0,
    step_count: steps.length,
    steps,
  };
}

function buildLLMStep(call, interactionID, fallbackIndex) {
  const startedAt = normalizeDateTime(call.started_at, new Date().toISOString());
  const contextSize = call.input_tokens + call.cached_tokens + call.cache_creation_tokens;
  const pricingModel = pricingKeyForAnthropicModel(call.model);
  const costUsd = estimateAnthropicCostUsd(call);
  return {
    id: `${interactionID}:step:llm:${safeID(call.message_id)}`,
    index: Math.max(1, Number(fallbackIndex) || 1),
    kind: "llm_call",
    phase: "build",
    title: call.model ? `LLM ${call.model}` : "LLM call",
    started_at: startedAt,
    ended_at: startedAt,
    duration_ms: 0,
    status: "completed",
    provider: "anthropic",
    model: pricingModel || call.model || null,
    tool_name: null,
    input_tokens: call.input_tokens,
    output_tokens: call.output_tokens,
    reasoning_tokens: call.reasoning_tokens,
    cached_tokens: call.cached_tokens,
    context_size_tokens: contextSize,
    cost_usd: costUsd,
    estimated_cost_usd: costUsd,
    reported_cost_usd: costUsd,
    estimation_source: "claude_transcript_plugin_pricing",
    pricing_version: anthropicPricingVersion,
    first_token_at: startedAt,
    first_token_latency_ms: Math.max(0, Number(call.latency_ms) || 0),
    payload_json: {
      source: "claude_transcript",
      message_id: call.message_id,
      cache_creation_input_tokens: call.cache_creation_tokens,
      token_usage: { quality: "exact", source: "claude_transcript" },
      latency_quality: "request_to_response_proxy",
      raw_model: call.model || null,
    },
    details: [],
  };
}

function readTranscriptInput(value) {
  if (!value || typeof value !== "object") return { stats: sanitizeTranscriptStats(null), calls: [] };
  if (Array.isArray(value.calls) || value.stats) {
    return { stats: sanitizeTranscriptStats(value.stats), calls: sanitizeLLMCalls(value.calls) };
  }
  return { stats: sanitizeTranscriptStats(value), calls: [] };
}

function sanitizeLLMCalls(calls) {
  if (!Array.isArray(calls)) return [];
  const sanitized = [];
  for (const entry of calls) {
    if (!entry || typeof entry !== "object") continue;
    const messageId = configuredValue(entry.message_id, "");
    if (!messageId) continue;
    sanitized.push({
      message_id: messageId,
      prompt_index: Math.max(0, Number(entry.prompt_index) || 0),
      model: configuredValue(entry.model, ""),
      started_at: configuredValue(entry.started_at, ""),
      latency_ms: Math.max(0, Number(entry.latency_ms) || 0),
      input_tokens: nonNegativeNumber(entry.input_tokens),
      output_tokens: nonNegativeNumber(entry.output_tokens),
      cached_tokens: nonNegativeNumber(entry.cached_tokens),
      cache_creation_tokens: nonNegativeNumber(entry.cache_creation_tokens),
      reasoning_tokens: nonNegativeNumber(entry.reasoning_tokens),
    });
  }
  return sanitized;
}

function groupCallsByInteraction(calls, interactionCount) {
  const grouped = new Map();
  if (interactionCount <= 0) return grouped;
  for (const call of calls) {
    const idx = Math.min(interactionCount - 1, Math.max(0, call.prompt_index));
    if (!grouped.has(idx)) grouped.set(idx, []);
    grouped.get(idx).push(call);
  }
  return grouped;
}

function totalsFromLLMCalls(calls) {
  const totals = { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, cached_tokens: 0, cache_creation_tokens: 0, llm_call_count: 0, cost_usd: 0 };
  for (const call of calls) {
    totals.input_tokens += call.input_tokens;
    totals.output_tokens += call.output_tokens;
    totals.reasoning_tokens += call.reasoning_tokens;
    totals.cached_tokens += call.cached_tokens;
    totals.cache_creation_tokens += call.cache_creation_tokens;
    totals.cost_usd += estimateAnthropicCostUsd(call);
    totals.llm_call_count += 1;
  }
  return totals;
}

function sessionTotalsFromInteractions(interactions, fallbackStats, calls) {
  if (calls.length > 0) {
    const models = new Set();
    for (const call of calls) {
      const normalized = pricingKeyForAnthropicModel(call.model) || configuredValue(call.model, "");
      if (normalized) models.add(normalized);
    }
    return {
      available: true,
      input_tokens: interactions.reduce((sum, item) => sum + item.input_tokens, 0),
      output_tokens: interactions.reduce((sum, item) => sum + item.output_tokens, 0),
      reasoning_tokens: interactions.reduce((sum, item) => sum + item.reasoning_tokens, 0),
      cached_tokens: interactions.reduce((sum, item) => sum + item.cached_tokens, 0),
      cache_creation_tokens: interactions.reduce((sum, item) => sum + item.cache_creation_tokens, 0),
      llm_call_count: interactions.reduce((sum, item) => sum + item.llm_call_count, 0),
      models_used: Array.from(models),
    };
  }
  return {
    available: fallbackStats.available,
    input_tokens: fallbackStats.input_tokens,
    output_tokens: fallbackStats.output_tokens,
    reasoning_tokens: fallbackStats.reasoning_tokens,
    cached_tokens: fallbackStats.cached_tokens,
    cache_creation_tokens: fallbackStats.cache_creation_tokens,
    llm_call_count: fallbackStats.llm_call_count,
    models_used: fallbackStats.models_used,
  };
}

function orderStepsByTime(steps) {
  const indexed = steps.map((step, position) => ({ step, position }));
  indexed.sort((a, b) => {
    const aTime = Date.parse(a.step.started_at);
    const bTime = Date.parse(b.step.started_at);
    if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) return aTime - bTime;
    return a.position - b.position;
  });
  return indexed.map(({ step }, index) => ({ ...step, index: index + 1 }));
}

function buildStep(step) {
  const endedAt = step.ended_at || step.started_at;
  return {
    id: step.id,
    index: Math.max(1, Number(step.index) || 1),
    kind: "tool_call",
    phase: allowedMode(step.phase),
    title: configuredValue(step.title, `Run ${configuredValue(step.tool_name, "unknown")}`),
    started_at: normalizeDateTime(step.started_at, new Date().toISOString()),
    ended_at: normalizeDateTime(endedAt, new Date().toISOString()),
    duration_ms: Math.max(0, Number(step.duration_ms) || durationMs(step.started_at, endedAt)),
    status: configuredValue(step.status, "started"),
    provider: null,
    model: null,
    tool_name: configuredValue(step.tool_name, "unknown"),
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cached_tokens: 0,
    context_size_tokens: 0,
    cost_usd: 0,
    payload_json: step.payload_json && typeof step.payload_json === "object" ? step.payload_json : null,
    details: [],
  };
}

function stepPayload(input, extra) {
  return removeEmpty({
    hook_event_name: configuredValue(input.hook_event_name, ""),
    timestamp: normalizeDateTime(input.timestamp, new Date().toISOString()),
    cwd: configuredValue(input.cwd, ""),
    transcript_path: configuredValue(input.transcript_path, ""),
    permission_mode: configuredValue(input.permission_mode, ""),
    tool_name: configuredValue(input.tool_name, ""),
    token_usage: missingTokenUsage(),
    ...extra,
  });
}

export function missingTokenUsage() {
  return { quality: "missing", source: "claude_hook" };
}

function sanitizeTranscriptStats(value) {
  const stats = value && typeof value === "object" ? value : {};
  const models = Array.isArray(stats.models_used)
    ? stats.models_used.filter((entry) => typeof entry === "string" && entry.trim() !== "")
    : [];
  return {
    available: stats.available === true,
    input_tokens: nonNegativeNumber(stats.input_tokens),
    output_tokens: nonNegativeNumber(stats.output_tokens),
    cached_tokens: nonNegativeNumber(stats.cached_tokens),
    cache_creation_tokens: nonNegativeNumber(stats.cache_creation_tokens),
    reasoning_tokens: nonNegativeNumber(stats.reasoning_tokens),
    llm_call_count: nonNegativeNumber(stats.llm_call_count),
    models_used: models,
  };
}

function nonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function interactionIDForPrompt(sessionID, input, prompt, timestamp) {
  const explicit = configuredValue(input.message_id, configuredValue(input.prompt_id, configuredValue(input.request_id, "")));
  if (explicit) {
    return `${sessionID}:int:${safeID(explicit)}`;
  }
  return `${sessionID}:int:${shortHash(`${prompt}\n${timestamp}`)}`;
}

function stepIDForTool(sessionID, input, timestamp) {
  const explicit = configuredValue(input.tool_use_id, configuredValue(input.tool_call_id, configuredValue(input.call_id, configuredValue(input.id, ""))));
  if (explicit) {
    return `${sessionID}:step:tool:${safeID(explicit)}`;
  }
  return `${sessionID}:step:tool:${shortHash(JSON.stringify({ tool: input.tool_name, input: input.tool_input, timestamp }))}`;
}

function projectName(cwd) {
  return configuredValue(basename(String(cwd || "")), "unknown");
}

function configuredValue(value, fallback = "") {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function normalizeDateTime(value, fallback) {
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  return fallback;
}

function minDateTime(left, right) {
  const leftMs = Date.parse(normalizeDateTime(left, right));
  const rightMs = Date.parse(normalizeDateTime(right, left));
  return new Date(Math.min(leftMs, rightMs)).toISOString();
}

function durationMs(start, end) {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
  return Math.max(0, endMs - startMs);
}

function sanitizeText(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
    .replace(/<system>[\s\S]*?<\/system>/gi, "")
    .trim();
}

function summarize(value, fallback) {
  const text = configuredValue(sanitizeText(value), fallback);
  return text.length <= 80 ? text : `${text.slice(0, 77)}...`;
}

function sessionSummary(session, interactions) {
  return configuredValue(interactions[0]?.prompt, configuredValue(session.summary, `Claude Code session ${session.id}`));
}

function allowedMode(value) {
  const mode = configuredValue(value, "build");
  return ["plan", "build", "review", "chat"].includes(mode) ? mode : "build";
}

function safeID(value) {
  const cleaned = String(value || "").replace(/[^A-Za-z0-9_.:-]/g, "_");
  return cleaned || "unknown";
}

function shortHash(value) {
  return createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16);
}

function safeJSONValue(value) {
  if (typeof value === "undefined") return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function safeError(input) {
  const error = input.error ?? input.tool_error ?? input.failure;
  if (!error) return undefined;
  if (typeof error === "string") return { message: error };
  if (typeof error === "object") return safeJSONValue(error);
  return { message: String(error) };
}

function removeEmpty(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== ""));
}

function fileEditCount(steps) {
  return steps.filter((step) => {
    const name = String(step.tool_name || "").toLowerCase();
    return name === "edit" || name === "write" || name === "multiedit" || name.includes("edit") || name.includes("write");
  }).length;
}
