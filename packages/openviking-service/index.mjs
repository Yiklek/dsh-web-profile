import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ENDPOINT = "http://127.0.0.1:1933";
const START_TIMEOUT_MS = 90_000;
const HEALTH_INTERVAL_MS = 500;

/**
 * Locate the profile that owns this package by walking up to the directory
 * holding `cordis.yml`. Deriving the root from the module's own depth would
 * break the moment the package moves, so it is discovered instead.
 */
function findProfileRoot(startDir) {
  let current = startDir;
  const root = parse(current).root;
  for (;;) {
    if (existsSync(join(current, "cordis.yml"))) return current;
    if (current === root) return startDir;
    current = dirname(current);
  }
}

const PROFILE_ROOT = findProfileRoot(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_SERVICE_ROOT = join(PROFILE_ROOT, ".services", "openviking");

/**
 * Strip proxy settings the server's HTTP clients cannot honour.
 *
 * OpenViking talks to its model provider through httpx-backed SDKs, and inherits
 * this process's environment. Two host-level values break it:
 *
 *   - `all_proxy=socks5://…` needs the optional `socksio` extra. Without it every
 *     model call fails with "Using SOCKS proxy, but the 'socksio' package is not
 *     installed", and closing the client additionally raises
 *     `AttributeError: 'AsyncHttpxClientWrapper' object has no attribute '_mounts'`.
 *   - a `no_proxy` entry written as bracketed IPv6 (`[::1]`) is fed to httpx as a
 *     URL pattern and raises `InvalidURL: Invalid port: ':1]'`.
 *
 * Ordinary http_proxy/https_proxy are kept, so a proxied host still reaches its
 * provider.
 */
function sanitizeProxyEnvironment(env) {
  const out = { ...env };

  for (const key of ["all_proxy", "ALL_PROXY"]) {
    if (/^socks/i.test(String(out[key] ?? "").trim())) delete out[key];
  }

  for (const key of ["no_proxy", "NO_PROXY"]) {
    const value = out[key];
    if (typeof value !== "string") continue;
    const entries = value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry && !/^\[.*\]$/.test(entry));
    if (entries.length === 0) delete out[key];
    else out[key] = entries.join(",");
  }

  return out;
}

function commandExists(command) {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    shell: false,
    timeout: 5_000,
  });
  return result.status === 0;
}

async function isHealthy(endpoint) {
  try {
    const response = await fetch(`${endpoint.replace(/\/+$/, "")}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForHealth(endpoint, child) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isHealthy(endpoint)) return true;
    if (child.exitCode !== null || child.signalCode !== null) return false;
    await wait(HEALTH_INTERVAL_MS);
  }
  return false;
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    await wait(100);
  }

  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}

/**
 * Start the OpenViking server for this profile, or adopt one already running.
 *
 * The entry is mounted before the OpenViking runtime plugin in the same group,
 * so the paths exported here are what that runtime resolves its configuration,
 * state directory and pending queue from.
 */
export async function apply(ctx, config = {}) {
  const logger = typeof ctx.logger === "function" ? ctx.logger("openviking-autostart") : console;
  const serviceRoot = config.serviceRoot || DEFAULT_SERVICE_ROOT;
  const endpoint = config.endpoint || DEFAULT_ENDPOINT;
  const configPath = config.configPath || join(serviceRoot, "ov.conf");
  const cliConfigPath = config.cliConfigPath || join(serviceRoot, "ovcli.conf");
  const stateDir = config.stateDir || join(serviceRoot, "state");
  const pendingDir = config.pendingDir || join(serviceRoot, "pending");
  const logPath = config.logPath || join(serviceRoot, "logs", "server.log");

  process.env.OPENVIKING_HOME = serviceRoot;
  process.env.OPENVIKING_CONFIG_FILE = configPath;
  process.env.OPENVIKING_CLI_CONFIG_FILE = cliConfigPath;
  process.env.OPENVIKING_STATE_DIR = stateDir;
  process.env.OPENVIKING_PENDING_DIR = pendingDir;
  process.env.OPENVIKING_URL = endpoint;

  mkdirSync(join(serviceRoot, "logs"), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(pendingDir, { recursive: true });

  // A server already on the port is adopted, never restarted or stopped.
  if (await isHealthy(endpoint)) {
    logger.info?.(`OpenViking is already healthy at ${endpoint}`);
    return;
  }

  // OpenViking is optional for this profile. Missing uvx is intentionally ignored.
  const uvxCommand = process.platform === "win32" ? "uvx.exe" : "uvx";
  if (!commandExists(uvxCommand)) return;

  if (!existsSync(configPath)) {
    logger.warn?.(`OpenViking autostart skipped because ${configPath} does not exist.`);
    return;
  }

  const logFd = openSync(logPath, "a", 0o600);
  const child = spawn(
    uvxCommand,
    // `[local-embed]` pulls llama-cpp-python, which the plain install omits.
    // Without it the server aborts: "Local embedding is enabled but
    // 'llama-cpp-python' is not installed". It builds once, then uv caches it.
    ["--from", "openviking[local-embed]", "openviking-server", "--config", configPath],
    {
      env: sanitizeProxyEnvironment(process.env),
      shell: false,
      stdio: ["ignore", logFd, logFd],
    },
  );
  closeSync(logFd);

  child.on("error", (error) => {
    logger.warn?.(`OpenViking process failed: ${error.message}`);
  });

  // Never block plugin loading on readiness: a cold start can take a minute, and
  // the runtime tolerates an unreachable endpoint by queueing writes in the
  // pending directory. Awaiting here would stall the whole memory group.
  ctx.effect(() => () => stopChild(child), "stop profile-managed OpenViking service");

  void waitForHealth(endpoint, child).then((healthy) => {
    if (healthy) logger.info?.(`OpenViking started at ${endpoint}`);
    else logger.warn?.(`OpenViking did not become healthy at ${endpoint}; see ${logPath}`);
  });
}
