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
// The profile this run configures. DSH_PROFILE_ROOT points the script at another
// directory, which is how the test suite drives a throwaway profile instead of
// the real one.
const projectRoot =
  process.env.DSH_PROFILE_ROOT?.trim() || dirname(dirname(fileURLToPath(import.meta.url)));
const servicesRoot = join(projectRoot, ".services");
const mnemonExecutable = process.platform === "win32" ? "mnemon.cmd" : "mnemon";
const mnemonPath = join(projectRoot, "node_modules", ".bin", mnemonExecutable);
// The package's own launcher script, which dsh-mnemon recognizes by structure:
// it resolves a path whose package is @mnemon-dev/mnemon and whose basename is
// bin/mnemon.js, then runs it as `node <launcher>`. A pnpm .bin/*.cmd shim never
// resolves that way — mnemonNpmLauncher looks for the launcher under the shim's
// own directory, which matches npm's flat layout, not pnpm's — so the plugin
// would spawn the .cmd directly, and Node refuses to spawn a .cmd without a
// shell. The install then looks missing and every memory write is refused.
// The shim still proves the install ran; it just cannot be the configured path.
const mnemonLauncherPath = join(
  projectRoot,
  "node_modules",
  "@mnemon-dev",
  "mnemon",
  "bin",
  "mnemon.js",
);
const mnemonCliPath = process.platform === "win32" ? mnemonLauncherPath : mnemonPath;
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
// The warm-up downloads (and on first use compiles) the OpenViking runtime.
// That is the right default for an install, and the wrong thing to do when the
// caller only wants the profile wired up — offline installs and the test suite
// both ask for it to be skipped.
const skipWarmup = process.argv.includes("--no-warmup");
// OpenViking is opt-in; see planDshPatch() for why it defaults to off.
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

/**
 * The OpenViking runtime the warm-up prepares, pinned to one version.
 *
 * An unpinned `uvx --from openviking[local-embed]` re-resolves its transitive
 * dependencies on every run, and uv keys its cache by the resolved environment
 * — so each drift in a dependency adds another full environment (roughly 800 MB
 * with the local-embed extra). Pinning keeps one environment, keeps installs
 * reproducible, and lets the CI cache key name exactly what it holds.
 *
 * Bump deliberately; bump {@link OPENVIKING_RUNTIME_VERSION} with it.
 */
const OPENVIKING_RUNTIME_VERSION = "0.4.22";
const OPENVIKING_RUNTIME_SPEC = `openviking[local-embed]==${OPENVIKING_RUNTIME_VERSION}`;

/**
 * The note left above the row this script maintains.
 *
 * It names the three fields rather than the whole row: the row is the Mnemon
 * settings row, and the settings UI writes the rest of its config too.
 */
const OWNERSHIP_NOTE =
  "cliPath / storageScope / dataDir are maintained by scripts/install-services.mjs";

/**
 * Comment lines written by the marker-block era of this script.
 *
 * The write scope is the row itself now, so a pair of block markers would only
 * claim a region nothing enforces. They are stripped when the patch is read,
 * which makes the first run after this change tidy the file up once.
 */
const RETIRED_MARKER_LINE =
  /^#\s*(?:LOCAL_MNEMON_CLI_(?:START|END)|OPENVIKING_AUTOSTART_(?:START|END)|Generated by scripts\/install-services\.mjs.*)$/;

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
    // Never a shell: Node concatenates command and args without quoting when it
    // uses one, so a profile path containing a space (common on Windows) would
    // break, and it warns about the injection risk (DEP0190). The Windows probe
    // goes through `process.execPath` instead — see ensureLocalMnemon().
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
      ["--from", OPENVIKING_RUNTIME_SPEC, "openviking-server", "--version"],
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
  } else if (!existsSync(mnemonLauncherPath)) {
    // The shim can exist while the launcher it should point at does not, and
    // only the launcher is a usable cliPath. Fail here rather than writing a
    // path dsh-mnemon will reject at runtime.
    throw new Error(
      `Local Mnemon launcher is missing at ${mnemonLauncherPath}.\n` +
        "Run `pnpm install` in this profile (add --frozen-lockfile if pnpm reports it is already up to date).",
    );
  }

  // Probe exactly what the block will configure. The Windows shim is a .cmd,
  // which Node refuses to spawn without a shell, so run the launcher through
  // this Node binary instead — the same thing dsh-mnemon does once it resolves
  // the launcher.
  const version =
    process.platform === "win32"
      ? capture(process.execPath, [mnemonLauncherPath, "--version"])
      : capture(mnemonPath, ["--version"]);
  if (!version) {
    throw new Error(`Local Mnemon CLI could not be executed at ${mnemonCliPath}.`);
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

/**
 * Read and parse the profile patch.
 *
 * The whole file is parsed, exactly as dsh-config-editor does when the settings
 * UI writes it — the patch is one YAML sequence and that UI already round-trips
 * all of it, so a narrower read would protect nothing. `!!js` expressions
 * survive because YAML_PARSE_OPTIONS declares the tag.
 *
 * Comment lines left by the marker-block era are dropped here, so the first run
 * after that change tidies the file up once.
 *
 * @returns the text as read, and its parsed document.
 */
function loadPatch() {
  const raw = existsSync(patchPath) ? readFileSync(patchPath, "utf8") : "";
  const cleaned = raw
    .split("\n")
    .filter((line) => !RETIRED_MARKER_LINE.test(line))
    .join("\n");
  let document;
  try {
    document = YAML.parseDocument(cleaned === "" ? "[]\n" : cleaned, YAML_PARSE_OPTIONS);
  } catch (error) {
    throw new Error(`${patchPath} is not parseable YAML: ${describeParseError(error)}`);
  }
  if (document.errors.length > 0) {
    throw new Error(`${patchPath} is not parseable YAML: ${describeParseError(document.errors[0])}`);
  }
  if (!YAML.isSeq(document.contents)) {
    throw new Error(`${patchPath} must be a YAML sequence`);
  }
  // A file seeded from `[]` (absent or empty) parses as a *flow* sequence, and a
  // flow collection forces every descendant to flow as well — the rows added
  // below would come out as `[{ id: mnemon, config: { ... } }]`. dsh-config-editor
  // normalizes this the same way before it writes.
  document.contents.flow = false;
  // Compared against the text as read, so a run whose only effect is stripping
  // retired markers still counts as a change and gets written.
  return { before: raw, document };
}

/**
 * Write the patch back, but only when serializing it produced different text.
 *
 * @param patch - the value from {@link loadPatch}.
 * @returns whether the file was written.
 */
function savePatch(patch) {
  const after = String(patch.document);
  if (after === patch.before) return false;
  writeFileSync(patchPath, after, "utf8");
  return true;
}

/**
 * Index of the last top-level row carrying one id, or -1 when there is none.
 *
 * "Last" is what dsh-config-editor targets when the settings UI writes, so a
 * reader and a writer never disagree about which row holds a config. An `insert`
 * row carries no top-level `id` and is skipped by that test alone.
 *
 * @param document - the parsed patch.
 * @param id - the entry id to look for.
 * @returns the row index, or -1.
 */
function findRow(document, id) {
  return document.contents.items.findLastIndex(
    (item, index) => YAML.isMap(item) && document.getIn([index, "id"]) === id,
  );
}

/**
 * Remove every top-level row carrying one id.
 *
 * @param document - the parsed patch.
 * @param id - the entry id to remove.
 */
function deleteRows(document, id) {
  for (let index = document.contents.items.length - 1; index >= 0; index--) {
    if (YAML.isMap(document.contents.items[index]) && document.getIn([index, "id"]) === id) {
      document.delete(index);
    }
  }
}

/** The patch fields this script owns inside the mnemon row. */
const MNEMON_MANAGED_FIELDS = ["cliPath", "storageScope", "dataDir"];

/**
 * DSH's `!!js` tag, declared the way dsh-config-editor declares it.
 *
 * The resolver returns the raw source text and never evaluates it: this script
 * must not run profile-supplied JavaScript. Declaring the tag is what keeps the
 * expression intact through a parse/serialize round trip — without it the
 * scalar is an ordinary string and loses its tag on the way back out.
 */
const JS_TAG = "tag:yaml.org,2002:js";
const YAML_PARSE_OPTIONS = Object.freeze({
  customTags: [{ tag: JS_TAG, resolve: (value) => value }],
  logLevel: "silent",
});

/**
 * Report a managed block the script cannot act on, and say what happens next.
 *
 * Without `--mnemon-data` nothing was asked for, so this stays a warning and the
 * run continues: `postinstall` must not fail because a patch file was hand-edited
 * into a shape this script does not recognize. With the flag, the caller asked
 * for a change that will not happen, and that is an error.
 *
 * @param detail - what is wrong, phrased to follow "the mnemon block".
 * @param requested - whether `--mnemon-data` asked for a change.
 */
function reportBlockProblem(detail, requested) {
  if (requested) reportFailure(`the mnemon block ${detail}; --mnemon-data was not applied`);
  else console.warn(`Warning: the mnemon block ${detail}; leaving it untouched`);
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
 * Read the mnemon row's current storage settings.
 *
 * A field holding an `!!js` expression parses to its raw source text — never
 * evaluated — and the writer skips expression-valued fields, so it is never
 * rewritten either.
 *
 * @param document - the parsed patch.
 * @returns the declared storage fields; both are undefined when the row is
 * absent or holds no such field.
 */
function readMnemonSettings(document) {
  const row = findRow(document, "mnemon");
  // `getIn` hands back the YAMLMap node, whose keys are not properties — reading
  // `node.storageScope` yields undefined while JSON.stringify still prints the
  // contents through toJSON(). Convert explicitly.
  const node = row < 0 ? undefined : document.getIn([row, "config"], true);
  const record = YAML.isMap(node) ? node.toJSON() : {};
  return {
    storageScope: typeof record.storageScope === "string" ? record.storageScope : undefined,
    dataDir: typeof record.dataDir === "string" ? record.dataDir : undefined,
  };
}

/**
 * Resolve the mnemon storage state the row should end up in.
 *
 * Without `--mnemon-data` the existing state *is* the desired state, so the row
 * keeps whatever the settings UI last wrote. Only a row that never configured a
 * scope falls back to the profile-local root.
 *
 * @param existing - the value from {@link readMnemonSettings}.
 * @returns the desired scope, the desired dataDir (undefined means "no such
 * field"), the origin for display, and whether a flag requested the state.
 */
function resolveMnemonStorage(existing) {
  const requested = mnemonDataRequested;
  if (requested === undefined) {
    if (existing.storageScope !== undefined) {
      const filled =
        (existing.storageScope === "custom" || existing.storageScope === "workspaces") &&
        existing.dataDir === undefined
          ? mnemonDataPath
          : undefined;
      return {
        storageScope: existing.storageScope,
        dataDir: existing.dataDir ?? filled,
        source: "existing config",
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
 * Apply the Mnemon settings to the parsed patch.
 *
 * Only the fields in {@link MNEMON_MANAGED_FIELDS} are touched, and only when
 * their value actually differs; every other field on the row is preserved — the
 * config map is shared with the settings UI, which writes its own keys there.
 *
 * The row is created when absent. A row whose `config` is neither absent, empty
 * nor a mapping is left alone and reported: it is malformed for this entry, and
 * replacing it would discard whatever a hand-edit meant.
 *
 * A managed field holding an `!!js` expression is likewise left alone and
 * reported: the script owns the field's value, not an expression that happens to
 * sit in it, and evaluating it is out of the question.
 *
 * @param document - the parsed patch, mutated in place.
 * @param storage - the desired state from {@link resolveMnemonStorage}.
 * @param existing - the value from {@link readMnemonSettings}.
 */
function applyMnemonSettings(document, storage, existing) {
  let row = findRow(document, "mnemon");
  if (row < 0) {
    const created = document.createNode({ id: "mnemon", config: {} });
    created.commentBefore = ` ${OWNERSHIP_NOTE}`;
    document.add(created);
    row = document.contents.items.length - 1;
  }

  // `config` can be missing, empty (`config:` parses as null), or — if the file
  // was hand-edited — a scalar or a sequence. Only the first two are ours to
  // fill in.
  const declaredConfig = document.getIn([row, "config"]);
  if (declaredConfig === undefined || declaredConfig === null) {
    document.setIn([row, "config"], document.createNode({}));
  } else if (!YAML.isMap(document.getIn([row, "config"], true))) {
    reportBlockProblem('has a config that is not a mapping', storage.requested);
    return;
  }

  for (const field of MNEMON_MANAGED_FIELDS) {
    const desired = field === "cliPath" ? mnemonCliPath : storage[field];
    const wanted = field === "storageScope" && desired !== undefined ? String(desired) : desired;
    const declared = existing === undefined ? undefined : existing[field];
    const node = document.getIn([row, "config", field], true);

    if (node?.tag === JS_TAG) {
      reportBlockProblem(`has an !!js expression in "${field}"`, storage.requested);
      continue;
    }

    if (wanted === undefined) {
      if (node !== undefined) document.deleteIn([row, "config", field]);
      continue;
    }
    if (declared === wanted) continue;
    document.setIn([row, "config", field], document.createNode(wanted));
  }

  // A row created from scratch (or a config the settings UI emptied) can come
  // back as a flow mapping — `config: { ... }`. Write it the way the rest of
  // this file is written.
  const config = document.getIn([row, "config"], true);
  if (config !== undefined) config.flow = false;

  // State the ownership note, keeping whatever comment the row already carries.
  // Re-checked each run so a file that lost it gets it back, and so an existing
  // note is left exactly as it is.
  const rowNode = document.contents.items[row];
  const comments = (rowNode.commentBefore ?? "")
    .split("\n")
    .filter((line) => line.trim() !== "");
  if (!comments.some((line) => line.includes(OWNERSHIP_NOTE))) {
    comments.push(` ${OWNERSHIP_NOTE}`);
    rowNode.commentBefore = comments.join("\n");
  }
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
 * Edit the profile patch in memory: the mnemon row, then the OpenViking row when
 * it is enabled.
 *
 * Nothing here touches the filesystem — the caller writes the document, and only
 * outside a dry run. Keeping every edit on this side of that gate is what makes
 * `--check` a real dry run.
 *
 * @param patch - the parsed patch, mutated in place.
 * @param storage - the desired mnemon state from {@link resolveMnemonStorage}.
 * @param existing - the current mnemon config from {@link readMnemonSettings}.
 */
function planDshPatch(patch, storage, existing) {
  applyMnemonSettings(patch.document, storage, existing);

  // OpenViking is off by default: its per-step recall runs a synchronous
  // pre-step phase (retrieve, then inject a persistent message) that every
  // model response has to wait for. Opt back in with `--openviking` or
  // DSH_ENABLE_OPENVIKING=1.
  if (!openVikingEnabled) {
    deleteRows(patch.document, "openviking-memory");
    return;
  }

  const row = findRow(patch.document, "openviking-memory");
  const config = patch.document.createNode([
    {
      id: "openviking-service-autostart",
      name: openVikingServicePackage,
      config: { serviceRoot: openVikingRoot },
    },
    {
      id: "openviking-memory-runtime",
      name: "@openviking/dsh-memory-plugin",
      // Query expansion is the one part of the recall path that leaves the
      // machine: it asks the configured `vlm` (a remote model) to rewrite the
      // query before retrieval. Embedding, search and rerank are already local.
      // Left on, every model step waits for that round trip.
      config: { recallQueryExpansion: "off" },
    },
  ]);
  if (row < 0) patch.document.add(patch.document.createNode({ id: "openviking-memory", config }));
  else patch.document.setIn([row, "config"], config);
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
  const patch = loadPatch();
  const mnemonExisting = readMnemonSettings(patch.document);
  const mnemonStorage = resolveMnemonStorage(mnemonExisting);
  const mnemonStorageLine =
    `Mnemon storage: ${mnemonStorage.storageScope} (from ${mnemonStorage.source})` +
    ` -> ${mnemonStorageRoot(mnemonStorage)}`;

  // Everything up to the gate below is in-memory only: `--check` runs the same
  // planning code and reports the same problems without touching anything.
  planDshPatch(patch, mnemonStorage, mnemonExisting);

  if (checkOnly) {
    console.log(`Mnemon CLI: ${mnemonVersion}`);
    console.log(mnemonStorageLine);
    console.log(
      `OpenViking: ${openVikingEnabled ? "enabled" : "disabled (opt-in with --openviking)"}`,
    );
    console.log(`DSH patch target: ${patchPath}`);
    exitOnFailures();
    process.exit(0);
  }

  // --- side effects from here down -------------------------------------------
  // The bundle entry is what makes DSH load the package's own patch, which is
  // what defines the group the OpenViking row targets, so the two switch
  // together.
  setProfileBundle(openVikingEnabled);
  configureMnemonData(mnemonStorage);
  const openViking = openVikingEnabled ? configureOpenViking() : null;
  savePatch(patch);
  if (openVikingEnabled && !skipWarmup) warmOpenVikingRuntime();
  else if (openVikingEnabled) console.log("OpenViking: skipped the runtime warm-up (--no-warmup).");

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
