# Running the server under `systemd --user`

The server is a single long-lived process. Started by hand it dies with your
terminal and keeps no logs; under a `systemd --user` unit it survives logout,
restarts on failure, and writes to journald. This directory holds a unit that
does that, plus the one helper it needs.

- `claude-assist-server.service` — the unit
- `wait-for-postgres.sh` — an `ExecStartPre` helper that waits for postgres on
  127.0.0.1:2528, since a `--user` unit cannot declare a dependency on the
  system-level `docker.service` that usually hosts it

Nothing here installs itself. Follow the steps below when you're ready.

Paths in this guide use `%h` (systemd's expansion for the unit user's home) and
assume the repo is checked out at `%h/claude-assist`. If yours lives elsewhere,
adjust `WorkingDirectory` and `ExecStart` in the unit to match.

## Prerequisites

**Enable lingering** for the account the service runs as, or its systemd
instance stops at logout and takes the server with it:

```bash
sudo loginctl enable-linger <user>
loginctl show-user <user> | grep Linger   # expect: Linger=yes
```

**Know how `bun` resolves on a minimal PATH.** `systemd --user` starts with a
bare PATH — no `~/.local/bin`, no version-manager shims:

```bash
systemctl --user show-environment | grep '^PATH='
```

If you install bun through a version manager, its shim usually needs the
manager's own binary on PATH to work at all, so invoking the shim from a unit
fails with something like `exec: asdf: not found`. The unit therefore sets an
explicit `Environment=PATH=...`. Edit that line to match your installation, or
point `ExecStart` at an absolute bun path. Reproduce the exact environment
before trusting it:

```bash
env -i PATH=<the unit's PATH> HOME=$HOME sh -c 'cd <workdir> && bun --version'
```

A version-manager shim reads the project's `.tool-versions` at invocation time,
so referencing the shim (rather than a pinned install path) keeps the unit
correct across bun upgrades.

## Things worth knowing before you install

- **Env loading is dotenv-relative-to-cwd, not `EnvironmentFile=`.**
  `apps/server/src/plugins/env.ts` registers `@fastify/env` with `dotenv: true`,
  which reads `.env` relative to `process.cwd()`. That is why the unit sets
  `WorkingDirectory` to `apps/server` and why it duplicates nothing from `.env`.
- **The scheduler needs no second unit.** `createScheduler()` runs cron-ish jobs
  as timers inside the same process, so one unit covers the API, the sweeps, and
  the scheduled pipelines.
- **Postgres is usually a container the unit can't depend on.** Hence
  `wait-for-postgres.sh`: it polls `pg_isready` for up to 60s (30 × 2s) before
  `ExecStart`. On timeout the unit fails and `Restart=on-failure` retries —
  which is what you want after a reboot where Docker is still coming up.
- **The health endpoint is namespaced.** Routes register under `/api`, so it is
  `/api/health`, not `/health`.
- **`NODE_ENV` only affects log formatting here** (pretty transport vs. raw
  JSON). Set it to whatever suits the box.

## Install

```bash
# 1. Symlink the unit (a symlink keeps it in sync with the repo) or copy it
ln -s %h/claude-assist/deploy/systemd/claude-assist-server.service \
  ~/.config/systemd/user/claude-assist-server.service

# 2. Pick the unit up
systemctl --user daemon-reload

# 3. Enable it (WantedBy=default.target — starts at boot/login, persists
#    across logout thanks to lingering)
systemctl --user enable claude-assist-server.service
```

Do **not** start it yet if a hand-run server is still up — see below.

## Cutover: stop the hand-run process first

Both processes bind port 2529 and talk to the same database, so they will fight
over the port. Stop the old one before starting the unit:

```bash
# 1. Find and stop it
pgrep -fa 'bun.*src/server\.ts'
kill <pid>

# 2. Confirm the port is free
ss -ltnp | grep :2529   # should print nothing

# 3. Start the unit
systemctl --user start claude-assist-server.service
```

## Verification

```bash
systemctl --user status claude-assist-server.service
journalctl --user -u claude-assist-server -f
curl -s http://localhost:2529/api/health
# expect: {"status":"ok","timestamp":"..."}
```

On a failure to start, `journalctl --user -u claude-assist-server -n 100
--no-pager` tells you which half broke: `wait-for-postgres.sh` (database
unreachable) or the app itself (most often a missing or invalid `.env` —
`DATABASE_URL` is `required` in the `@fastify/env` schema).

## Rollback

```bash
systemctl --user stop claude-assist-server.service
systemctl --user disable claude-assist-server.service
# then run it by hand again:
cd ~/claude-assist/apps/server && bun src/server.ts
```
