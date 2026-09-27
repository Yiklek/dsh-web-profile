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

/** Failures that make the process exit non-zero once the work is done. */
let failures = 0;

/**
 * Report a failure: a request this script could not carry out. Only states that
 * need an explicit flag can reach here, so `postinstall` (which passes none) is
 * never failed by one.
 *
 * @param message - the failure, without a severity prefix.
 */
function reportFailure(message) {
  console.error(`Error: ${message}`);
  failures += 1;
}

/**
 * Bail out on recorded failures, leaving a zero exit status untouched.
 *
 * @param code - the exit status to use when failures were recorded.
 */
function exitOnFailures(code = 1) {
  if (failures === 0) return;
  process.exit(code);
}

/**
 * The storage scopes `--mnemon-data` accepts. Mnemon itself has no "profile"
 * scope: the profile-local root is `custom` plus an explicit `dataDir`, and
 * `global` (`~/.mnemon`) is deliberately not offered here.
 */
const MNEMON_DATA_SCOPES = ["profile", "workspace", "workspaces"];

/**
 * Normalize one `--mnemon-data` value.
 *
 * @param value - the raw value after the flag.
 * @returns `profile`, `workspace`, or `workspaces`.
 */
function normalizeMnemonDataScope(value) {
  const scope = value.trim().toLowerCase();
  if (scope === "" || scope === "profile") return "profile";
  if (scope === "workspace" || scope === "workspaces") return scope;
  console.error(
    `Error: --mnemon-data accepts ${MNEMON_DATA_SCOPES.join(", ")} (bare means profile); got ${JSON.stringify(value)}`,
  );
  process.exit(2);
}

/**
 * Parse `--mnemon-data[=<scope>]`, whose value is optional.
 *
 * A bare `--mnemon-data` (nothing after it, or a following flag) means
 * `profile`, so the flag can force the profile-local root back on a profile
 * that had switched away from it.
 *
 * @param argv - the process argument list.
 * @returns the requested scope, or undefined when the flag is absent.
 */
function mnemonDataOption(argv) {
  const inline = argv.find((argument) => argument.startsWith("--mnemon-data="));
  if (inline !== undefined) return normalizeMnemonDataScope(inline.slice("--mnemon-data=".length));
  const index = argv.indexOf("--mnemon-data");
  if (index === -1) return undefined;
  const next = argv[index + 1];
  if (next === undefined || next.startsWith("-")) return "profile";
  return normalizeMnemonDataScope(next);
}

/** Requested scope from `--mnemon-data`, or undefined when it was not passed. */
const mnemonDataRequested = mnemonDataOption(process.argv);

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

/**
 * The note `upsertManagedBlock` writes under every opening marker. Readers strip
 * it so that a re-rendered body round-trips byte-for-byte instead of stacking a
 * second copy of the note on every run.
 */
const GENERATED_NOTE =
  "# Generated by scripts/install-services.mjs; do not edit this block manually.";

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
    GENERATED_NOTE,
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

/**
 * Read one generated block's body, or undefined when it is absent.
 *
 * The generated note and the newlines around it belong to the writer, so they
 * are stripped here: callers get exactly the rows `upsertManagedBlock` wraps.
 *
 * @param markerStart - the opening marker line.
 * @param markerEnd - the closing marker line.
 * @returns the rows between the markers.
 */
function readManagedBlockBody(markerStart, markerEnd) {
  if (!existsSync(patchPath)) return undefined;
  const text = readFileSync(patchPath, "utf8");
  const start = text.indexOf(markerStart);
  const end = text.indexOf(markerEnd);
  if (start < 0 || end < start) return undefined;
  const region = text.slice(start + markerStart.length, end);
  const noteIndex = region.indexOf(GENERATED_NOTE);
  const body = noteIndex === -1 ? region : region.slice(noteIndex + GENERATED_NOTE.length);
  return body.replace(/^\n+/, "").replace(/\n+$/, "");
}

/** The patch fields this script owns inside the mnemon block, in block order. */
const MNEMON_MANAGED_FIELDS = ["cliPath", "storageScope", "dataDir"];

/** Index of one managed field's line, or -1 when it is absent. */
function fieldLineIndex(lines, field) {
  return lines.findIndex((line) => new RegExp(`^ {4}${field}:`).test(line));
}

/** Render one managed field's line at the block's config indentation. */
function renderField(field, value) {
  return field === "storageScope"
    ? `    storageScope: ${value}`
    : `    ${field}: ${JSON.stringify(value)}`;
}

/** Where a missing managed field belongs, keeping cliPath/storageScope/dataDir order. */
function insertionIndexFor(lines, field) {
  const anchors = field === "dataDir" ? ["storageScope", "cliPath"] : ["cliPath"];
  for (const anchor of [...anchors, "config"]) {
    const pattern = anchor === "config" ? /^ {2}config:/ : new RegExp(`^ {4}${anchor}:`);
    const index = lines.findIndex((line) => pattern.test(line));
    if (index !== -1) return index + 1;
  }
  const row = lines.findIndex((line) => /^- id: mnemon/.test(line));
  return row === -1 ? lines.length : row + 1;
}

/**
 * Collapse one YAML parse failure into a single log line.
 *
 * @param error - a parser error or thrown value.
 * @returns the message without line breaks.
 */
function describeParseError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/gu, " ").trim();
}

/**
 * Read the mnemon block's current storage settings.
 *
 * Only the managed block is parsed — never the whole patch file, whose other
 * rows may hold `!!js` expressions. A field that is itself an expression parses
 * to its raw source text: it is never evaluated, and because the writer only
 * replaces lines whose value changed, it is also never rewritten.
 *
 * @returns undefined when the block is absent, `{ unparsable }` when it is not
 * parseable YAML, or the declared storage fields.
 */
function readMnemonBlockSettings() {
  const body = readManagedBlockBody(...blocks.mnemon);
  if (body === undefined) return undefined;
  let document;
  try {
    document = YAML.parseDocument(body, { logLevel: "silent" });
  } catch (error) {
    return { unparsable: describeParseError(error) };
  }
  if (document.errors.length > 0) return { unparsable: describeParseError(document.errors[0]) };
  const entries = document.toJS();
  const config = Array.isArray(entries)
    ? entries.find((entry) => entry?.id === "mnemon")?.config
    : undefined;
  const record = config !== null && typeof config === "object" ? config : {};
  return {
    storageScope: typeof record.storageScope === "string" ? record.storageScope : undefined,
    dataDir: typeof record.dataDir === "string" ? record.dataDir : undefined,
  };
}

/**
 * Resolve the mnemon storage state the block should end up in.
 *
 * Without `--mnemon-data` the existing state *is* the desired state, so the
 * block keeps whatever the settings UI last wrote. Only a block that never
 * configured a scope falls back to the profile-local root.
 *
 * @param existing - the value from {@link readMnemonBlockSettings}.
 * @returns the desired scope, the desired dataDir (undefined means "no such
 * line"), the origin for display, and whether a flag requested the state.
 */
function resolveMnemonStorage(existing) {
  const requested = mnemonDataRequested;
  if (requested === undefined) {
    if (existing?.unparsable !== undefined) {
      // Nothing is written in this state (see planMnemonBlockBody), so report an
      // unknown scope instead of inventing the profile default.
      return { storageScope: "unknown", dataDir: undefined, source: "unparsable block", requested: false };
    }
    const readable = existing !== undefined;
    if (readable && existing.storageScope !== undefined) {
      const filled =
        (existing.storageScope === "custom" || existing.storageScope === "workspaces") &&
        existing.dataDir === undefined
          ? mnemonDataPath
          : undefined;
      return {
        storageScope: existing.storageScope,
        dataDir: existing.dataDir ?? filled,
        source: "existing block",
        requested: false,
      };
    }
    return {
      storageScope: "custom",
      dataDir: mnemonDataPath,
      source: "default (profile)",
      requested: false,
    };
  }
  const source = `--mnemon-data=${requested}`;
  if (requested === "workspace") {
    // Mnemon hardcodes `<workspace>/.mnemon` for this scope and ignores
    // `dataDir`, so the line is removed instead of holding dead configuration.
    return { storageScope: "workspace", dataDir: undefined, source, requested: true };
  }
  if (requested === "workspaces") {
    return { storageScope: "workspaces", dataDir: mnemonDataPath, source, requested: true };
  }
  return { storageScope: "custom", dataDir: mnemonDataPath, source, requested: true };
}

/**
 * Plan the managed block body.
 *
 * Only the fields in {@link MNEMON_MANAGED_FIELDS} are touched, and only when
 * their value actually differs; every other byte inside the block (unknown
 * fields, `!!js` expressions, comments) is preserved. A field this script
 * cannot rewrite — an expression, or a value whose line was hand-reformatted —
 * is left untouched and reported.
 *
 * @param storage - the desired state from {@link resolveMnemonStorage}.
 * @param existing - the value from {@link readMnemonBlockSettings}.
 * @returns the body to write, or undefined to leave the block alone.
 */
function planMnemonBlockBody(storage, existing) {
  const body = readManagedBlockBody(...blocks.mnemon);
  if (body !== undefined && existing?.unparsable !== undefined) {
    const detail = `the mnemon block is not parseable YAML (${existing.unparsable})`;
    if (storage.requested) reportFailure(`${detail}; --mnemon-data was not applied`);
    else console.warn(`Warning: ${detail}; leaving it untouched`);
    return undefined;
  }

  const lines = body === undefined ? ["- id: mnemon", "  config:"] : body.split("\n");
  for (const field of MNEMON_MANAGED_FIELDS) {
    const desired = field === "cliPath" ? mnemonPath : storage[field];
    const declared = existing === undefined ? undefined : existing[field];
    const wanted = field === "storageScope" && desired !== undefined ? String(desired) : desired;
    const index = fieldLineIndex(lines, field);

    if (index === -1) {
      if (declared !== undefined) {
        const detail = `field "${field}" has no line at the managed indentation`;
        if (storage.requested) reportFailure(`${detail}; the requested value was not applied`);
        else console.warn(`Warning: ${detail}; leaving the block untouched for it`);
        continue;
      }
      if (wanted === undefined) continue;
      lines.splice(insertionIndexFor(lines, field), 0, renderField(field, wanted));
      continue;
    }

    if (declared === wanted) continue;
    if (wanted === undefined) lines.splice(index, 1);
    else lines[index] = renderField(field, wanted);
  }
  return lines.join("\n");
}

/**
 * Expand a leading `~`/`~/` exactly as mnemon's own storage resolver does, so a
 * preserved `dataDir` from the settings UI lands where the plugin will look.
 *
 * @param value - a raw configured directory.
 * @returns an absolute path.
 */
function expandDirectory(value) {
  if (value === "~") return homedir();
  return value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

/**
 * Describe where one resolved scope actually stores data.
 *
 * @param storage - the value from {@link resolveMnemonStorage}.
 * @returns a display path, with `<workspace id>` standing for a hashed child.
 */
function mnemonStorageRoot(storage) {
  switch (storage.storageScope) {
    case "custom":
      return expandDirectory(storage.dataDir ?? mnemonDataPath);
    case "workspaces":
      return join(
        expandDirectory(storage.dataDir ?? mnemonDataPath),
        "workspaces",
        "<workspace id>",
      );
    case "workspace":
      return join("<workspace>", ".mnemon");
    case "global":
      return expandDirectory(process.env.MNEMON_DATA_DIR?.trim() || join(homedir(), ".mnemon"));
    default:
      return "(unknown storageScope)";
  }
}

/**
 * Write the profile patch: the managed mnemon block, then the OpenViking block
 * when it is enabled.
 *
 * @param storage - the desired mnemon state from {@link resolveMnemonStorage}.
 * @param existing - the current mnemon block from {@link readMnemonBlockSettings}.
 */
function configureDshPatch(storage, existing) {
  const mnemonBody = planMnemonBlockBody(storage, existing);
  if (mnemonBody !== undefined) upsertManagedBlock(...blocks.mnemon, mnemonBody);

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

/**
 * Create the storage root a resolved scope owns inside the profile.
 *
 * `workspace` stores inside each workspace directory (`<workspace>/.mnemon`),
 * which the plugin creates on demand, and `global` stores inside the home
 * directory — neither is pre-created here. Creation is best-effort: this runs as
 * `postinstall` too, and a root that cannot be pre-created must not fail
 * `pnpm install` (the plugin creates its storage root on demand regardless).
 *
 * @param storage - the value from {@link resolveMnemonStorage}.
 */
function configureMnemonData(storage) {
  if (storage.storageScope !== "custom" && storage.storageScope !== "workspaces") return;
  const directory = expandDirectory(storage.dataDir ?? mnemonDataPath);
  try {
    mkdirSync(directory, { recursive: true });
  } catch (error) {
    console.warn(
      `Warning: could not create the Mnemon data directory ${directory}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
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
  const mnemonExisting = readMnemonBlockSettings();
  const mnemonStorage = resolveMnemonStorage(mnemonExisting);
  const mnemonStorageLine =
    `Mnemon storage: ${mnemonStorage.storageScope} (from ${mnemonStorage.source})` +
    ` -> ${mnemonStorageRoot(mnemonStorage)}`;

  if (checkOnly) {
    // Plan without writing, so a dry run surfaces the same problems a real run
    // would hit (an unparseable block, a stale dataDir).
    planMnemonBlockBody(mnemonStorage, mnemonExisting);
    console.log(`Mnemon CLI: ${mnemonVersion}`);
    console.log(mnemonStorageLine);
    console.log(
      `OpenViking: ${openVikingEnabled ? "enabled" : "disabled (opt-in with --openviking)"}`,
    );
    console.log(`DSH patch target: ${patchPath}`);
    exitOnFailures();
    process.exit(0);
  }

  configureMnemonData(mnemonStorage);
  const openViking = openVikingEnabled ? configureOpenViking() : null;
  configureDshPatch(mnemonStorage, mnemonExisting);
  if (openVikingEnabled) warmOpenVikingRuntime();

  console.log(`Mnemon CLI: ${mnemonVersion}`);
  console.log(mnemonStorageLine);
  if (!openViking) {
    console.log("OpenViking: disabled (opt-in with --openviking)");
    console.log("Restart DSH to apply.");
    exitOnFailures();
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
  exitOnFailures();
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
