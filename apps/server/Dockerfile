# syntax=docker/dockerfile:1

FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies and build
FROM base AS build
COPY package.json bun.lock tsconfig.json ./
COPY packages/core packages/core
COPY packages/sessions packages/sessions
COPY packages/google packages/google
COPY apps/server apps/server
COPY apps/admin/package.json apps/admin/package.json
RUN bun install --frozen-lockfile
RUN cd packages/core && bun run build
RUN cd packages/sessions && bun run build
RUN cd packages/google && bun run build

# Production image
FROM base AS runner
ENV NODE_ENV=production

# Copy built artifacts and node_modules
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/server ./apps/server

WORKDIR /app/apps/server

EXPOSE 2529

CMD ["bun", "src/server.ts"]
