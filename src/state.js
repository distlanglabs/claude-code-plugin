import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

function configuredValue(value, fallback = "") {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

export function statePath() {
  const override = configuredValue(process.env.DISTLANG_CLAUDE_CODE_STATE_FILE, "");
  if (override) return override;
  return join(homedir(), ".config", "claude", "distlang-plugin.json");
}

export function defaultState() {
  return {
    enabled: true,
    updated_at: null,
    sessions: [],
  };
}

export async function readState() {
  try {
    const parsed = JSON.parse(await fs.readFile(statePath(), "utf8"));
    return {
      enabled: parsed && parsed.enabled === false ? false : true,
      updated_at: typeof parsed?.updated_at === "string" ? parsed.updated_at : null,
      sessions: Array.isArray(parsed?.sessions) ? parsed.sessions.slice(-20) : [],
    };
  } catch {
    return defaultState();
  }
}

export async function writeState(state) {
  const filePath = statePath();
  await fs.mkdir(dirname(filePath), { recursive: true });
  const payload = {
    enabled: state && state.enabled === false ? false : true,
    updated_at: new Date().toISOString(),
    sessions: Array.isArray(state?.sessions) ? state.sessions.slice(-20) : [],
  };
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

export async function setEnabled(enabled) {
  const state = await readState();
  state.enabled = enabled !== false;
  return writeState(state);
}
