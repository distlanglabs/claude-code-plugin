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

export async function parseTranscript(filePath) {
  if (typeof filePath !== "string" || filePath.trim() === "") return emptyStats();
  let raw = "";
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return emptyStats();
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
  return aggregateTranscriptRecords(records);
}
