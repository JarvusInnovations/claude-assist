# claude-assist-server systemd --user unit

Migrates the server from a manually-run `bun src/server.ts` process in a herdr
terminal pane (no persisted logs, dies with the pane) to a supervised
`systemd --user` service, matching the pattern already in use on this box for
Tana (`~/.config/systemd/user/tana.service`, `xvfb.service`, `openbox.service`,
`x11vnc.service`) and an MCP proxy (`mcp-proxy.service`).

Files here:

- `claude-assist-server.service` — the unit
- `wait-for-postgres.sh` — `ExecStartPre` helper that polls
  `server-postgres-1` (127.0.0.1:2528) before starting, since a `--user` unit
  can't depend on the system `docker.service`

Nothing in this directory is installed, enabled, or started automatically —
see "Install" below to do that manually when ready.

## Prerequisites (already verified on this box)

**Lingering is enabled** for the deploy user (referred to below as `<user>`):

```
$ loginctl show-user <user>
...
Linger=yes
```

This means the `<user>` account's systemd instance (and anything running under
it, including this unit once enabled) keeps running after logout / without an
active session — same as it does today for Tana. No action needed here.

`~/.config/systemd/user/` already holds the Tana units (`tana.service`,
`xvfb.service`, `openbox.service`, `x11vnc.service`) plus
`mcp-proxy.service` and `anytype.service`, all `enabled` and
`WantedBy=default.target`. This unit follows the same convention.

## Surprises found while preparing this

- **`systemd --user`'s default PATH is minimal** — verified via
  `systemctl --user show-environment`, it's just
  `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin`.
  No `~/.local/bin`, no asdf shims. The asdf `bun` shim
  (`~/.asdf/shims/bun`) execs `asdf exec bun`, and `asdf` itself lives at
  `~/.local/bin/asdf` on this box — under the unadorned default PATH the shim
  fails with `exec: asdf: not found`. The unit sets an explicit
  `Environment=PATH=...` that prepends `~/.local/bin` and `~/.asdf/shims` to
  the default systemd PATH to fix this. Confirmed working end-to-end with
  `env -i` reproducing that exact PATH + `WorkingDirectory` combo — resolves
  to bun 1.3.6 via the repo's `.tool-versions`.
- **The bun shim is asdf-stable, not version-pinned** — `~/.asdf/shims/bun`
  always resolves the version from `.tool-versions` at invocation time
  (walking up from cwd), so the unit doesn't need to reference
  `~/.asdf/installs/bun/<version>/bin/bun` directly and won't go stale on a
  `bun` upgrade.
- **Env loading is dotenv-via-cwd, not systemd `EnvironmentFile=`.** The
  server's `src/plugins/env.ts` registers `@fastify/env` with `dotenv: true`,
  which loads `.env` relative to `process.cwd()`. There's no explicit path —
  it only works because the process's cwd is `apps/server`. The unit sets
  `WorkingDirectory=%h/claude-assist/apps/server` for exactly this
  reason; no `EnvironmentFile=` directive is used or needed, and the unit
  doesn't duplicate anything from `.env`.
- **`server-postgres-1` is a plain docker container**, not docker-compose
  managed by the "api" service (that service is `profiles: ["disabled"]` in
  `docker-compose.override.yml` — the bare-metal `bun src/server.ts` process
  is the real prod runtime, matching what's running today). Since a
  `--user` unit can't `After=`/`Requires=` the system `docker.service`,
  `wait-for-postgres.sh` polls `pg_isready -h 127.0.0.1 -p 2528` for up to
  60s (30 attempts × 2s) before `ExecStart` runs. If it times out the unit
  fails and `Restart=on-failure` retries — useful after a reboot if Docker is
  still coming up when this unit starts.
- **The in-process scheduler needs no separate unit.** `apps/server/src/server.ts`
  calls `createScheduler(fastify)` from `@jarvus/claude-assist-core`
  (`packages/core/src/scheduler.ts`, built on `croner`) — cron-ish jobs run
  as timers inside the same Fastify process, not as separate cron jobs or
  processes. One unit covers everything.
- **Health endpoint is namespaced**: `/api/health`, not `/health` — the
  routes are registered under an `/api` prefix in `server.ts`.
- `NODE_ENV=development` is set in the live `apps/server/.env` today (not
  `production`) — that's existing behavior carried over as-is, not something
  this migration changes. It only affects log formatting (pino-pretty
  transport vs. raw JSON).

## Install (do this manually — not done by preparing this PR)

```bash
# 1. Symlink (preferred, keeps it in sync with the repo) or copy the unit
ln -s ~/claude-assist/deploy/systemd/claude-assist-server.service \
  ~/.config/systemd/user/claude-assist-server.service

# 2. Reload the user systemd instance so it picks up the new unit
systemctl --user daemon-reload

# 3. Enable it (WantedBy=default.target — starts on next boot/login and
#    persists thanks to lingering, same as Tana)
systemctl --user enable claude-assist-server.service
```

Do **not** `systemctl --user start` yet — see cutover order below.

## Cutover order (stop the old pane process FIRST)

Both the herdr-pane `bun src/server.ts` and the systemd unit's `bun
src/server.ts` will bind the same port (2529) and connect to the same
postgres — running both at once will fight over the port. Stop the old one
before starting the new one:

```bash
# 1. Find and stop the herdr-pane process
pgrep -fa 'bun.*src/server\.ts'
kill <pid>              # or Ctrl-C in the herdr pane / close the pane

# 2. Confirm the port is free
ss -ltnp | grep :2529   # should print nothing

# 3. Start the systemd unit
systemctl --user start claude-assist-server.service
```

## Verification

```bash
# Unit state
systemctl --user status claude-assist-server.service

# Follow logs (journald — this is the persisted-log win over the pty pane)
journalctl --user -u claude-assist-server -f

# Health check
curl -s http://localhost:2529/api/health
# expect: {"status":"ok","timestamp":"..."}
```

If it fails to start, `journalctl --user -u claude-assist-server -n 100
--no-pager` will show whether it's the `wait-for-postgres.sh` pre-start
(postgres unreachable) or the app itself (e.g. missing/invalid `.env`
values — `DATABASE_URL` is `required` in the `@fastify/env` schema).

## Rollback

```bash
systemctl --user stop claude-assist-server.service
systemctl --user disable claude-assist-server.service
# then restart the old herdr-pane process manually:
cd ~/claude-assist/apps/server && bun src/server.ts
```
