# syntax=docker/dockerfile:1

FROM oven/bun:1 AS base
WORKDIR /app

# Build frontend
FROM base AS build-frontend
COPY package.json bun.lock ./
COPY packages/core/package.json packages/core/package.json
COPY packages/capture/package.json packages/capture/package.json
COPY packages/chat/package.json packages/chat/package.json
COPY packages/sessions/package.json packages/sessions/package.json
COPY packages/google/package.json packages/google/package.json
COPY packages/notify/package.json packages/notify/package.json
COPY packages/slack-urgency/package.json packages/slack-urgency/package.json
COPY packages/briefing/package.json packages/briefing/package.json
COPY packages/pages/package.json packages/pages/package.json
COPY packages/ledger/package.json packages/ledger/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/admin apps/admin
RUN bun install --frozen-lockfile
WORKDIR /app/apps/admin
RUN bun run build

# Build backend packages
FROM base AS build-backend
COPY package.json bun.lock tsconfig.json ./
COPY packages/core packages/core
COPY packages/capture packages/capture
COPY packages/chat packages/chat
COPY packages/sessions packages/sessions
COPY packages/google packages/google
COPY packages/notify packages/notify
COPY packages/slack-urgency packages/slack-urgency
COPY packages/briefing packages/briefing
COPY packages/pages packages/pages
COPY packages/ledger packages/ledger
COPY apps/server apps/server
COPY apps/admin/package.json apps/admin/package.json
RUN bun install --frozen-lockfile
RUN cd packages/core && bun run build
RUN cd packages/capture && bun run build
RUN cd packages/chat && bun run build
RUN cd packages/sessions && bun run build
RUN cd packages/google && bun run build
RUN cd packages/notify && bun run build
RUN cd packages/slack-urgency && bun run build
RUN cd packages/briefing && bun run build
RUN cd packages/pages && bun run build
RUN cd packages/ledger && bun run build

# Production image
FROM base AS runner
ENV NODE_ENV=production

# Copy built artifacts and node_modules
COPY --from=build-backend /app/node_modules ./node_modules
COPY --from=build-backend /app/packages ./packages
COPY --from=build-backend /app/apps/server ./apps/server
COPY --from=build-frontend /app/apps/admin/dist ./apps/admin/dist

WORKDIR /app/apps/server

EXPOSE 2529

CMD ["bun", "src/server.ts"]
