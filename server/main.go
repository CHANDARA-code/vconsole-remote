package main

import (
	"embed"
	"io/fs"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/gorilla/websocket"
	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
)

//go:embed assets/*
var embeddedAssets embed.FS

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow all origins for developer convenience
	},
}

func main() {
	// Start background room reaper to clean rooms inactive > 30 mins
	reaper := startRoomReaper(5*time.Minute, 30*time.Minute)
	defer reaper.Stop()

	e := setupRouter()

	port := getEnv("PORT", "8080")
	log.Printf("Starting vConsole-remote server on port %s", port)
	if err := e.Start(":" + port); err != nil && err != http.ErrServerClosed {
		log.Fatal("Failed to start server:", err)
	}
}

// setupRouter configures and returns the Echo router with all routes and middleware.
func setupRouter() *echo.Echo {
	e := echo.New()
	e.HideBanner = true

	// Middleware
	e.Use(middleware.Logger())
	e.Use(middleware.Recover())

	// Static & Embedded Dashboard Routes
	registerRoutes(e)

	return e
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

	// Static assets served directly from embedded FS
	assetSubFS, err := fs.Sub(embeddedAssets, "assets")
	if err == nil {
		e.GET("/assets/*", echo.WrapHandler(http.StripPrefix("/assets/", http.FileServer(http.FS(assetSubFS)))))
	}

	// WebSocket handler for mobile devices and developer browser
	e.GET("/ws", wsHandler)
}

// wsHandler handles WebSocket connections and dispatches by client type.
func wsHandler(c echo.Context) error {
	conn, err := upgrader.Upgrade(c.Response(), c.Request(), nil)
	if err != nil {
		log.Printf("WebSocket upgrade error: %v", err)
		return err
	}
	defer conn.Close()

	connType := c.QueryParam("type")
	pin := c.QueryParam("pin")

	switch connType {
	case "device":
		_ = handleDeviceConnection(conn)
	case "developer":
		_ = handleDeveloperConnection(conn, pin)
	default:
		// Default to developer if unspecified
		_ = handleDeveloperConnection(conn, pin)
	}
	return nil
}

// getEnv retrieves an environment variable or returns the default value.
func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}
