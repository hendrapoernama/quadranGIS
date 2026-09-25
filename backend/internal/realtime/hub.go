// Package realtime menyediakan hub WebSocket yang menyebarkan event perubahan
// GIS ke semua klien. Redis pub/sub dipakai agar beberapa instance backend
// tetap sinkron; bila Redis tidak tersedia, event disebar secara lokal.
package realtime

import (
	"context"
	"encoding/json"
	"log"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"quadrangis/internal/cache"
	"quadrangis/internal/stream"
)

const channel = "quadran:events"

// Client adalah satu koneksi WebSocket.
type Client struct {
	conn *websocket.Conn
	send chan []byte
	hub  *Hub
	user string
}

// Hub mengelola klien dan penyebaran pesan.
type Hub struct {
	mu      sync.RWMutex
	clients map[*Client]struct{}
	cache   *cache.Cache
	useBus  bool
}

// New membuat hub. Jika cache tersedia, hub berlangganan channel Redis.
func New(ctx context.Context, c *cache.Cache) *Hub {
	h := &Hub{clients: make(map[*Client]struct{}), cache: c}
	if c != nil && c.Available() {
		h.useBus = true
		go c.Subscribe(ctx, channel, h.broadcast)
	}
	return h
}

// Publish mengirim event ke seluruh klien (melalui Redis jika aktif).
func (h *Hub) Publish(ev stream.Event) {
	if ev.At.IsZero() {
		ev.At = time.Now()
	}
	b, err := json.Marshal(ev)
	if err != nil {
		return
	}
	if h.useBus && h.cache != nil && h.cache.Available() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if err := h.cache.Publish(ctx, channel, b); err == nil {
			return
		}
	}
	h.broadcast(b)
}

func (h *Hub) broadcast(b []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.clients {
		select {
		case c.send <- b:
		default:
			// klien lambat: lewati pesan agar tidak memblokir
		}
	}
}

// ClientCount mengembalikan jumlah klien terhubung.
func (h *Hub) ClientCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}

func (h *Hub) add(c *Client) {
	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.mu.Unlock()
}

func (h *Hub) remove(c *Client) {
	h.mu.Lock()
	if _, ok := h.clients[c]; ok {
		delete(h.clients, c)
		close(c.send)
	}
	h.mu.Unlock()
}

// Serve mendaftarkan koneksi WebSocket baru dan menjalankan pompa baca/tulis.
func (h *Hub) Serve(conn *websocket.Conn, username string) {
	c := &Client{conn: conn, send: make(chan []byte, 256), hub: h, user: username}
	h.add(c)
	go c.writePump()
	c.readPump()
}

func (c *Client) readPump() {
	defer func() {
		c.hub.remove(c)
		_ = c.conn.Close()
	}()
	c.conn.SetReadLimit(4096)
	_ = c.conn.SetReadDeadline(time.Now().Add(90 * time.Second))
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(90 * time.Second))
	})
	for {
		if _, _, err := c.conn.ReadMessage(); err != nil {
			return
		}
		// pesan dari klien diabaikan (hanya ping/pong)
	}
}

func (c *Client) writePump() {
	ticker := time.NewTicker(30 * time.Second)
	defer func() {
		ticker.Stop()
		_ = c.conn.Close()
	}()
	for {
		select {
		case msg, ok := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if !ok {
				_ = c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// LogStats mencatat jumlah klien (untuk debug).
func (h *Hub) LogStats() { log.Printf("[ws] klien terhubung: %d", h.ClientCount()) }
