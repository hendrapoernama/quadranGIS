package api

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	_ "image/jpeg" // dekode ukuran foto
	_ "image/png"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"quadrangis/internal/gis"
	"quadrangis/internal/middleware"
	"quadrangis/internal/models"
	"quadrangis/internal/push"
)

// ---------------------------------------------------------------- aset terdekat

// GET /api/field/nearby?lng&lat&radius&limit&types=a,b
func (s *Server) fieldNearby(c *gin.Context) {
	lng, err1 := strconv.ParseFloat(c.Query("lng"), 64)
	lat, err2 := strconv.ParseFloat(c.Query("lat"), 64)
	if err1 != nil || err2 != nil || lng < -180 || lng > 180 || lat < -90 || lat > 90 {
		failT(c, http.StatusBadRequest, "common.bad_payload")
		return
	}
	radius := float64(queryInt(c, "radius", s.d.Configs.Int("mobile.nearby_radius_m", 500)))
	if radius <= 0 || radius > 5000 {
		radius = 500
	}
	var types []string
	if t := strings.TrimSpace(c.Query("types")); t != "" {
		types = strings.Split(t, ",")
	}
	items, err := s.d.Field.NearbyNodes(c.Request.Context(), lng, lat, radius, types, queryInt(c, "limit", 30))
	if err != nil {
		handleErr(c, err)
		return
	}
	ok(c, gin.H{"items": items, "radius_m": radius})
}

// ---------------------------------------------------------------- foto aset

// GET /api/field/photos?kind&id  atau ?mine=1 / ?recent=1
func (s *Server) fieldListPhotos(c *gin.Context) {
	ctx := c.Request.Context()
	if c.Query("mine") == "1" || c.Query("recent") == "1" {
		owner := ""
		if c.Query("mine") == "1" {
			_, owner = claimsUser(c)
		}
		items, err := s.d.Field.RecentPhotos(ctx, owner, queryInt(c, "limit", 30))
		if err != nil {
			handleErr(c, err)
			return
		}
		ok(c, gin.H{"items": items})
		return
	}
	kind := c.Query("kind")
	id := int64(queryInt(c, "id", 0))
	if (kind != "node" && kind != "edge" && kind != "report") || id <= 0 {
		failT(c, http.StatusBadRequest, "common.bad_payload")
		return
	}
	items, err := s.d.Field.ListPhotos(ctx, kind, id, queryInt(c, "limit", 60))
	if err != nil {
		handleErr(c, err)
		return
	}
	ok(c, gin.H{"items": items})
}

// GET /api/field/photos/:id/image?thumb=1
func (s *Server) fieldPhotoImage(c *gin.Context) {
	id, okID := paramInt64(c, "id")
	if !okID {
		return
	}
	data, mime, err := s.d.Field.PhotoData(c.Request.Context(), id, c.Query("thumb") == "1")
	if err != nil {
		handleErr(c, err)
		return
	}
	// isi foto tidak pernah berubah: boleh di-cache lama di perangkat (juga untuk mode offline)
	c.Header("Cache-Control", "private, max-age=2592000, immutable")
	c.Data(http.StatusOK, mime, data)
}

// POST /api/field/photos (multipart): image, thumb?, kind, id, lng?, lat?, accuracy?, taken_at?, note?, client_id?
func (s *Server) fieldUploadPhoto(c *gin.Context) {
	ctx := c.Request.Context()
	maxBytes := int64(s.d.Configs.Int("mobile.photo_max_kb", 1500)) * 1024
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxBytes*2+256*1024)
	kind := c.PostForm("kind")
	id, _ := strconv.ParseInt(c.PostForm("id"), 10, 64)
	if (kind != "node" && kind != "edge" && kind != "report") || id <= 0 {
		failT(c, http.StatusBadRequest, "field.photo_target")
		return
	}
	read := func(field string, limit int64) ([]byte, string, error) {
		fh, err := c.FormFile(field)
		if err != nil {
			return nil, "", err
		}
		if fh.Size > limit {
			return nil, "", errTooLarge
		}
		f, err := fh.Open()
		if err != nil {
			return nil, "", err
		}
		defer f.Close()
		b, err := io.ReadAll(io.LimitReader(f, limit+1))
		if err != nil {
			return nil, "", err
		}
		if int64(len(b)) > limit {
			return nil, "", errTooLarge
		}
		return b, http.DetectContentType(b), nil
	}
	img, mime, err := read("image", maxBytes)
	if err != nil {
		if errors.Is(err, errTooLarge) {
			failT(c, http.StatusRequestEntityTooLarge, "field.photo_too_large", maxBytes/1024)
			return
		}
		failT(c, http.StatusBadRequest, "field.photo_invalid")
		return
	}
	if mime != "image/jpeg" && mime != "image/png" {
		failT(c, http.StatusBadRequest, "field.photo_invalid")
		return
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(img))
	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 {
		failT(c, http.StatusBadRequest, "field.photo_invalid")
		return
	}
	var thumb []byte
	if tb, tmime, err := read("thumb", 256*1024); err == nil && tmime == "image/jpeg" {
		thumb = tb
	}
	// target harus ada
	if kind == "report" {
		if _, err := s.d.Ops.GetReport(ctx, id); err != nil {
			handleErr(c, err)
			return
		}
	} else if _, err := s.d.Features.Get(ctx, kind, id); err != nil {
		handleErr(c, err)
		return
	}
	p := gis.Photo{TargetKind: kind, TargetID: id, Mime: mime, Width: cfg.Width, Height: cfg.Height, TakenAt: time.Now(),
		Note: strings.TrimSpace(c.PostForm("note"))}
	if len(p.Note) > 1000 {
		p.Note = p.Note[:1000]
	}
	if v := strings.TrimSpace(c.PostForm("client_id")); v != "" && len(v) <= 64 {
		p.ClientID = &v
	}
	pf := func(k string) *float64 {
		if v, err := strconv.ParseFloat(c.PostForm(k), 64); err == nil {
			return &v
		}
		return nil
	}
	p.Lng, p.Lat, p.AccuracyM = pf("lng"), pf("lat"), pf("accuracy")
	if t, err := time.Parse(time.RFC3339, c.PostForm("taken_at")); err == nil && t.Before(time.Now().Add(5*time.Minute)) {
		p.TakenAt = t
	}
	uid, uname := claimsUser(c)
	p.CreatedByName = uname
	saved, created, err := s.d.Field.SavePhoto(ctx, p, img, thumb, uid)
	if err != nil {
		handleErr(c, err)
		return
	}
	if created {
		s.auditOps(c, "field.photo", fmt.Sprintf("%s:%d", kind, id), gin.H{"photo": saved.ID, "bytes": len(img), "offline": p.ClientID != nil})
	}
	ok(c, saved)
}

var errTooLarge = errors.New("too large")

// DELETE /api/field/photos/:id (milik sendiri; gis.edit boleh menghapus foto siapa pun)
func (s *Server) fieldDeletePhoto(c *gin.Context) {
	id, okID := paramInt64(c, "id")
	if !okID {
		return
	}
	_, uname := claimsUser(c)
	owner := uname
	if cl := middleware.GetClaims(c); cl != nil && cl.Has("gis.edit") {
		owner = ""
	}
	if err := s.d.Field.DeletePhoto(c.Request.Context(), id, owner); err != nil {
		handleErr(c, err)
		return
	}
	s.auditOps(c, "field.photo_delete", strconv.FormatInt(id, 10), nil)
	ok(c, gin.H{"ok": true})
}

// ---------------------------------------------------------------- Web Push

var pushState struct {
	mu     sync.Mutex
	sender *push.Sender
	key    string
}

// pushSender menyiapkan pengirim Web Push; kunci VAPID dibuat & disimpan otomatis bila belum ada.
func (s *Server) pushSender(ctx context.Context) (*push.Sender, error) {
	pushState.mu.Lock()
	defer pushState.mu.Unlock()
	pub := strings.TrimSpace(s.d.Configs.Str("push.vapid_public", ""))
	priv := strings.TrimSpace(s.d.Configs.Str("push.vapid_private", ""))
	if pub == "" || priv == "" {
		var err error
		pub, priv, err = push.GenerateVAPID()
		if err != nil {
			return nil, err
		}
		if err := s.d.Configs.UpsertMany(ctx, []models.Config{
			{Key: "push.vapid_public", Value: pub, ValueType: "string", Group: "mobile", Description: "Kunci publik VAPID Web Push (dibuat otomatis saat pertama start)"},
			{Key: "push.vapid_private", Value: priv, ValueType: "secret", Group: "mobile", Description: "Kunci privat VAPID Web Push (dibuat otomatis, jangan dibagikan)"},
		}); err != nil {
			return nil, err
		}
		_ = s.d.Configs.Refresh(ctx)
		log.Printf("[push] kunci VAPID baru dibuat")
	}
	key := pub + "|" + priv + "|" + s.d.Configs.Str("push.subject", "")
	if pushState.sender != nil && pushState.key == key {
		return pushState.sender, nil
	}
	sd, err := push.NewSender(pub, priv, s.d.Configs.Str("push.subject", ""))
	if err != nil {
		return nil, err
	}
	pushState.sender, pushState.key = sd, key
	return sd, nil
}

// GET /api/push/key
func (s *Server) pushKey(c *gin.Context) {
	sd, err := s.pushSender(c.Request.Context())
	if err != nil {
		handleErr(c, err)
		return
	}
	_, uname := claimsUser(c)
	subs, _ := s.d.Field.PushSubs(c.Request.Context(), "", uname)
	ok(c, gin.H{"public_key": sd.PublicKey(), "topics": gis.PushTopics, "subscriptions": subs})
}

// POST /api/push/subscribe {endpoint, keys:{p256dh, auth}, topics}
func (s *Server) pushSubscribe(c *gin.Context) {
	var req struct {
		Endpoint string `json:"endpoint"`
		Keys     struct {
			P256dh string `json:"p256dh"`
			Auth   string `json:"auth"`
		} `json:"keys"`
		Topics []string `json:"topics"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || !strings.HasPrefix(req.Endpoint, "https://") || req.Keys.P256dh == "" || req.Keys.Auth == "" || len(req.Endpoint) > 1000 {
		failT(c, http.StatusBadRequest, "common.bad_payload")
		return
	}
	topics := []string{}
	for _, t := range req.Topics {
		if inList(t, gis.PushTopics) {
			topics = append(topics, t)
		}
	}
	uid, uname := claimsUser(c)
	ua := c.GetHeader("User-Agent")
	if len(ua) > 250 {
		ua = ua[:250]
	}
	if err := s.d.Field.SavePushSub(c.Request.Context(), gis.PushSub{UserID: uid, Username: uname, Endpoint: req.Endpoint, P256dh: req.Keys.P256dh,
		Auth: req.Keys.Auth, Topics: topics, UserAgent: ua}); err != nil {
		handleErr(c, err)
		return
	}
	s.auditOps(c, "push.subscribe", "", gin.H{"topics": topics})
	ok(c, gin.H{"ok": true, "topics": topics})
}

// POST /api/push/unsubscribe {endpoint}
func (s *Server) pushUnsubscribe(c *gin.Context) {
	var req struct {
		Endpoint string `json:"endpoint"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.Endpoint == "" {
		failT(c, http.StatusBadRequest, "common.bad_payload")
		return
	}
	if err := s.d.Field.DeletePushSub(c.Request.Context(), req.Endpoint); err != nil {
		handleErr(c, err)
		return
	}
	ok(c, gin.H{"ok": true})
}

// POST /api/push/test: kirim notifikasi uji ke perangkat milik pengguna ini
func (s *Server) pushTest(c *gin.Context) {
	_, uname := claimsUser(c)
	subs, err := s.d.Field.PushSubs(c.Request.Context(), "", uname)
	if err != nil {
		handleErr(c, err)
		return
	}
	sent, failed := s.sendPush(c.Request.Context(), subs, push.Message{Title: "QuadranGIS", Body: tr(c, "field.push_test_body"), URL: "/field", Tag: "test"}, "normal")
	ok(c, gin.H{"sent": sent, "failed": failed, "devices": len(subs)})
}

func (s *Server) sendPush(ctx context.Context, subs []gis.PushSub, msg push.Message, urgency string) (int, int) {
	sd, err := s.pushSender(ctx)
	if err != nil {
		log.Printf("[push] pengirim tidak siap: %v", err)
		return 0, len(subs)
	}
	sent, failed := 0, 0
	for _, sub := range subs {
		err := sd.Send(ctx, push.Subscription{Endpoint: sub.Endpoint, P256dh: sub.P256dh, Auth: sub.Auth}, msg, 3600, urgency)
		switch {
		case err == nil:
			sent++
			s.d.Field.MarkPush(ctx, sub.ID, true, false)
		case errors.Is(err, push.ErrGone):
			failed++
			s.d.Field.MarkPush(ctx, sub.ID, false, true)
		default:
			failed++
			log.Printf("[push] kirim ke %s gagal: %v", sub.Username, err)
			s.d.Field.MarkPush(ctx, sub.ID, false, false)
		}
	}
	return sent, failed
}

// notify mengirim notifikasi ke seluruh langganan topik (asinkron, tidak menahan request).
func (s *Server) notify(topic string, msg push.Message, urgency string) {
	msg.Topic = topic
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		subs, err := s.d.Field.PushSubs(ctx, topic, "")
		if err != nil || len(subs) == 0 {
			return
		}
		s.sendPush(ctx, subs, msg, urgency)
	}()
}

// notifyOutage: padam dimulai / pulih.
func (s *Server) notifyOutage(outageID *int64, closed []int64, kind, level, code string, customers int, feeder string) {
	if outageID != nil {
		urg := "normal"
		if kind == "GANGGUAN" || kind == "BENCANA ALAM" {
			urg = "high"
		}
		body := fmt.Sprintf("%s · level %s · %d pelanggan", code, level, customers)
		if feeder != "" {
			body += " · " + feeder
		}
		s.notify("outage", push.Message{Title: "Padam " + kind, Body: body, URL: "/monitoring?tab=outages", Tag: fmt.Sprintf("outage-%d", *outageID)}, urg)
	}
	for _, id := range closed {
		s.notify("outage", push.Message{Title: "Pulih: " + code, Body: fmt.Sprintf("Kejadian padam #%d selesai", id), URL: "/monitoring?tab=outages", Tag: fmt.Sprintf("outage-%d", id)}, "normal")
	}
}
