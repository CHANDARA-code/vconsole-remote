package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Config holds all runtime security and session-lifecycle settings.
// Every field is overridable through an environment variable so the same
// binary can run locally and behind a public edge proxy without a rebuild.
type Config struct {
	RoomMaxDuration       time.Duration
	RoomIdleTimeout       time.Duration
	AuthTimeout           time.Duration
	ReaperInterval        time.Duration
	PinAttemptLimit       int
	PinAttemptWindow      time.Duration
	PinBlockDuration      time.Duration
	RequireDeviceApproval bool
	RequireRoomKey        bool
	TrustProxy            bool
	AllowedOrigins        []string
	MaxRooms              int
}

var activeConfig atomic.Pointer[Config]

func init() {
	initial := defaultConfig()
	activeConfig.Store(&initial)
}

// cfg returns the active configuration. Reads happen on every connection while
// applyConfig may swap the whole struct, so the pointer is loaded atomically.
func cfg() *Config {
	return activeConfig.Load()
}

func defaultConfig() Config {
	return Config{
		RoomMaxDuration:       8 * time.Hour,
		RoomIdleTimeout:       30 * time.Minute,
		AuthTimeout:           60 * time.Second,
		ReaperInterval:        time.Minute,
		PinAttemptLimit:       5,
		PinAttemptWindow:      time.Minute,
		PinBlockDuration:      10 * time.Minute,
		RequireDeviceApproval: true,
		RequireRoomKey:        false,
		TrustProxy:            false,
		AllowedOrigins:        nil,
		MaxRooms:              10000,
	}
}

// loadConfig reads configuration from the environment, falling back to defaults.
func loadConfig() Config {
	c := defaultConfig()
	c.RoomMaxDuration = getEnvDuration("ROOM_MAX_DURATION", c.RoomMaxDuration)
	c.RoomIdleTimeout = getEnvDuration("ROOM_IDLE_TIMEOUT", c.RoomIdleTimeout)
	c.AuthTimeout = getEnvDuration("AUTH_APPROVAL_TIMEOUT", c.AuthTimeout)
	c.ReaperInterval = getEnvDuration("REAPER_INTERVAL", c.ReaperInterval)
	c.PinAttemptLimit = getEnvInt("PIN_ATTEMPT_LIMIT", c.PinAttemptLimit)
	c.PinAttemptWindow = getEnvDuration("PIN_ATTEMPT_WINDOW", c.PinAttemptWindow)
	c.PinBlockDuration = getEnvDuration("PIN_BLOCK_DURATION", c.PinBlockDuration)
	c.RequireDeviceApproval = getEnvBool("REQUIRE_DEVICE_APPROVAL", c.RequireDeviceApproval)
	c.RequireRoomKey = getEnvBool("REQUIRE_ROOM_KEY", c.RequireRoomKey)
	c.TrustProxy = getEnvBool("TRUST_PROXY", c.TrustProxy)
	c.AllowedOrigins = parseOriginList(os.Getenv("ALLOWED_ORIGINS"))
	c.MaxRooms = getEnvInt("MAX_ROOMS", c.MaxRooms)
	return c
}

func getEnvDuration(key string, fallback time.Duration) time.Duration {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	if d, err := time.ParseDuration(raw); err == nil && d > 0 {
		return d
	}
	return fallback
}

func getEnvInt(key string, fallback int) int {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return fallback
	}
	if n, err := strconv.Atoi(raw); err == nil && n > 0 {
		return n
	}
	return fallback
}

func getEnvBool(key string, fallback bool) bool {
	raw := strings.TrimSpace(strings.ToLower(os.Getenv(key)))
	switch raw {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return fallback
	}
}

func parseOriginList(raw string) []string {
	var out []string
	for _, part := range strings.Split(raw, ",") {
		if trimmed := strings.TrimSpace(strings.ToLower(part)); trimmed != "" {
			out = append(out, strings.TrimSuffix(trimmed, "/"))
		}
	}
	return out
}

const roomKeyBytes = 8

// generateRoomKey returns a cryptographically random hex secret bound to a room.
func generateRoomKey() (string, error) {
	buf := make([]byte, roomKeyBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

// constantTimeEquals compares two secrets without leaking length or content timing.
func constantTimeEquals(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// rateLimiter tracks failed pairing attempts per client IP and blocks abusive
// sources for a fixed cooldown once the failure threshold is crossed.
type rateLimiter struct {
	mu      sync.Mutex
	entries map[string]*rateEntry
	limit   int
	window  time.Duration
	block   time.Duration
}

type rateEntry struct {
	failures     []time.Time
	blockedUntil time.Time
}

func newRateLimiter(limit int, window, block time.Duration) *rateLimiter {
	return &rateLimiter{
		entries: make(map[string]*rateEntry),
		limit:   limit,
		window:  window,
		block:   block,
	}
}

// Configure retunes the limiter in place and drops accumulated state, so the
// limiter pointer stays stable for concurrent readers.
func (rl *rateLimiter) Configure(limit int, window, block time.Duration) {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	rl.limit = limit
	rl.window = window
	rl.block = block
	rl.entries = make(map[string]*rateEntry)
}

// Allowed reports whether an IP may attempt a pairing right now. When blocked it
// also returns the remaining cooldown so the caller can emit a Retry-After hint.
func (rl *rateLimiter) Allowed(ip string) (bool, time.Duration) {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	entry, exists := rl.entries[ip]
	if !exists {
		return true, 0
	}
	if remaining := time.Until(entry.blockedUntil); remaining > 0 {
		return false, remaining
	}
	return true, 0
}

// RecordFailure registers one failed pairing attempt, blocking the IP once the
// configured number of failures occurs inside the sliding window.
func (rl *rateLimiter) RecordFailure(ip string) {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := time.Now()
	entry, exists := rl.entries[ip]
	if !exists {
		entry = &rateEntry{}
		rl.entries[ip] = entry
	}

	cutoff := now.Add(-rl.window)
	kept := entry.failures[:0]
	for _, ts := range entry.failures {
		if ts.After(cutoff) {
			kept = append(kept, ts)
		}
	}
	entry.failures = append(kept, now)

	if len(entry.failures) >= rl.limit {
		entry.blockedUntil = now.Add(rl.block)
		entry.failures = nil
	}
}

// Reset clears the failure history for an IP after a successful pairing.
func (rl *rateLimiter) Reset(ip string) {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	delete(rl.entries, ip)
}

// Cleanup drops entries that are no longer blocked and have no recent failures,
// keeping the limiter's memory proportional to active clients only.
func (rl *rateLimiter) Cleanup() {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := time.Now()
	cutoff := now.Add(-rl.window)
	for ip, entry := range rl.entries {
		if entry.blockedUntil.After(now) {
			continue
		}
		recent := false
		for _, ts := range entry.failures {
			if ts.After(cutoff) {
				recent = true
				break
			}
		}
		if !recent {
			delete(rl.entries, ip)
		}
	}
}

var pinLimiter = newRateLimiter(defaultConfig().PinAttemptLimit, defaultConfig().PinAttemptWindow, defaultConfig().PinBlockDuration)

// applyConfig installs a configuration and retunes every component derived from
// it. Called once at startup, and by tests that need non-default limits.
func applyConfig(c Config) {
	activeConfig.Store(&c)
	pinLimiter.Configure(c.PinAttemptLimit, c.PinAttemptWindow, c.PinBlockDuration)
}

// clientIP resolves the caller's address, honouring edge-proxy headers only when
// TRUST_PROXY is enabled. Trusting them unconditionally would let an attacker
// forge a fresh identity per request and walk straight through the rate limiter.
func clientIP(r *http.Request) string {
	if cfg().TrustProxy {
		if cf := strings.TrimSpace(r.Header.Get("CF-Connecting-IP")); cf != "" {
			return cf
		}
		if xff := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); xff != "" {
			if first := strings.TrimSpace(strings.Split(xff, ",")[0]); first != "" {
				return first
			}
		}
		if xr := strings.TrimSpace(r.Header.Get("X-Real-IP")); xr != "" {
			return xr
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// maskIP partially redacts an address so the approval prompt can show where a
// request came from without printing a full identifier on someone's screen.
func maskIP(ip string) string {
	if ip == "" {
		return "unknown"
	}
	if strings.Contains(ip, ":") {
		parts := strings.Split(ip, ":")
		if len(parts) > 2 {
			return parts[0] + ":" + parts[1] + ":xx:xx"
		}
		return "xx:xx"
	}
	octets := strings.Split(ip, ".")
	if len(octets) == 4 {
		return octets[0] + "." + octets[1] + ".xx.xx"
	}
	return "unknown"
}

// maskPin redacts the second half of a room PIN for log output, so a leaked or
// shipped log file never carries a working pairing credential.
func maskPin(pin string) string {
	if len(pin) < 3 {
		return "***"
	}
	return pin[:3] + "***"
}

// describeClient renders a human-readable "Chrome on macOS" style label from a
// User-Agent string, for display in the device approval prompt.
func describeClient(userAgent string) string {
	if strings.TrimSpace(userAgent) == "" {
		return "Unknown client"
	}
	ua := strings.ToLower(userAgent)

	browser := "Unknown browser"
	switch {
	case strings.Contains(ua, "edg/"):
		browser = "Edge"
	case strings.Contains(ua, "opr/") || strings.Contains(ua, "opera"):
		browser = "Opera"
	case strings.Contains(ua, "firefox"):
		browser = "Firefox"
	case strings.Contains(ua, "chrome") || strings.Contains(ua, "crios"):
		browser = "Chrome"
	case strings.Contains(ua, "safari"):
		browser = "Safari"
	}

	platform := "Unknown OS"
	switch {
	case strings.Contains(ua, "windows"):
		platform = "Windows"
	case strings.Contains(ua, "iphone") || strings.Contains(ua, "ipad"):
		platform = "iOS"
	case strings.Contains(ua, "android"):
		platform = "Android"
	case strings.Contains(ua, "mac os x") || strings.Contains(ua, "macintosh"):
		platform = "macOS"
	case strings.Contains(ua, "linux"):
		platform = "Linux"
	}

	return browser + " on " + platform
}

// originAllowed enforces the ALLOWED_ORIGINS list for dashboard (developer)
// connections. An empty list allows every origin, which keeps local development
// working; production deployments are expected to set it explicitly.
func originAllowed(r *http.Request) bool {
	if len(cfg().AllowedOrigins) == 0 {
		return true
	}
	origin := strings.ToLower(strings.TrimSpace(r.Header.Get("Origin")))
	if origin == "" {
		return true
	}
	origin = strings.TrimSuffix(origin, "/")
	for _, allowed := range cfg().AllowedOrigins {
		if origin == allowed {
			return true
		}
	}
	return false
}
