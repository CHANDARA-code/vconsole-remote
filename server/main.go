package main

import (
	"embed"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"strconv"

	"github.com/gorilla/websocket"
	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
)

//go:embed assets/*
var embeddedAssets embed.FS

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		// Mobile SDK clients connect from arbitrary app origins (capacitor://,
		// file://, custom schemes), so origin pinning applies to dashboard
		// connections only and is enforced before the upgrade in wsHandler.
		return true
	},
}

func main() {
	applyConfig(loadConfig())
	logConfigSummary()

	// Background reaper enforcing the idle timeout and the hard session cap
	reaper := startRoomReaper(cfg().ReaperInterval, cfg().RoomIdleTimeout)
	defer reaper.Stop()

	e := setupRouter()

	port := getEnv("PORT", "8080")
	log.Printf("Starting vConsole-remote server on port %s", port)
	if err := e.Start(":" + port); err != nil && err != http.ErrServerClosed {
		log.Fatal("Failed to start server:", err)
	}
}

// logConfigSummary prints the active security posture at boot so a misconfigured
// public deployment is obvious in the first lines of output.
func logConfigSummary() {
	log.Printf("[Config] Session limits: max=%s idle=%s approval-timeout=%s",
		cfg().RoomMaxDuration, cfg().RoomIdleTimeout, cfg().AuthTimeout)
	log.Printf("[Config] Pairing: device-approval=%v require-room-key=%v rate-limit=%d/%s block=%s",
		cfg().RequireDeviceApproval, cfg().RequireRoomKey,
		cfg().PinAttemptLimit, cfg().PinAttemptWindow, cfg().PinBlockDuration)
	log.Printf("[Config] Network: trust-proxy=%v allowed-origins=%v max-rooms=%d",
		cfg().TrustProxy, cfg().AllowedOrigins, cfg().MaxRooms)

	if !cfg().RequireDeviceApproval {
		log.Printf("[Config] WARNING: device approval is disabled. Anyone who guesses a PIN gets full access. Never run a public server this way.")
	}
}

// setupRouter configures and returns the Echo router with all routes and middleware.
func setupRouter() *echo.Echo {
	e := echo.New()
	e.HideBanner = true

	// Access log records the path only. Logging the full URI would persist room
	// PINs and keys into stdout, defeating the zero-retention design.
	e.Use(middleware.LoggerWithConfig(middleware.LoggerConfig{
		Format: "method=${method} path=${path} status=${status} latency=${latency_human}\n",
	}))
	e.Use(middleware.Recover())
	e.Use(securityHeaders)

	// Static & Embedded Dashboard Routes
	registerRoutes(e)

	return e
}

// securityHeaders applies baseline hardening headers to every response.
func securityHeaders(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error {
		h := c.Response().Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		return next(c)
	}
}

// registerRoutes sets up embedded dashboard, static asset, and WebSocket routes.
func registerRoutes(e *echo.Echo) {
	// Root dashboard served directly from embedded FS (zero host filesystem dependency)
	e.GET("/", func(c echo.Context) error {
		data, err := embeddedAssets.ReadFile("assets/index.html")
		if err != nil {
			return c.String(http.StatusInternalServerError, "Failed to load embedded dashboard")
		}
		return c.HTMLBlob(http.StatusOK, data)
	})

	// Favicon served from embedded FS or returns 204 No Content
	e.GET("/favicon.ico", func(c echo.Context) error {
		data, err := embeddedAssets.ReadFile("assets/favicon.ico")
		if err != nil {
			return c.NoContent(http.StatusNoContent)
		}
		return c.Blob(http.StatusOK, "image/x-icon", data)
	})

	// Liveness probe reporting only aggregate, non-identifying counters
	e.GET("/healthz", func(c echo.Context) error {
		roomsMu.RLock()
		active := len(rooms)
		roomsMu.RUnlock()
		return c.JSON(http.StatusOK, map[string]interface{}{
			"status":      "ok",
			"activeRooms": active,
			"maxRooms":    cfg().MaxRooms,
		})
	})

	// Static assets served directly from embedded FS
	assetSubFS, err := fs.Sub(embeddedAssets, "assets")
	if err == nil {
		e.GET("/assets/*", echo.WrapHandler(http.StripPrefix("/assets/", http.FileServer(http.FS(assetSubFS)))))
	}

	// WebSocket handler for mobile devices and developer browser
	e.GET("/ws", wsHandler)
}

// wsHandler validates pairing credentials before upgrading, so brute-force and
// single-occupancy rejections are answered with real HTTP status codes instead
// of consuming a WebSocket connection slot.
func wsHandler(c echo.Context) error {
	req := c.Request()
	connType := c.QueryParam("type")
	pin := c.QueryParam("pin")
	key := c.QueryParam("key")
	ip := clientIP(req)

	if connType != "device" {
		if !originAllowed(req) {
			return c.JSON(http.StatusForbidden, map[string]string{
				"error":  "origin_not_allowed",
				"detail": "This origin is not permitted to open a debug session",
			})
		}

		if allowed, retryIn := pinLimiter.Allowed(ip); !allowed {
			seconds := int(retryIn.Seconds()) + 1
			c.Response().Header().Set("Retry-After", strconv.Itoa(seconds))
			return c.JSON(http.StatusTooManyRequests, map[string]string{
				"error":  "too_many_attempts",
				"detail": fmt.Sprintf("Too many failed pairing attempts. Try again in %d seconds", seconds),
			})
		}

		// Only the query-param path can be screened here. In-band `connect_room`
		// pairing runs the identical checks inside pairDeveloper.
		if pin != "" {
			if verdict := preflightPairing(pin, key, ip); verdict != accessOK {
				return respondPairingRefusal(c, verdict)
			}
		}
	}

	conn, err := upgrader.Upgrade(c.Response(), req, nil)
	if err != nil {
		log.Printf("WebSocket upgrade error: %v", err)
		return err
	}
	defer conn.Close()

	meta := devSession{
		Key:       key,
		ClientIP:  ip,
		UserAgent: req.UserAgent(),
	}

	switch connType {
	case "device":
		_ = handleDeviceConnection(conn)
	default:
		// Default to developer if unspecified
		_ = handleDeveloperConnection(conn, pin, meta)
	}
	return nil
}

// preflightPairing screens credentials before the upgrade and records failed
// attempts against the rate limiter.
func preflightPairing(pin, key, ip string) accessVerdict {
	if len(pin) != 6 || !isNumeric(pin) {
		pinLimiter.RecordFailure(ip)
		return accessNotFound
	}

	verdict := checkRoomAccess(pin, key)
	// A busy room is a legitimate state, not a guess, so it does not count
	// toward the brute-force budget.
	if verdict != accessOK && verdict != accessBusy {
		pinLimiter.RecordFailure(ip)
	}
	return verdict
}

func respondPairingRefusal(c echo.Context, verdict accessVerdict) error {
	status := http.StatusNotFound
	if verdict == accessBusy {
		status = http.StatusForbidden
	} else if verdict == accessBadKey {
		status = http.StatusForbidden
	}
	return c.JSON(status, map[string]string{
		"error":  verdict.reason(),
		"detail": verdict.message(),
	})
}

// getEnv retrieves an environment variable or returns the default value.
func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}
