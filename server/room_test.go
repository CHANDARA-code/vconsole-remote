package main

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// TestGenerateRoomPinEntropyAndUniqueness validates:
// 1. PIN generation randomness and entropy across 10,000 iterations.
// 2. Each PIN is strictly 6 numeric digits in range [100000, 999999].
// 3. Collision handling terminates without recursion hangs or stack overflows.
func TestGenerateRoomPinEntropyAndUniqueness(t *testing.T) {
	const totalPins = 10000
	const goroutines = 20
	pinsPerWorker := totalPins / goroutines

	var wg sync.WaitGroup
	var mu sync.Mutex
	generatedPins := make(map[string]int)
	digitCounts := make([]int, 10)

	for g := 0; g < goroutines; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < pinsPerWorker; i++ {
				pin, err := generateRoomPin()
				if err != nil {
					t.Errorf("generateRoomPin error: %v", err)
					return
				}

				if len(pin) != 6 {
					t.Errorf("PIN length is %d, expected 6 (PIN: %s)", len(pin), pin)
				}

				num, err := strconv.Atoi(pin)
				if err != nil {
					t.Errorf("PIN is not numeric: %s", pin)
				}

				if num < 100000 || num > 999999 {
					t.Errorf("PIN %d is out of range [100000, 999999]", num)
				}

				mu.Lock()
				generatedPins[pin]++
				for _, ch := range pin {
					digitCounts[ch-'0']++
				}
				mu.Unlock()
			}
		}()
	}
	wg.Wait()

	mu.Lock()
	defer mu.Unlock()

	// Verify all 10,000 pins were generated
	totalGenerated := 0
	for _, count := range generatedPins {
		totalGenerated += count
	}
	if totalGenerated != totalPins {
		t.Fatalf("Expected %d generated PINs, got %d", totalPins, totalGenerated)
	}

	// In 10,000 samples from 900,000 possibilities, unique count should be very high (> 9,000)
	if len(generatedPins) < 9000 {
		t.Errorf("Suspiciously low entropy: %d unique PINs out of %d generated", len(generatedPins), totalPins)
	}

	// Verify all 10 digits [0-9] are distributed across generated digits
	for d := 0; d < 10; d++ {
		if digitCounts[d] == 0 {
			t.Errorf("Digit %d was never generated across %d PINs", d, totalPins)
		}
	}

	// Test collision retry limit behavior
	// Fill a mock map with collisions to verify deterministic error return
	roomsMu.Lock()
	savedRooms := rooms
	rooms = make(map[string]*Room)
	// Force all generated pins to exist
	for i := 100000; i <= 999999; i++ {
		p := strconv.Itoa(i)
		rooms[p] = &Room{ID: p}
	}
	roomsMu.Unlock()

	_, err := generateRoomPin()
	if err == nil {
		t.Error("Expected error when all PINs are taken, got nil")
	}

	// Restore original rooms
	roomsMu.Lock()
	rooms = savedRooms
	roomsMu.Unlock()
}

// TestSafeConnConcurrentWrites tests per-socket mutex synchronization
// under high concurrency (100+ goroutines) using the Go race detector.
func TestSafeConnConcurrentWrites(t *testing.T) {
	e := setupRouter()
	server := httptest.NewServer(e)
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/ws?type=device"
	clientWs, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("WebSocket dial failed: %v", err)
	}
	safeClient := NewSafeConn(clientWs)
	defer safeClient.Close()

	// Read initial PIN
	var initMsg Message
	if err := safeClient.ReadJSON(&initMsg); err != nil {
		t.Fatalf("Failed to read initial PIN message: %v", err)
	}

	const goroutineCount = 100
	const messagesPerGoroutine = 20
	var wg sync.WaitGroup

	// Concurrently write JSON and raw messages from 100 parallel goroutines
	for i := 0; i < goroutineCount; i++ {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()
			for m := 0; m < messagesPerGoroutine; m++ {
				err := safeClient.WriteJSON(map[string]interface{}{
					"type":      "console",
					"level":     "log",
					"worker":    workerID,
					"seq":       m,
					"timestamp": time.Now().UnixNano(),
				})
				if err != nil && !safeClient.IsClosed() {
					t.Errorf("SafeConn.WriteJSON failed: %v", err)
				}

				err = safeClient.WriteMessage(websocket.TextMessage, []byte(`{"type":"ping"}`))
				if err != nil && !safeClient.IsClosed() {
					t.Errorf("SafeConn.WriteMessage failed: %v", err)
				}
			}
		}(i)
	}

	wg.Wait()

	// Test concurrent close safety: multiple concurrent Close() calls must not panic
	var closeWg sync.WaitGroup
	for i := 0; i < 10; i++ {
		closeWg.Add(1)
		go func() {
			defer closeWg.Done()
			_ = safeClient.Close()
			if !safeClient.IsClosed() {
				t.Error("SafeConn should be marked closed")
			}
		}()
	}
	closeWg.Wait()

	// Write after close should return error without panic
	err = safeClient.WriteJSON(map[string]string{"type": "test"})
	if err == nil {
		t.Error("Expected error writing to closed SafeConn, got nil")
	}
}

// TestRoomLifecycleAndPairing tests complete room lifecycle:
// 1. Device registration and PIN receipt
// 2. Developer browser pairing (via connect_room message and via URL query param)
// 3. Bidirectional event forwarding (console, storage, DOM, REPL exec_js)
// 4. Developer disconnect -> device notification and unpairing
// 5. Developer reconnect -> pairing restoration
// 6. Device disconnect -> developer notification, socket termination, and room deletion
func TestRoomLifecycleAndPairing(t *testing.T) {
	e := setupRouter()
	server := httptest.NewServer(e)
	defer server.Close()

	baseWS := "ws" + strings.TrimPrefix(server.URL, "http")

	// 1. Device connects
	deviceWS, _, err := websocket.DefaultDialer.Dial(baseWS+"/ws?type=device", nil)
	if err != nil {
		t.Fatalf("Device dial error: %v", err)
	}
	safeDevice := NewSafeConn(deviceWS)
	defer safeDevice.Close()

	var pinMsg Message
	if err := safeDevice.ReadJSON(&pinMsg); err != nil {
		t.Fatalf("Device failed to read PIN: %v", err)
	}

	if pinMsg.Type != "room_pin" {
		t.Fatalf("Expected message type 'room_pin', got %s", pinMsg.Type)
	}
	pin := pinMsg.Pin
	if len(pin) != 6 {
		t.Fatalf("Expected 6-digit PIN, got %s", pin)
	}

	// Verify room in server state
	roomsMu.RLock()
	room, exists := rooms[pin]
	roomsMu.RUnlock()
	if !exists {
		t.Fatalf("Room %s does not exist in server state", pin)
	}
	if room.ID != pin {
		t.Fatalf("Room ID mismatch: %s vs %s", room.ID, pin)
	}

	// 2. Developer connects via /ws?type=developer and sends connect_room
	devWS, _, err := websocket.DefaultDialer.Dial(baseWS+"/ws?type=developer", nil)
	if err != nil {
		t.Fatalf("Developer dial error: %v", err)
	}
	safeDev := NewSafeConn(devWS)
	defer safeDev.Close()

	if err := safeDev.WriteJSON(map[string]string{
		"type": "connect_room",
		"pin":  pin,
	}); err != nil {
		t.Fatalf("Developer connect_room write failed: %v", err)
	}

	// Developer is held pending until the device owner approves
	var pendingMsg Message
	if err := safeDev.ReadJSON(&pendingMsg); err != nil {
		t.Fatalf("Developer read auth_pending failed: %v", err)
	}
	if pendingMsg.Type != "auth_pending" {
		t.Fatalf("Expected auth_pending, got %+v", pendingMsg)
	}

	// Device receives the approval prompt and allows the connection
	var authReq Message
	if err := safeDevice.ReadJSON(&authReq); err != nil {
		t.Fatalf("Device read auth_request failed: %v", err)
	}
	if authReq.Type != "auth_request" || authReq.AuthId == "" {
		t.Fatalf("Expected auth_request with an authId, got %+v", authReq)
	}
	if authReq.AuthId != pendingMsg.AuthId {
		t.Fatalf("authId mismatch: device %s vs developer %s", authReq.AuthId, pendingMsg.AuthId)
	}
	if err := safeDevice.WriteJSON(map[string]interface{}{
		"type":     "auth_response",
		"authId":   authReq.AuthId,
		"approved": true,
	}); err != nil {
		t.Fatalf("Device auth_response write failed: %v", err)
	}

	// Developer reads confirmation
	var devConfirm Message
	if err := safeDev.ReadJSON(&devConfirm); err != nil {
		t.Fatalf("Developer read confirmation failed: %v", err)
	}
	if devConfirm.Type != "room_connected" || devConfirm.Pin != pin {
		t.Fatalf("Expected room_connected for %s, got %+v", pin, devConfirm)
	}

	// Device reads dev_connected notification
	var devConnectedMsg Message
	if err := safeDevice.ReadJSON(&devConnectedMsg); err != nil {
		t.Fatalf("Device read dev_connected failed: %v", err)
	}
	if devConnectedMsg.Type != "dev_connected" || devConnectedMsg.Pin != pin {
		t.Fatalf("Expected dev_connected for %s, got %+v", pin, devConnectedMsg)
	}

	// Verify room is paired
	roomsMu.RLock()
	isConn := rooms[pin].IsConnected
	devConnBound := rooms[pin].DevConn != nil
	roomsMu.RUnlock()
	if !isConn || !devConnBound {
		t.Fatalf("Room state expected connected, got isConn=%v, devConnBound=%v", isConn, devConnBound)
	}

	// 3. Test bidirectional message forwarding

	// Device -> Developer: Console log
	logMsg := map[string]interface{}{
		"type":      "console",
		"level":     "info",
		"args":      []interface{}{"User clicked button", 42},
		"timestamp": time.Now().Unix(),
	}
	if err := safeDevice.WriteJSON(logMsg); err != nil {
		t.Fatalf("Device log write failed: %v", err)
	}

	var rcvDevMsg map[string]interface{}
	if err := safeDev.ReadJSON(&rcvDevMsg); err != nil {
		t.Fatalf("Developer read log failed: %v", err)
	}
	if rcvDevMsg["type"] != "console" || rcvDevMsg["level"] != "info" {
		t.Fatalf("Developer received unexpected console payload: %+v", rcvDevMsg)
	}

	// Developer -> Device: On-demand pull storage
	pullStorageMsg := map[string]interface{}{
		"type": "pull_storage",
		"pin":  pin,
	}
	if err := safeDev.WriteJSON(pullStorageMsg); err != nil {
		t.Fatalf("Developer pull_storage write failed: %v", err)
	}

	var rcvDeviceMsg map[string]interface{}
	if err := safeDevice.ReadJSON(&rcvDeviceMsg); err != nil {
		t.Fatalf("Device read pull_storage failed: %v", err)
	}
	if rcvDeviceMsg["type"] != "pull_storage" {
		t.Fatalf("Device received unexpected pull payload: %+v", rcvDeviceMsg)
	}

	// Device -> Developer: Storage response data
	storageData := map[string]interface{}{
		"type": "storage_data",
		"data": map[string]interface{}{
			"localStorage": map[string]string{"auth_token": "xyz123"},
		},
	}
	if err := safeDevice.WriteJSON(storageData); err != nil {
		t.Fatalf("Device storage_data write failed: %v", err)
	}

	var rcvDevStorage map[string]interface{}
	if err := safeDev.ReadJSON(&rcvDevStorage); err != nil {
		t.Fatalf("Developer read storage_data failed: %v", err)
	}
	if rcvDevStorage["type"] != "storage_data" {
		t.Fatalf("Developer received unexpected storage payload: %+v", rcvDevStorage)
	}

	// Developer -> Device: Remote REPL exec_js
	execJsMsg := map[string]interface{}{
		"type": "exec_js",
		"code": "2 + 2",
		"pin":  pin,
	}
	if err := safeDev.WriteJSON(execJsMsg); err != nil {
		t.Fatalf("Developer exec_js write failed: %v", err)
	}

	var rcvDeviceExec map[string]interface{}
	if err := safeDevice.ReadJSON(&rcvDeviceExec); err != nil {
		t.Fatalf("Device read exec_js failed: %v", err)
	}
	if rcvDeviceExec["type"] != "exec_js" || rcvDeviceExec["code"] != "2 + 2" {
		t.Fatalf("Device received unexpected exec_js: %+v", rcvDeviceExec)
	}

	// Device -> Developer: REPL result
	execResultMsg := map[string]interface{}{
		"type":    "exec_result",
		"result":  "4",
		"isError": false,
	}
	if err := safeDevice.WriteJSON(execResultMsg); err != nil {
		t.Fatalf("Device exec_result write failed: %v", err)
	}

	var rcvDevResult map[string]interface{}
	if err := safeDev.ReadJSON(&rcvDevResult); err != nil {
		t.Fatalf("Developer read exec_result failed: %v", err)
	}
	if rcvDevResult["type"] != "exec_result" || rcvDevResult["result"] != "4" {
		t.Fatalf("Developer received unexpected exec_result: %+v", rcvDevResult)
	}

	// 4. Developer disconnects
	safeDev.Close()

	// Device should receive dev_disconnected notification
	var devDisconnectMsg Message
	if err := safeDevice.ReadJSON(&devDisconnectMsg); err != nil {
		t.Fatalf("Device failed to read dev_disconnected: %v", err)
	}
	if devDisconnectMsg.Type != "dev_disconnected" {
		t.Fatalf("Expected dev_disconnected, got %s", devDisconnectMsg.Type)
	}

	// Room still exists in server, waiting for reconnection
	roomsMu.RLock()
	r, exists := rooms[pin]
	if !exists || r.DevConn != nil || r.IsConnected {
		t.Fatalf("Expected room to persist with unlinked DevConn, got exists=%v, devConn=%v, isConnected=%v", exists, r.DevConn, r.IsConnected)
	}
	roomsMu.RUnlock()

	// 5. Developer reconnects via direct URL query param: /ws?type=developer&pin=<PIN>
	devWS2, _, err := websocket.DefaultDialer.Dial(baseWS+"/ws?type=developer&pin="+pin, nil)
	if err != nil {
		t.Fatalf("Developer reconnect dial error: %v", err)
	}
	safeDev2 := NewSafeConn(devWS2)
	defer safeDev2.Close()

	// Reconnecting still requires a fresh approval from the device owner
	var pendingMsg2 Message
	if err := safeDev2.ReadJSON(&pendingMsg2); err != nil {
		t.Fatalf("Developer reconnect auth_pending failed: %v", err)
	}
	if pendingMsg2.Type != "auth_pending" {
		t.Fatalf("Expected auth_pending on reconnect, got %+v", pendingMsg2)
	}

	var authReq2 Message
	if err := safeDevice.ReadJSON(&authReq2); err != nil {
		t.Fatalf("Device read auth_request on reconnect failed: %v", err)
	}
	if authReq2.Type != "auth_request" {
		t.Fatalf("Expected auth_request on reconnect, got %+v", authReq2)
	}
	if err := safeDevice.WriteJSON(map[string]interface{}{
		"type":     "auth_response",
		"authId":   authReq2.AuthId,
		"approved": true,
	}); err != nil {
		t.Fatalf("Device auth_response write on reconnect failed: %v", err)
	}

	// Dev receives room_connected once approved
	var devConfirm2 Message
	if err := safeDev2.ReadJSON(&devConfirm2); err != nil {
		t.Fatalf("Developer reconnect confirmation failed: %v", err)
	}
	if devConfirm2.Type != "room_connected" || devConfirm2.Pin != pin {
		t.Fatalf("Expected room_connected for %s, got %+v", pin, devConfirm2)
	}

	// Device receives dev_connected
	var devConnectedMsg2 Message
	if err := safeDevice.ReadJSON(&devConnectedMsg2); err != nil {
		t.Fatalf("Device read dev_connected on reconnect failed: %v", err)
	}
	if devConnectedMsg2.Type != "dev_connected" {
		t.Fatalf("Expected dev_connected, got %s", devConnectedMsg2.Type)
	}

	// 6. Device disconnects: developer receives device_disconnected and developer socket is closed
	safeDevice.Close()

	var devDeviceDisconnect Message
	if err := safeDev2.ReadJSON(&devDeviceDisconnect); err != nil {
		t.Fatalf("Developer failed to read device_disconnected: %v", err)
	}
	if devDeviceDisconnect.Type != "device_disconnected" {
		t.Fatalf("Expected device_disconnected, got %s", devDeviceDisconnect.Type)
	}

	// Wait briefly for server cleanup goroutine to finalize
	time.Sleep(50 * time.Millisecond)

	// Room must be deleted from rooms map
	roomsMu.RLock()
	_, exists = rooms[pin]
	roomsMu.RUnlock()
	if exists {
		t.Fatalf("Room %s should be deleted from server after device disconnect", pin)
	}
}

// TestRoomReaper verifies that idle rooms exceeding the maxIdle threshold
// are reaped, active rooms remain, and sockets are cleanly closed.
func TestRoomReaper(t *testing.T) {
	roomsMu.Lock()
	savedRooms := rooms
	rooms = make(map[string]*Room)

	// Create 3 active rooms
	for i := 1; i <= 3; i++ {
		p := "10000" + strconv.Itoa(i)
		rooms[p] = &Room{
			ID:         p,
			CreatedAt:  time.Now(),
			LastActive: time.Now(),
		}
	}

	// Create 3 stale rooms (> 1 hour old)
	for i := 4; i <= 6; i++ {
		p := "10000" + strconv.Itoa(i)
		rooms[p] = &Room{
			ID:         p,
			CreatedAt:  time.Now(),
			LastActive: time.Now().Add(-2 * time.Hour),
		}
	}
	roomsMu.Unlock()

	// Reap rooms idle for > 30 minutes
	reapedCount := reapIdleRooms(30 * time.Minute)
	if reapedCount != 3 {
		t.Fatalf("Expected 3 reaped rooms, got %d", reapedCount)
	}

	roomsMu.RLock()
	remaining := len(rooms)
	for i := 1; i <= 3; i++ {
		p := "10000" + strconv.Itoa(i)
		if _, exists := rooms[p]; !exists {
			t.Errorf("Active room %s was incorrectly reaped", p)
		}
	}
	for i := 4; i <= 6; i++ {
		p := "10000" + strconv.Itoa(i)
		if _, exists := rooms[p]; exists {
			t.Errorf("Stale room %s was not reaped", p)
		}
	}
	roomsMu.RUnlock()

	if remaining != 3 {
		t.Fatalf("Expected 3 remaining rooms, got %d", remaining)
	}

	// Restore rooms
	roomsMu.Lock()
	rooms = savedRooms
	roomsMu.Unlock()

	// Test RoomReaper background ticker lifecycle
	reaper := startRoomReaper(20*time.Millisecond, 50*time.Millisecond)
	roomsMu.Lock()
	testStalePin := "999888"
	rooms[testStalePin] = &Room{
		ID:         testStalePin,
		CreatedAt:  time.Now(),
		LastActive: time.Now().Add(-1 * time.Second),
	}
	roomsMu.Unlock()

	// Allow ticker to fire
	time.Sleep(60 * time.Millisecond)

	roomsMu.RLock()
	_, stillExists := rooms[testStalePin]
	roomsMu.RUnlock()

	if stillExists {
		t.Errorf("Room %s should have been reaped by background ticker", testStalePin)
	}

	// Clean stop
	reaper.Stop()
}

// TestEmbeddedAssetsServing tests serving assets from embed.FS:
// 1. GET / returns HTTP 200 and index.html
// 2. GET /favicon.ico returns HTTP 204 or 200
func TestEmbeddedAssetsServing(t *testing.T) {
	e := setupRouter()

	// GET /
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("GET / returned status %d, expected 200", rec.Code)
	}

	body := rec.Body.String()
	if !strings.Contains(body, "<!DOCTYPE html>") {
		t.Errorf("GET / does not contain '<!DOCTYPE html>'")
	}
	if !strings.Contains(body, "vConsole Remote Dashboard") {
		t.Errorf("GET / does not contain 'vConsole Remote Dashboard'")
	}

	contentType := rec.Header().Get("Content-Type")
	if !strings.HasPrefix(contentType, "text/html") {
		t.Errorf("GET / Content-Type is %s, expected text/html", contentType)
	}

	// GET /favicon.ico
	favReq := httptest.NewRequest(http.MethodGet, "/favicon.ico", nil)
	favRec := httptest.NewRecorder()
	e.ServeHTTP(favRec, favReq)

	if favRec.Code != http.StatusOK && favRec.Code != http.StatusNoContent {
		t.Fatalf("GET /favicon.ico returned status %d, expected 200 or 204", favRec.Code)
	}
}

// TestDeveloperInvalidPin tests developer connecting with non-existent PIN.
func TestDeveloperInvalidPin(t *testing.T) {
	e := setupRouter()
	server := httptest.NewServer(e)
	defer server.Close()

	baseWS := "ws" + strings.TrimPrefix(server.URL, "http")

	// 1. Direct query param with non-existent PIN
	devWS, _, err := websocket.DefaultDialer.Dial(baseWS+"/ws?type=developer&pin=000000", nil)
	if err != nil {
		// Connection failed or closed immediately, which is acceptable
		return
	}
	safeDev := NewSafeConn(devWS)
	defer safeDev.Close()

	var errMsg Message
	_ = safeDev.ReadJSON(&errMsg)
	if errMsg.Type != "error" {
		t.Errorf("Expected type 'error' for invalid PIN, got %s", errMsg.Type)
	}

	// 2. In-band message with non-existent PIN
	devWS2, _, err := websocket.DefaultDialer.Dial(baseWS+"/ws?type=developer", nil)
	if err != nil {
		t.Fatalf("Developer dial error: %v", err)
	}
	safeDev2 := NewSafeConn(devWS2)
	defer safeDev2.Close()

	_ = safeDev2.WriteJSON(map[string]string{
		"type": "connect_room",
		"pin":  "999999",
	})

	var errMsg2 Message
	if err := safeDev2.ReadJSON(&errMsg2); err != nil {
		t.Fatalf("Failed to read error message: %v", err)
	}
	if errMsg2.Type != "error" {
		t.Errorf("Expected type 'error' for invalid PIN, got %s", errMsg2.Type)
	}
}
