package middleware

import (
	"sync/atomic"
	"time"

	"github.com/gin-gonic/gin"
)

// Metrics menghitung jumlah permintaan HTTP, error, dan total latensi.
type Metrics struct {
	requests atomic.Int64
	errors   atomic.Int64
	totalNs  atomic.Int64
}

// Handler adalah middleware pencatat metrik.
func (m *Metrics) Handler() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()
		m.requests.Add(1)
		m.totalNs.Add(int64(time.Since(start)))
		if c.Writer.Status() >= 500 {
			m.errors.Add(1)
		}
	}
}

// Snapshot mengembalikan nilai kumulatif.
func (m *Metrics) Snapshot() (requests, errors, totalNs int64) {
	return m.requests.Load(), m.errors.Load(), m.totalNs.Load()
}
