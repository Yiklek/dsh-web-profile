#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const MIN_NODE_MAJOR = 22;
const OPENVIKING_DEFAULT_PORT = 1933;
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const servicesRoot = join(projectRoot, ".services");
const mnemonExecutable = process.platform === "win32" ? "mnemon.cmd" : "mnemon";
const mnemonPath = join(projectRoot, "node_modules", ".bin", mnemonExecutable);
const mnemonDataPath = join(servicesRoot, "mnemon");
const patchPath = join(projectRoot, "cordis.patch.yml");
const manifestPath = join(projectRoot, "package.json");
// A real package under packages/, not a file:// module: every active entry is
// resolved to an owning npm package before each DeepSeek request, and a bare
// specifier keeps that resolution on the package graph instead of walking up to
// the profile's own manifest.
const openVikingServicePackage = "dsh-openviking-service";
// The bundle entry, not our patch block, is what makes DSH load OpenViking's own
// patch — and that patch is what defines the `openviking-memory` group our block
// targets. Enabling or disabling both together is what keeps them in step.
const openVikingBundle = "@openviking/dsh-memory-plugin";
const openVikingRoot = join(servicesRoot, "openviking");
const checkOnly = process.argv.includes("--check");
// OpenViking is opt-in; see configureDshPatch() for why it defaults to off.
const openVikingEnabled =
  process.argv.includes("--openviking") || process.env.DSH_ENABLE_OPENVIKING === "1";

/**
 * The model OpenViking uses to extract memories from committed sessions.
 *
 * Pinned to DeepSeek's own OpenAI-compatible endpoint on purpose: OpenViking's
 * `openai` backend forwards `api_base` straight to the OpenAI SDK, so any
 * compatible endpoint works, and this one needs no protocol translation. DSH's
 * deployment default is deliberately NOT consulted — it can point at a
 * provider OpenViking cannot speak to (for example an Anthropic-Messages-only
 * coding route), which leaves extraction silently producing nothing.
 */
const OPENVIKING_VLM = Object.freeze({
  provider: "openai",
  model: "deepseek-flash",
  api_base: "https://api.deepseek.com/v1",
});

const blocks = {
  mnemon: ["# LOCAL_MNEMON_CLI_START", "# LOCAL_MNEMON_CLI_END"],
  openviking: ["# OPENVIKING_AUTOSTART_START", "# OPENVIKING_AUTOSTART_END"],
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: "inherit",
    shell: false,
    ...options,
  });

  if (result.error) {
    throw new Error(`Failed to run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    shell: false,
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function readJson(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!value || Array.isArray(value) || typeof value !== "object") {
      throw new Error("the root value must be a JSON object");
    }
    return value;
  } catch (error) {
    throw new Error(
      `Cannot read JSON config at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function writeJson(path, value, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode });
  chmodSync(path, mode);
}

function commandExists(command) {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    shell: false,
    timeout: 5_000,
  });
  return result.status === 0;
}

/** Read one named secret from DSH's owner-only credential store. */function readDshCredential(name) {
  const path = join(process.env.DSH_HOME || join(homedir(), ".dsh"), ".credentials.yaml");
  if (!existsSync(path)) return "";
  try {
    const refs = YAML.parse(readFileSync(path, "utf8"))?.refs ?? {};
    const value = refs[name];
    return typeof value === "string" ? value.trim() : "";
  } catch (error) {
    throw new Error(
      `Cannot read DSH credentials at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Strip proxy settings OpenViking's httpx-backed SDKs cannot honour.
 *
 * A host-level `all_proxy=socks5://…` needs the optional `socksio` extra; without
 * it every model call fails and closing the client raises
 * `AttributeError: 'AsyncHttpxClientWrapper' object has no attribute '_mounts'`.
 * A `no_proxy` entry written as bracketed IPv6 (`[::1]`) is fed to httpx as a URL
 * pattern and raises `InvalidURL: Invalid port: ':1]'`. Ordinary http_proxy and
 * https_proxy are kept.
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

/**
 * Materialize the OpenViking runtime into uv's tool cache ahead of time.
 *
 * Starting the server lazily would make the very first DSH session pay for the
 * download — and, because llama-cpp-python ships source-only, for a full
 * llama.cpp compile. Doing it here keeps that cost out of DSH startup, so a
 * plain `pnpm install` is all that is needed to get everything ready.
 *
 * A failure here is a warning, not an error: OpenViking is optional, and the
 * lifecycle plugin retries the same command when DSH actually starts.
 */
function warmOpenVikingRuntime() {
  const uvxCommand = process.platform === "win32" ? "uvx.exe" : "uvx";
  if (!commandExists(uvxCommand)) {
    console.warn("uvx is not on PATH; skipping the OpenViking runtime warm-up.");
    return false;
  }

  console.log("Preparing the OpenViking runtime (first run compiles llama-cpp-python)…");
  try {
    run(
      uvxCommand,
      ["--from", "openviking[local-embed]", "openviking-server", "--version"],
      { env: sanitizeProxyEnvironment(process.env) },
    );
    return true;
  } catch (error) {
    console.warn(
      `OpenViking runtime warm-up failed: ${error instanceof Error ? error.message : String(error)}` +
        "\nThe lifecycle plugin will retry it when DSH starts.",
    );
    return false;
  }
}

/**
 * Confirm the local Mnemon CLI is present and runnable.
 *
 * Installing it is pnpm's job, driven by the `@mnemon-dev/mnemon` dependency in
 * package.json — this only verifies the result, because a missing binary means
 * the install itself did not complete and quietly repairing it here would hide
 * that.
 */
async function ensureLocalMnemon() {
  if (!existsSync(mnemonPath)) {
    throw new Error(
      `Local Mnemon CLI is missing at ${mnemonPath}.\n` +
        "Run `pnpm install` in this profile (add --frozen-lockfile if pnpm reports it is already up to date).",
    );
  }
  if (process.platform !== "win32") {
    await access(mnemonPath, constants.X_OK);
  }

  const version = capture(mnemonPath, ["--version"]);
  if (!version) {
    throw new Error(`Local Mnemon CLI could not be executed at ${mnemonPath}.`);
  }
  return version;
}

/**
 * Add or remove the OpenViking bundle entry in the profile manifest.
 *
 * An absent bundle means DSH never loads the package's own patch, so the group
 * our block targets would not exist — the two must be switched together.
 * The rest of the manifest is preserved; only this one array element changes.
 */
function setProfileBundle(enabled) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const bundles = manifest?.dsh?.profile?.bundles;
  if (!Array.isArray(bundles)) {
    throw new Error(`${manifestPath} has no dsh.profile.bundles array to edit.`);
  }

  const index = bundles.indexOf(openVikingBundle);
  if (enabled && index < 0) {
    // Keep it next to dsh-mnemon so the memory plugins stay grouped.
    const anchor = bundles.indexOf("dsh-mnemon");
    bundles.splice(anchor < 0 ? bundles.length : anchor, 0, openVikingBundle);
  } else if (!enabled && index >= 0) {
    bundles.splice(index, 1);
  } else {
    return "unchanged";
  }

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return enabled ? "added" : "removed";
}

function upsertManagedBlock(markerStart, markerEnd, body) {
  const block = [
    markerStart,
    "# Generated by scripts/install-services.mjs; do not edit this block manually.",
    body,
    markerEnd,
  ].join("\n");
  const existing = existsSync(patchPath) ? readFileSync(patchPath, "utf8") : "";
  const start = existing.indexOf(markerStart);
  const end = existing.indexOf(markerEnd);
  let next;

  if (start >= 0 || end >= 0) {
    if (start < 0 || end < start) {
      throw new Error(`Malformed generated block ${markerStart} in ${patchPath}.`);
    }
    next = `${existing.slice(0, start)}${block}${existing.slice(end + markerEnd.length)}`;
  } else {
    const prefix = existing.trimEnd();
    next = prefix ? `${prefix}\n\n${block}\n` : `${block}\n`;
  }

  if (next !== existing) writeFileSync(patchPath, next, "utf8");
}

function removeManagedBlock(markerStart, markerEnd) {  if (!existsSync(patchPath)) return;
  const existing = readFileSync(patchPath, "utf8");
  const start = existing.indexOf(markerStart);
  const end = existing.indexOf(markerEnd);
  if (start < 0 && end < 0) return;
  if (start < 0 || end < start) {
    throw new Error(`Malformed generated block ${markerStart} in ${patchPath}.`);
  }
  const next = `${existing.slice(0, start)}${existing.slice(end + markerEnd.length)}`
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
  writeFileSync(patchPath, next ? `${next}\n` : "", "utf8");
}

function configureDshPatch() {
  upsertManagedBlock(
    ...blocks.mnemon,
    [
      "- id: mnemon",
      "  config:",
      `    cliPath: ${JSON.stringify(mnemonPath)}`,
      "    storageScope: custom",
      `    dataDir: ${JSON.stringify(mnemonDataPath)}`,
    ].join("\n"),
  );

  // OpenViking is off by default: its per-step recall runs a synchronous
  // pre-step phase (retrieve, then inject a persistent message) that every
  // model response has to wait for. Opt back in with `--openviking` or
  // DSH_ENABLE_OPENVIKING=1.
  setProfileBundle(openVikingEnabled);

  if (!openVikingEnabled) {
    removeManagedBlock(...blocks.openviking);
    return;
  }

  upsertManagedBlock(
    ...blocks.openviking,
    [
      "- id: openviking-memory",
      "  config:",
      "    - id: openviking-service-autostart",
      `      name: ${JSON.stringify(openVikingServicePackage)}`,
      "      config:",
      `        serviceRoot: ${JSON.stringify(openVikingRoot)}`,
      "    - id: openviking-memory-runtime",
      "      name: '@openviking/dsh-memory-plugin'",
      "      config:",
      // Query expansion is the one part of the recall path that leaves the
      // machine: it asks the configured `vlm` (a remote model) to rewrite the
      // query before retrieval. Embedding, search and rerank are already local.
      // Left on, every model step waits for that round trip.
      "        recallQueryExpansion: off",
    ].join("\n"),
  );
}

function configureMnemonData() {
  mkdirSync(mnemonDataPath, { recursive: true });
}

function configureOpenViking() {
  for (const directory of ["pending", "state", "logs", "data"]) {
    mkdirSync(join(openVikingRoot, directory), { recursive: true });
  }

  const configPath = join(openVikingRoot, "ov.conf");
  const baseConfig = existsSync(configPath) ? readJson(configPath) : {};
  const config = {
    ...baseConfig,
    storage: {
      ...(baseConfig.storage || {}),
      workspace: join(openVikingRoot, "data"),
    },
    server: {
      ...(baseConfig.server || {}),
      host: "127.0.0.1",
      port: OPENVIKING_DEFAULT_PORT,
    },
  };

  // Memory extraction is what turns stored sessions into recallable memories;
  // without a `vlm` the server still starts and still records conversations, but
  // silently extracts nothing.
  const apiKey = (process.env.DEEPSEEK_API_KEY || "").trim() || readDshCredential("DEEPSEEK_API_KEY");
  let vlm = "unconfigured";
  if (apiKey) {
    config.vlm = { ...OPENVIKING_VLM, api_key: apiKey };
    vlm = `${OPENVIKING_VLM.provider} / ${OPENVIKING_VLM.model}`;
  }

  writeJson(configPath, config);

  const cliConfigPath = join(openVikingRoot, "ovcli.conf");
  const baseCliConfig = existsSync(cliConfigPath) ? readJson(cliConfigPath) : {};
  writeJson(cliConfigPath, {
    ...baseCliConfig,
    url: `http://127.0.0.1:${OPENVIKING_DEFAULT_PORT}`,
  });

  return { configPath, cliConfigPath, vlm, hasApiKey: Boolean(apiKey) };
}

const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
if (!Number.isInteger(nodeMajor) || nodeMajor < MIN_NODE_MAJOR) {
  console.error(
    `Error: Mnemon requires Node.js ${MIN_NODE_MAJOR} or newer; found ${process.version}.`,
  );
  process.exit(1);
}

try {
  const mnemonVersion = await ensureLocalMnemon();

  if (checkOnly) {
    console.log(`Mnemon CLI: ${mnemonVersion}`);
    console.log(`Mnemon data: ${mnemonDataPath}`);
    console.log(
      `OpenViking: ${openVikingEnabled ? "enabled" : "disabled (opt-in with --openviking)"}`,
    );
    console.log(`DSH patch target: ${patchPath}`);
    process.exit(0);
  }

  configureMnemonData();
  const openViking = openVikingEnabled ? configureOpenViking() : null;
  configureDshPatch();
  if (openVikingEnabled) warmOpenVikingRuntime();

  console.log(`Mnemon CLI: ${mnemonVersion}`);
  console.log(`Mnemon data: ${mnemonDataPath}`);
  if (!openViking) {
    console.log("OpenViking: disabled (opt-in with --openviking)");
    console.log("Restart DSH to apply.");
    process.exit(0);
  }
  console.log(`OpenViking config: ${openViking.configPath}`);
  console.log(`OpenViking data: ${openVikingRoot}`);
  console.log(`OpenViking extraction model: ${openViking.vlm}`);
  if (!openViking.hasApiKey) {
    console.warn(
      "DEEPSEEK_API_KEY was not found in the environment or in ~/.dsh/.credentials.yaml.\n" +
        "OpenViking will start and record sessions, but memory extraction stays disabled.",
    );
  }
  console.log("Restart DSH to load the profile-local memory services.");
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
