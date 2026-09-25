package auth

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"math/big"
	"strconv"
	"strings"
	"sync"
	"time"

	"quadrangis/internal/cache"
)

// Captcha membuat soal matematika sederhana yang harus dijawab saat login.
// Jawaban disimpan di Redis (atau memori bila Redis tidak tersedia) dan
// hanya berlaku sekali pakai.
type Captcha struct {
	cache *cache.Cache
	ttl   time.Duration

	mu  sync.Mutex
	mem map[string]memCaptcha
}

type memCaptcha struct {
	answer  int
	expires time.Time
}

// NewCaptcha membuat generator captcha.
func NewCaptcha(c *cache.Cache, ttl time.Duration) *Captcha {
	cp := &Captcha{cache: c, ttl: ttl, mem: make(map[string]memCaptcha)}
	go cp.gc()
	return cp
}

func randInt(max int) int {
	n, err := rand.Int(rand.Reader, big.NewInt(int64(max)))
	if err != nil {
		return 1
	}
	return int(n.Int64())
}

// Generate membuat soal baru dan mengembalikan id + pertanyaan.
func (c *Captcha) Generate(ctx context.Context) (id, question string) {
	var a, b, answer int
	var op string
	switch randInt(3) {
	case 0:
		a, b = 1+randInt(30), 1+randInt(30)
		op, answer = "+", a+b
	case 1:
		a, b = 10+randInt(40), 1+randInt(10)
		op, answer = "-", a-b
	default:
		a, b = 2+randInt(8), 2+randInt(8)
		op, answer = "×", a*b
	}
	buf := make([]byte, 12)
	_, _ = rand.Read(buf)
	id = hex.EncodeToString(buf)
	question = fmt.Sprintf("%d %s %d = ?", a, op, b)

	key := "captcha:" + id
	stored := false
	if c.cache != nil && c.cache.Available() {
		c.cache.SetString(ctx, key, strconv.Itoa(answer), c.ttl)
		stored = c.cache.Available()
	}
	if !stored {
		c.mu.Lock()
		c.mem[id] = memCaptcha{answer: answer, expires: time.Now().Add(c.ttl)}
		c.mu.Unlock()
	}
	return id, question
}

// Verify memeriksa jawaban; captcha dihapus setelah dicek (sekali pakai).
func (c *Captcha) Verify(ctx context.Context, id, answer string) bool {
	ans, err := strconv.Atoi(strings.TrimSpace(answer))
	if err != nil || id == "" {
		return false
	}
	key := "captcha:" + id
	if c.cache != nil && c.cache.Available() {
		if v, ok := c.cache.GetString(ctx, key); ok {
			c.cache.Del(ctx, key)
			want, _ := strconv.Atoi(v)
			return want == ans
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.mem[id]
	if !ok {
		return false
	}
	delete(c.mem, id)
	if time.Now().After(entry.expires) {
		return false
	}
	return entry.answer == ans
}

func (c *Captcha) gc() {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for range t.C {
		now := time.Now()
		c.mu.Lock()
		for k, v := range c.mem {
			if now.After(v.expires) {
				delete(c.mem, k)
			}
		}
		c.mu.Unlock()
	}
}
