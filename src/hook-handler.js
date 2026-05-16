import { appendFile } from "node:fs/promises";
import { normalizeClaudeHookEvent } from "./normalize.js";
import { getAuthStatus, uploadAgentDebuggerPayload } from "./distlang.js";
import { readState, statePath, writeState } from "./state.js";

function configuredValue(value, fallback = "") {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function debugEnabled() {
  const value = configuredValue(process.env.DISTLANG_CLAUDE_CODE_DEBUG, "").toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function logFile() {
  return configuredValue(process.env.DISTLANG_CLAUDE_CODE_LOG_FILE, "");
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function log(level, message, extra = undefined) {
  if (level === "debug" && !debugEnabled()) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), service: "distlang-claude-code-plugin", level, message, extra });
  const path = logFile();
  if (path) await appendFile(path, `${line}\n`).catch(() => {});
}

export async function main() {
  const raw = await readStdin().catch(() => "");
  let event = null;
  try {
    event = raw.trim() ? JSON.parse(raw) : {};
  } catch (error) {
    await log("warn", "Claude Code hook input was not valid JSON", { error: String(error) });
    return;
  }

  const previousState = await readState();
  if (previousState.enabled === false) {
    await log("debug", "Distlang Claude Code uploads are disabled", { statePath: statePath() });
    return;
  }

  const normalized = normalizeClaudeHookEvent(event, previousState);
  await writeState(normalized.state).catch((error) => log("warn", "Failed to persist Claude Code hook state", { error: String(error) }));
  if (!normalized.payload) return;

  let auth = null;
  try {
    auth = await getAuthStatus();
  } catch (error) {
    await log("warn", "Distlang auth check failed; skipping Agent Debugger upload", { error: String(error) });
    return;
  }
  if (!auth || auth.ok !== true || auth.logged_in !== true) {
    await log("warn", "Distlang Agent Debugger upload skipped: run distlang helpers login", { auth });
    return;
  }

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await uploadAgentDebuggerPayload(normalized.payload);
      if (!response.ok) {
        await log("warn", "Agent Debugger upload returned non-ok response", { attempt, response });
      } else {
        await log("debug", "Agent Debugger upload succeeded", { attempt, event: normalized.event, response });
      }
      return;
    } catch (error) {
      await log("warn", "Agent Debugger upload failed", { attempt, error: String(error) });
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}
