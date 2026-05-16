import { createHash } from "node:crypto";
import { basename } from "node:path";

const source = "claude-code";

export function normalizeClaudeHookEvent(event, previousState = {}) {
  const input = event && typeof event === "object" ? event : {};
  const hookEventName = configuredValue(input.hook_event_name, configuredValue(input.hookEventName, "unknown"));
  const timestamp = normalizeDateTime(input.timestamp, new Date().toISOString());
  const sessionID = safeID(configuredValue(input.session_id, configuredValue(input.sessionId, "claude-session-unknown")));
  const cwd = configuredValue(input.cwd, configuredValue(process.env.CLAUDE_PROJECT_DIR, process.cwd()));
  const project = projectName(cwd);
  const state = normalizeState(previousState);
  const session = ensureSessionState(state, sessionID, timestamp, cwd, project, input.transcript_path);

  const result = {
    state,
    payload: null,
    event: { hook_event_name: hookEventName, session_id: sessionID, timestamp },
  };

  if (hookEventName === "SessionStart") {
    session.status = "running";
    session.started_at = minDateTime(session.started_at, timestamp);
    session.cwd = cwd;
    session.project = project;
    session.transcript_path = configuredValue(input.transcript_path, session.transcript_path);
    result.payload = buildPayload(session, timestamp);
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
    result.payload = buildPayload(session, timestamp);
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
    result.payload = buildPayload(session, timestamp);
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
    result.payload = buildPayload(session, timestamp);
    return result;
  }

  if (hookEventName === "Stop" || hookEventName === "StopFailure") {
    const failed = hookEventName === "StopFailure";
    const interaction = ensureCurrentInteraction(session, timestamp);
    interaction.status = failed ? "error" : "success";
    interaction.ended_at = timestamp;
    interaction.summary = summarize(interaction.prompt, `Interaction ${interaction.index}`);
    session.status = failed ? "error" : "running";
    result.payload = buildPayload(session, timestamp);
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
    result.payload = buildPayload(session, timestamp);
    return result;
  }

  result.payload = buildPayload(session, timestamp);
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

function buildPayload(session, now) {
  const interactions = session.interactions.map((interaction) => buildInteraction(interaction, now));
  const allSteps = interactions.flatMap((interaction) => interaction.steps);
  const endedAt = session.ended_at || now;
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
      total_cost_usd: 0,
      input_tokens: 0,
      output_tokens: 0,
      reasoning_tokens: 0,
      cached_tokens: 0,
      llm_call_count: 0,
      context_size_tokens_p50: 0,
      context_size_tokens_p95: 0,
      context_size_tokens_max: 0,
      models_used: [],
      files_changed_count: fileEditCount(allSteps),
      retry_count: 0,
    },
    interactions,
  };
}

function buildInteraction(interaction, now) {
  const endedAt = interaction.ended_at || now;
  const steps = interaction.steps.map((step) => buildStep(step));
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
    llm_call_count: 0,
    cost_usd: 0,
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cached_tokens: 0,
    context_size_tokens_p50: 0,
    context_size_tokens_p95: 0,
    context_size_tokens_max: 0,
    step_count: steps.length,
    steps,
  };
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
