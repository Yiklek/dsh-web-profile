# dsh-openviking-service

A DSH profile lifecycle plugin that starts the local OpenViking server on
demand and stops it when the profile disposes.

It is a **process supervisor only** — memory, recall, capture and the
`mcp__openviking__*` tools all belong to `@openviking/dsh-memory-plugin`, which
this entry deliberately loads *after* itself.

## Mounting

`scripts/install-services.mjs` writes the managed block into the profile's
`cordis.patch.yml`:

```yaml
- id: openviking-memory
  config:
    - id: openviking-service-autostart
      name: dsh-openviking-service          # bare package name
      config:
        serviceRoot: "<profile>/.services/openviking"
    - id: openviking-memory-runtime
      name: '@openviking/dsh-memory-plugin'
```

The entry name is a real package name rather than a `file://` path on purpose:
DSH's DeepSeek request-extension inventory resolves every active entry to an
owning npm package before each request, and a loose module path has to be
resolved by walking up to some `package.json`. Keeping a proper package
identity avoids that fragile path entirely.

## Behaviour

| Condition | Result |
|---|---|
| `/health` already answers | Adopt it; do not restart, do not stop on exit |
| `uvx` missing on PATH | Skip silently — OpenViking is optional |
| `ov.conf` missing | Log a warning and skip |
| Otherwise | Spawn `uvx --from openviking[local-embed] openviking-server` |

The spawn is **non-blocking**: readiness is awaited in the background so a cold
start cannot stall DSH startup. That is safe because the runtime queues writes
in `.services/openviking/pending/` while the endpoint is unreachable and
replays them once it is up.

Environment exported to the rest of the process:

```text
OPENVIKING_HOME · OPENVIKING_CONFIG_FILE · OPENVIKING_CLI_CONFIG_FILE
OPENVIKING_STATE_DIR · OPENVIKING_PENDING_DIR · OPENVIKING_URL
```

Cleanup is registered with `ctx.effect`, so the profile stops the server it
started (SIGTERM, then SIGKILL after 5s).
