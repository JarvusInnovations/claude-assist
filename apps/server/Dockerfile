# syntax=docker/dockerfile:1

FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package.json bun.lock ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
RUN bun install --frozen-lockfile

# Build core package
FROM deps AS build
COPY packages/core packages/core
COPY tsconfig.json ./
RUN cd packages/core && bun run build

# Production image
FROM base AS runner
ENV NODE_ENV=production

# Copy built artifacts
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=deps /app/packages/core/package.json ./packages/core/
COPY apps/server/src ./apps/server/src
COPY apps/server/package.json ./apps/server/

WORKDIR /app/apps/server

EXPOSE 3000

CMD ["bun", "src/server.ts"]
