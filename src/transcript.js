import { promises as fs } from "node:fs";

function emptyStats() {
  return {
    available: false,
    input_tokens: 0,
    output_tokens: 0,
    cached_tokens: 0,
    cache_creation_tokens: 0,
    reasoning_tokens: 0,
    llm_call_count: 0,
    models_used: [],
  };
}

function numberOrZero(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function configuredValue(value, fallback = "") {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

export function aggregateTranscriptRecords(records) {
  const stats = emptyStats();
  const seenMessageIds = new Set();
  const models = new Set();

  for (const record of records) {
    if (!record || record.type !== "assistant") continue;
    const message = record.message;
    if (!message || typeof message !== "object") continue;

    const messageId = typeof message.id === "string" ? message.id : "";
    if (messageId && seenMessageIds.has(messageId)) continue;
    if (messageId) seenMessageIds.add(messageId);

    const usage = message.usage && typeof message.usage === "object" ? message.usage : null;
    if (usage) {
      stats.input_tokens += numberOrZero(usage.input_tokens);
      stats.output_tokens += numberOrZero(usage.output_tokens);
      stats.cached_tokens += numberOrZero(usage.cache_read_input_tokens);
      stats.cache_creation_tokens += numberOrZero(usage.cache_creation_input_tokens);
      stats.reasoning_tokens += numberOrZero(usage.reasoning_tokens);
      stats.llm_call_count += 1;
      stats.available = true;
    }

    const model = typeof message.model === "string" ? message.model.trim() : "";
    if (model) models.add(model);
  }

  stats.models_used = Array.from(models);
  return stats;
}

export function extractLLMCalls(records) {
  const calls = [];
  const seenMessageIds = new Set();
  let promptIndex = -1;
  let lastPromptId = "";
  let lastUserRecordTimestampMs = 0;

  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    if (record.type === "user") {
      const ts = Date.parse(typeof record.timestamp === "string" ? record.timestamp : "");
      if (Number.isFinite(ts)) lastUserRecordTimestampMs = ts;
      const promptId = configuredValue(record.promptId, "");
      if (promptId && promptId !== lastPromptId) {
        lastPromptId = promptId;
        promptIndex += 1;
      }
      continue;
    }
    if (record.type !== "assistant") continue;
    const message = record.message;
    if (!message || typeof message !== "object") continue;
    const messageId = typeof message.id === "string" ? message.id : "";
    if (!messageId) continue;
    if (seenMessageIds.has(messageId)) continue;
    seenMessageIds.add(messageId);
    const usage = message.usage && typeof message.usage === "object" ? message.usage : null;
    if (!usage) continue;

    const startedAt = configuredValue(record.timestamp, "");
    const startedAtMs = Date.parse(startedAt);
    const latencyMs = lastUserRecordTimestampMs > 0 && Number.isFinite(startedAtMs)
      ? Math.max(0, startedAtMs - lastUserRecordTimestampMs)
      : 0;

    calls.push({
      message_id: messageId,
      prompt_index: Math.max(0, promptIndex),
      model: configuredValue(message.model, ""),
      started_at: startedAt,
      latency_ms: latencyMs,
      input_tokens: numberOrZero(usage.input_tokens),
      output_tokens: numberOrZero(usage.output_tokens),
      cached_tokens: numberOrZero(usage.cache_read_input_tokens),
      cache_creation_tokens: numberOrZero(usage.cache_creation_input_tokens),
      reasoning_tokens: numberOrZero(usage.reasoning_tokens),
    });
  }
  return calls;
}

export async function parseTranscript(filePath) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    return { stats: emptyStats(), calls: [] };
  }
  let raw = "";
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return { stats: emptyStats(), calls: [] };
  }
  const records = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // Skip malformed lines; transcripts can be truncated mid-write.
    }
  }
  return {
    stats: aggregateTranscriptRecords(records),
    calls: extractLLMCalls(records),
  };
}
