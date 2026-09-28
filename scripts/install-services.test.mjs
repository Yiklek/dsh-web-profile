// @ts-check
/**
 * Tests for install-services.mjs.
 *
 * Every case drives the real script as a subprocess against a throwaway profile
 * directory (DSH_PROFILE_ROOT), so what is asserted is the file the script
 * leaves behind — not an internal helper. That keeps the suite honest about
 * argv handling, exit codes and file writes, and lets it run unchanged on Linux,
 * macOS and Windows.
 *
 * Run with: node --test scripts/
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import YAML from "yaml";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(scriptDir, "install-services.mjs");
const FAKE_VERSION = "mnemon version 9.9.9-test";

/** Directories removed when the suite finishes. */
const created = [];
after(() => {
  for (const directory of created) rmSync(directory, { recursive: true, force: true });
});

/**
 * Build a profile directory the script can be pointed at.
 *
 * The mnemon CLI is faked on both paths the script may use: an executable shim
 * for POSIX, and the package launcher script that Windows resolves to.
 *
 * @param {{ patch?: string, bundles?: string[], manifest?: object }} [options]
 * @returns the profile root.
 */
function makeProfile({ patch, bundles = [], manifest } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dsh-install-services-"));
  created.push(root);

  const binDir = join(root, "node_modules", ".bin");
  const launcherDir = join(root, "node_modules", "@mnemon-dev", "mnemon", "bin");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(launcherDir, { recursive: true });

  // POSIX shim: the script runs this directly. Windows never executes it — the
  // script resolves the package launcher there instead — and chmod is largely a
  // no-op there, so only the mode given to the write matters.
  const shim = join(binDir, "mnemon");
  writeFileSync(shim, `#!/bin/sh\necho '${FAKE_VERSION}'\n`, { mode: 0o755 });
  if (process.platform !== "win32") chmodSync(shim, 0o755);
  // Windows shim: present so the install "looks" complete, never executed by
  // the script (it resolves the launcher instead).
  writeFileSync(join(binDir, "mnemon.cmd"), `@echo ${FAKE_VERSION}\r\n`);
  // The package launcher, used on Windows and recognized by dsh-mnemon.
  writeFileSync(join(launcherDir, "mnemon.js"), `process.stdout.write(${JSON.stringify(FAKE_VERSION)});\n`);
  writeFileSync(
    join(root, "node_modules", "@mnemon-dev", "mnemon", "package.json"),
    `${JSON.stringify({ name: "@mnemon-dev/mnemon", version: "9.9.9-test", bin: { mnemon: "bin/mnemon.js" } }, null, 2)}\n`,
  );

  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify(
      manifest ?? {
        name: "test-profile",
        version: "0.0.0",
        private: true,
        dsh: { profile: { bundles } },
      },
      null,
      2,
    )}\n`,
  );
  if (patch !== undefined) writeFileSync(join(root, "cordis.patch.yml"), patch);
  return root;
}

/**
 * Run the script against one profile.
 *
 * @param {string} root - the profile directory.
 * @param {string[]} [args] - extra argv.
 * @returns the child's exit code and streams.
 */
function runScript(root, args = []) {
  const env = { ...process.env, DSH_PROFILE_ROOT: root };
  // Keep the ambient environment from changing what a case exercises.
  delete env.DSH_ENABLE_OPENVIKING;
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  return {
    code: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

/** Read a profile file, or undefined when it does not exist. */
function read(root, name) {
  const path = join(root, name);
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** Parse the patch and return the mnemon row's config as plain data. */
function mnemonConfig(root) {
  const text = read(root, "cordis.patch.yml");
  if (text === undefined) return undefined;
  const document = YAML.parseDocument(text, {
    customTags: [{ tag: "tag:yaml.org,2002:js", resolve: (value) => value }],
    logLevel: "silent",
  });
  assert.equal(document.errors.length, 0, `patch did not parse: ${document.errors[0]?.message}`);
  if (!YAML.isSeq(document.contents)) return undefined;
  const row = document.contents.items.findLastIndex(
    (item, index) => YAML.isMap(item) && document.getIn([index, "id"]) === "mnemon",
  );
  if (row < 0) return undefined;
  const node = document.getIn([row, "config"], true);
  return YAML.isMap(node) ? node.toJSON() : node;
}

/** The bundle list in a profile manifest. */
function bundlesOf(root) {
  return JSON.parse(read(root, "package.json")).dsh.profile.bundles;
}

const MNEMON_ROW = "cliPath / storageScope / dataDir are maintained by scripts/install-services.mjs";

describe("patch creation", () => {
  test("creates the row when the patch file does not exist", () => {
    const root = makeProfile();
    assert.equal(runScript(root).code, 0);
    assert.equal(mnemonConfig(root).storageScope, "custom");
    assert.match(mnemonConfig(root).cliPath, /node_modules/);
  });

  test("creates the row when the patch file is empty", () => {
    const root = makeProfile({ patch: "" });
    assert.equal(runScript(root).code, 0);
    assert.equal(mnemonConfig(root).storageScope, "custom");
  });

  test("writes block style, never flow", () => {
    const root = makeProfile({ patch: "" });
    runScript(root);
    const text = read(root, "cordis.patch.yml");
    // A flow sequence here is the bug this pins: seeding from `[]` makes every
    // descendant flow, so the row would come out as `[{ id: mnemon, ... }]`.
    assert.doesNotMatch(text, /^\s*\[/mu);
    assert.doesNotMatch(text, /\{/u);
    assert.match(text, /^- id: mnemon$/mu);
  });

  test("states the ownership note above the row", () => {
    const root = makeProfile();
    runScript(root);
    assert.ok(read(root, "cordis.patch.yml").includes(MNEMON_ROW));
  });
});

describe("cliPath", () => {
  test("resolves to the npm launcher on Windows and the shim elsewhere", () => {
    const root = makeProfile();
    runScript(root);
    const { cliPath } = mnemonConfig(root);
    if (process.platform === "win32") {
      // A pnpm .bin/*.cmd shim cannot be resolved by dsh-mnemon's
      // mnemonNpmLauncher, so Windows must be given the launcher script.
      assert.match(cliPath, /@mnemon-dev[/\\]mnemon[/\\]bin[/\\]mnemon\.js$/u);
    } else {
      assert.match(cliPath, /node_modules[/\\]\.bin[/\\]mnemon$/u);
    }
  });

  test("is updated when the recorded path is stale", () => {
    const root = makeProfile({
      patch: "- id: mnemon\n  config:\n    cliPath: /stale/mnemon\n    storageScope: custom\n",
    });
    runScript(root);
    assert.notEqual(mnemonConfig(root).cliPath, "/stale/mnemon");
  });
});

describe("field ownership", () => {
  test("preserves fields written by the settings UI", () => {
    const root = makeProfile({
      patch: [
        "- id: mnemon",
        "  config:",
        "    cliPath: /old/mnemon",
        "    storageScope: custom",
        "    dataDir: /tmp/distinct",
        "    idleReviewMs: 30000",
        "    idleReview:",
        "      enabled: true",
        "",
      ].join("\n"),
    });
    runScript(root);
    const config = mnemonConfig(root);
    assert.equal(config.dataDir, "/tmp/distinct");
    assert.equal(config.idleReviewMs, 30000);
    assert.deepEqual(config.idleReview, { enabled: true });
  });

  test("leaves unrelated rows byte-identical", () => {
    const other = [
      "# a hand-written header",
      "- insert:",
      "    - id: mcp-playwright",
      "      name: '@deepseek-ai/dsh-mcp-client'",
      "- id: llm-deepseek",
      "  config:",
      "    retryPolicy:",
      "      mode: normal",
    ].join("\n");
    const root = makeProfile({ patch: `${other}\n- id: mnemon\n  config:\n    cliPath: /old\n` });
    runScript(root);
    const text = read(root, "cordis.patch.yml");
    for (const line of other.split("\n")) {
      assert.ok(text.includes(line), `lost a row line: ${line}`);
    }
  });

  test("keeps an unrelated !!js expression tagged", () => {
    const root = makeProfile({
      patch: [
        "- id: mnemon",
        "  config:",
        "    cliPath: /old/mnemon",
        "    storageScope: custom",
        '    provider: !!js process.env.P ?? "default"',
        "",
      ].join("\n"),
    });
    runScript(root);
    assert.ok(read(root, "cordis.patch.yml").includes('provider: !!js process.env.P ?? "default"'));
  });

  test("adds the ownership note only once", () => {
    const root = makeProfile();
    runScript(root);
    runScript(root);
    const occurrences = read(root, "cordis.patch.yml").split(MNEMON_ROW).length - 1;
    assert.equal(occurrences, 1);
  });

  test("keeps a comment the row already carried", () => {
    const root = makeProfile({ patch: "# my own note\n- id: mnemon\n  config:\n    cliPath: /old\n" });
    runScript(root);
    const text = read(root, "cordis.patch.yml");
    assert.ok(text.includes("# my own note"));
    assert.ok(text.includes(MNEMON_ROW));
  });
});

describe("!!js expressions in a managed field", () => {
  const patch = [
    "- id: mnemon",
    "  config:",
    '    cliPath: !!js process.env.MNEMON_CLI ?? "/fallback"',
    "    storageScope: custom",
    "",
  ].join("\n");

  test("is reported and left alone without a flag", () => {
    const root = makeProfile({ patch });
    const { code, output } = runScript(root);
    assert.equal(code, 0);
    assert.match(output, /!!js expression in "cliPath"/u);
    assert.ok(read(root, "cordis.patch.yml").includes("!!js process.env.MNEMON_CLI"));
  });

  test("fails the run when --mnemon-data asked for a change", () => {
    const root = makeProfile({ patch });
    const { code, output } = runScript(root, ["--mnemon-data", "profile"]);
    assert.equal(code, 1);
    assert.match(output, /not applied/u);
    assert.ok(read(root, "cordis.patch.yml").includes("!!js process.env.MNEMON_CLI"));
  });

  test("is never evaluated", () => {
    const marker = join(tmpdir(), `dsh-js-tag-${process.pid}-${Date.now()}`);
    const root = makeProfile({
      patch: [
        "- id: mnemon",
        "  config:",
        "    cliPath: /old/mnemon",
        "    storageScope: custom",
        `    sideEffect: !!js require("node:fs").writeFileSync(${JSON.stringify(marker)}, "")`,
        "",
      ].join("\n"),
    });
    runScript(root);
    assert.equal(existsSync(marker), false, "the script evaluated a profile-supplied expression");
  });
});

describe("malformed config", () => {
  test("fills a null config", () => {
    const root = makeProfile({ patch: "- id: mnemon\n  config:\n" });
    assert.equal(runScript(root).code, 0);
    assert.equal(mnemonConfig(root).storageScope, "custom");
  });

  test("fills a missing config key", () => {
    const root = makeProfile({ patch: "- id: mnemon\n" });
    assert.equal(runScript(root).code, 0);
    assert.equal(mnemonConfig(root).storageScope, "custom");
  });

  for (const [label, body] of [
    ["a scalar", "  config: hello"],
    ["a sequence", "  config:\n    - a"],
  ]) {
    test(`leaves ${label} config alone and warns`, () => {
      const root = makeProfile({ patch: `- id: mnemon\n${body}\n` });
      const before = read(root, "cordis.patch.yml");
      const { code, output } = runScript(root);
      assert.equal(code, 0);
      assert.match(output, /config that is not a mapping/u);
      assert.equal(read(root, "cordis.patch.yml"), before);
    });
  }
});

describe("unusable patch file", () => {
  test("fails on invalid YAML", () => {
    const root = makeProfile({ patch: "a: [unclosed\n" });
    const { code, output } = runScript(root);
    assert.equal(code, 1);
    assert.match(output, /not parseable YAML/u);
  });

  test("fails when the document is not a sequence", () => {
    const root = makeProfile({ patch: "id: mnemon\nconfig:\n  cliPath: /x\n" });
    const { code, output } = runScript(root);
    assert.equal(code, 1);
    assert.match(output, /must be a YAML sequence/u);
  });
});

describe("--mnemon-data", () => {
  const patch = "- id: mnemon\n  config:\n    cliPath: /old\n    storageScope: custom\n    dataDir: /old/data\n";

  test("rejects an unknown value with exit 2", () => {
    const root = makeProfile({ patch });
    const { code, output } = runScript(root, ["--mnemon-data", "custom"]);
    assert.equal(code, 2);
    assert.match(output, /accepts profile, workspace, workspaces/u);
  });

  test("profile keeps a dataDir", () => {
    const root = makeProfile({ patch });
    runScript(root, ["--mnemon-data", "profile"]);
    assert.equal(mnemonConfig(root).storageScope, "custom");
    assert.equal(mnemonConfig(root).dataDir, join(root, ".services", "mnemon"));
  });

  test("workspace drops the dataDir the scope ignores", () => {
    const root = makeProfile({ patch });
    runScript(root, ["--mnemon-data", "workspace"]);
    assert.equal(mnemonConfig(root).storageScope, "workspace");
    assert.equal(mnemonConfig(root).dataDir, undefined);
  });

  test("workspaces keeps a dataDir", () => {
    const root = makeProfile({ patch });
    runScript(root, ["--mnemon-data", "workspaces"]);
    assert.equal(mnemonConfig(root).storageScope, "workspaces");
    assert.ok(mnemonConfig(root).dataDir);
  });

  test("keeps the configured scope when no flag is given", () => {
    const root = makeProfile({
      patch: "- id: mnemon\n  config:\n    cliPath: /old\n    storageScope: workspace\n",
    });
    runScript(root);
    assert.equal(mnemonConfig(root).storageScope, "workspace");
  });
});

describe("--check", () => {
  test("writes nothing even when both files need changes", () => {
    // The mnemon row is stale and the OpenViking bundle is present, so a real
    // run without --openviking would rewrite both files.
    const root = makeProfile({
      patch: "- id: mnemon\n  config:\n    cliPath: /stale\n    storageScope: custom\n",
      bundles: ["dsh-mnemon", "@openviking/dsh-memory-plugin"],
    });
    const patchBefore = read(root, "cordis.patch.yml");
    const manifestBefore = read(root, "package.json");

    const { code } = runScript(root, ["--check"]);
    assert.equal(code, 0);
    assert.equal(read(root, "cordis.patch.yml"), patchBefore);
    assert.equal(read(root, "package.json"), manifestBefore);

    // Sanity: the same state must actually change under a real run, otherwise
    // this case would pass without proving anything.
    runScript(root);
    assert.notEqual(read(root, "cordis.patch.yml"), patchBefore);
    assert.notEqual(read(root, "package.json"), manifestBefore);
  });

  test("reports the same problems a real run would", () => {
    const root = makeProfile({ patch: "- id: mnemon\n  config: hello\n" });
    const { code, output } = runScript(root, ["--check"]);
    assert.equal(code, 0);
    assert.match(output, /not a mapping/u);
  });
});

describe("idempotence", () => {
  test("a second run changes nothing", () => {
    const root = makeProfile({
      patch: "- id: mnemon\n  config:\n    cliPath: /old\n    storageScope: custom\n",
    });
    runScript(root);
    const first = read(root, "cordis.patch.yml");
    const manifest = read(root, "package.json");
    runScript(root);
    assert.equal(read(root, "cordis.patch.yml"), first);
    assert.equal(read(root, "package.json"), manifest);
  });
});

describe("retired markers", () => {
  test("are cleaned up, leaving other comments and rows", () => {
    const root = makeProfile({
      patch: [
        "# header",
        "# LOCAL_MNEMON_CLI_START",
        "# Generated by scripts/install-services.mjs; do not edit this block manually.",
        "- id: mnemon",
        "  config:",
        "    cliPath: /old",
        "    storageScope: custom",
        "# LOCAL_MNEMON_CLI_END",
        "- id: llm-deepseek",
        "  name: '@deepseek-ai/dsh-llm-deepseek'",
        "",
      ].join("\n"),
    });
    runScript(root);
    const text = read(root, "cordis.patch.yml");
    assert.doesNotMatch(text, /LOCAL_MNEMON_CLI/u);
    assert.ok(text.includes("# header"));
    assert.ok(text.includes("llm-deepseek"));
  });
});

describe("OpenViking", () => {
  const patch = "- id: mnemon\n  config:\n    cliPath: /old\n    storageScope: custom\n";
  const bundle = "@openviking/dsh-memory-plugin";

  test("enabling writes the row and the bundle entry", () => {
    const root = makeProfile({ patch, bundles: ["dsh-mnemon"] });
    assert.equal(runScript(root, ["--openviking", "--no-warmup"]).code, 0);

    const text = read(root, "cordis.patch.yml");
    assert.ok(text.includes("openviking-memory"));
    assert.ok(text.includes("recallQueryExpansion: off"));
    assert.ok(text.includes("dsh-openviking-service"));
    assert.ok(bundlesOf(root).includes(bundle));
  });

  test("disabling removes both", () => {
    const root = makeProfile({ patch, bundles: ["dsh-mnemon", bundle] });
    runScript(root, ["--openviking", "--no-warmup"]);
    assert.equal(runScript(root).code, 0);

    assert.ok(!read(root, "cordis.patch.yml").includes("openviking-memory"));
    assert.ok(!bundlesOf(root).includes(bundle));
  });

  test("enabling twice is idempotent", () => {
    const root = makeProfile({ patch, bundles: ["dsh-mnemon"] });
    runScript(root, ["--openviking", "--no-warmup"]);
    const first = read(root, "cordis.patch.yml");
    runScript(root, ["--openviking", "--no-warmup"]);
    assert.equal(read(root, "cordis.patch.yml"), first);
    assert.equal(bundlesOf(root).filter((name) => name === bundle).length, 1);
  });

  test("is off by default", () => {
    const root = makeProfile({ patch, bundles: ["dsh-mnemon", bundle] });
    runScript(root);
    assert.ok(!read(root, "cordis.patch.yml").includes("openviking-memory"));
    assert.ok(!bundlesOf(root).includes(bundle));
  });
});

describe("startup report", () => {
  test("names the origin of the storage scope", () => {
    const root = makeProfile({ patch: "- id: mnemon\n  config:\n    cliPath: /old\n    storageScope: custom\n" });
    assert.match(runScript(root).stdout, /\(from existing config\)/u);
    assert.match(runScript(makeProfile()).stdout, /\(from default \(profile\)\)/u);
  });
});
