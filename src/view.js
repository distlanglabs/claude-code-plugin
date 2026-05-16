import { spawn } from "node:child_process";
import { distlangCommandInfo, getAuthStatus, loginWithDistlang, resolveDistlangBinary } from "./distlang.js";
import { readState } from "./state.js";

function configuredValue(value, fallback = "") {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

export function dashboardBaseUrl() {
  return configuredValue(process.env.DISTLANG_DASHBOARD_URL, "https://dash.distlang.com").replace(/\/+$/, "");
}

export function sessionUrl(sessionID) {
  const id = configuredValue(sessionID, "");
  if (!id) return "";
  return `${dashboardBaseUrl()}/agent-debugger/sessions/${encodeURIComponent(id)}`;
}

export function agentDebuggerUrl() {
  return `${dashboardBaseUrl()}/agent-debugger`;
}

export async function resolveSessionID(explicit) {
  const fromArg = configuredValue(explicit, "");
  if (fromArg) return fromArg;
  const fromEnv = configuredValue(process.env.CLAUDE_SESSION_ID, "");
  if (fromEnv) return fromEnv;
  const state = await readState();
  const sessions = Array.isArray(state?.sessions) ? state.sessions : [];
  for (let index = sessions.length - 1; index >= 0; index -= 1) {
    const candidate = sessions[index];
    const id = configuredValue(candidate?.id, "");
    if (id) return id;
  }
  return "";
}

function openerCommand() {
  if (process.platform === "darwin") return { command: "open", args: [] };
  if (process.platform === "win32") return { command: "cmd", args: ["/c", "start", ""] };
  return { command: "xdg-open", args: [] };
}

function openUrl(url) {
  const { command, args } = openerCommand();
  return new Promise((resolve) => {
    try {
      const child = spawn(command, [...args, url], { detached: true, stdio: "ignore" });
      child.on("error", () => resolve(false));
      child.unref();
      resolve(true);
    } catch {
      resolve(false);
    }
  });
}

async function ensureAuth() {
  await resolveDistlangBinary({ installIfMissing: true });
  let auth = await getAuthStatus().catch(() => null);
  if (!auth || auth.ok !== true || auth.logged_in !== true) {
    await loginWithDistlang();
    auth = await getAuthStatus().catch(() => null);
  }
  return auth;
}

export async function main() {
  const explicit = process.argv.slice(2).find((value) => !value.startsWith("--"));
  const sessionID = await resolveSessionID(explicit);
  const auth = await ensureAuth();
  if (!auth || auth.ok !== true || auth.logged_in !== true) {
    console.error("Distlang sign-in did not complete. Re-run /distlang-view or /distlang-start to try again.");
    process.exit(1);
  }
  const url = sessionID ? sessionUrl(sessionID) : agentDebuggerUrl();
  const opened = await openUrl(url);
  console.log(JSON.stringify({
    ok: true,
    logged_in: true,
    session_id: sessionID || null,
    url,
    opened,
    fallback: sessionID ? null : "agent_debugger_overview",
    distlang: distlangCommandInfo(),
  }, null, 2));
}
