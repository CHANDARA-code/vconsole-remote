# Multi-stage build for vConsole Remote

# Stage 1: Build the Client SDK
FROM node:20-alpine AS sdk-builder

WORKDIR /app

# Install dependencies
COPY packages/vconsole-remote/package*.json ./
RUN npm ci

# Copy source code and build UMD & ESM bundles
COPY packages/vconsole-remote/rollup.config.js ./
COPY packages/vconsole-remote/src/ ./src/
RUN npm run build

# Stage 2: Build Go binary with embedded assets
FROM golang:1.22-alpine AS go-builder

WORKDIR /app

# Install git for module fetching if needed
RUN apk add --no-cache git

# Copy go mod and sum files
COPY server/go.mod server/go.sum ./

# Download dependencies
RUN go mod download

# Copy server Go source code and embedded assets
COPY server/*.go ./
COPY server/assets/ ./assets/

# Build static Linux binary with embedded assets
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o vconsole-remote .

# Stage 3: Minimal runner
FROM alpine:latest AS runner

RUN apk --no-cache add ca-certificates
WORKDIR /root/

# Copy the binary from the previous stage
COPY --from=go-builder /app/vconsole-remote .

# Expose port
EXPOSE 8080

# Run the binary
CMD ["./vconsole-remote"]