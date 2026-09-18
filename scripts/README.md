# Profile-local memory services

This profile (`~/.dsh/profiles/web`, branch `profile-web`) is the authoritative
copy. The project worktree `~/projects/dsh-web-profile` (branch `main`) is a
separate worktree — edits there do **not** affect the running profile.

## Layout

```text
~/.dsh/profiles/web/
├── package.json                      # deps + dsh.profile.bundles
├── pnpm-workspace.yaml               # workspaces: "." and "packages/*"
├── cordis.patch.yml                  # user patch layer (gitignored)
├── packages/
│   └── openviking-service/           # profile lifecycle plugin (a real package)
│       ├── package.json              # name + version → normal package identity
│       ├── index.mjs
│       └── README.md
├── scripts/
│   └── install-services.mjs          # wires cliPath + autostart into the patch
└── .services/                        # gitignored, profile-local data
    ├── mnemon/                       # Mnemon runtime + documents
    └── openviking/                   # ov.conf, data/, logs/, pending/, state/
```

`pnpm install` runs `postinstall` → `install-services.mjs --configure-only`,
which rewrites two managed blocks in `cordis.patch.yml`:

- `# LOCAL_MNEMON_CLI_START` … `# LOCAL_MNEMON_CLI_END`
- `# OPENVIKING_AUTOSTART_START` … `# OPENVIKING_AUTOSTART_END`

Everything outside those markers is preserved byte-for-byte. Do not hand-edit
inside them; re-run `pnpm run install-services` instead.

## Commands

```bash
pnpm run install-services              # re-wire paths and configs
pnpm run install-services -- --check   # report resolved paths only
```

## Services

**Mnemon** — local CLI at `node_modules/.bin/mnemon`, data in `.services/mnemon`
via `storageScope: custom`. No background process.

**OpenViking** — the `dsh-openviking-service` package starts the server on demand
and stops it when the profile disposes. It never blocks plugin loading: a cold
start runs in the background, and the runtime tolerates an unreachable endpoint
by queueing writes in `.services/openviking/pending/`.

It is mounted by **bare package name**, not a `file://` path. Every active entry
is resolved to an owning npm package before each DeepSeek request
(`dsh-plugin-package-inventory-deepseek`); a loose module path would instead be
resolved by walking up to the nearest `package.json`, which is how a missing
`version` field once produced `DeepSeek request extension preparation failed`.
Keeping a real package identity avoids that path entirely.

> OpenViking's local embedding backend needs `llama-cpp-python`, which the plain
> `uvx --from openviking` install omits. The supervisor already launches with the
> `openviking[local-embed]` extra; it builds once, then uv caches it. To avoid the
> build entirely, set a remote `embedding.dense.provider` in `ov.conf`.

**Hindsight** — removed entirely. The plugin, bundle entry, service plugin,
`.services/hindsight/` and `~/.hindsight/` are all gone.

## Environment isolation

The OpenViking plugin exports `OPENVIKING_*` variables (config, state, pending,
URL) into the DSH process so the runtime plugin resolves profile-local paths.
That mutation is namespaced and process-wide by design; nothing else is changed.
