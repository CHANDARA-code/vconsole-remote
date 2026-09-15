# Multi-stage build for the vConsole Remote broker.
#
# The dashboard is compiled into the binary via Go's embed.FS, and the client
# SDK ships separately over npm, so the image needs nothing but the Go build.

# Stage 1: Build the static Go binary with embedded assets
FROM golang:1.22-alpine AS go-builder

WORKDIR /app

# Dependencies first, so the module cache survives source-only changes
COPY server/go.mod server/go.sum ./
RUN go mod download

COPY server/*.go ./
COPY server/assets/ ./assets/

RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o vconsole-remote .

# Stage 2: Minimal runtime
FROM alpine:3.20 AS runner

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

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --spider -q http://127.0.0.1:8080/healthz || exit 1

ENTRYPOINT ["/app/vconsole-remote"]
