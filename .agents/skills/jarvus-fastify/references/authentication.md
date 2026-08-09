# Authentication & Authorization

Patterns for authenticating and authorizing requests in Fastify backends. The model:
**deny by default over the whole surface**, sessions in httpOnly cookies backed by a
revocable token store, and authorization resolved from live state — never from token
claims.

## The Model: Deny by Default

The single most important decision is the default. There are two ways to wire auth:

- **Allow by default** — a global hook does optional auth; routes opt IN to protection
  with a per-route `preHandler`. **Don't do this.**
- **Deny by default** — a global hook requires an authenticated principal for every
  request the router matches; anonymity is an explicit, enumerated allowlist. Routes
  declare what they require; an undeclared route fails closed.

Why allow-by-default fails: every new route is born unprotected. Protection depends on
each author remembering to attach the right `preHandler`, forever — and the uncovered
fork is exactly where holes hide. A security review of a production Fastify service
built on the opt-in model found its environment-admin CRUD routes reachable completely
unauthenticated: nobody had opted them in. Deny-by-default makes that class of bug
structurally impossible — a new route is authenticated the moment it exists, and making
one anonymous is a deliberate, reviewed addition to a single list.

Three rules follow from this:

1. **One global hook covers everything** — all methods, all paths, including static
   assets and 404-bound requests the router matches. Not just `/api/*`.
2. **Anonymity is enumerated** — an explicit allowlist of exact `METHOD /path` entries,
   plus narrowly-scoped safe-method prefix rules where a plugin serves a namespace
   (docs UI assets, the SPA shell).
3. **Routes declare their requirement; undeclared fails closed** — a route with no
   declared capability requires the *highest* privilege, not the lowest. A config miss
   surfaces as an admin-only 403 someone notices, not an open endpoint nobody does.

## Dependencies

```bash
bun add jose
```

Use `jose` (pure JS, WebCrypto-based, works on Bun/Node/edge) rather than
`jsonwebtoken`.

## Route Capability Declarations

Each route declares what it requires via Fastify's route `config`, typed through
declaration merging on `FastifyContextConfig`:

```typescript
// src/auth/gateway.ts

/** What a route requires. Extend to fit your domain — the shape that
 *  matters is: routes declare, the gateway enforces. */
export type RouteCapability =
  | { kind: 'viewer' }                        // any authenticated principal
  | { kind: 'operator'; targetEnv: (req: FastifyRequest) => string }
  | { kind: 'admin' }

export const CAP_VIEWER: RouteCapability = { kind: 'viewer' }
export const CAP_ADMIN: RouteCapability = { kind: 'admin' }

/** operator on the environment named by a route param */
export function operatorOnEnvParam(paramName = 'env'): RouteCapability {
  return {
    kind: 'operator',
    targetEnv: (req) => (req.params as Record<string, string>)[paramName] ?? ''
  }
}

declare module 'fastify' {
  interface FastifyContextConfig {
    capability?: RouteCapability
  }

  interface FastifyRequest {
    /** Set by the gateway once authentication succeeds. */
    principal?: PrincipalInfo
  }
}
```

Routes declare their capability in `config` — visible right where the route is defined,
and machine-checkable:

```typescript
fastify.get('/api/v1/runs', {
  config: { capability: CAP_VIEWER },
  schema: { /* ... */ }
}, async (request, reply) => { /* ... */ })

fastify.post<{ Params: { env: string } }>('/api/v1/envs/:env/promote', {
  config: { capability: operatorOnEnvParam('env') },
  schema: { /* ... */ }
}, async (request, reply) => { /* ... */ })

fastify.post('/api/v1/principals', {
  config: { capability: CAP_ADMIN },
  schema: { /* ... */ }
}, async (request, reply) => { /* ... */ })
```

When the requirement derives from the request (an env named in a param, a body field,
a path segment of a resource key), the capability carries a `targetEnv`-style resolver
function rather than a static string — the gateway calls it against the live request.

## The Anonymous Allowlist

The allowlist is a small, exact, reviewable data structure — not a prefix heuristic:

```typescript
// Exact method+path entries. Health probes and any read a deploy/monitor
// tool must hit before it can authenticate.
const ANON_EXACT = new Set<string>([
  'GET /health',
  'GET /health/deep'
])

// Fastify auto-registers a HEAD twin for every GET; treat HEAD as GET.
const SAFE_METHODS = new Set(['GET', 'HEAD'])

export function isAnonymousRoute(method: string, path: string): boolean {
  const normalized = method === 'HEAD' ? 'GET' : method
  if (ANON_EXACT.has(`${normalized} ${path}`)) return true

  // The /auth/* namespace establishes sessions and verifies its own
  // tokens — all methods (logout/refresh are POSTs).
  if (path === '/auth' || path.startsWith('/auth/')) return true

  if (SAFE_METHODS.has(method)) {
    // The browsable OpenAPI reference + the swagger-ui plugin's static
    // assets under it. Safe methods only — a non-GET registered on an
    // allowlisted path is still denied by default.
    if (path === '/docs' || path.startsWith('/docs/')) return true

    // The static SPA shell: safe-method requests outside the API and
    // auth namespaces (index.html, /assets/*, deep-link fallbacks). The
    // shell contains no data — everything it renders comes from the
    // authenticated API.
    if (path !== '/api' && !path.startsWith('/api/')) return true
  }
  return false
}
```

Key points:

- **Exact entries are the norm.** Each prefix rule must be tied to a namespace a plugin
  owns (`/docs/*` static assets, the SPA shell) and restricted to safe methods.
- **HEAD normalizes to GET** so the auto-registered HEAD twins don't fall through.
- The allowlist is trivially unit-testable — write regression tests asserting exactly
  which `(method, path)` pairs are anonymous.

## The Global Gateway Hook

One `preHandler` authenticates and authorizes every matched request:

```typescript
async function authorizeRequest(
  req: FastifyRequest,
  reply: FastifyReply,
  /* your principal-resolution deps */
): Promise<boolean> {
  const path = req.url.split('?')[0] ?? req.url
  if (isAnonymousRoute(req.method, path)) return true

  // 1. Authenticate: resolve exactly one principal from one transport.
  const resolved = await resolveApiPrincipal(req)
  if (!resolved) {
    reply.status(401).send({ error: 'unauthorized' })
    return false
  }

  // 2. CSRF: only cookie-authenticated state-changing requests (see below).
  if (
    resolved.transport === 'cookie' &&
    STATE_CHANGING_METHODS.has(req.method) &&
    !hasCsrfHeader(req.headers)
  ) {
    reply.status(403).send({ error: 'csrf_header_required' })
    return false
  }

  req.principal = resolved.principal

  // 3. Authorize against the route's declared capability.
  //    FAIL CLOSED: no declaration means the highest requirement, not open.
  const capability: RouteCapability =
    (req.routeOptions.config as { capability?: RouteCapability } | undefined)
      ?.capability ?? CAP_ADMIN

  if (capability.kind === 'viewer') return true

  const targetEnv =
    capability.kind === 'operator' ? capability.targetEnv(req) : undefined

  if (hasCapability(resolved.principal, capability, targetEnv)) return true

  reply.status(403).send({
    error: 'forbidden',
    required: capability.kind,
    ...(targetEnv !== undefined ? { environment: targetEnv } : {}),
    your_role: effectiveRoleFor(resolved.principal, capability, targetEnv)
  })
  return false
}

export function registerAuthzGateway(app: FastifyInstance /*, deps */) {
  // Callback-style registration is deliberate — see gotchas.md: an async
  // hook that calls reply.send() and returns does NOT reliably stop the
  // request under every runtime. done() is only called on the allow path.
  app.addHook('preHandler', (req, reply, done) => {
    authorizeRequest(req, reply)
      .then((shouldContinue) => {
        if (shouldContinue) done()
        // else: 401/403 already sent — do NOT call done(), which would
        // resume the chain and run the handler after the reply.
      })
      .catch((err) => done(err as Error))
  })
}
```

The error contract distinguishes two failures, never conflated:

- **`401 Unauthorized`** — no valid principal (missing/expired/revoked token). The
  browser app treats this as "redirect to login."
- **`403 Forbidden`** — authenticated but under-privileged. The body names the
  requirement, the target, and the caller's effective role
  (`{error: "forbidden", required, environment, your_role}`) so the UI can render a
  specific message instead of a generic denial.

**Always register the gateway.** There is no auth-optional mode, no boolean that skips
registration. Local development substitutes the principal instead (see below).

## Sessions

### Never return the token in the response body

The classic anti-pattern: `POST /login` returns `{ token }` for the client to stash in
localStorage. That token is JS-readable — any XSS exfiltrates it. Instead, the login
flow *sets a cookie* and the response body carries only display data:

| Attribute | Value | Why |
| ----------- | ------- | ----- |
| Name | `__Secure-<app>_session` | The `__Secure-` prefix requires `Secure`, blocking downgrade tricks |
| `HttpOnly` | yes | JS cannot read the token — XSS can't exfiltrate it |
| `Secure` | yes | HTTPS only |
| `SameSite` | `Lax` | Cookies still flow to same-site API calls; combined with the CSRF header below |
| `Path` | `/` | |
| `Domain` | `.<apex-domain>` when the API is on a subdomain; omit for host-only |

Because the cookie is httpOnly, the frontend can't read claims from the JWT — expose a
`GET /auth/session` endpoint returning the validated principal's identity + display
claims + **live** role/grants.

On a plain-http local origin the `__Secure-` prefix is unusable (it requires `Secure`,
which requires HTTPS) — fall back to an unprefixed, non-Secure cookie name when the
configured base URL is http.

### CSRF: custom header on cookie-authenticated writes

`SameSite=Lax` alone doesn't cover same-site subdomain cases or every legacy browser.
Require a custom header (e.g. `X-MYAPP-CSRF: 1`) on every **state-changing**
(POST/PUT/PATCH/DELETE) request authenticated **by cookie**. Only same-origin JS can
set a custom header; a cross-site form POST cannot.

**Bearer-authenticated requests are exempt** — CSRF rides *ambient* credentials the
browser attaches automatically, and an attacker can't set an `Authorization` header
cross-site. Applying the CSRF check to Bearer traffic just breaks curl and CI for no
security gain. Reads (GET/HEAD) are exempt too — they're CSRF-safe by definition
(assuming your GETs are actually side-effect-free).

### JWT as format, database as authority

Use a JWT as the token *format* — but a pure stateless `jwt.verify()` is not an
authentication authority. A signature check can't revoke anything: logout, token theft
response, and account deactivation would all have to wait out `exp`.

Instead, every issued token gets a row in a **database-backed token store**, keyed by
the JWT's `jti`:

| Field | Description |
| ------- | ------------- |
| `id` | Token id (`jti` in the JWT) — the revocation handle |
| `principal_id` | Owning principal |
| `kind` | `user` (cookie session) \| `service_account` (Bearer) |
| `created_at`, `expires_at` | Lifetime bounds |
| `revoked_at` | Non-null once logged out / revoked / principal deactivated |

Per request: verify signature + `exp` (a **fast pre-check** that filters garbage before
touching the DB), then validate live — row exists, not revoked, not expired, owning
principal active. Any failure → 401. The signature alone is never sufficient. This is
what turns logout and deactivation into *immediate* effects.

```typescript
export async function resolveSession(cookieHeader: string | undefined) {
  const token = parseCookies(cookieHeader)[SESSION_COOKIE_NAME]
  if (!token) return null
  const claims = await verifySessionJwt(token)   // signature + exp: fast pre-check
  if (!claims || claims.kind !== 'user') return null
  const result = await tokenStore.validate(claims.jti)  // THE authority
  if (!result?.valid || !result.principal) return null
  return { claims, principal: result.principal }
}
```

### Authorization from live state, never token claims

The JWT may carry `role`/`name`/`email` claims — treat them as **display hints only**,
for cheap frontend rendering. Enforcement always reads the principal's live authority
(role + grants) from the store, resolved per request. WHY: claims are a snapshot at
mint time; if authorization reads them, a demoted or deactivated user keeps their old
powers until the token expires. Live resolution makes role changes and offboarding take
effect on the very next request, with no restart and no token invalidation dance.

## Multiple Credential Transports

Humans and machines authenticate differently; support both, resolved to the same
principal model:

| Principal | Transport | CSRF |
|-----------|-----------|------|
| **User** (browser) | `__Secure-` session cookie | Needs the custom-header defense |
| **Service account** (automation) | `Authorization: Bearer <jwt>` | Immune — exempt |

**Each transport is terminal.** Resolution checks transports in a fixed order, and once
a request *presents* a given transport (the header is there), resolution either succeeds
via that transport or the request fails — it never falls back to trying the next one:

```typescript
export async function resolveApiPrincipal(req: FastifyRequest) {
  const authHeader = req.headers.authorization
  if (authHeader) {
    // Bearer presented: succeed as Bearer or fail. No cookie fallback.
    const resolved = await resolveBearerPrincipal(authHeader)
    return resolved ? { principal: resolved.principal, transport: 'bearer' as const } : null
  }
  const session = await resolveSession(req.headers.cookie)
  return session ? { principal: session.principal, transport: 'cookie' as const } : null
}
```

And enforce token `kind` per transport: a `user`-kind token is accepted **only** from
the cookie; a `service_account`-kind token **only** from the `Authorization` header.

WHY: fallback creates confused-deputy holes. If a bad Bearer token silently falls
through to the browser's ambient cookie, a page's fetch with a stale/garbage
`Authorization` header still acts as the logged-in user — and a leaked JS-readable copy
of a user token could be replayed as a Bearer credential. Wrong transport → rejected,
full stop.

## Local Development Mode

Local development (especially ephemeral instances spun up by coding agents) must not
require an IdP, a client secret, or a login click. The **wrong** way to get there is
"just don't register the auth hook in dev" — that creates an auth-optional code path,
forks every route into two behaviors, and is one misconfigured env var away from
serving production traffic open.

Instead, an explicit `AUTH_DISABLED` mode that **substitutes the principal, never the
enforcement**:

```typescript
const resolved =
  authMode.mode === 'disabled'
    ? { principal: DEV_PRINCIPAL, transport: 'dev' as const }  // synthetic dev admin
    : await resolveApiPrincipal(req)
```

- **The gateway still runs.** Every request resolves to a fixed synthetic dev-admin
  principal and then flows through the exact same capability checks as production —
  deny-by-default, fail-closed, and the 401/403 contract are all exercised identically.
- **Boot contract: exactly one mode.** The service requires exactly one of
  `OIDC_ISSUER_URL` (enforced) or `AUTH_DISABLED=1` (dev). Neither → refuse to boot
  with a message naming both options. Both → refuse to boot (ambiguous intent is a
  misconfiguration, not a precedence question). There is deliberately no third
  "no auth configured" state.
- **Strict tri-state parse.** `AUTH_DISABLED` accepts `1/true/yes` or `0/false/no`;
  anything else **throws at boot**. A typo'd `AUTH_DISABLED=ture` silently meaning
  either mode would be confusing at best and dangerous at worst.
- **Loopback containment.** Under `AUTH_DISABLED` the server binds `127.0.0.1` unless
  `HOST` is explicitly set — and widening it boots with a prominent warning.
- **Hard refusal on deployment platforms.** If deployment-platform markers are present
  (e.g. Cloud Run sets `K_REVISION`), boot **fails regardless** of anything else:

```typescript
if (isAuthDisabled(env)) {
  if (env.K_REVISION) {
    throw new Error(
      'AUTH_DISABLED is set in a Cloud Run environment (K_REVISION present) — the ' +
      'local-development bypass must never serve deployed traffic; unset AUTH_DISABLED ' +
      'and configure OIDC'
    )
  }
  // ...
}
```

  A disabled-auth image accidentally deployed fails its health checks instead of
  silently serving an open console.

## Identity Provider Integration

Keep the skill of *establishing* identity separate from sessions and authorization.
For human users, federate to an OIDC identity provider using the **authorization-code
flow with PKCE** as the reference flow — do not default to local bcrypt passwords (you
then own password storage, reset flows, MFA, and breach response; an IdP already does
all of it, and enterprise clients will require their IdP anyway):

1. Unauthenticated browser → redirect to `GET /auth/login`.
2. `/auth/login` redirects to the IdP authorize endpoint with `client_id`,
   `redirect_uri`, `scope`, a PKCE `code_challenge`, an anti-forgery `state`, and a
   `nonce`. Stash `state` + PKCE verifier + `nonce` in a short-lived signed cookie
   (path-scoped to `/auth`) so a stateless service survives the redirect round-trip.
3. IdP redirects back to `GET /auth/callback?code=…&state=…`.
4. Callback validates `state` against the stash, exchanges `code` (with the PKCE
   verifier) for the ID token, and **verifies** it: signature against the IdP JWKS,
   issuer, audience, expiry, and the `nonce` claim against the stash.
5. Resolve identity claims to a platform principal (provision on first sign-in if your
   policy allows), mint a platform session token backed by a token-store row, set the
   session cookie, redirect to the app.

Consume **only identity claims** (`sub`, `email`, `name`). Never read roles or groups
from IdP claims — authority is platform state (see "live state, never token claims"
above), which is what makes role changes immediate and keeps the platform portable
across IdPs.

## Security Considerations

1. **Deny by default** — one global gateway; anonymity is an enumerated allowlist;
   undeclared routes fail closed to the highest requirement
2. **httpOnly cookies for humans** — never return tokens in response bodies for the
   browser to store
3. **Revocation must be possible** — DB-backed token store keyed by `jti`;
   signature+exp is a pre-check, the store is the authority
4. **Authorize from live state** — token claims are display hints, never enforcement
   inputs
5. **Transports are terminal** — wrong-transport tokens are rejected, never fall back
6. **CSRF header on cookie-authenticated writes** — Bearer traffic exempt
7. **Dev mode substitutes the principal, not the enforcement** — loopback-bound,
   strict tri-state parse, hard boot refusal on deployment platforms
8. **Never log tokens** — keep JWTs out of request/response log hooks
9. **Strong signing keys** — HS256 needs ≥32 bytes; validate the length at boot, since
   `sign()` failing at first login is a far worse place to find out
