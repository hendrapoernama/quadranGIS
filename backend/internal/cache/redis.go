// Package cache membungkus Redis sebagai cache tile, penyimpanan captcha,
// rate-limit login, dan pub/sub event realtime. Semua operasi toleran
// terhadap Redis yang tidak tersedia (aplikasi tetap berjalan tanpa cache).
package cache

import (
	"context"
	"errors"
	"log"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
)

// ErrUnavailable dikembalikan ketika Redis tidak dapat dihubungi.
var ErrUnavailable = errors.New("redis tidak tersedia")

// Cache adalah klien Redis dengan status ketersediaan.
type Cache struct {
	client *redis.Client
	ok     atomic.Bool
}

// New membuat klien Redis dan memeriksa koneksi awal.
func New(addr, password string, db int) *Cache {
	c := &Cache{client: redis.NewClient(&redis.Options{
		Addr:         addr,
		Password:     password,
		DB:           db,
		DialTimeout:  3 * time.Second,
		ReadTimeout:  2 * time.Second,
		WriteTimeout: 2 * time.Second,
		PoolSize:     32,
	})}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := c.client.Ping(ctx).Err(); err != nil {
		log.Printf("[redis] tidak tersedia saat start (%v); cache dinonaktifkan sementara", err)
		c.ok.Store(false)
	} else {
		c.ok.Store(true)
	}
	return c
}

// Client mengembalikan klien mentah (untuk pub/sub).
func (c *Cache) Client() *redis.Client { return c.client }

// Available mengembalikan status terakhir Redis.
func (c *Cache) Available() bool { return c.ok.Load() }

// Ping memperbarui status ketersediaan dan mengembalikan latensi.
func (c *Cache) Ping(ctx context.Context) (time.Duration, bool) {
	start := time.Now()
	err := c.client.Ping(ctx).Err()
	c.ok.Store(err == nil)
	return time.Since(start), err == nil
}

// GetBytes mengambil nilai biner.
func (c *Cache) GetBytes(ctx context.Context, key string) ([]byte, bool) {
	if !c.ok.Load() {
		return nil, false
	}
	b, err := c.client.Get(ctx, key).Bytes()
	if err != nil {
		if !errors.Is(err, redis.Nil) {
			c.ok.Store(false)
		}
		return nil, false
	}
	return b, true
}

// SetBytes menyimpan nilai biner dengan TTL.
func (c *Cache) SetBytes(ctx context.Context, key string, val []byte, ttl time.Duration) {
	if !c.ok.Load() {
		return
	}
	if err := c.client.Set(ctx, key, val, ttl).Err(); err != nil {
		c.ok.Store(false)
	}
}

// GetString mengambil string.
func (c *Cache) GetString(ctx context.Context, key string) (string, bool) {
	b, ok := c.GetBytes(ctx, key)
	return string(b), ok
}

// SetString menyimpan string.
func (c *Cache) SetString(ctx context.Context, key, val string, ttl time.Duration) {
	c.SetBytes(ctx, key, []byte(val), ttl)
}

// Del menghapus kunci.
func (c *Cache) Del(ctx context.Context, keys ...string) {
	if !c.ok.Load() || len(keys) == 0 {
		return
	}
	// hapus per batch agar tidak melebihi batas argumen
	for i := 0; i < len(keys); i += 500 {
		end := i + 500
		if end > len(keys) {
			end = len(keys)
		}
		if err := c.client.Del(ctx, keys[i:end]...).Err(); err != nil {
			c.ok.Store(false)
			return
		}
	}
}

// Incr menaikkan counter dengan TTL (untuk rate limit).
func (c *Cache) Incr(ctx context.Context, key string, ttl time.Duration) (int64, error) {
	if !c.ok.Load() {
		return 0, ErrUnavailable
	}
	pipe := c.client.TxPipeline()
	incr := pipe.Incr(ctx, key)
	pipe.Expire(ctx, key, ttl)
	if _, err := pipe.Exec(ctx); err != nil {
		c.ok.Store(false)
		return 0, err
	}
	return incr.Val(), nil
}

// GetInt64 membaca nilai integer (mis. versi tile).
func (c *Cache) GetInt64(ctx context.Context, key string) (int64, bool) {
	if !c.ok.Load() {
		return 0, false
	}
	v, err := c.client.Get(ctx, key).Int64()
	if err != nil {
		return 0, false
	}
	return v, true
}

// IncrPersistent menaikkan counter tanpa TTL.
func (c *Cache) IncrPersistent(ctx context.Context, key string) (int64, error) {
	if !c.ok.Load() {
		return 0, ErrUnavailable
	}
	v, err := c.client.Incr(ctx, key).Result()
	if err != nil {
		c.ok.Store(false)
	}
	return v, err
}

// Publish mengirim pesan ke channel pub/sub.
func (c *Cache) Publish(ctx context.Context, channel string, payload []byte) error {
	if !c.ok.Load() {
		return ErrUnavailable
	}
	if err := c.client.Publish(ctx, channel, payload).Err(); err != nil {
		c.ok.Store(false)
		return err
	}
	return nil
}

// Subscribe berlangganan channel dan memanggil handler untuk setiap pesan.
// Berjalan sampai ctx selesai; mencoba ulang jika koneksi putus.
func (c *Cache) Subscribe(ctx context.Context, channel string, handler func([]byte)) {
	for {
		if ctx.Err() != nil {
			return
		}
		sub := c.client.Subscribe(ctx, channel)
		ch := sub.Channel()
	loop:
		for {
			select {
			case <-ctx.Done():
				_ = sub.Close()
				return
			case msg, ok := <-ch:
				if !ok {
					break loop
				}
				handler([]byte(msg.Payload))
			}
		}
		_ = sub.Close()
		c.ok.Store(false)
		select {
		case <-ctx.Done():
			return
		case <-time.After(3 * time.Second):
		}
	}
}

// Close menutup klien.
func (c *Cache) Close() error { return c.client.Close() }
