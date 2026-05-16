import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
let managedInstallPromise = null;
let resolvedBinaryPromise = null;

function configuredValue(value, fallback = "") {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function autoInstallDisabled() {
  const value = configuredValue(process.env.DISTLANG_CLAUDE_CODE_NO_INSTALL, "").toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function managedInstallDir() {
  return configuredValue(process.env.DISTLANG_CLAUDE_CODE_DISTLANG_INSTALL_DIR, join(homedir(), ".cache", "distlang", "claude-code-plugin", "bin"));
}

function managedBinaryPath() {
  return join(managedInstallDir(), process.platform === "win32" ? "distlang.exe" : "distlang");
}

async function pathHasExecutable(filePath) {
  try {
    await fs.access(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findDistlangOnPath() {
  const pathValue = configuredValue(process.env.PATH, "");
  const names = process.platform === "win32" ? ["distlang.exe", "distlang.cmd", "distlang.bat"] : ["distlang"];
  for (const part of pathValue.split(process.platform === "win32" ? ";" : ":")) {
    if (!part) continue;
    for (const name of names) {
      const candidate = join(part, name);
      if (await pathHasExecutable(candidate)) return candidate;
    }
  }
  return "";
}

async function verifyDistlangBinary(filePath) {
  const path = configuredValue(filePath, "");
  if (!path) {
    const error = new Error("distlang binary path is empty");
    error.code = "ENOENT";
    throw error;
  }
  await execFileAsync(path, ["--version"], { env: process.env, timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
  return path;
}

async function installManagedDistlang() {
  if (managedInstallPromise) return managedInstallPromise;
  managedInstallPromise = (async () => {
    await fs.mkdir(managedInstallDir(), { recursive: true });
    await execFileAsync("bash", ["-lc", "curl -fsSL https://distlang.com/install-main | bash"], {
      env: { ...process.env, DISTLANG_INSTALL_DIR: managedInstallDir() },
      timeout: 60000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return verifyDistlangBinary(managedBinaryPath());
  })();
  try {
    return await managedInstallPromise;
  } finally {
    managedInstallPromise = null;
  }
}

export async function resolveDistlangBinary(options = {}) {
  const installIfMissing = options.installIfMissing !== false;
  const explicit = configuredValue(process.env.DISTLANG_BIN, "");
  if (explicit) {
    await verifyDistlangBinary(explicit);
    return { path: explicit, source: "env" };
  }
  if (resolvedBinaryPromise && installIfMissing) return resolvedBinaryPromise;
  const resolver = (async () => {
    const fromPath = await findDistlangOnPath();
    if (fromPath) {
      await verifyDistlangBinary(fromPath);
      return { path: fromPath, source: "path" };
    }
    const managed = managedBinaryPath();
    if (await pathHasExecutable(managed)) {
      await verifyDistlangBinary(managed);
      return { path: managed, source: "managed" };
    }
    if (!installIfMissing || autoInstallDisabled()) {
      const error = new Error("distlang CLI not found");
      error.code = "ENOENT";
      throw error;
    }
    return { path: await installManagedDistlang(), source: "installed" };
  })();
  if (installIfMissing) resolvedBinaryPromise = resolver;
  try {
    return await resolver;
  } catch (error) {
    if (installIfMissing) resolvedBinaryPromise = null;
    throw error;
  }
}

export function distlangCommandInfo() {
  return {
    bin: configuredValue(process.env.DISTLANG_BIN, "distlang"),
    managed_bin: managedBinaryPath(),
    auto_install_disabled: autoInstallDisabled(),
  };
}

export async function runDistlang(args, options = {}) {
  const resolved = await resolveDistlangBinary({ installIfMissing: options.installIfMissing !== false });
  return execFileAsync(resolved.path, args, {
    env: process.env,
    timeout: options.timeout ?? 15000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

export async function getAuthStatus() {
  const { stdout } = await runDistlang(["helpers", "auth", "status", "--json"], { timeout: 10000 });
  return JSON.parse(stdout || "{}");
}

export async function loginWithDistlang() {
  return runDistlang(["helpers", "login"], { timeout: 120000 });
}

export async function logoutWithDistlang() {
  return runDistlang(["helpers", "logout"], { timeout: 30000 });
}

export async function uploadAgentDebuggerPayload(payload) {
  const tempFile = join(tmpdir(), `distlang-agent-debugger-claude-${randomUUID()}.json`);
  await fs.writeFile(tempFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  try {
    const { stdout } = await runDistlang([
      "helpers",
      "request",
      "POST",
      "/agent-debugger/v1/ingest",
      `--body-file=${tempFile}`,
      "--content-type=application/json",
      "--json",
    ], { timeout: 12000 });
    return JSON.parse(stdout || "{}");
  } finally {
    await fs.unlink(tempFile).catch(() => {});
  }
}

export async function fetchRecentClaudeSessions() {
  const { stdout } = await runDistlang(["helpers", "request", "GET", "/agent-debugger/v1/sessions?source=claude-code&limit=5", "--json"], { timeout: 10000 });
  return JSON.parse(stdout || "{}");
}
