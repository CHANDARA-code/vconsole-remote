package main

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"

	"github.com/labstack/echo/v4"
)

// The minified client SDK, compiled into the binary so a page can load it
// straight from the broker it talks to. Serving both from one origin means the
// SDK and the wire protocol it speaks cannot drift apart the way a
// version-pinned CDN copy can once the broker is upgraded.
//
// assets/sdk.js is a build artifact, not a source file: scripts/build-sdk.sh
// (and the Dockerfile's sdk-builder stage) drop the rollup output there before
// `go build` runs. A bare source checkout does not have it, which is why this
// degrades to a clear 503 instead of failing the build — `go run .` stays
// usable for server-only work.
var (
	sdkBundle []byte
	sdkETag   string
)

func init() {
	data, err := embeddedAssets.ReadFile("assets/sdk.js")
	if err != nil {
		return
	}
	sum := sha256.Sum256(data)
	sdkBundle = data
	sdkETag = `"` + hex.EncodeToString(sum[:8]) + `"`
}

// registerSDKRoute exposes the client SDK at /sdk.js.
func registerSDKRoute(e *echo.Echo) {
	e.GET("/sdk.js", func(c echo.Context) error {
		if sdkBundle == nil {
			// Deliberately valid JavaScript: a page that loads this gets a
			// console error naming the cause, not a silent undefined global.
			return c.Blob(http.StatusServiceUnavailable, "application/javascript; charset=utf-8",
				[]byte("console.error('[vConsole Remote] This broker was built without the client SDK. "+
					"Build it with scripts/build-sdk.sh, or load the SDK from npm/jsDelivr instead.');\n"))
		}

		h := c.Response().Header()
		// A plain <script src> tag needs no CORS header, but `import()` and
		// fetch() do, and this is public read-only static content either way.
		h.Set("Access-Control-Allow-Origin", "*")
		h.Set("ETag", sdkETag)
		// Short max-age rather than immutable: the URL is stable across
		// deploys, so a long cache would pin devices to an SDK older than the
		// broker. The ETag makes the revalidation cheap.
		h.Set("Cache-Control", "public, max-age=3600")

		if etagMatches(c.Request().Header.Get("If-None-Match"), sdkETag) {
			return c.NoContent(http.StatusNotModified)
		}
		return c.Blob(http.StatusOK, "application/javascript; charset=utf-8", sdkBundle)
	})
}

// etagMatches reports whether an If-None-Match header selects the given tag.
//
// RFC 9110 requires the *weak* comparison here, which matters in practice:
// an edge proxy that recompresses a response (Cloudflare does) hands the
// client back `W/"abc"` for what the origin sent as `"abc"`. Comparing the raw
// strings would then miss on every revalidation and re-send the whole bundle.
// The header may also carry a list, or `*`.
func etagMatches(header, tag string) bool {
	if header == "" {
		return false
	}
	if strings.TrimSpace(header) == "*" {
		return true
	}
	tag = strings.TrimPrefix(tag, "W/")
	for _, candidate := range strings.Split(header, ",") {
		if strings.TrimPrefix(strings.TrimSpace(candidate), "W/") == tag {
			return true
		}
	}
	return false
}
