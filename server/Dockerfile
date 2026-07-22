# CCH Server — standalone single-container deployment
# Uses PGlite (embedded Postgres), no external dependencies

# Stage 1: install dependencies
FROM node:20 AS deps

RUN apt-get update && apt-get install -y python3 make g++ build-essential && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.11.0 --activate

WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY patches ./patches
COPY scripts ./scripts

RUN mkdir -p server packages/wire

COPY server/package.json server/
COPY packages/wire/package.json packages/wire/

COPY server/prisma server/prisma

RUN SKIP_HAPPY_WIRE_BUILD=1 pnpm install --no-frozen-lockfile

# Stage 2: build
FROM deps AS builder

COPY packages/wire packages/wire
COPY server server

RUN pnpm --filter @cch/wire build
RUN pnpm --filter cch-server build

# Stage 3: runtime
FROM node:20-slim AS runner

WORKDIR /repo

RUN apt-get update && apt-get install -y ffmpeg curl && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV PGLITE_DIR=/data/pglite

COPY --from=builder /repo/node_modules /repo/node_modules
COPY --from=builder /repo/packages/wire /repo/packages/wire
COPY --from=builder /repo/server /repo/server

VOLUME /data
EXPOSE 3005

WORKDIR /repo/server

CMD ["sh", "-c", "../node_modules/.bin/tsx sources/standalone.ts migrate && exec ../node_modules/.bin/tsx sources/standalone.ts serve"]
