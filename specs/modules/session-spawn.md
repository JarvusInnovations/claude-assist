# Module: Session Spawn

A generic, instance-agnostic service that **warms an interactive Remote-Control
(RC) session** through a configured spawn command and hands the resulting
takeover link to the notification dispatcher — the "spawn" half of the
app-initiated *gather-and-ping* flow (a surface gathers context, this module
spawns a warm session and pings the phone with a takeover link).

The module knows nothing about how a warm session is produced. It knows only
"a configured command that, given a preload prompt, prints a takeover link."
What that command is — a session-tool wrapper, a stub, anything — is instance
data and never enters this repo. Meal-planning is the first configured caller; the
machinery is generic (any module can request a warm session with its own
context).

A caller may also tag its request with a short **group** — a caller identity
(e.g. `kitchen`) passed to the spawn command as `SESSION_SPAWN_GROUP` (see
§ Caller group). What the command does with that tag — routing sessions to a
per-caller workspace, tagging metadata, ignoring it entirely — is instance
configuration, outside this module's concern.

Every spawn also carries an explicit **model** (see § Model selection), so a
warm session's capability never depends on whichever model the owner happened to
select interactively last.

## Runtime shape

The module decorates the Fastify instance with a single service,
`fastify.sessionSpawner`, implementing the `SessionSpawner` interface. Any
module (a route handler in kitchen, a future scheduler) calls
`sessionSpawner.spawn(request)` with its own `preloadPrompt` + `title`, and
optionally a caller `group` tag. The service:

1. Runs the configured spawn command with the preload prompt (see § Spawn
   command contract).
2. On success, **dispatches the takeover link to the phone through the existing
   notification dispatcher** (`fastify.notify`) and returns a **spawn record**
   that carries status + a spawn id and **never the link**.
3. On failure, dispatches a "couldn't start your session" push (**no link**)
   and returns a failure record.

The service holds no database schema and runs no migrations — it is a stateless
command-runner + dispatcher. It requires the notify module: the takeover link
travels only in the delivered push, so with no dispatcher there is nowhere safe
to put it, and the feature is disabled.

## Configuration

`SESSION_SPAWN_CMD` — the spawn command, as a **JSON argv array of strings**,
following the repo's existing JSON-argv env convention (identical parsing to
`CHAT_CONTEXT_COMMANDS`): a JSON array whose elements are each a non-empty
string. Example (illustrative only — the real value is instance data and never
committed):

```
SESSION_SPAWN_CMD=["some-rc-tool","spawn","--workspace","planning","--preload-file"]
```

- **Unset** → the feature is disabled. `fastify.sessionSpawner` is still present
  (callers need not guard on its existence), but every `spawn()` returns a
  `not_configured` record and dispatches nothing. Routes map that to `503`.
- **Malformed** (not a JSON array of non-empty strings) → logged as a warning and
  treated as unset (disabled), never a boot failure — same fail-soft posture as
  `CHAT_CONTEXT_COMMANDS`.
- The instance is responsible for the command's **working directory** and any
  auth/session context (e.g. pointing the command at the owner's repo so the
  warm session already has the relevant CLI + protocol available). None of that
  is this module's concern or appears in this repo.

An optional wall-clock bound (`SESSION_SPAWN_TIMEOUT_MS`, default `120000`)
caps how long the service waits on the command before treating the spawn as
failed — a slow warm or a hung command must fail loud, never hang the caller.

`SESSION_SPAWN_MODEL` (default `opus`) is the instance-wide model every spawned
session runs on unless the caller overrides it — see § Model selection.

## Spawn command contract

Given a `SpawnRequest { preloadPrompt, title, group?, model? }`, the service:

1. Writes `preloadPrompt` to a **temporary file** (owner-only mode, in the OS
   temp dir).
2. Builds the argv: the configured `SESSION_SPAWN_CMD` array, with the **temp
   file path appended as the final element** — so the configured command's last
   flag (e.g. `--preload-file`) receives the path. The command reads the preload
   prompt from that file; the prompt is never passed as a shell-visible argument.
3. Runs the command (`argv[0]` with the remaining args), capturing stdout and
   stderr, bounded by the timeout above. The command runs with a **sanitized
   environment** (see § Sanitized environment), plus `SESSION_SPAWN_GROUP` when
   a valid `group` was given (see § Caller group) and `SESSION_SPAWN_MODEL`
   carrying the resolved model (see § Model selection).
4. **Success** ⇔ the command exits `0` **and** stdout contains at least one
   `https://` URL. The **takeover link is the first `https://` URL in stdout.**
5. **Failure** ⇔ non-zero exit, timeout, **or** exit `0` with no `https://` URL
   found in stdout. The failure **reason is the command's stderr** (trimmed,
   collapsed to one line, capped, and passed through the notify RC-link
   redaction before it is stored or logged — see § Security).
6. The **temp file is deleted in a `finally`**, on every outcome.

The contract the configured command must honor: *read a preload prompt from the
file path given as its last argument, warm an RC session, and print a takeover
URL as the first `https://` URL on stdout.* Everything else about the command is
opaque to this module.

**The command must be fully non-interactive.** It runs with no terminal and
nobody watching, so any first-run confirmation the underlying session tool would
otherwise prompt for — folder trust, a newly-configured integration, a tool
permission — must be pre-empted by the wrapper (pre-approved via flags or
settings the wrapper passes). A blocking prompt shows up here only as a timeout
with no link, i.e. an opaque failure; keeping prompts from arising is the
wrapper's job, not something this module can detect or answer.

## Sanitized environment

The spawn command is invoked with a **shallow copy of the service's environment
with the Claude programmatic-auth variables stripped**:

- `CLAUDE_CODE_OAUTH_TOKEN`
- `ANTHROPIC_API_KEY`
- `ANTHROPIC_AUTH_TOKEN`

Everything else the child needs (`PATH`, `HOME`, and the rest) is preserved
untouched; the service's own `process.env` is copied, never mutated.

**Why.** The command warms an *interactive* Remote-Control session that must
authenticate as the human's **claude.ai subscription** — the ambient login in
the user's `~/.claude`. The service process, though, carries metered
programmatic API credentials in its own environment. If those inherit into the
child, two things break at once:

1. **RC refuses the spawn** — an inherited `CLAUDE_CODE_OAUTH_TOKEN` overrides
   subscription auth and the command fails with *"Remote Control requires a
   claude.ai subscription login, not oauth_token."*
2. **The billing boundary is violated** — a human-driven interactive session
   would run on the service's metered API credentials. This module only *pulls
   the trigger*; the human then reasons under their own subscription. Leaking the
   service's metered creds into that session collapses the single-invoker /
   honest-billing seam this whole module exists to keep clean.

So the stripped env is the concrete enforcement of the honest-billing boundary:
a spawned human session inherits ambient/subscription auth, never the service's
metered API credentials. A spawner test asserts the child env omits all three
stripped keys while preserving unrelated vars (e.g. `PATH`).

## Caller group

A caller may set `SpawnRequest.group` — a short tag identifying *which caller*
requested the spawn (e.g. `kitchen`). When present and valid, the service adds
`SESSION_SPAWN_GROUP=<group>` to the child env passed to the spawn command
(alongside the sanitized env above). When absent — or invalid — the variable is
omitted entirely; the instance wrapper is expected to fall back to a default
when it sees no `SESSION_SPAWN_GROUP`.

- **Validation.** `group` must match `^[a-z0-9-]{1,32}$` (lowercase
  alphanumerics and hyphens, 1-32 chars). This is defensive: an unsanitized
  caller-supplied string is never interpolated into a child process
  environment. An invalid value is **not** an error — the spawn proceeds as if
  `group` were absent, with a warning logged (`spawnId`, the rejected value).
  A misbehaving caller degrades to "no group tag," never a broken spawn.
- **What it's for.** The toolkit does not know or care what a group is used
  for. The first caller, meal-planning, tags its requests `kitchen`; the
  instance's spawn command can use that to route the warm session into a
  caller-specific workspace, tag session metadata, or ignore it — all instance
  configuration, none of it in this repo.
- **Scope.** One tag per request, not a list — a caller is one thing (a route,
  a scheduler), and its group is fixed at the call site (see
  `PLAN_SESSION_GROUP` in the kitchen module's caller code as the pattern:
  export the group as a constant next to the session title).

## Model selection

A spawned session's model is **always chosen explicitly** — never inherited from
whatever the owner last selected interactively. Left implicit, a warm session
silently runs on the CLI's sticky default, so the same button can hand back a
frontier-model session one day and a small-model session the next. The model is
config, resolved per spawn and handed to the command as `SESSION_SPAWN_MODEL`.

**Resolution order** (first match wins):

1. `SpawnRequest.model` — the caller's override, when present and valid.
2. `SESSION_SPAWN_MODEL` — the instance-wide default (schema default `opus`).
3. Neither present/valid → the variable is **omitted** from the child env, and
   the instance wrapper falls back to whatever it considers safe (the same
   posture as an absent `SESSION_SPAWN_GROUP`).

- **Validation.** A model identifier must match
  `^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$` — an alias (`opus`, `sonnet`) or a full
  model name, with no whitespace or shell metacharacters. Same defensive reason
  as `group`: a caller- or config-supplied string is never interpolated into a
  child environment unchecked. An invalid **caller** value is not an error — it
  is dropped with a warning and resolution falls through to the instance
  default. An invalid **instance** value is warned once at construction and
  treated as unset.
- **Aliases are the intended value.** The default is the alias `opus`, not a
  pinned model name, so the instance tracks the latest model in that tier
  without a config edit. An instance that needs a frozen version can pin the
  full name.
- **Why a caller override at all.** Different surfaces want different tiers: an
  interactive planning session the owner is waiting on wants the strongest
  model, while a mechanical warm-start might not. The caller names its own need;
  the value it names is still instance config (an env var read at the call site),
  not a constant in code — the same split as `group` (constant identity) vs. the
  command (instance data).
- **Not the estimator's model.** This is the model an *interactive human*
  session runs on under subscription auth, entirely separate from the metered
  per-module model settings (`KITCHEN_ESTIMATION_MODEL` and friends). The two
  must never be conflated — see § Sanitized environment for the billing seam.

## Dispatch-and-redact

Delivery is always through the existing dispatcher (`fastify.notify`); this
module grows no delivery code of its own.

- **On success** — dispatch a `notice`-priority notification whose `url` is the
  **raw takeover link**, with a title naming the session (e.g. "Your
  meal-planning session is ready") and a tappable `urlTitle` ("Take over"). The
  dispatcher stores the notification with the link **redacted at rest** (its
  `session_<token>` reduced to a redacted placeholder — `packages/notify`
  `redact.ts`), while delivering the real link to the phone. The link exists in
  plaintext only in the delivered push payload.
- **On failure** — dispatch a `notice`-priority notification with **no `url`**
  (title e.g. "Couldn't start your session", body a short redacted reason). A
  failed spawn is a surface the owner asked for; it must not silently vanish.

Priority is `notice` (not `interrupt`): the owner initiated the request and is
waiting, but a warm session becoming ready is not an emergency that earns a
high-priority interrupt.

## Return contract — the spawn record

`spawn()` resolves to a `SpawnRecord`:

| field | type | notes |
| --- | --- | --- |
| `status` | `'spawned' \| 'failed' \| 'not_configured'` | outcome |
| `spawnId` | `string` | opaque id for this spawn attempt (ULID); correlates logs ↔ request without exposing the link |
| `notificationId` | `number?` | the `notify.notifications` row id of the dispatched push, when one was dispatched (present for `spawned` and `failed`, absent for `not_configured`) |
| `reason` | `string?` | failure reason, already redacted; present only for `failed` |

**The record never contains the takeover link, redacted or otherwise.** A
caller returning the record verbatim (as the kitchen endpoint does) therefore
cannot leak the link.

## Security — the no-link-in-response invariant

The takeover link is a live session-control handle: whoever holds it can take
over the session. It is treated as a secret. The invariant, tested explicitly:

**The raw takeover link appears in exactly one place — the payload delivered to
the notification channel — and nowhere else. It is absent from the returned
`SpawnRecord`, from any route response built on it, and from every log line.**

Enforcement:

- The service extracts the link into a local variable, passes it to the
  dispatcher as `url`, and never puts it in the returned record.
- The service **never logs stdout** (which holds the link). It logs only
  `spawnId`, `status`, and — on failure — the **redacted** reason.
- The dispatcher redacts session-control links at rest (`redact.ts`), so the
  stored notification row holds only a redacted form; the raw link lives solely
  in the transient delivered payload.
- Any text this module does log that could contain a link (a stderr reason) is
  passed through the notify redaction first.

A conformance test asserts the link is present in the captured dispatch payload
but absent from (a) the returned record serialized to JSON and (b) all captured
log output.

## `SessionSpawner` interface

```ts
interface SpawnRequest {
  /** The warm-start briefing the session opens with. Written to the temp file. */
  preloadPrompt: string;
  /** Short human label for the session, used in the push title (e.g. "meal-planning"). */
  title: string;
  /**
   * Optional short caller tag (e.g. "kitchen"), passed to the spawn command as
   * SESSION_SPAWN_GROUP. Must match ^[a-z0-9-]{1,32}$; invalid ⇒ treated as
   * absent (see § Caller group).
   */
  group?: string;
  /**
   * Optional model override (alias like "opus" or a full model name), passed to
   * the spawn command as SESSION_SPAWN_MODEL. Must match
   * ^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$; invalid ⇒ falls through to the
   * instance default (see § Model selection).
   */
  model?: string;
}

type SpawnStatus = 'spawned' | 'failed' | 'not_configured';

interface SpawnRecord {
  status: SpawnStatus;
  spawnId: string;
  notificationId?: number;
  reason?: string;
}

interface SessionSpawner {
  spawn(request: SpawnRequest): Promise<SpawnRecord>;
}
```

The interface + record types live in `core` (like the notify contracts), so any
module can call `fastify.sessionSpawner` type-safely without importing the
implementation package.

## Testing seam

The suite runs with **no real spawn**: a fixture shell script stands in for the
configured command. The success fixture echoes a fake takeover line
(`https://example.test/rc/session_FAKE`) after reading its preload-file
argument; failure fixtures exit non-zero or print no URL. `SESSION_SPAWN_CMD`
in tests points at the fixture, so the full path — command run, link extracted,
dispatch, redaction, record returned — exercises end-to-end against a fake
dispatcher without touching any real session tooling. Spawner tests reuse the
injectable exec seam (`config.execFile`) to assert the captured child env
carries `SESSION_SPAWN_GROUP` when a valid `group` was requested, and omits it
when `group` is absent or invalid — and likewise that `SESSION_SPAWN_MODEL`
carries the caller override when valid, the instance default when the caller
supplies none or supplies an invalid one, and is absent when neither is
configured.

## Principles

**Inherited** — this module is the mechanical embodiment of the honest-billing
seam: it only *pulls the trigger* on a warm session. The thinking happens when a
human takes over the spawned session under their own human-driven credentials,
cleanly distinct from any metered automation. The button/endpoint spawns; it
does not reason.

**Local**

- **The link rides the push, nothing else.** A session-control link is a secret
  and gets exactly one destination — the delivered notification. It never enters
  a return value, an HTTP response, or a log. When in doubt about where a link
  may appear, the answer is "only the push payload."
- **Fail loud, never hang.** A spawn either produces a link within the timeout or
  becomes a failure push. There is no silent partial state: every `spawn()` call
  resolves to a definite record and (unless unconfigured) a dispatched push.
- **Generic mechanism, configured caller.** This module carries no knowledge of
  what it spawns or why. The context builder + preload prompt + spawn command are
  the seams; a caller supplies context, the instance supplies the command.
