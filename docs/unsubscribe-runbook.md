# Unsubscribe automation — runbook

Operating notes for the tiered unsubscribe automation in the google module
(`packages/google/src/services/unsubscribe*.ts`). What the tiers *are* is
documented in the code; this file is what an operator needs to turn it on, watch
it, and unstick it.

## The one thing to internalize

**The automation never decides that a sender should go.** The only way a sender
enters execution is the owner tapping "queue unsubscribe" in the daily digest,
which writes `google.sender_standing.standing = 'unsubscribe_queue'`. The
enqueue statement reads that table and nothing else, and the executor re-reads
the standing at execution time — so clearing a sender's standing stops the
automation even after a row was enqueued.

The action-layer whitelist gates all three tiers on top of that. A whitelisted
sender is never auto-unsubscribed, *even when the owner also flagged it*: that
contradiction is routed to the review queue for a human, not resolved by the
service.

## Turning it on

Off by default. Two switches, because the second has an external dependency:

```bash
GOOGLE_UNSUBSCRIBE_ENABLED=true            # tiers 1 and 3
GOOGLE_UNSUBSCRIBE_BROWSER_ENABLED=true    # tier 2, needs the browser bridge
GOOGLE_UNSUBSCRIBE_BROWSER_BIN=<cli>       # your browser-automation CLI
```

It also requires the email action layer: anything that sets
`GOOGLE_DISABLE_EMAIL_ACTIONS` or `DISABLE_SYNCS` disables unsubscribes too.

Rate limiting and cadence:

```bash
GOOGLE_UNSUBSCRIBE_CRON="17 * * * *"              # hourly cycle
GOOGLE_UNSUBSCRIBE_REVIEW_CRON="0 14 * * 1"       # weekly review-queue ping
GOOGLE_UNSUBSCRIBE_MAX_PER_RUN=10
GOOGLE_UNSUBSCRIBE_RATE_WINDOW_MINUTES=60
GOOGLE_UNSUBSCRIBE_RATE_MAX_PER_DOMAIN=3
GOOGLE_UNSUBSCRIBE_PROOF_DIR=/var/lib/claude-assist/unsubscribe-proof
GOOGLE_UNSUBSCRIBE_BROWSER_TIMEOUT_MS=60000
```

The proof directory must be writable by the server process and should be on
durable storage — the audit ledger stores the screenshot *path*, so losing the
directory loses the evidence while the ledger row still claims it exists.

## The browser bridge (tier 2)

Tier 2 shells out to a CLI that drives a persistent browser over a local bridge.
The contract is three verbs:

| verb | used for |
| --- | --- |
| `<bin> eval <js>` | preflight probe, page probe, click, confirmation check |
| `<bin> open <url>` | navigate to the unsubscribe page |
| `<bin> screenshot <path>` | write the proof image |

A fourth, `<bin> newpage <url>`, is used only as cold-start recovery and is
optional — a CLI without it degrades to the review queue.

The bridge is a **live external dependency**, usually on a separate always-on
host. That is why every tier-2 path is written to exit clean:

- `preflight()` runs `eval 1+1` with a short timeout. A missing binary, a
  refused connection, a timeout, *or an `Error:` payload returned with a zero
  exit code* all mean not-ready.
- Not-ready ⇒ the driver returns `unavailable`, the attempt is written
  `needs_review` with `reason: browser-unavailable`, and it waits for a human.
  Nothing is retried into a wall, and nothing is half-submitted.
- The same downgrade covers a login wall, zero or several candidate controls, a
  navigation failure, and an unwritable proof directory.

Because of this, **tier 2 is never exercised by the test suite against a real
browser** — the driver is tested through an injected command runner, and the
absence of a bridge in CI is a first-class, asserted code path.

### Verifying the bridge by hand

```bash
<bin> eval "1+1"        # expect a result of 2, no "Error:" in the output
<bin> pages             # "0 pages open" is the cold-bridge state
<bin> newpage https://example.com
```

Zero open pages is the failure worth knowing about: `open` navigates nothing and
the page probe comes back empty. The driver recovers with `newpage` on its own,
but if you are debugging by hand, that is the state you are probably in.

## Watching it

```bash
# what is waiting on a human
curl -s localhost:2529/api/google/unsubscribes/review | jq

# the full attempt log by status
curl -s 'localhost:2529/api/google/unsubscribes?status=succeeded' | jq

# run a cycle now (same gate, same rate limit — a trigger, not a bypass)
curl -s -XPOST localhost:2529/api/google/unsubscribes/run | jq
```

Everything executed also lands in the audit ledger:

```bash
curl -s 'localhost:2529/api/ledger/actions?type=unsubscribe' | jq
```

Each row carries the sender, the tier, the method, the target URL, the HTTP
status (tier 1) or the screenshot path (tier 2). There is deliberately no
endpoint that unsubscribes an arbitrary sender — adding one would open a second
queue source and void the guarantee above.

## Unsticking things

**An attempt is stuck in `running`.** The lease expires after five minutes and
the next cycle reclaims it. Nothing to do.

**An attempt reached `failed`.** Three attempts with backoff were exhausted;
`last_error` says why. An unsubscribe endpoint that fails repeatedly is a case
for a human, which is why the cap is low.

**A sender should be retried after being resolved.** Re-tap "queue unsubscribe"
in the digest. A `set_at` newer than every existing attempt re-arms the sender;
that is the only re-arm path, and it is deliberately a human action.

**Everything is being deferred.** Check the rate limit: `deferred` attempts
carry the reason in `last_error` and a future `next_attempt_at`. Being paced
does not consume an attempt.

**A sender you wanted gone lands in review every time.** Check whether it is on
the whitelist (reply history, contacts, or a team domain). The whitelist wins by
design; resolve it by removing the sender from the whitelist source, not by
bypassing the gate.
