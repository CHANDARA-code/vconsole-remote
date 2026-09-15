package main

import (
	"errors"
	"sync"

	"github.com/gorilla/websocket"
)

// SafeConn wraps a gorilla websocket.Conn with mutex synchronization
// to guarantee thread-safe concurrent writes and close operations.
type SafeConn struct {
	conn    *websocket.Conn
	writeMu sync.Mutex
	closeMu sync.Mutex
	closed  bool
}

// NewSafeConn wraps a raw websocket.Conn into a SafeConn.
func NewSafeConn(c *websocket.Conn) *SafeConn {
	if c == nil {
		return nil
	}
	return &SafeConn{conn: c}
}

// WriteJSON safely serializes v to JSON and writes it to the WebSocket connection.
func (s *SafeConn) WriteJSON(v interface{}) error {
	if s == nil {
		return errors.New("connection is nil")
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	if s.isClosed() {
		return errors.New("connection closed")
	}
	return s.conn.WriteJSON(v)
}

// WriteMessage safely writes a raw message to the WebSocket connection.
func (s *SafeConn) WriteMessage(messageType int, data []byte) error {
	if s == nil {
		return errors.New("connection is nil")
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	if s.isClosed() {
		return errors.New("connection closed")
	}
	return s.conn.WriteMessage(messageType, data)
}

// ReadJSON reads a JSON message from the WebSocket connection.
// Gorilla WebSocket supports one concurrent reader.
func (s *SafeConn) ReadJSON(v interface{}) error {
	if s == nil {
		return errors.New("connection is nil")
	}
	return s.conn.ReadJSON(v)
}

// Close safely terminates the WebSocket connection.
// Safe to call concurrently and multiple times.
func (s *SafeConn) Close() error {
	if s == nil {
		return nil
	}
	s.closeMu.Lock()
	if s.closed {
		s.closeMu.Unlock()
		return nil
	}
	s.closed = true
	s.closeMu.Unlock()

	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.conn.Close()
}

// IsClosed reports whether the connection has been closed.
func (s *SafeConn) IsClosed() bool {
	return s.isClosed()
}

func (s *SafeConn) isClosed() bool {
	if s == nil {
		return true
	}
	s.closeMu.Lock()
	defer s.closeMu.Unlock()
	return s.closed
}

// RawConn returns the underlying Gorilla websocket.Conn.
func (s *SafeConn) RawConn() *websocket.Conn {
	if s == nil {
		return nil
	}
	return s.conn
}
