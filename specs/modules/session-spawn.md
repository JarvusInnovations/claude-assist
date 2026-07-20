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

## Runtime shape

The module decorates the Fastify instance with a single service,
`fastify.sessionSpawner`, implementing the `SessionSpawner` interface. Any
module (a route handler in kitchen, a future scheduler) calls
`sessionSpawner.spawn(request)` with its own `preloadPrompt` + `title`. The
service:

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

## Spawn command contract

Given a `SpawnRequest { preloadPrompt, title }`, the service:

1. Writes `preloadPrompt` to a **temporary file** (owner-only mode, in the OS
   temp dir).
2. Builds the argv: the configured `SESSION_SPAWN_CMD` array, with the **temp
   file path appended as the final element** — so the configured command's last
   flag (e.g. `--preload-file`) receives the path. The command reads the preload
   prompt from that file; the prompt is never passed as a shell-visible argument.
3. Runs the command (`argv[0]` with the remaining args), capturing stdout and
   stderr, bounded by the timeout above. The command runs with a **sanitized
   environment** (see § Sanitized environment).
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
dispatcher without touching any real session tooling.

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
