---
name: assist-screen
description: >-
  Check an outgoing draft message against a written policy before posting it, via
  the bundled screen-check command. The check is made by a separate model that sees
  only the draft, the destination class and the policy. Use when a tool or agent
  needs a screen command for outgoing posts, or asks "screen this draft", "check
  this against the policy before I post", or "configure screen.command".
---

# assist-screen

`scripts/screen-check` sends one draft to the claude-assist screen endpoint
(`POST /api/screen`) and prints the verdict. It is built to be configured as
another tool's screen command.

## Contract

stdin, exactly these keys:

```json
{ "draft": "…", "destination_class": "…", "policy": "…" }
```

stdout, on success (exit `0` for both):

```json
{ "verdict": "pass" }
{ "verdict": "block", "passage": "…", "reason": "…" }
```

On any failure (no token, bad stdin, server unreachable, timeout, any non-2xx,
an answer that is not a valid verdict) stdout is **empty**, one line goes to
stderr, and the exit code is non-zero (`2` for a local usage problem, `1`
otherwise). Treat a non-zero exit as "do not post".

## Environment

| Variable | Meaning |
| --- | --- |
| `CLAUDE_ASSIST_SERVER` | Base URL of the service. Default `http://localhost:2529`. |
| `CLAUDE_ASSIST_SCREEN_TOKEN` | Bearer token; must equal the server's `SCREEN_API_TOKEN`. Required. |
| `CLAUDE_ASSIST_SCREEN_TIMEOUT_MS` | Whole-request timeout. Default `120000`. |

## Example

```bash
echo '{"draft":"…","destination_class":"public-channel","policy":"…"}' \
  | scripts/screen-check
```

Limits: `draft` and `policy` up to 20,000 characters each,
`destination_class` up to 200. The server stores none of the text; it logs
the draft's SHA-256, the class, the verdict and the spend.
