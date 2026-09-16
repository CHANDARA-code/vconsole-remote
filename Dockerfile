# Multi-stage build for the vConsole Remote broker.
#
# The dashboard and the client SDK are both compiled into the binary via Go's
# embed.FS, so the image serves the dashboard, the WebSocket hub and /sdk.js
# from one process with no runtime filesystem dependency.

# Stage 1: Build the client SDK bundle that the broker serves at /sdk.js
FROM node:22-alpine AS sdk-builder

WORKDIR /sdk

# Manifests first, so the npm cache survives source-only changes
COPY packages/vconsole-remote/package.json packages/vconsole-remote/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY packages/vconsole-remote/rollup.config.js ./
COPY packages/vconsole-remote/src/ ./src/
RUN npm run build

# Stage 2: Build the static Go binary with embedded assets
FROM golang:1.26-alpine AS go-builder

WORKDIR /app

# Dependencies first, so the module cache survives source-only changes
COPY server/go.mod server/go.sum ./
RUN go mod download

COPY server/*.go ./
COPY server/assets/ ./assets/

# Staged as assets/sdk.js so embed.FS picks it up; see server/sdk.go.
COPY --from=sdk-builder /sdk/dist/vconsole-remote.min.js ./assets/sdk.js

RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o vconsole-remote .

# Stage 3: Minimal runtime
FROM alpine:3.24 AS runner

LABEL org.opencontainers.image.title="vConsole Remote" \
      org.opencontainers.image.description="Remote debugging broker for mobile web apps" \
      org.opencontainers.image.source="https://github.com/chandara-code/vconsole-remote" \
      org.opencontainers.image.licenses="MIT"

RUN apk --no-cache add ca-certificates wget \
    && adduser -D -H -u 10001 vconsole

WORKDIR /app
COPY --from=go-builder /app/vconsole-remote /app/vconsole-remote

# Rooms live only in memory, so the container needs no writable state
USER vconsole

EXPOSE 8080

# GET, not --spider: --spider sends HEAD and /healthz is a GET-only Echo
# route, which answers 405 — that would mark the container unhealthy forever.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1

ENTRYPOINT ["/app/vconsole-remote"]
