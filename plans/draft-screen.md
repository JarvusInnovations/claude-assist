---
status: done
depends: [model-invoker]
specs:
  - specs/modules/screen.md
  - specs/modules/invoker.md
issues: []
---

# Plan: an isolated screen for outgoing drafts

## Scope

An agent about to post a message needs the draft checked against a written
policy by a model that sees nothing else. The request and verdict shapes are
fixed by the external tools that will call it.

In scope:

- `POST /api/screen`: strict request validation, one metered `classify`-tier
  call through the invoker with a fixed module-owned prompt, a strictly
  parsed verdict, and fail-closed errors.
- A shared bearer token (`SCREEN_API_TOKEN`) that turns the route on and that
  every request must carry.
- Logging only the draft's hash, the class, the verdict or failure code, and
  the spend.
- `skills/assist-screen/scripts/screen-check`, the client an external tool
  configures as its screen command.
- The invoker spec's boundary sentence for this kind of caller.

Out of scope:

- Persisting verdicts in a table. The invoker ledger already holds the spend
  per call under `screen.draft`; a verdict history would need a migration and
  a reason to keep it.
- Any change to the invoker itself (see Notes on how it files timeouts).

## Implements

- `specs/modules/screen.md`: contract, HTTP, authentication, request
  validation, the model call, failing closed, what is kept, client.
- `specs/modules/invoker.md` § What routes through it: the line is the shape
  of the job, not who asked for it.

## Approach

- `packages/screen/src/screen.ts`: pure `validateRequest`,
  `buildUserMessage` (each field XML-escaped in its own tag), `parseVerdict`
  (strict keys, passage must appear in the draft, error messages never echo
  the answer), `mapInvokerError`, and `runScreen`, which calls
  `invoker.invoke` once. `invoke` rather than `invokeTagged`, so there is no
  parse-correction turn and the result's model and cost can be logged.
- `packages/screen/src/routes.ts`: `registerScreenRoutes` with the token
  check in an `onRequest` hook (before the body is parsed), one log line per
  request.
- `packages/screen/src/client/`: `screenCheck` as a pure function over
  stdin text, env and a fetch, plus `bin.ts`; bundled by
  `scripts/build-cli.ts` into `skills/assist-screen/scripts/screen-check.mjs`
  with a bash shim.
- Host: `SCREEN_API_TOKEN` in the env schema and `.env.example`; registered
  under `/api` after the invoker; Dockerfile, `.dockerignore` and CI build
  steps for the new package. No migration.

## Validation

- [x] Unit: a pass and a block (with passage and reason) come back as `200`
      with exactly the verdict JSON.
- [x] Unit: missing, wrong and non-bearer credentials are `401` and make no
      model call; registering without a token throws.
- [x] Unit: unknown, missing, non-string and empty fields are `400`; an
      oversized draft, policy or class is `413` with its own code; none of
      them reaches the model.
- [x] Unit: budget refusal, kill switch and a disabled invoker are `503`;
      a timeout (by reason, or by the SDK's timeout class under
      `provider_error`) is `504`; provider error, refusal, rate limit and an
      unexpected error are `502`; none carries a `verdict` key.
- [x] Unit: prose, off-schema JSON, extra keys, empty passage or reason, and
      a passage not in the draft are `502 screen_unparseable`.
- [x] Unit: the invoker call carries the fixed system prompt, task
      `screen.draft`, tier `classify`, no model pin, and one user turn made
      only of the three fields; `invokeTagged` is never used.
- [x] Unit: an injection attempt in the draft reaches the model escaped,
      inside the one `<draft>` envelope, with the system prompt unchanged.
- [x] Unit: the log carries the draft hash, class, verdict, model, cost and
      duration, and no draft, policy, passage or reason text.
- [x] Unit: the client prints the verdict and exits `0` for pass and block;
      prints nothing and exits non-zero for a missing token, bad stdin, a
      network error, a timeout, a non-200, and a 200 that is not a valid
      verdict.
- [x] Process: the real entry point, run as a subprocess against a loopback
      stub server, gives the same exit codes and stdout.
- [x] The bundled `screen-check` runs under plain `node` (checked by hand
      against an unreachable server and with no token).
- [x] CI steps (builds, `type-check:axi`, `check:skills`, `bun run test`)
      pass locally.

## Risks / unknowns

- **Model adherence.** Whether the `classify`-tier model quotes passages
  verbatim often enough is untested against a real model. A paraphrased
  passage fails closed (`502`), which blocks the post rather than letting it
  through; if that happens often the prompt or the tier needs a look.
- **Auth is new for `/api`.** Other routes rely on the network alone. The
  token is the screen's own addition because every request costs money.

## Notes

- The invoker files a timeout without an HTTP status as `provider_error`
  (it is retryable), so its `timeout` reason does not occur in practice. The
  screen reads the SDK error class on `cause` to answer `504`. The invoker
  is unchanged here.
- Fastify's async `onRequest` hook that returns `reply` after sending
  produced a stray `ERR_HTTP_HEADERS_SENT` under Bun's test runner; the
  callback form (reply without calling `done`) does not.

## After this plan

- Live check, after an operator sets `SCREEN_API_TOKEN` and restarts:
  `screen-check` with a draft that plainly breaks a one-line policy returns a
  block quoting it; a clean draft passes; the spend endpoint shows the calls
  under `screen.draft`; the log lines carry a hash and no text.
- Try an injection draft against the real model and confirm it is judged on
  content.

## Follow-ups

None.
