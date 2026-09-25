// Package stream mengelola produser dan konsumer Kafka untuk event perubahan GIS.
// Kafka bersifat opsional: bila tidak tersedia, aplikasi tetap berjalan dan
// hanya mencatat peringatan.
package stream

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net"
	"strconv"
	"sync/atomic"
	"time"

	"github.com/segmentio/kafka-go"
)

// Event adalah payload yang dikirim ke Kafka dan ke klien realtime.
type Event struct {
	Type     string          `json:"type"`           // feature.created | feature.updated | feature.deleted | topology.rebuilt | ...
	Kind     string          `json:"kind,omitempty"` // node | edge
	ID       int64           `json:"id,omitempty"`
	TypeCode string          `json:"type_code,omitempty"`
	BBox     []float64       `json:"bbox,omitempty"`     // [minx,miny,maxx,maxy]
	Affected []int64         `json:"affected,omitempty"` // fitur lain yang ikut berubah (split/merge)
	Version  int64           `json:"tile_version,omitempty"`
	UserID   string          `json:"user_id,omitempty"`
	Username string          `json:"username,omitempty"`
	At       time.Time       `json:"at"`
	Data     json.RawMessage `json:"data,omitempty"`
}

// Producer mengirim event ke Kafka secara asinkron lewat antrean internal.
type Producer struct {
	writer  *kafka.Writer
	queue   chan Event
	enabled bool
	ok      atomic.Bool
	topic   string
}

// NewProducer membuat produser; enabled=false menghasilkan produser no-op.
func NewProducer(brokers []string, topic string, enabled bool) *Producer {
	p := &Producer{queue: make(chan Event, 4096), enabled: enabled, topic: topic}
	if !enabled || len(brokers) == 0 {
		return p
	}
	p.writer = &kafka.Writer{
		Addr:                   kafka.TCP(brokers...),
		Topic:                  topic,
		Balancer:               &kafka.Hash{},
		RequiredAcks:           kafka.RequireOne,
		AllowAutoTopicCreation: true,
		BatchTimeout:           50 * time.Millisecond,
		WriteTimeout:           5 * time.Second,
	}
	go p.loop()
	return p
}

func (p *Producer) loop() {
	for ev := range p.queue {
		b, err := json.Marshal(ev)
		if err != nil {
			continue
		}
		key := ev.Type
		if ev.Kind != "" {
			key = ev.Kind
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		err = p.writer.WriteMessages(ctx, kafka.Message{Key: []byte(key), Value: b, Time: ev.At})
		cancel()
		if err != nil {
			if p.ok.Load() {
				log.Printf("[kafka] gagal mengirim event: %v", err)
			}
			p.ok.Store(false)
		} else {
			p.ok.Store(true)
		}
	}
}

// Publish memasukkan event ke antrean (tidak memblokir).
func (p *Producer) Publish(ev Event) {
	if !p.enabled || p.writer == nil {
		return
	}
	if ev.At.IsZero() {
		ev.At = time.Now()
	}
	select {
	case p.queue <- ev:
	default:
		log.Printf("[kafka] antrean penuh, event %s dibuang", ev.Type)
	}
}

// Healthy menandakan pengiriman terakhir berhasil.
func (p *Producer) Healthy() bool { return p.enabled && p.ok.Load() }

// Enabled menandakan Kafka diaktifkan.
func (p *Producer) Enabled() bool { return p.enabled }

// Close menutup writer.
func (p *Producer) Close() {
	if p.writer != nil {
		close(p.queue)
		_ = p.writer.Close()
	}
}

// Message adalah pesan yang diterima konsumer.
type Message struct {
	Topic     string
	Partition int
	Offset    int64
	Key       string
	Value     []byte
	Time      time.Time
}

// EnsureTopic membuat topik bila belum ada, agar konsumer dapat langsung bergabung.
// Mencoba beberapa kali karena broker mungkin belum siap saat aplikasi start.
func EnsureTopic(ctx context.Context, brokers []string, topic string, partitions int) error {
	if len(brokers) == 0 {
		return errors.New("broker kafka tidak dikonfigurasi")
	}
	var lastErr error
	for attempt := 0; attempt < 10; attempt++ {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		lastErr = createTopic(ctx, brokers[0], topic, partitions)
		if lastErr == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(3 * time.Second):
		}
	}
	return lastErr
}

func createTopic(ctx context.Context, broker, topic string, partitions int) error {
	dialCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	conn, err := kafka.DialContext(dialCtx, "tcp", broker)
	if err != nil {
		return err
	}
	defer conn.Close()
	ctrl, err := conn.Controller()
	if err != nil {
		return err
	}
	cc, err := kafka.DialContext(dialCtx, "tcp", net.JoinHostPort(ctrl.Host, strconv.Itoa(ctrl.Port)))
	if err != nil {
		return err
	}
	defer cc.Close()
	err = cc.CreateTopics(kafka.TopicConfig{Topic: topic, NumPartitions: partitions, ReplicationFactor: 1})
	if err != nil && !errors.Is(err, kafka.TopicAlreadyExists) {
		return err
	}
	return nil
}

// Consume membaca topik dalam consumer group dan memanggil handler untuk tiap pesan.
// Berjalan sampai ctx selesai.
func Consume(ctx context.Context, brokers []string, topic, groupID string, handler func(context.Context, Message) error) {
	if err := EnsureTopic(ctx, brokers, topic, 3); err != nil {
		log.Printf("[kafka] tidak dapat memastikan topik %s: %v", topic, err)
	}
	r := kafka.NewReader(kafka.ReaderConfig{
		Brokers:                brokers,
		GroupID:                groupID,
		Topic:                  topic,
		MinBytes:               1,
		MaxBytes:               10e6,
		MaxWait:                time.Second,
		CommitInterval:         time.Second,
		StartOffset:            kafka.LastOffset,
		WatchPartitionChanges:  true,
		PartitionWatchInterval: 5 * time.Second,
		ErrorLogger:            kafka.LoggerFunc(func(msg string, args ...any) { log.Printf("[kafka] "+msg, args...) }),
	})
	defer r.Close()
	log.Printf("[kafka] konsumer aktif topik=%s group=%s", topic, groupID)
	for {
		m, err := r.ReadMessage(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			log.Printf("[kafka] konsumer error: %v (coba lagi 5 detik)", err)
			select {
			case <-ctx.Done():
				return
			case <-time.After(5 * time.Second):
			}
			continue
		}
		msg := Message{Topic: m.Topic, Partition: m.Partition, Offset: m.Offset, Key: string(m.Key), Value: m.Value, Time: m.Time}
		if err := handler(ctx, msg); err != nil {
			log.Printf("[kafka] handler error: %v", err)
		}
	}
}
