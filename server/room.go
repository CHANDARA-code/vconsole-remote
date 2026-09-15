package main

import (
	"crypto/rand"
	"errors"
	"fmt"
	"log"
	"math/big"
	"strconv"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Room represents a real-time debugging session connecting a mobile device and a developer.
type Room struct {
	ID          string
	Key         string
	DeviceConn  *SafeConn
	DevConn     *SafeConn
	CreatedAt   time.Time
	LastActive  time.Time
	IsConnected bool
	PendingAuth *PendingAuth
}

// PendingAuth is a developer connection held in limbo while the mobile device
// owner decides whether to admit it. No room traffic reaches the developer
// socket until Result receives true.
type PendingAuth struct {
	ID     string
	Conn   *SafeConn
	Result chan bool
}

// Message represents a message exchanged between client, server, and developer.
type Message struct {
	Type       string      `json:"type"`
	Pin        string      `json:"pin,omitempty"`
	Key        string      `json:"key,omitempty"`
	Message    interface{} `json:"message,omitempty"`
	Timestamp  int64       `json:"timestamp,omitempty"`
	RequestId  string      `json:"requestId,omitempty"`
	Request    interface{} `json:"request,omitempty"`
	Body       interface{} `json:"body,omitempty"`
	Storage    interface{} `json:"storage,omitempty"`
	Tree       interface{} `json:"tree,omitempty"`
	Screenshot interface{} `json:"screenshot,omitempty"`
	Code       string      `json:"code,omitempty"`
	Result     interface{} `json:"result,omitempty"`
	Level      string      `json:"level,omitempty"`
	Args       interface{} `json:"args,omitempty"`
	Data       interface{} `json:"data,omitempty"`
	IsError    bool        `json:"isError,omitempty"`
	AuthId     string      `json:"authId,omitempty"`
	Client     interface{} `json:"client,omitempty"`
	ExpiresIn  int         `json:"expiresIn,omitempty"`
	Reason     string      `json:"reason,omitempty"`
}

var (
	rooms   = make(map[string]*Room)
	roomsMu sync.RWMutex
)

const maxPinRetries = 10

// accessVerdict is the outcome of validating a developer's pairing credentials.
type accessVerdict int

const (
	accessOK accessVerdict = iota
	accessNotFound
	accessBadKey
	accessBusy
)

func (v accessVerdict) reason() string {
	switch v {
	case accessNotFound:
		return "room_not_found"
	case accessBadKey:
		return "invalid_key"
	case accessBusy:
		return "room_busy"
	default:
		return ""
	}
}

func (v accessVerdict) message() string {
	switch v {
	case accessNotFound:
		return "Room not found or expired"
	case accessBadKey:
		return "Invalid or missing room key"
	case accessBusy:
		return "Room is already in use by another developer"
	default:
		return ""
	}
}

// devSession carries the identifying metadata shown to the device owner in the
// approval prompt.
type devSession struct {
	Key       string
	ClientIP  string
	UserAgent string
}

// generateRoomPin produces a cryptographically secure 6-digit numeric PIN [100000, 999999]
// using crypto/rand with finite collision retry handling to avoid recursion and hangs.
func generateRoomPin() (string, error) {
	for attempt := 0; attempt < maxPinRetries; attempt++ {
		// Uniform random integer in range [0, 900000)
		n, err := rand.Int(rand.Reader, big.NewInt(900000))
		if err != nil {
			return "", fmt.Errorf("crypto/rand error: %w", err)
		}
		// Offset by 100000 guarantees exactly 6 digits (100000 - 999999)
		pin := strconv.FormatInt(n.Int64()+100000, 10)

		roomsMu.RLock()
		_, exists := rooms[pin]
		roomsMu.RUnlock()

		if !exists {
			return pin, nil
		}
	}
	return "", errors.New("failed to generate unique room PIN: collision retry limit exceeded")
}

// checkRoomAccess validates pairing credentials without reserving anything. It
// runs before the WebSocket upgrade so abusive requests get a real HTTP status.
func checkRoomAccess(pin, key string) accessVerdict {
	roomsMu.RLock()
	defer roomsMu.RUnlock()

	room, exists := rooms[pin]
	if !exists {
		return accessNotFound
	}
	if cfg().RequireRoomKey && key == "" {
		return accessBadKey
	}
	if key != "" && !constantTimeEquals(key, room.Key) {
		return accessBadKey
	}
	if room.DevConn != nil || room.PendingAuth != nil {
		return accessBusy
	}
	return accessOK
}

// reservePendingAuth re-validates credentials and atomically claims the room's
// single developer slot. Re-checking after the upgrade closes the race between
// the pre-upgrade check and the actual handshake.
func reservePendingAuth(pin, key, authID string, conn *SafeConn) (*SafeConn, *PendingAuth, accessVerdict) {
	roomsMu.Lock()
	defer roomsMu.Unlock()

	room, exists := rooms[pin]
	if !exists {
		return nil, nil, accessNotFound
	}
	if cfg().RequireRoomKey && key == "" {
		return nil, nil, accessBadKey
	}
	if key != "" && !constantTimeEquals(key, room.Key) {
		return nil, nil, accessBadKey
	}
	if room.DevConn != nil || room.PendingAuth != nil {
		return nil, nil, accessBusy
	}

	pending := &PendingAuth{
		ID:     authID,
		Conn:   conn,
		Result: make(chan bool, 1),
	}
	room.PendingAuth = pending
	room.LastActive = time.Now()

	return room.DeviceConn, pending, accessOK
}

// clearPendingAuth releases a pending slot that was never promoted.
func clearPendingAuth(pin string, pending *PendingAuth) {
	roomsMu.Lock()
	defer roomsMu.Unlock()
	if room, exists := rooms[pin]; exists && room.PendingAuth == pending {
		room.PendingAuth = nil
	}
}

// promoteDeveloper converts an approved pending connection into the room's
// active developer socket, returning the device socket to notify.
func promoteDeveloper(pin string, pending *PendingAuth, conn *SafeConn) (*SafeConn, bool) {
	roomsMu.Lock()
	defer roomsMu.Unlock()

	room, exists := rooms[pin]
	if !exists {
		return nil, false
	}
	if room.PendingAuth == pending {
		room.PendingAuth = nil
	}
	if room.DevConn != nil {
		return nil, false
	}

	room.DevConn = conn
	room.IsConnected = true
	room.LastActive = time.Now()

	return room.DeviceConn, true
}

// releaseDeveloper unbinds a developer socket from its room, returning the
// device socket so it can be told the session ended.
func releaseDeveloper(pin string, conn *SafeConn) *SafeConn {
	roomsMu.Lock()
	defer roomsMu.Unlock()

	room, exists := rooms[pin]
	if !exists {
		return nil
	}
	if room.DevConn != conn {
		return nil
	}

	room.DevConn = nil
	room.IsConnected = false
	room.LastActive = time.Now()

	return room.DeviceConn
}

// authorizedDeviceConn returns the device socket only when conn is the room's
// approved developer. Every developer-to-device command routes through this, so
// an unpaired socket can never reach a room by naming its PIN in a payload.
func authorizedDeviceConn(pin string, conn *SafeConn) *SafeConn {
	roomsMu.Lock()
	defer roomsMu.Unlock()

	room, exists := rooms[pin]
	if !exists || room.DevConn != conn {
		return nil
	}
	room.LastActive = time.Now()

	return room.DeviceConn
}

// handleDeviceConnection handles WebSocket connections from mobile devices running vConsole.
func handleDeviceConnection(rawConn *websocket.Conn) error {
	safeConn := NewSafeConn(rawConn)
	defer safeConn.Close()

	roomsMu.RLock()
	roomCount := len(rooms)
	roomsMu.RUnlock()
	if cfg().MaxRooms > 0 && roomCount >= cfg().MaxRooms {
		log.Printf("[Device] Rejected: room capacity %d reached", cfg().MaxRooms)
		_ = safeConn.WriteJSON(Message{
			Type:      "error",
			Reason:    "capacity",
			Message:   "Server is at room capacity, try again later",
			Timestamp: time.Now().Unix(),
		})
		return nil
	}

	pin, err := generateRoomPin()
	if err != nil {
		log.Printf("[Device] Failed to generate PIN: %v", err)
		_ = safeConn.WriteJSON(Message{
			Type:      "error",
			Message:   "Failed to allocate room PIN",
			Timestamp: time.Now().Unix(),
		})
		return nil
	}

	key, err := generateRoomKey()
	if err != nil {
		log.Printf("[Device] Failed to generate room key: %v", err)
		_ = safeConn.WriteJSON(Message{
			Type:      "error",
			Message:   "Failed to allocate room key",
			Timestamp: time.Now().Unix(),
		})
		return nil
	}

	now := time.Now()
	room := &Room{
		ID:         pin,
		Key:        key,
		DeviceConn: safeConn,
		CreatedAt:  now,
		LastActive: now,
	}

	roomsMu.Lock()
	rooms[pin] = room
	roomsMu.Unlock()

	log.Printf("[Device] Registered room: %s", maskPin(pin))

	// Send initial PIN and room key to device outside roomsMu lock
	if err := safeConn.WriteJSON(Message{
		Type:      "room_pin",
		Pin:       pin,
		Key:       key,
		Timestamp: time.Now().Unix(),
	}); err != nil {
		roomsMu.Lock()
		delete(rooms, pin)
		roomsMu.Unlock()
		return err
	}

	// Defer cleanup when device disconnects: reject any pending approval, notify
	// developer, close developer socket, delete room
	defer func() {
		log.Printf("[Device] Disconnected from room: %s", maskPin(pin))
		var devConnToNotify *SafeConn
		var pending *PendingAuth

		roomsMu.Lock()
		if r, exists := rooms[pin]; exists {
			devConnToNotify = r.DevConn
			pending = r.PendingAuth
			delete(rooms, pin)
		}
		roomsMu.Unlock()

		if pending != nil {
			select {
			case pending.Result <- false:
			default:
			}
		}

		if devConnToNotify != nil {
			_ = devConnToNotify.WriteJSON(Message{
				Type:      "device_disconnected",
				Message:   "Device has disconnected",
				Timestamp: time.Now().Unix(),
			})
			_ = devConnToNotify.Close()
		}
	}()

	// Event loop: forward all device messages to developer browser
	for {
		var rawMsg map[string]interface{}
		if err := safeConn.ReadJSON(&rawMsg); err != nil {
			log.Printf("[Device] %s connection read error: %v", maskPin(pin), err)
			break
		}

		// Authorization verdicts are consumed by the server, never forwarded
		if msgType, _ := rawMsg["type"].(string); msgType == "auth_response" {
			resolveAuthResponse(pin, rawMsg)
			continue
		}

		var devConn *SafeConn
		roomsMu.Lock()
		if r, exists := rooms[pin]; exists {
			r.LastActive = time.Now()
			devConn = r.DevConn
		}
		roomsMu.Unlock()

		// Forward device message (console, network, storage, screenshot, dom) outside lock
		if devConn != nil {
			if err := devConn.WriteJSON(rawMsg); err != nil {
				log.Printf("[Device] Error forwarding message to developer in room %s: %v", maskPin(pin), err)
			}
		}
	}

	return nil
}

// resolveAuthResponse delivers the device owner's Allow/Reject decision to the
// developer goroutine waiting on it.
func resolveAuthResponse(pin string, rawMsg map[string]interface{}) {
	authID, _ := rawMsg["authId"].(string)
	approved, _ := rawMsg["approved"].(bool)

	roomsMu.Lock()
	defer roomsMu.Unlock()

	room, exists := rooms[pin]
	if !exists || room.PendingAuth == nil {
		return
	}
	if authID != "" && room.PendingAuth.ID != authID {
		return
	}

	select {
	case room.PendingAuth.Result <- approved:
	default:
	}
}

// devMessage is one frame read from a developer socket, or the read error that
// ended the stream.
type devMessage struct {
	data map[string]interface{}
	err  error
}

// startDevReadPump owns the single reader for a developer connection. Routing
// every frame through one channel lets the pairing handshake notice a developer
// who disconnects mid-approval instead of holding the room until timeout.
func startDevReadPump(conn *SafeConn) <-chan devMessage {
	ch := make(chan devMessage, 16)
	go func() {
		defer close(ch)
		for {
			var raw map[string]interface{}
			if err := conn.ReadJSON(&raw); err != nil {
				ch <- devMessage{err: err}
				return
			}
			ch <- devMessage{data: raw}
		}
	}()
	return ch
}

// pairDeveloper runs the full admission handshake for one room: credential
// validation, single-occupancy reservation, and the device owner's approval.
// It returns the paired PIN, or ok=false when admission was refused.
func pairDeveloper(safeConn *SafeConn, msgs <-chan devMessage, pin, key string, meta devSession) (string, bool) {
	if len(pin) != 6 || !isNumeric(pin) {
		_ = safeConn.WriteJSON(Message{
			Type:      "error",
			Reason:    "invalid_pin",
			Message:   "Room PIN must be exactly 6 digits",
			Timestamp: time.Now().Unix(),
		})
		pinLimiter.RecordFailure(meta.ClientIP)
		return "", false
	}

	if allowed, retryIn := pinLimiter.Allowed(meta.ClientIP); !allowed {
		_ = safeConn.WriteJSON(Message{
			Type:      "rate_limited",
			Reason:    "too_many_attempts",
			Message:   fmt.Sprintf("Too many failed attempts. Try again in %d seconds", int(retryIn.Seconds())+1),
			Timestamp: time.Now().Unix(),
		})
		return "", false
	}

	authID, err := generateRoomKey()
	if err != nil {
		_ = safeConn.WriteJSON(Message{
			Type:      "error",
			Message:   "Failed to start authorization",
			Timestamp: time.Now().Unix(),
		})
		return "", false
	}

	deviceConn, pending, verdict := reservePendingAuth(pin, key, authID, safeConn)
	if verdict != accessOK {
		if verdict != accessBusy {
			pinLimiter.RecordFailure(meta.ClientIP)
		}
		_ = safeConn.WriteJSON(Message{
			Type:      "error",
			Reason:    verdict.reason(),
			Message:   verdict.message(),
			Timestamp: time.Now().Unix(),
		})
		return "", false
	}

	if !cfg().RequireDeviceApproval {
		return finishPairing(safeConn, pin, pending, meta)
	}

	_ = safeConn.WriteJSON(Message{
		Type:      "auth_pending",
		Pin:       pin,
		AuthId:    authID,
		ExpiresIn: int(cfg().AuthTimeout.Seconds()),
		Message:   "Waiting for approval on the mobile device",
		Timestamp: time.Now().Unix(),
	})

	if deviceConn != nil {
		_ = deviceConn.WriteJSON(Message{
			Type:      "auth_request",
			AuthId:    authID,
			ExpiresIn: int(cfg().AuthTimeout.Seconds()),
			Client: map[string]interface{}{
				"description": describeClient(meta.UserAgent),
				"ip":          maskIP(meta.ClientIP),
				"userAgent":   meta.UserAgent,
				"requestedAt": time.Now().Unix(),
			},
			Timestamp: time.Now().Unix(),
		})
	}

	timer := time.NewTimer(cfg().AuthTimeout)
	defer timer.Stop()

	for {
		select {
		case approved := <-pending.Result:
			if !approved {
				clearPendingAuth(pin, pending)
				pinLimiter.RecordFailure(meta.ClientIP)
				log.Printf("[Developer] Authorization rejected for room %s", maskPin(pin))
				_ = safeConn.WriteJSON(Message{
					Type:      "auth_rejected",
					Reason:    "rejected_by_device",
					Message:   "The device owner rejected this connection",
					Timestamp: time.Now().Unix(),
				})
				_ = safeConn.Close()
				return "", false
			}
			return finishPairing(safeConn, pin, pending, meta)

		case msg, ok := <-msgs:
			// The developer vanished (or sent noise) while awaiting approval.
			if !ok || msg.err != nil {
				clearPendingAuth(pin, pending)
				notifyAuthCancelled(pin, authID)
				return "", false
			}

		case <-timer.C:
			clearPendingAuth(pin, pending)
			notifyAuthCancelled(pin, authID)
			log.Printf("[Developer] Authorization timed out for room %s", maskPin(pin))
			_ = safeConn.WriteJSON(Message{
				Type:      "auth_timeout",
				Reason:    "approval_timeout",
				Message:   "The device did not respond to the authorization request",
				Timestamp: time.Now().Unix(),
			})
			_ = safeConn.Close()
			return "", false
		}
	}
}

// finishPairing binds an admitted developer to the room and announces the pairing.
func finishPairing(safeConn *SafeConn, pin string, pending *PendingAuth, meta devSession) (string, bool) {
	deviceConn, ok := promoteDeveloper(pin, pending, safeConn)
	if !ok {
		_ = safeConn.WriteJSON(Message{
			Type:      "error",
			Reason:    "room_unavailable",
			Message:   "Room is no longer available",
			Timestamp: time.Now().Unix(),
		})
		return "", false
	}

	pinLimiter.Reset(meta.ClientIP)
	log.Printf("[Developer] Paired with room %s", maskPin(pin))

	_ = safeConn.WriteJSON(Message{
		Type:      "room_connected",
		Pin:       pin,
		Timestamp: time.Now().Unix(),
	})

	if deviceConn != nil {
		_ = deviceConn.WriteJSON(Message{
			Type:      "dev_connected",
			Pin:       pin,
			Timestamp: time.Now().Unix(),
		})
	}

	return pin, true
}

// notifyAuthCancelled tells the device to dismiss an approval prompt that is no
// longer actionable.
func notifyAuthCancelled(pin, authID string) {
	roomsMu.RLock()
	var deviceConn *SafeConn
	if room, exists := rooms[pin]; exists {
		deviceConn = room.DeviceConn
	}
	roomsMu.RUnlock()

	if deviceConn != nil {
		_ = deviceConn.WriteJSON(Message{
			Type:      "auth_cancelled",
			AuthId:    authID,
			Timestamp: time.Now().Unix(),
		})
	}
}

func isNumeric(s string) bool {
	for _, ch := range s {
		if ch < '0' || ch > '9' {
			return false
		}
	}
	return len(s) > 0
}

// handleDeveloperConnection handles WebSocket connections from desktop developer browsers.
// Supports both immediate query parameter pairing (/ws?type=developer&pin=123456&key=...)
// and in-band message pairing ({"type": "connect_room", "pin": "123456", "key": "..."}).
func handleDeveloperConnection(rawConn *websocket.Conn, initialPin string, meta devSession) error {
	safeConn := NewSafeConn(rawConn)
	defer safeConn.Close()

	msgs := startDevReadPump(safeConn)
	var currentPin string

	// Defer cleanup on developer disconnect: unbind DevConn, notify device
	defer func() {
		if currentPin == "" {
			return
		}
		log.Printf("[Developer] Disconnected from room: %s", maskPin(currentPin))
		if deviceConn := releaseDeveloper(currentPin, safeConn); deviceConn != nil {
			_ = deviceConn.WriteJSON(Message{
				Type:      "dev_disconnected",
				Message:   "Developer has disconnected",
				Timestamp: time.Now().Unix(),
			})
		}
	}()

	if initialPin != "" {
		pin, ok := pairDeveloper(safeConn, msgs, initialPin, meta.Key, meta)
		if !ok {
			return nil
		}
		currentPin = pin
	}

	// Event loop: process developer commands and forward to device
	for msg := range msgs {
		if msg.err != nil {
			if currentPin != "" {
				log.Printf("[Developer] Read error on room %s: %v", maskPin(currentPin), msg.err)
			}
			break
		}

		rawMsg := msg.data
		msgType, _ := rawMsg["type"].(string)

		switch msgType {
		case "connect_room":
			pin, _ := rawMsg["pin"].(string)
			key, _ := rawMsg["key"].(string)
			if pin == "" {
				continue
			}
			if currentPin != "" {
				if deviceConn := releaseDeveloper(currentPin, safeConn); deviceConn != nil {
					_ = deviceConn.WriteJSON(Message{
						Type:      "dev_disconnected",
						Message:   "Developer has disconnected",
						Timestamp: time.Now().Unix(),
					})
				}
				currentPin = ""
			}
			if paired, ok := pairDeveloper(safeConn, msgs, pin, key, meta); ok {
				currentPin = paired
			}

		case "ping":
			_ = safeConn.WriteJSON(map[string]interface{}{
				"type":      "pong",
				"timestamp": time.Now().Unix(),
			})

		default:
			// Forward requests to device (pull_network_body, pull_storage,
			// pull_dom_tree, pull_screenshot, exec_js). Routing uses only the
			// PIN this socket was authorized for, never one named in the payload.
			if currentPin == "" {
				_ = safeConn.WriteJSON(Message{
					Type:      "error",
					Reason:    "not_paired",
					Message:   "Not authorized for any room",
					Timestamp: time.Now().Unix(),
				})
				continue
			}

			deviceConn := authorizedDeviceConn(currentPin, safeConn)
			if deviceConn == nil {
				continue
			}
			if err := deviceConn.WriteJSON(rawMsg); err != nil {
				log.Printf("[Developer] Error forwarding %s to device on room %s: %v", msgType, maskPin(currentPin), err)
			}
		}
	}

	return nil
}

// RoomReaper handles periodic cleanup of stale/inactive rooms.
type RoomReaper struct {
	ticker *time.Ticker
	quit   chan struct{}
}

// Stop terminates the background reaper goroutine.
func (r *RoomReaper) Stop() {
	if r.ticker != nil {
		r.ticker.Stop()
	}
	close(r.quit)
}

// startRoomReaper starts a background goroutine that expires rooms on both the
// idle timeout and the hard maximum session duration, and trims the rate
// limiter's bookkeeping.
func startRoomReaper(interval, maxIdle time.Duration) *RoomReaper {
	reaper := &RoomReaper{
		ticker: time.NewTicker(interval),
		quit:   make(chan struct{}),
	}

	go func() {
		for {
			select {
			case <-reaper.ticker.C:
				count := reapExpiredRooms(maxIdle, cfg().RoomMaxDuration)
				if count > 0 {
					log.Printf("[Reaper] Expired %d rooms", count)
				}
				pinLimiter.Cleanup()
			case <-reaper.quit:
				return
			}
		}
	}()

	return reaper
}

type expiredRoom struct {
	room   *Room
	reason string
}

// reapExpiredRooms deletes every room that exceeded its idle timeout or its hard
// maximum duration, notifies both peers, and closes their sockets. Returns the
// count of expired rooms.
func reapExpiredRooms(maxIdle, maxDuration time.Duration) int {
	now := time.Now()
	var expired []expiredRoom

	roomsMu.Lock()
	for pin, room := range rooms {
		reason := ""
		if maxDuration > 0 && !room.CreatedAt.IsZero() && now.Sub(room.CreatedAt) > maxDuration {
			reason = "max_duration"
		} else if maxIdle > 0 && now.Sub(room.LastActive) > maxIdle {
			reason = "idle_timeout"
		}
		if reason != "" {
			expired = append(expired, expiredRoom{room: room, reason: reason})
			delete(rooms, pin)
		}
	}
	roomsMu.Unlock()

	// Notify and close sockets outside roomsMu lock
	for _, item := range expired {
		notice := Message{
			Type:      "session_expired",
			Reason:    item.reason,
			Message:   expiryMessage(item.reason),
			Timestamp: now.Unix(),
		}
		if item.room.DeviceConn != nil {
			_ = item.room.DeviceConn.WriteJSON(notice)
			_ = item.room.DeviceConn.Close()
		}
		if item.room.DevConn != nil {
			_ = item.room.DevConn.WriteJSON(notice)
			_ = item.room.DevConn.Close()
		}
		if item.room.PendingAuth != nil && item.room.PendingAuth.Conn != nil {
			_ = item.room.PendingAuth.Conn.Close()
		}
	}

	return len(expired)
}

// reapIdleRooms expires rooms purely on inactivity.
func reapIdleRooms(maxIdle time.Duration) int {
	return reapExpiredRooms(maxIdle, 0)
}

func expiryMessage(reason string) string {
	if reason == "max_duration" {
		return "Debug session reached its maximum duration and was closed"
	}
	return "Debug session was closed after inactivity"
}
