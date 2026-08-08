# jarvus-fastify

The Jarvus convention set for building backends with **Fastify 5 + TypeScript on Bun** — routes,
services, the plugin pattern, `@fastify/env` environment validation, CORS, and logging. Bun is the
runtime, package manager, and test runner; TypeScript source runs directly with no build step. It
keeps backend code consistent with how Jarvus structures Fastify apps.

## When you'd want it

Any project with a Fastify/TypeScript backend — creating new APIs, adding routes, implementing
services, working with plugins, or wiring environment variables. Install it on a repo so an agent
building backend code follows the house patterns instead of improvising.

## Install

**Recommended scope: per-project.** This encodes the stack *this* project uses, so installing it in
the repo means every developer (and their agents) gets the same guidance — version-controlled with
the code and updated alongside it.

```bash
npx skills add JarvusInnovations/agent-skills --skill jarvus-fastify
```

(Add `--global` if you'd rather have it available everywhere.) See `SKILL.md` for the stack and patterns
and `references/` for authentication, MCP integration, and more.
