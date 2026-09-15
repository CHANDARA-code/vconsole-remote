package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// withConfig installs a temporary configuration for one test and restores the
// previous one (and a clean rate limiter) afterwards.
func withConfig(t *testing.T, mutate func(c *Config)) {
	t.Helper()
	previous := *cfg()
	next := previous
	mutate(&next)
	applyConfig(next)
	t.Cleanup(func() { applyConfig(previous) })
}

// newDevice dials a device connection and returns it with its room credentials.
func newDevice(t *testing.T, baseWS string) (*SafeConn, string, string) {
	t.Helper()
	conn, _, err := websocket.DefaultDialer.Dial(baseWS+"/ws?type=device", nil)
	if err != nil {
		t.Fatalf("device dial error: %v", err)
	}
	device := NewSafeConn(conn)

	var pinMsg Message
	if err := device.ReadJSON(&pinMsg); err != nil {
		t.Fatalf("device failed to read room_pin: %v", err)
	}
	if pinMsg.Type != "room_pin" {
		t.Fatalf("expected room_pin, got %s", pinMsg.Type)
	}
	if pinMsg.Key == "" {
		t.Fatalf("expected room_pin to carry a room key")
	}
	return device, pinMsg.Pin, pinMsg.Key
}

// approveNext reads the pending auth_request on a device socket and answers it.
func approveNext(t *testing.T, device *SafeConn, approved bool) {
	t.Helper()
	var req Message
	if err := device.ReadJSON(&req); err != nil {
		t.Fatalf("device failed to read auth_request: %v", err)
	}
	if req.Type != "auth_request" {
		t.Fatalf("expected auth_request, got %s", req.Type)
	}
	if err := device.WriteJSON(map[string]interface{}{
		"type":     "auth_response",
		"authId":   req.AuthId,
		"approved": approved,
	}); err != nil {
		t.Fatalf("device failed to answer auth_request: %v", err)
	}
}

// TestRateLimiterBlocksAfterThreshold verifies the sliding-window failure
// counter, the cooldown, and the reset-on-success behaviour in isolation.
func TestRateLimiterBlocksAfterThreshold(t *testing.T) {
	rl := newRateLimiter(5, time.Minute, 10*time.Minute)

	for i := 0; i < 4; i++ {
		rl.RecordFailure("1.2.3.4")
		if allowed, _ := rl.Allowed("1.2.3.4"); !allowed {
			t.Fatalf("IP blocked after only %d failures, expected 5", i+1)
		}
	}

	rl.RecordFailure("1.2.3.4")
	allowed, retryIn := rl.Allowed("1.2.3.4")
	if allowed {
		t.Fatal("expected IP to be blocked after 5 failures within the window")
	}
	if retryIn <= 9*time.Minute {
		t.Fatalf("expected ~10m cooldown, got %s", retryIn)
	}

	if other, _ := rl.Allowed("5.6.7.8"); !other {
		t.Fatal("blocking one IP must not affect another")
	}

	rl.Reset("1.2.3.4")
	if allowed, _ := rl.Allowed("1.2.3.4"); !allowed {
		t.Fatal("Reset should clear an IP's block")
	}
}

// TestRateLimiterWindowExpiry verifies that failures older than the window do
// not accumulate toward the block threshold.
func TestRateLimiterWindowExpiry(t *testing.T) {
	rl := newRateLimiter(3, 50*time.Millisecond, time.Minute)

	rl.RecordFailure("9.9.9.9")
	rl.RecordFailure("9.9.9.9")
	time.Sleep(70 * time.Millisecond)
	rl.RecordFailure("9.9.9.9")

	if allowed, _ := rl.Allowed("9.9.9.9"); !allowed {
		t.Fatal("stale failures outside the window must not trigger a block")
	}
}

// TestBruteForcePinAttemptsAreBlocked drives the HTTP surface: repeated wrong
// PINs must eventually be refused with 429 before a socket is ever upgraded.
func TestBruteForcePinAttemptsAreBlocked(t *testing.T) {
	withConfig(t, func(c *Config) {
		c.PinAttemptLimit = 5
		c.PinAttemptWindow = time.Minute
		c.PinBlockDuration = 10 * time.Minute
	})

	server := httptest.NewServer(setupRouter())
	defer server.Close()
	baseWS := "ws" + strings.TrimPrefix(server.URL, "http")

	for i := 0; i < 5; i++ {
		conn, resp, err := websocket.DefaultDialer.Dial(baseWS+"/ws?type=developer&pin=000000", nil)
		if err == nil {
			conn.Close()
			t.Fatalf("attempt %d: expected a non-existent room to be refused", i+1)
		}
		if resp == nil || resp.StatusCode != http.StatusNotFound {
			t.Fatalf("attempt %d: expected 404, got %v", i+1, resp)
		}
	}

	conn, resp, err := websocket.DefaultDialer.Dial(baseWS+"/ws?type=developer&pin=000000", nil)
	if err == nil {
		conn.Close()
		t.Fatal("expected the 6th attempt to be rate limited")
	}
	if resp == nil || resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("expected 429 after exceeding the attempt limit, got %v", resp)
	}
	if resp.Header.Get("Retry-After") == "" {
		t.Error("expected a Retry-After header on a rate-limited response")
	}

	// A valid room must also be refused while the IP is serving its cooldown.
	device, pin, _ := newDevice(t, baseWS)
	defer device.Close()

	conn, resp, err = websocket.DefaultDialer.Dial(baseWS+"/ws?type=developer&pin="+pin, nil)
	if err == nil {
		conn.Close()
		t.Fatal("a blocked IP must not pair even with a correct PIN")
	}
	if resp == nil || resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("expected 429 for a blocked IP, got %v", resp)
	}
}

// TestDeviceApprovalGrantsAccess verifies that traffic only flows after the
// device owner taps Allow.
func TestDeviceApprovalGrantsAccess(t *testing.T) {
	withConfig(t, func(c *Config) { c.RequireDeviceApproval = true })

	server := httptest.NewServer(setupRouter())
	defer server.Close()
	baseWS := "ws" + strings.TrimPrefix(server.URL, "http")

	device, pin, _ := newDevice(t, baseWS)
	defer device.Close()

	devWS, _, err := websocket.DefaultDialer.Dial(baseWS+"/ws?type=developer&pin="+pin, nil)
	if err != nil {
		t.Fatalf("developer dial error: %v", err)
	}
	dev := NewSafeConn(devWS)
	defer dev.Close()

	var pending Message
	if err := dev.ReadJSON(&pending); err != nil {
		t.Fatalf("developer failed to read auth_pending: %v", err)
	}
	if pending.Type != "auth_pending" {
		t.Fatalf("expected auth_pending, got %s", pending.Type)
	}

	// While pending, the developer must not be bound to the room.
	roomsMu.RLock()
	boundEarly := rooms[pin].DevConn != nil
	roomsMu.RUnlock()
	if boundEarly {
		t.Fatal("developer was bound to the room before approval")
	}

	approveNext(t, device, true)

	var connected Message
	if err := dev.ReadJSON(&connected); err != nil {
		t.Fatalf("developer failed to read room_connected: %v", err)
	}
	if connected.Type != "room_connected" {
		t.Fatalf("expected room_connected after approval, got %s", connected.Type)
	}
}

// TestDeviceRejectionDeniesAccess verifies that a rejected developer is told so
// and dropped without ever receiving room traffic.
func TestDeviceRejectionDeniesAccess(t *testing.T) {
	withConfig(t, func(c *Config) { c.RequireDeviceApproval = true })

	server := httptest.NewServer(setupRouter())
	defer server.Close()
	baseWS := "ws" + strings.TrimPrefix(server.URL, "http")

	device, pin, _ := newDevice(t, baseWS)
	defer device.Close()

	devWS, _, err := websocket.DefaultDialer.Dial(baseWS+"/ws?type=developer&pin="+pin, nil)
	if err != nil {
		t.Fatalf("developer dial error: %v", err)
	}
	dev := NewSafeConn(devWS)
	defer dev.Close()

	var pending Message
	if err := dev.ReadJSON(&pending); err != nil {
		t.Fatalf("developer failed to read auth_pending: %v", err)
	}

	approveNext(t, device, false)

	var rejected Message
	if err := dev.ReadJSON(&rejected); err != nil {
		t.Fatalf("developer failed to read auth_rejected: %v", err)
	}
	if rejected.Type != "auth_rejected" {
		t.Fatalf("expected auth_rejected, got %s", rejected.Type)
	}

	roomsMu.RLock()
	stillBound := rooms[pin].DevConn != nil
	pendingLeft := rooms[pin].PendingAuth != nil
	roomsMu.RUnlock()
	if stillBound {
		t.Error("a rejected developer must not be bound to the room")
	}
	if pendingLeft {
		t.Error("a rejected developer must not hold the pending slot")
	}
}

// TestApprovalTimeoutReleasesRoom verifies an unanswered prompt expires and
// frees the room's single developer slot.
func TestApprovalTimeoutReleasesRoom(t *testing.T) {
	withConfig(t, func(c *Config) {
		c.RequireDeviceApproval = true
		c.AuthTimeout = 150 * time.Millisecond
	})

	server := httptest.NewServer(setupRouter())
	defer server.Close()
	baseWS := "ws" + strings.TrimPrefix(server.URL, "http")

	device, pin, _ := newDevice(t, baseWS)
	defer device.Close()

	devWS, _, err := websocket.DefaultDialer.Dial(baseWS+"/ws?type=developer&pin="+pin, nil)
	if err != nil {
		t.Fatalf("developer dial error: %v", err)
	}
	dev := NewSafeConn(devWS)
	defer dev.Close()

	var pending Message
	if err := dev.ReadJSON(&pending); err != nil {
		t.Fatalf("developer failed to read auth_pending: %v", err)
	}

	var timeout Message
	if err := dev.ReadJSON(&timeout); err != nil {
		t.Fatalf("developer failed to read auth_timeout: %v", err)
	}
	if timeout.Type != "auth_timeout" {
		t.Fatalf("expected auth_timeout, got %s", timeout.Type)
	}

	roomsMu.RLock()
	pendingLeft := rooms[pin].PendingAuth != nil
	roomsMu.RUnlock()
	if pendingLeft {
		t.Fatal("an expired prompt must release the pending slot")
	}
}

// TestSingleDeveloperOccupancy verifies a second developer is refused while the
// room already has one, and admitted once that developer leaves.
func TestSingleDeveloperOccupancy(t *testing.T) {
	withConfig(t, func(c *Config) { c.RequireDeviceApproval = true })

	server := httptest.NewServer(setupRouter())
	defer server.Close()
	baseWS := "ws" + strings.TrimPrefix(server.URL, "http")

	device, pin, _ := newDevice(t, baseWS)
	defer device.Close()

	firstWS, _, err := websocket.DefaultDialer.Dial(baseWS+"/ws?type=developer&pin="+pin, nil)
	if err != nil {
		t.Fatalf("first developer dial error: %v", err)
	}
	first := NewSafeConn(firstWS)

	var pending Message
	if err := first.ReadJSON(&pending); err != nil {
		t.Fatalf("first developer failed to read auth_pending: %v", err)
	}
	approveNext(t, device, true)
	var connected Message
	if err := first.ReadJSON(&connected); err != nil {
		t.Fatalf("first developer failed to read room_connected: %v", err)
	}

	var devJoined Message
	if err := device.ReadJSON(&devJoined); err != nil {
		t.Fatalf("device failed to read dev_connected: %v", err)
	}
	if devJoined.Type != "dev_connected" {
		t.Fatalf("expected dev_connected, got %s", devJoined.Type)
	}

	// Second developer is turned away before the upgrade.
	secondWS, resp, err := websocket.DefaultDialer.Dial(baseWS+"/ws?type=developer&pin="+pin, nil)
	if err == nil {
		secondWS.Close()
		t.Fatal("expected the second developer to be refused")
	}
	if resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 room busy, got %v", resp)
	}

	// The slot frees up once the first developer disconnects.
	first.Close()
	var devGone Message
	if err := device.ReadJSON(&devGone); err != nil {
		t.Fatalf("device failed to read dev_disconnected: %v", err)
	}
	if devGone.Type != "dev_disconnected" {
		t.Fatalf("expected dev_disconnected, got %s", devGone.Type)
	}

	thirdWS, _, err := websocket.DefaultDialer.Dial(baseWS+"/ws?type=developer&pin="+pin, nil)
	if err != nil {
		t.Fatalf("expected the freed room to accept a new developer: %v", err)
	}
	thirdWS.Close()
}

// TestRoomKeyValidation verifies the optional QR secret: a wrong key is refused,
// the right key is admitted, and REQUIRE_ROOM_KEY makes the key mandatory.
func TestRoomKeyValidation(t *testing.T) {
	withConfig(t, func(c *Config) { c.RequireDeviceApproval = true })

	server := httptest.NewServer(setupRouter())
	defer server.Close()
	baseWS := "ws" + strings.TrimPrefix(server.URL, "http")

	device, pin, key := newDevice(t, baseWS)
	defer device.Close()

	conn, resp, err := websocket.DefaultDialer.Dial(baseWS+"/ws?type=developer&pin="+pin+"&key=deadbeefdeadbeef", nil)
	if err == nil {
		conn.Close()
		t.Fatal("expected a wrong room key to be refused")
	}
	if resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 for a wrong key, got %v", resp)
	}

	pinLimiter.Reset("127.0.0.1")

	devWS, _, err := websocket.DefaultDialer.Dial(baseWS+"/ws?type=developer&pin="+pin+"&key="+key, nil)
	if err != nil {
		t.Fatalf("expected the correct room key to be admitted: %v", err)
	}
	dev := NewSafeConn(devWS)
	defer dev.Close()

	var pending Message
	if err := dev.ReadJSON(&pending); err != nil {
		t.Fatalf("developer failed to read auth_pending: %v", err)
	}
	if pending.Type != "auth_pending" {
		t.Fatalf("expected auth_pending with a valid key, got %s", pending.Type)
	}
}

// TestRequireRoomKeyRejectsMissingKey verifies the strict mode where a PIN alone
// is not enough to reach the approval prompt.
func TestRequireRoomKeyRejectsMissingKey(t *testing.T) {
	withConfig(t, func(c *Config) {
		c.RequireDeviceApproval = true
		c.RequireRoomKey = true
	})

	server := httptest.NewServer(setupRouter())
	defer server.Close()
	baseWS := "ws" + strings.TrimPrefix(server.URL, "http")

	device, pin, _ := newDevice(t, baseWS)
	defer device.Close()

	conn, resp, err := websocket.DefaultDialer.Dial(baseWS+"/ws?type=developer&pin="+pin, nil)
	if err == nil {
		conn.Close()
		t.Fatal("expected a missing key to be refused when REQUIRE_ROOM_KEY is set")
	}
	if resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 for a missing key, got %v", resp)
	}
}

// TestUnpairedDeveloperCannotReachRoom verifies that naming a room's PIN inside
// a payload does not route that payload to the device. Only the PIN a socket was
// actually authorized for is used.
func TestUnpairedDeveloperCannotReachRoom(t *testing.T) {
	withConfig(t, func(c *Config) { c.RequireDeviceApproval = true })

	server := httptest.NewServer(setupRouter())
	defer server.Close()
	baseWS := "ws" + strings.TrimPrefix(server.URL, "http")

	device, pin, _ := newDevice(t, baseWS)
	defer device.Close()

	attackerWS, _, err := websocket.DefaultDialer.Dial(baseWS+"/ws?type=developer", nil)
	if err != nil {
		t.Fatalf("attacker dial error: %v", err)
	}
	attacker := NewSafeConn(attackerWS)
	defer attacker.Close()

	if err := attacker.WriteJSON(map[string]interface{}{
		"type": "exec_js",
		"pin":  pin,
		"code": "window.__pwned = true",
	}); err != nil {
		t.Fatalf("attacker write error: %v", err)
	}

	var refusal Message
	if err := attacker.ReadJSON(&refusal); err != nil {
		t.Fatalf("attacker failed to read refusal: %v", err)
	}
	if refusal.Type != "error" || refusal.Reason != "not_paired" {
		t.Fatalf("expected a not_paired error, got %+v", refusal)
	}

	// The device must not have received the injected command.
	_ = device.RawConn().SetReadDeadline(time.Now().Add(250 * time.Millisecond))
	var leaked map[string]interface{}
	if err := device.ReadJSON(&leaked); err == nil {
		t.Fatalf("device received an unauthorized command: %+v", leaked)
	}
	_ = device.RawConn().SetReadDeadline(time.Time{})
}

// TestSessionMaxDurationExpiry verifies the hard session cap closes a room that
// is still actively used, and that both peers are told why.
func TestSessionMaxDurationExpiry(t *testing.T) {
	roomsMu.Lock()
	saved := rooms
	rooms = make(map[string]*Room)
	roomsMu.Unlock()
	defer func() {
		roomsMu.Lock()
		rooms = saved
		roomsMu.Unlock()
	}()

	now := time.Now()
	roomsMu.Lock()
	rooms["700001"] = &Room{
		ID:         "700001",
		CreatedAt:  now.Add(-9 * time.Hour),
		LastActive: now,
	}
	rooms["700002"] = &Room{
		ID:         "700002",
		CreatedAt:  now.Add(-1 * time.Hour),
		LastActive: now,
	}
	roomsMu.Unlock()

	expired := reapExpiredRooms(30*time.Minute, 8*time.Hour)
	if expired != 1 {
		t.Fatalf("expected exactly 1 room past the 8h cap, got %d", expired)
	}

	roomsMu.RLock()
	_, oldExists := rooms["700001"]
	_, youngExists := rooms["700002"]
	roomsMu.RUnlock()

	if oldExists {
		t.Error("a room older than the hard cap must be removed even while active")
	}
	if !youngExists {
		t.Error("a room inside both limits must survive")
	}
}

// TestSessionExpiryNotifiesPeers verifies the session_expired notice reaches a
// live developer socket before the server closes it.
func TestSessionExpiryNotifiesPeers(t *testing.T) {
	withConfig(t, func(c *Config) { c.RequireDeviceApproval = true })

	server := httptest.NewServer(setupRouter())
	defer server.Close()
	baseWS := "ws" + strings.TrimPrefix(server.URL, "http")

	device, pin, _ := newDevice(t, baseWS)
	defer device.Close()

	devWS, _, err := websocket.DefaultDialer.Dial(baseWS+"/ws?type=developer&pin="+pin, nil)
	if err != nil {
		t.Fatalf("developer dial error: %v", err)
	}
	dev := NewSafeConn(devWS)
	defer dev.Close()

	var pending Message
	if err := dev.ReadJSON(&pending); err != nil {
		t.Fatalf("developer failed to read auth_pending: %v", err)
	}
	approveNext(t, device, true)
	var connected Message
	if err := dev.ReadJSON(&connected); err != nil {
		t.Fatalf("developer failed to read room_connected: %v", err)
	}

	// Age the room past the hard cap and run the reaper.
	roomsMu.Lock()
	rooms[pin].CreatedAt = time.Now().Add(-9 * time.Hour)
	roomsMu.Unlock()

	if count := reapExpiredRooms(30*time.Minute, 8*time.Hour); count != 1 {
		t.Fatalf("expected the aged room to be reaped, got %d", count)
	}

	var expiredMsg Message
	if err := dev.ReadJSON(&expiredMsg); err != nil {
		t.Fatalf("developer failed to read session_expired: %v", err)
	}
	if expiredMsg.Type != "session_expired" || expiredMsg.Reason != "max_duration" {
		t.Fatalf("expected session_expired/max_duration, got %+v", expiredMsg)
	}
}

// TestRoomCapacityLimit verifies the global room cap refuses new devices instead
// of letting an attacker exhaust server memory.
func TestRoomCapacityLimit(t *testing.T) {
	roomsMu.Lock()
	saved := rooms
	rooms = make(map[string]*Room)
	for i := 0; i < 3; i++ {
		p := "60000" + string(rune('1'+i))
		rooms[p] = &Room{ID: p, CreatedAt: time.Now(), LastActive: time.Now()}
	}
	roomsMu.Unlock()
	defer func() {
		roomsMu.Lock()
		rooms = saved
		roomsMu.Unlock()
	}()

	withConfig(t, func(c *Config) { c.MaxRooms = 3 })

	server := httptest.NewServer(setupRouter())
	defer server.Close()
	baseWS := "ws" + strings.TrimPrefix(server.URL, "http")

	conn, _, err := websocket.DefaultDialer.Dial(baseWS+"/ws?type=device", nil)
	if err != nil {
		t.Fatalf("device dial error: %v", err)
	}
	device := NewSafeConn(conn)
	defer device.Close()

	var msg Message
	if err := device.ReadJSON(&msg); err != nil {
		t.Fatalf("device failed to read capacity refusal: %v", err)
	}
	if msg.Type != "error" || msg.Reason != "capacity" {
		t.Fatalf("expected a capacity error at the room cap, got %+v", msg)
	}
}

// TestOriginAllowListBlocksForeignDashboards verifies ALLOWED_ORIGINS pinning
// for developer connections.
func TestOriginAllowListBlocksForeignDashboards(t *testing.T) {
	withConfig(t, func(c *Config) {
		c.AllowedOrigins = []string{"https://debug.example.com"}
	})

	server := httptest.NewServer(setupRouter())
	defer server.Close()
	baseWS := "ws" + strings.TrimPrefix(server.URL, "http")

	device, pin, _ := newDevice(t, baseWS)
	defer device.Close()

	headers := http.Header{}
	headers.Set("Origin", "https://evil.example.net")
	conn, resp, err := websocket.DefaultDialer.Dial(baseWS+"/ws?type=developer&pin="+pin, headers)
	if err == nil {
		conn.Close()
		t.Fatal("expected a foreign origin to be refused")
	}
	if resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 for a disallowed origin, got %v", resp)
	}

	allowedHeaders := http.Header{}
	allowedHeaders.Set("Origin", "https://debug.example.com")
	okConn, _, err := websocket.DefaultDialer.Dial(baseWS+"/ws?type=developer&pin="+pin, allowedHeaders)
	if err != nil {
		t.Fatalf("expected the allow-listed origin to connect: %v", err)
	}
	okConn.Close()
}

// TestClientIPTrustsProxyHeadersOnlyWhenConfigured guards the rate limiter
// against spoofed forwarding headers.
func TestClientIPTrustsProxyHeadersOnlyWhenConfigured(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/ws", nil)
	req.RemoteAddr = "203.0.113.7:51234"
	req.Header.Set("CF-Connecting-IP", "198.51.100.9")
	req.Header.Set("X-Forwarded-For", "198.51.100.10, 10.0.0.1")

	withConfig(t, func(c *Config) { c.TrustProxy = false })
	if got := clientIP(req); got != "203.0.113.7" {
		t.Fatalf("with TRUST_PROXY off expected the socket address, got %s", got)
	}

	withConfig(t, func(c *Config) { c.TrustProxy = true })
	if got := clientIP(req); got != "198.51.100.9" {
		t.Fatalf("with TRUST_PROXY on expected the CF-Connecting-IP, got %s", got)
	}
}

// TestMaskingHelpers verifies the redaction used in prompts and logs.
func TestMaskingHelpers(t *testing.T) {
	if got := maskIP("110.23.45.67"); got != "110.23.xx.xx" {
		t.Errorf("maskIP(IPv4) = %s, want 110.23.xx.xx", got)
	}
	if got := maskIP(""); got != "unknown" {
		t.Errorf("maskIP(empty) = %s, want unknown", got)
	}
	if got := maskPin("482910"); got != "482***" {
		t.Errorf("maskPin = %s, want 482***", got)
	}
	if strings.Contains(maskPin("482910"), "910") {
		t.Error("maskPin must not leak the second half of a PIN")
	}
}

// TestDescribeClient verifies the human-readable label shown in the prompt.
func TestDescribeClient(t *testing.T) {
	cases := map[string]string{
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36":   "Chrome on macOS",
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gecko/20100101 Firefox/121.0":                                              "Firefox on Windows",
		"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1": "Safari on iOS",
		"": "Unknown client",
	}
	for ua, want := range cases {
		if got := describeClient(ua); got != want {
			t.Errorf("describeClient(%.40q) = %s, want %s", ua, got, want)
		}
	}
}

// TestGeneratedRoomKeysAreUnique guards against a constant or low-entropy secret.
func TestGeneratedRoomKeysAreUnique(t *testing.T) {
	seen := make(map[string]bool)
	for i := 0; i < 1000; i++ {
		key, err := generateRoomKey()
		if err != nil {
			t.Fatalf("generateRoomKey error: %v", err)
		}
		if len(key) != roomKeyBytes*2 {
			t.Fatalf("key length %d, want %d hex chars", len(key), roomKeyBytes*2)
		}
		if seen[key] {
			t.Fatalf("duplicate room key generated: %s", key)
		}
		seen[key] = true
	}
}
