package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"quadrangis/internal/gis"
	"quadrangis/internal/i18n"
	"quadrangis/internal/stream"
	"quadrangis/internal/switchcmd"
)

// Energize / de-energize objek jaringan oleh sistem eksternal (SCADA, DMS, AMI, ...) lewat Kafka.
// Pesan JSON diurai switchcmd, objek dicari dari kode / nama (+ jenis), lalu dijalankan lewat execManeuver —
// jalur yang sama dengan operator (kejadian padam, SOE, notifikasi, audit). Setiap pesan dicatat di switch_events.

// StartSwitchEvents menjalankan konsumer Kafka perintah energize / de-energize.
func StartSwitchEvents(ctx context.Context, d *Deps) {
	if !d.Cfg.KafkaEnabled {
		log.Printf("[switch] Kafka nonaktif: perintah energize / de-energize eksternal tidak diterima")
		return
	}
	s := &Server{d: d}
	topic := d.Configs.Str("scada.switch_topic", "scada.switch.events")
	group := d.Configs.Str("scada.switch_group", "quadrangis-switch")
	go stream.Consume(ctx, d.Cfg.KafkaBrokers, topic, group, func(ctx context.Context, m stream.Message) error {
		part, off := m.Partition, m.Offset
		s.handleSwitchMessage(ctx, m.Value, switchMeta{Channel: "kafka", Topic: m.Topic, Partition: &part, Offset: &off})
		return nil
	})
}

type switchMeta struct {
	Channel   string // kafka | uji
	Topic     string
	Partition *int
	Offset    *int64
}

// switchEvent adalah satu baris log perintah eksternal.
type switchEvent struct {
	ID         int64           `json:"id"`
	ReceivedAt time.Time       `json:"received_at"`
	EventID    string          `json:"event_id"`
	Source     string          `json:"source"`
	Channel    string          `json:"channel"`
	Topic      string          `json:"topic"`
	Partition  *int            `json:"partition"`
	Offset     *int64          `json:"offset"`
	Payload    json.RawMessage `json:"payload"`
	Code       string          `json:"code"`
	TypeText   string          `json:"type_text"`
	Action     string          `json:"action"`
	Category   string          `json:"category"`
	EventAt    *time.Time      `json:"event_at"`
	TargetKind string          `json:"target_kind"`
	TargetID   *int64          `json:"target_id"`
	TargetCode string          `json:"target_code"`
	TargetType string          `json:"target_type"`
	Result     string          `json:"result"` // applied | skipped | duplicate | error
	Message    string          `json:"message"`
	ManeuverID *int64          `json:"maneuver_id"`
	OutageID   *int64          `json:"outage_id"`
	DurationMs int             `json:"duration_ms"`
}

// handleSwitchMessage memproses satu pesan dan mencatat hasilnya.
func (s *Server) handleSwitchMessage(ctx context.Context, raw []byte, meta switchMeta) switchEvent {
	start := time.Now()
	ev := switchEvent{Channel: meta.Channel, Topic: meta.Topic, Partition: meta.Partition, Offset: meta.Offset, Result: "error"}
	if json.Valid(raw) {
		ev.Payload = json.RawMessage(raw)
	} else {
		ev.Payload, _ = json.Marshal(map[string]string{"raw": string(raw)})
	}
	done := func() switchEvent {
		ev.DurationMs = int(time.Since(start).Milliseconds())
		s.saveSwitchEvent(&ev)
		return ev
	}
	if !s.d.Configs.Bool("scada.switch_enabled", true) {
		ev.Message = "integrasi perintah eksternal dinonaktifkan (konfigurasi scada.switch_enabled)"
		return done()
	}
	cmd, err := switchcmd.Parse(raw)
	ev.EventID, ev.Source, ev.Code, ev.TypeText, ev.Action, ev.Category, ev.EventAt = cmd.EventID, cmd.Source, cmd.Code, cmd.Type, cmd.Action, cmd.Category, cmd.At
	if ev.Code == "" && cmd.ID > 0 {
		ev.Code = "#" + strconv.FormatInt(cmd.ID, 10)
	}
	if err != nil {
		ev.Message = err.Error()
		return done()
	}
	if cmd.EventID != "" {
		var dup bool
		_ = s.d.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM switch_events WHERE event_id = $1 AND result IN ('applied', 'skipped'))`, cmd.EventID).Scan(&dup)
		if dup {
			ev.Result, ev.Message = "duplicate", "event_id "+cmd.EventID+" sudah pernah diproses"
			return done()
		}
	}
	// graf dimuat ±20–60 detik setelah backend mulai: tunggu agar perintah tidak gagal palsu
	for wait := 0; !s.d.Graph.Ready(); wait++ {
		if wait >= 300 {
			ev.Message = "graf topologi belum siap"
			return done()
		}
		select {
		case <-ctx.Done():
			ev.Message = "dibatalkan (server berhenti)"
			return done()
		case <-time.After(2 * time.Second):
		}
	}
	kind, id, err := s.resolveSwitchTarget(ctx, cmd)
	if err != nil {
		ev.Message = err.Error()
		return done()
	}
	ev.TargetKind, ev.TargetID = kind, &id
	notes := []string{}
	at := cmd.At
	if at != nil {
		if ahead := time.Duration(s.d.Configs.Int("scada.switch_max_future_sec", 120)) * time.Second; at.After(time.Now().Add(ahead)) {
			notes = append(notes, fmt.Sprintf("tanggal %s di masa depan diganti waktu terima", at.Format(time.RFC3339)))
			at = nil
		}
	}
	note := strings.TrimSpace(cmd.Note)
	if cmd.Source != "" {
		note = strings.TrimSpace("[" + cmd.Source + "] " + note)
	}
	req := maneuverReq{Action: cmd.Action, Kind: cmd.Category, Note: note}
	if kind == "edge" {
		req.EdgeID = id
	} else {
		req.NodeID = id
	}
	who := "Sistem eksternal"
	if cmd.Source != "" {
		who += " " + cmd.Source
	}
	actor := maneuverActor{Username: s.d.Configs.Str("scada.switch_username", "scada"), FullName: who, Role: "sistem", ClientIP: meta.Channel,
		Channel: "kafka", Lang: i18n.ID, At: at, System: true}
	res, err := s.execManeuver(ctx, req, actor)
	var me *maneuverError
	switch {
	case errors.As(err, &me) && me.status == http.StatusConflict && strings.Contains(me.msg, "sudah berstatus"):
		ev.Result, ev.Message = "skipped", me.msg
	case err != nil:
		ev.Message = err.Error()
	default:
		ev.Result = "applied"
		ev.Message, _ = res["message"].(string)
		if mid, ok := res["maneuver_id"].(int64); ok {
			ev.ManeuverID = &mid
		}
		if oid, ok := res["outage_id"].(*int64); ok {
			ev.OutageID = oid
		}
		ev.TargetCode, _ = res["code"].(string)
		ev.TargetType, _ = res["type_code"].(string)
	}
	if ev.TargetCode == "" {
		if c, err := s.d.Features.Get(ctx, kind, id); err == nil {
			ev.TargetCode, _ = c.Properties["code"].(string)
			ev.TargetType, _ = c.Properties["type_code"].(string)
		}
	}
	if len(notes) > 0 {
		ev.Message = strings.TrimSpace(ev.Message + " · " + strings.Join(notes, "; "))
	}
	return done()
}

func (s *Server) saveSwitchEvent(ev *switchEvent) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	err := s.d.Pool.QueryRow(ctx, `INSERT INTO switch_events (event_id, source, channel, topic, kafka_partition, kafka_offset, payload, code, type_text, action,
		category, event_at, target_kind, target_id, target_code, target_type, result, message, maneuver_id, outage_id, duration_ms)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING id, received_at`,
		ev.EventID, ev.Source, ev.Channel, ev.Topic, ev.Partition, ev.Offset, []byte(ev.Payload), ev.Code, ev.TypeText, ev.Action,
		ev.Category, ev.EventAt, ev.TargetKind, ev.TargetID, ev.TargetCode, ev.TargetType, ev.Result, ev.Message, ev.ManeuverID, ev.OutageID, ev.DurationMs).
		Scan(&ev.ID, &ev.ReceivedAt)
	if err != nil {
		log.Printf("[switch] simpan log gagal: %v", err)
		return
	}
	if ev.Result == "error" {
		log.Printf("[switch] perintah %s %s ditolak: %s", ev.Code, ev.Action, ev.Message)
	}
	data, _ := json.Marshal(ev)
	s.d.Hub.Publish(stream.Event{Type: "switch.event", ID: ev.ID, At: time.Now(), Data: data})
}

// switchTypes memetakan jenis objek (kode tipe / nama tipe / sebagian nama) ke kode tipe bertopologi.
func (s *Server) switchTypes(t string) ([]string, error) {
	t = strings.ToLower(strings.TrimSpace(t))
	if t == "" {
		return nil, nil
	}
	var exact, byName, partial []string
	for _, ct := range s.d.Types.List() {
		if !ct.Topology {
			continue
		}
		code, name, nameEN := strings.ToLower(ct.Code), strings.ToLower(ct.Name), strings.ToLower(ct.NameEN)
		switch {
		case code == t:
			exact = append(exact, ct.Code)
		case name == t || (nameEN != "" && nameEN == t):
			byName = append(byName, ct.Code)
		case strings.Contains(code, t) || strings.Contains(name, t) || (nameEN != "" && strings.Contains(nameEN, t)):
			partial = append(partial, ct.Code)
		}
	}
	for _, l := range [][]string{exact, byName, partial} {
		if len(l) > 0 {
			return l, nil
		}
	}
	return nil, fmt.Errorf("jenis objek %q tidak dikenal", t)
}

// resolveSwitchTarget mencari objek bertopologi dari id / kode / nama / kode SSOT / IDPEL (+ jenis objek).
func (s *Server) resolveSwitchTarget(ctx context.Context, c switchcmd.Command) (string, int64, error) {
	types, err := s.switchTypes(c.Type)
	if err != nil {
		return "", 0, err
	}
	if types == nil {
		types = []string{}
	}
	typeOK := func(tc string) bool {
		if len(types) == 0 {
			return true
		}
		for _, t := range types {
			if t == tc {
				return true
			}
		}
		return false
	}
	code := c.Code
	if c.ID > 0 {
		for _, kind := range []string{"node", "edge"} {
			if f, err := s.d.Features.Get(ctx, kind, c.ID); err == nil {
				tc, _ := f.Properties["type_code"].(string)
				if ct, ok := s.d.Types.Get(tc); ok && ct.Topology && typeOK(tc) {
					return kind, c.ID, nil
				}
			}
		}
		if code == "" {
			code = strconv.FormatInt(c.ID, 10) // angka panjang = IDPEL / kode, bukan id objek
		}
	}
	rows, err := s.d.Pool.Query(ctx, `
		(SELECT 'node', n.id, n.type_code, n.code = $1 FROM gis_nodes n JOIN component_types t ON t.code = n.type_code AND t.topology
		  WHERE (n.code = $1 OR lower(n.name) = lower($1) OR (n.properties ? 'kode_ssot' AND n.properties->>'kode_ssot' = $1)
		         OR (n.properties ? 'idpel' AND n.properties->>'idpel' = $1))
		    AND (cardinality($2::text[]) = 0 OR n.type_code = ANY($2)) LIMIT 20)
		UNION ALL
		(SELECT 'edge', e.id, e.type_code, e.code = $1 FROM gis_edges e
		  WHERE (e.code = $1 OR (e.properties ? 'kode_ssot' AND e.properties->>'kode_ssot' = $1))
		    AND (cardinality($2::text[]) = 0 OR e.type_code = ANY($2)) LIMIT 20)`, code, types)
	if err != nil {
		return "", 0, err
	}
	defer rows.Close()
	type hit struct {
		kind, typ string
		id        int64
		exact     bool
	}
	var all, exact []hit
	for rows.Next() {
		var h hit
		if err := rows.Scan(&h.kind, &h.id, &h.typ, &h.exact); err != nil {
			return "", 0, err
		}
		all = append(all, h)
		if h.exact {
			exact = append(exact, h)
		}
	}
	if err := rows.Err(); err != nil {
		return "", 0, err
	}
	list := all
	if len(exact) > 0 {
		list = exact
	}
	switch len(list) {
	case 0:
		if len(types) > 0 {
			return "", 0, fmt.Errorf("objek %q berjenis %s tidak ditemukan", code, strings.Join(types, ", "))
		}
		return "", 0, fmt.Errorf("objek %q tidak ditemukan", code)
	case 1:
		return list[0].kind, list[0].id, nil
	}
	seen, kinds := map[string]bool{}, []string{}
	for _, h := range list {
		if !seen[h.typ] {
			seen[h.typ] = true
			kinds = append(kinds, h.typ)
		}
	}
	return "", 0, fmt.Errorf("ditemukan %d objek %q (%s) — sertakan jenis objek atau gunakan id", len(list), code, strings.Join(kinds, ", "))
}

// ---------------------------------------------------------------- endpoint admin

// GET /api/admin/switch-events?limit=&before_id=&result= — log perintah eksternal + status integrasi
func (s *Server) switchEventsList(c *gin.Context) {
	ctx := c.Request.Context()
	limit := queryInt(c, "limit", 100)
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.d.Pool.Query(ctx, `SELECT id, received_at, event_id, source, channel, topic, kafka_partition, kafka_offset, payload, code, type_text, action,
		category, event_at, target_kind, target_id, target_code, target_type, result, message, maneuver_id, outage_id, coalesce(duration_ms, 0)
		FROM switch_events WHERE ($1 = 0 OR id < $1) AND ($2 = '' OR result = $2) ORDER BY id DESC LIMIT $3`,
		int64(queryInt(c, "before_id", 0)), c.Query("result"), limit)
	if err != nil {
		handleErr(c, err)
		return
	}
	defer rows.Close()
	items := []switchEvent{}
	for rows.Next() {
		var e switchEvent
		var payload []byte
		if err := rows.Scan(&e.ID, &e.ReceivedAt, &e.EventID, &e.Source, &e.Channel, &e.Topic, &e.Partition, &e.Offset, &payload, &e.Code, &e.TypeText, &e.Action,
			&e.Category, &e.EventAt, &e.TargetKind, &e.TargetID, &e.TargetCode, &e.TargetType, &e.Result, &e.Message, &e.ManeuverID, &e.OutageID, &e.DurationMs); err != nil {
			handleErr(c, err)
			return
		}
		e.Payload = json.RawMessage(payload)
		items = append(items, e)
	}
	counts := map[string]int{}
	if r2, err := s.d.Pool.Query(ctx, `SELECT result, count(*) FROM switch_events WHERE received_at > now() - interval '24 hours' GROUP BY 1`); err == nil {
		for r2.Next() {
			var k string
			var n int
			if r2.Scan(&k, &n) == nil {
				counts[k] = n
			}
		}
		r2.Close()
	}
	ok(c, gin.H{"items": items, "counts_24h": counts, "config": gin.H{
		"kafka_enabled": s.d.Cfg.KafkaEnabled, "enabled": s.d.Configs.Bool("scada.switch_enabled", true),
		"topic": s.d.Configs.Str("scada.switch_topic", "scada.switch.events"), "group": s.d.Configs.Str("scada.switch_group", "quadrangis-switch"),
		"username": s.d.Configs.Str("scada.switch_username", "scada"), "categories": gis.ManeuverKinds,
	}})
}

// POST /api/admin/switch-events/test?mode=kafka|direct (badan: pesan JSON) — kirim perintah uji
func (s *Server) switchEventsTest(c *gin.Context) {
	raw, err := c.GetRawData()
	if err != nil || !json.Valid(raw) {
		fail(c, http.StatusBadRequest, pick(c, "Badan permintaan harus JSON yang valid.", "Request body must be valid JSON."))
		return
	}
	p := s.person(c)
	s.d.Audit.Log(&p.UserID, p.Username, "switch.test", "switch_event", c.Query("mode"), json.RawMessage(raw), clientIP(c))
	if c.Query("mode") == "direct" {
		ok(c, gin.H{"mode": "direct", "event": s.handleSwitchMessage(c.Request.Context(), raw, switchMeta{Channel: "uji"})})
		return
	}
	if !s.d.Cfg.KafkaEnabled {
		fail(c, http.StatusConflict, pick(c, "Kafka nonaktif di server — gunakan mode proses langsung.", "Kafka is disabled on the server — use direct mode."))
		return
	}
	topic := s.d.Configs.Str("scada.switch_topic", "scada.switch.events")
	key := []byte(nil)
	if cmd, err := switchcmd.Parse(raw); err == nil && cmd.Code != "" {
		key = []byte(cmd.Code) // kunci = kode objek: urutan perintah satu objek terjaga (satu partisi)
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Second)
	defer cancel()
	if err := stream.PublishRaw(ctx, s.d.Cfg.KafkaBrokers, topic, key, raw); err != nil {
		fail(c, http.StatusBadGateway, "Kafka: "+err.Error())
		return
	}
	ok(c, gin.H{"mode": "kafka", "topic": topic, "sent": true})
}
