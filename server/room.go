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
	DeviceConn  *SafeConn
	DevConn     *SafeConn
	LastActive  time.Time
	IsConnected bool
}

// Message represents a message exchanged between client, server, and developer.
type Message struct {
	Type       string      `json:"type"`
	Pin        string      `json:"pin,omitempty"`
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
}

var (
	rooms   = make(map[string]*Room)
	roomsMu sync.RWMutex
)

const maxPinRetries = 10

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

// handleDeviceConnection handles WebSocket connections from mobile devices running vConsole.
func handleDeviceConnection(rawConn *websocket.Conn) error {
	safeConn := NewSafeConn(rawConn)
	defer safeConn.Close()

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

	room := &Room{
		ID:         pin,
		DeviceConn: safeConn,
		LastActive: time.Now(),
	}

	roomsMu.Lock()
	rooms[pin] = room
	roomsMu.Unlock()

	log.Printf("[Device] Registered room: %s", pin)

	// Send initial PIN to device outside roomsMu lock
	if err := safeConn.WriteJSON(Message{
		Type:      "room_pin",
		Pin:       pin,
		Timestamp: time.Now().Unix(),
	}); err != nil {
		roomsMu.Lock()
		delete(rooms, pin)
		roomsMu.Unlock()
		return err
	}

	// Defer cleanup when device disconnects: notify developer, close developer socket, delete room
	defer func() {
		log.Printf("[Device] Disconnected from room: %s", pin)
		var devConnToNotify *SafeConn

		roomsMu.Lock()
		if r, exists := rooms[pin]; exists {
			devConnToNotify = r.DevConn
			delete(rooms, pin)
		}
		roomsMu.Unlock()

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
			log.Printf("[Device] %s connection read error: %v", pin, err)
			break
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
				log.Printf("[Device] Error forwarding message to developer in room %s: %v", pin, err)
			}
		}
	}

	return nil
}

// handleDeveloperConnection handles WebSocket connections from desktop developer browsers.
// Supports both immediate query parameter pairing (/ws?type=developer&pin=123456)
// and in-band message pairing ({"type": "connect_room", "pin": "123456"}).
func handleDeveloperConnection(rawConn *websocket.Conn, initialPin string) error {
	safeConn := NewSafeConn(rawConn)
	defer safeConn.Close()

	var currentPin string

	// Handle immediate PIN connection if provided via query param
	if initialPin != "" {
		var (
			deviceConn *SafeConn
			found      bool
		)

		roomsMu.Lock()
		if r, exists := rooms[initialPin]; exists {
			found = true
			r.DevConn = safeConn
			r.IsConnected = true
			r.LastActive = time.Now()
			currentPin = initialPin
			deviceConn = r.DeviceConn
		}
		roomsMu.Unlock()

		if !found {
			_ = safeConn.WriteJSON(Message{
				Type:      "error",
				Message:   "Room not found or expired",
				Timestamp: time.Now().Unix(),
			})
			return nil
		}

		// Notify developer and device outside lock
		_ = safeConn.WriteJSON(Message{
			Type:      "room_connected",
			Pin:       initialPin,
			Timestamp: time.Now().Unix(),
		})

		if deviceConn != nil {
			_ = deviceConn.WriteJSON(Message{
				Type:      "dev_connected",
				Pin:       initialPin,
				Timestamp: time.Now().Unix(),
			})
		}
	}

	// Defer cleanup on developer disconnect: unbind DevConn, set IsConnected=false, notify device
	defer func() {
		if currentPin != "" {
			log.Printf("[Developer] Disconnected from room: %s", currentPin)
			var deviceConn *SafeConn

			roomsMu.Lock()
			if r, exists := rooms[currentPin]; exists {
				if r.DevConn == safeConn {
					r.DevConn = nil
					r.IsConnected = false
					r.LastActive = time.Now()
					deviceConn = r.DeviceConn
				}
			}
			roomsMu.Unlock()

			if deviceConn != nil {
				_ = deviceConn.WriteJSON(Message{
					Type:      "dev_disconnected",
					Message:   "Developer has disconnected",
					Timestamp: time.Now().Unix(),
				})
			}
		}
	}()

	// Event loop: process developer commands and forward to device
	for {
		var rawMsg map[string]interface{}
		if err := safeConn.ReadJSON(&rawMsg); err != nil {
			log.Printf("[Developer] Read error on room %s: %v", currentPin, err)
			break
		}

		msgType, _ := rawMsg["type"].(string)

		switch msgType {
		case "connect_room":
			pin, _ := rawMsg["pin"].(string)
			if pin == "" {
				continue
			}

			var (
				deviceConn *SafeConn
				found      bool
			)

			roomsMu.Lock()
			if r, exists := rooms[pin]; exists {
				found = true
				r.DevConn = safeConn
				r.IsConnected = true
				r.LastActive = time.Now()
				currentPin = pin
				deviceConn = r.DeviceConn
			}
			roomsMu.Unlock()

			if !found {
				_ = safeConn.WriteJSON(Message{
					Type:      "error",
					Message:   "Room not found or invalid PIN",
					Timestamp: time.Now().Unix(),
				})
				continue
			}

			// Send confirmation to developer outside lock
			_ = safeConn.WriteJSON(Message{
				Type:      "room_connected",
				Pin:       pin,
				Timestamp: time.Now().Unix(),
			})

			// Notify device that developer has connected
			if deviceConn != nil {
				_ = deviceConn.WriteJSON(Message{
					Type:      "dev_connected",
					Pin:       pin,
					Timestamp: time.Now().Unix(),
				})
			}

		case "ping":
			_ = safeConn.WriteJSON(map[string]interface{}{
				"type":      "pong",
				"timestamp": time.Now().Unix(),
			})

		default:
			// Forward requests to device (pull_network_body, pull_storage, pull_dom_tree, pull_screenshot, exec_js, etc.)
			targetPin, _ := rawMsg["pin"].(string)
			if targetPin == "" {
				targetPin = currentPin
			}
			if targetPin == "" {
				continue
			}

			var deviceConn *SafeConn
			roomsMu.RLock()
			if r, exists := rooms[targetPin]; exists {
				deviceConn = r.DeviceConn
			}
			roomsMu.RUnlock()

			if deviceConn != nil {
				if err := deviceConn.WriteJSON(rawMsg); err != nil {
					log.Printf("[Developer] Error forwarding %s to device on room %s: %v", msgType, targetPin, err)
				}
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

// startRoomReaper starts a background goroutine that reaps idle rooms.
func startRoomReaper(interval, maxIdle time.Duration) *RoomReaper {
	reaper := &RoomReaper{
		ticker: time.NewTicker(interval),
		quit:   make(chan struct{}),
	}

	go func() {
		for {
			select {
			case <-reaper.ticker.C:
				count := reapIdleRooms(maxIdle)
				if count > 0 {
					log.Printf("[Reaper] Reaped %d inactive rooms", count)
				}
			case <-reaper.quit:
				return
			}
		}
	}()

	return reaper
}

// reapIdleRooms deletes rooms that have been inactive longer than maxIdle
// and closes any dangling socket connections. Returns the count of reaped rooms.
func reapIdleRooms(maxIdle time.Duration) int {
	now := time.Now()
	var staleRooms []*Room

	roomsMu.Lock()
	for pin, room := range rooms {
		if now.Sub(room.LastActive) > maxIdle {
			staleRooms = append(staleRooms, room)
			delete(rooms, pin)
		}
	}
	roomsMu.Unlock()

	// Close sockets outside roomsMu lock
	for _, room := range staleRooms {
		if room.DeviceConn != nil {
			_ = room.DeviceConn.Close()
		}
		if room.DevConn != nil {
			_ = room.DevConn.Close()
		}
	}

	return len(staleRooms)
}
