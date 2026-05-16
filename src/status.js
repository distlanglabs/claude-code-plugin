import { distlangCommandInfo, fetchRecentClaudeSessions, getAuthStatus, loginWithDistlang, logoutWithDistlang, resolveDistlangBinary } from "./distlang.js";
import { readState, setEnabled, statePath } from "./state.js";

function actionFromArg() {
  const arg = process.argv.slice(2).find((value) => !value.startsWith("--"));
  return String(arg || "status").toLowerCase();
}

export async function main() {
  const action = actionFromArg();
  if (!["status", "start", "stop", "login", "logout"].includes(action)) {
    throw new Error("Usage: distlang-claude-code-status [status|start|stop|login|logout]");
  }
  if (action === "start" || action === "login") {
    await setEnabled(true);
    await resolveDistlangBinary({ installIfMissing: true });
    let auth = await getAuthStatus().catch(() => null);
    if (!auth || auth.ok !== true || auth.logged_in !== true) {
      await loginWithDistlang();
      auth = await getAuthStatus().catch(() => null);
    }
    console.log(JSON.stringify({ ok: true, enabled: true, auth, statePath: statePath(), distlang: distlangCommandInfo() }, null, 2));
    return;
  }
  if (action === "stop" || action === "logout") {
    await setEnabled(false);
    await logoutWithDistlang().catch(() => {});
    console.log(JSON.stringify({ ok: true, enabled: false, statePath: statePath(), distlang: distlangCommandInfo() }, null, 2));
    return;
  }
  const state = await readState();
  const resolved = await resolveDistlangBinary({ installIfMissing: true }).catch((error) => ({ error: String(error) }));
  const auth = await getAuthStatus().catch((error) => ({ error: String(error) }));
  const sessions = auth && auth.ok === true && auth.logged_in === true ? await fetchRecentClaudeSessions().catch((error) => ({ error: String(error) })) : null;
  console.log(JSON.stringify({ ok: true, statePath: statePath(), state: { enabled: state.enabled, sessions: state.sessions.length }, distlang: resolved, auth, sessions }, null, 2));
}
