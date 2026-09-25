package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"quadrangis/internal/ai"
	"quadrangis/internal/middleware"
)

// GET /api/ai/providers: daftar penyedia beserta status konfigurasinya (tanpa membuka kunci).
func (s *Server) aiProviders(c *gin.Context) {
	def := s.d.Configs.Str("ai.default_provider", "anthropic")
	items := make([]gin.H, 0, len(ai.Providers))
	for _, p := range ai.Providers {
		key, _, model := ai.Settings(s.d.Configs, p)
		items = append(items, gin.H{"id": p.ID, "name": p.Name, "model": model, "default_model": p.DefaultModel, "configured": key != ""})
	}
	ok(c, gin.H{"items": items, "default": def})
}

type aiChatReq struct {
	Provider       string       `json:"provider"`
	Model          string       `json:"model"`
	Messages       []ai.Message `json:"messages"`
	IncludeContext bool         `json:"include_context"`
	Selected       *struct {
		Kind string `json:"kind"`
		ID   int64  `json:"id"`
	} `json:"selected"`
}

const aiMaxMessages = 40
const aiMaxChars = 60000

// buildAIContext merangkum kondisi jaringan terkini untuk prompt sistem.
func (s *Server) buildAIContext(ctx context.Context, req aiChatReq) string {
	var b strings.Builder
	sum, feeders := s.d.Graph.PowerSummary()
	st := s.d.Graph.Status()
	fmt.Fprintf(&b, "Waktu data: %s\n", sum.At.Format(time.RFC3339))
	fmt.Fprintf(&b, "Graf jaringan: %v node, %v edge, %v penyulang, %v sumber.\n", st["nodes"], st["edges"], st["feeders"], st["sources"])
	fmt.Fprintf(&b, "Rekap nyala/padam (padam/total): GI %d/%d, trafo GI %d/%d, gardu distribusi %d/%d, trafo distribusi %d/%d, pelanggan %d/%d, beban padam %.0f VA dari %.0f VA.\n",
		sum.GI.Off, sum.GI.Total, sum.TrafoGI.Off, sum.TrafoGI.Total, sum.GD.Off, sum.GD.Total, sum.TrafoGD.Off, sum.TrafoGD.Total,
		sum.Customers.Off, sum.Customers.Total, sum.LoadOffVA, sum.LoadVA)
	fmt.Fprintf(&b, "Penyulang: %d nyala, %d sebagian, %d padam. Zona: %d nyala, %d sebagian, %d padam. Gardu distribusi: %d nyala, %d sebagian, %d padam. Switch terbuka: %d.\n",
		sum.Feeders.On, sum.Feeders.Partial, sum.Feeders.Off, sum.Zones.On, sum.Zones.Partial, sum.Zones.Off,
		sum.GDState.On, sum.GDState.Partial, sum.GDState.Off, sum.OpenSwitches)

	off := make([]int, 0)
	for i, f := range feeders {
		if f.State != "on" {
			off = append(off, i)
		}
	}
	sort.Slice(off, func(a, b int) bool { return feeders[off[a]].CustomersOff > feeders[off[b]].CustomersOff })
	if len(off) > 15 {
		off = off[:15]
	}
	if len(off) > 0 {
		list := make([]int64, 0, len(off)*2)
		for _, i := range off {
			list = append(list, feeders[i].Head, feeders[i].GI)
		}
		names, _ := s.d.Power.NodeCodes(ctx, list)
		b.WriteString("Penyulang padam/sebagian (maks. 15):\n")
		for _, i := range off {
			f := feeders[i]
			fmt.Fprintf(&b, "- %s (GI %s): %s, pelanggan padam %d/%d, beban padam %.0f VA\n",
				names[f.Head].Code, names[f.GI].Code, f.State, f.CustomersOff, f.Customers, f.LoadOffVA)
		}
	}
	if outs, err := s.d.Power.ListOutages(ctx, true, 10); err == nil && len(outs) > 0 {
		b.WriteString("Kejadian padam aktif (maks. 10):\n")
		for _, o := range outs {
			var rep struct {
				Customers int     `json:"pelanggan"`
				GD        int     `json:"gd"`
				LoadVA    float64 `json:"beban_va"`
			}
			_ = json.Unmarshal(o.Summary, &rep)
			fmt.Fprintf(&b, "- #%d %s level %s oleh %s %s sejak %s: %d gardu, %d pelanggan, %.0f VA\n",
				o.ID, o.Kind, o.Level, o.CauseNodeType, o.CauseNodeCode, o.StartedAt.Format("2006-01-02 15:04"), rep.GD, rep.Customers, rep.LoadVA)
		}
	} else {
		b.WriteString("Tidak ada kejadian padam aktif.\n")
	}
	if req.Selected != nil && (req.Selected.Kind == "node" || req.Selected.Kind == "edge") && req.Selected.ID > 0 {
		if ft, err := s.d.Features.Get(ctx, req.Selected.Kind, req.Selected.ID); err == nil {
			s.enrichFeature(ctx, &ft)
			delete(ft.Properties, "footprint")
			if raw, err := json.Marshal(ft.Properties); err == nil {
				txt := string(raw)
				if len(txt) > 6000 {
					txt = txt[:6000]
				}
				fmt.Fprintf(&b, "Objek yang sedang dipilih pengguna (%s #%d): %s\n", req.Selected.Kind, req.Selected.ID, txt)
			}
		}
	}
	return b.String()
}

// POST /api/ai/chat: jawaban dialirkan sebagai server-sent events {delta} ... {done}.
func (s *Server) aiChat(c *gin.Context) {
	var req aiChatReq
	if err := c.ShouldBindJSON(&req); err != nil || len(req.Messages) == 0 {
		failT(c, http.StatusBadRequest, "common.bad_payload")
		return
	}
	if req.Provider == "" {
		req.Provider = s.d.Configs.Str("ai.default_provider", "anthropic")
	}
	p, found := ai.Find(req.Provider)
	if !found {
		failT(c, http.StatusBadRequest, "ai.provider_unknown", req.Provider)
		return
	}
	key, base, model := ai.Settings(s.d.Configs, p)
	if key == "" {
		failT(c, http.StatusBadRequest, "ai.not_configured", p.Name)
		return
	}
	if m := strings.TrimSpace(req.Model); m != "" {
		model = m
	}
	// batasi riwayat: pesan terbaru, peran valid, total karakter terbatas
	msgs := make([]ai.Message, 0, len(req.Messages))
	for _, m := range req.Messages {
		if (m.Role == "user" || m.Role == "assistant") && strings.TrimSpace(m.Content) != "" {
			msgs = append(msgs, m)
		}
	}
	if len(msgs) > aiMaxMessages {
		msgs = msgs[len(msgs)-aiMaxMessages:]
	}
	total := 0
	for i := len(msgs) - 1; i >= 0; i-- {
		total += len(msgs[i].Content)
		if total > aiMaxChars {
			msgs = msgs[i+1:]
			break
		}
	}
	for len(msgs) > 0 && msgs[0].Role != "user" {
		msgs = msgs[1:]
	}
	if len(msgs) == 0 || msgs[len(msgs)-1].Role != "user" {
		failT(c, http.StatusBadRequest, "common.bad_payload")
		return
	}

	lang := middleware.GetLang(c)
	system := "Anda adalah asisten AI untuk QuadranGIS, aplikasi GIS jaringan distribusi listrik (PLN): GI, trafo GI, penyulang 20 kV (SKTM/SUTM), " +
		"gardu distribusi, trafo distribusi, JTR (SKUTR/SKTR), SR, pelanggan TT/TM/TR, recloser, LBS, kubikel, tiang TM/TR. " +
		"Manuver jaringan (GANGGUAN, PEMELIHARAAN, MLS) membuka/menutup alat switching dan menentukan objek padam/nyala. " +
		"Jawab ringkas, akurat, dan hanya berdasarkan data yang diberikan; katakan terus terang bila data tidak cukup. Jangan mengarang kode objek atau angka."
	if lang == "en" {
		system += " Reply in English."
	} else {
		system += " Jawab dalam bahasa Indonesia."
	}
	if extra := strings.TrimSpace(s.d.Configs.Str("ai.system_prompt", "")); extra != "" {
		system += "\n\n" + extra
	}
	if req.IncludeContext {
		system += "\n\nData jaringan terkini:\n" + s.buildAIContext(c.Request.Context(), req)
	}

	// SSE: tanpa buffering di nginx, tenggat tulis diperpanjang untuk jawaban panjang
	rc := http.NewResponseController(c.Writer)
	_ = rc.SetWriteDeadline(time.Now().Add(10 * time.Minute))
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("X-Accel-Buffering", "no")
	c.Status(http.StatusOK)
	send := func(v any) error {
		b, _ := json.Marshal(v)
		if _, err := fmt.Fprintf(c.Writer, "data: %s\n\n", b); err != nil {
			return err
		}
		return rc.Flush()
	}
	_ = send(gin.H{"start": true, "provider": p.ID, "model": model})

	start := time.Now()
	chars := 0
	usage, err := ai.Stream(c.Request.Context(), ai.Request{
		Provider: p, APIKey: key, BaseURL: base, Model: model, System: system, Messages: msgs,
		MaxTokens: s.d.Configs.Int("ai.max_tokens", 2048),
	}, func(delta string) error {
		chars += len(delta)
		return send(gin.H{"delta": delta})
	})
	cl := middleware.GetClaims(c)
	status := "ok"
	if err != nil {
		status = "error"
		if !errors.Is(err, context.Canceled) {
			_ = send(gin.H{"error": tr(c, "ai.provider_error", p.Name, err.Error())})
		}
	} else {
		_ = send(gin.H{"done": true, "usage": usage, "duration_ms": time.Since(start).Milliseconds()})
	}
	if cl != nil {
		s.d.Audit.Log(&cl.UserID, cl.Username, "ai.chat", "ai", p.ID,
			gin.H{"model": model, "status": status, "messages": len(msgs), "context": req.IncludeContext, "output_chars": chars,
				"input_tokens": usage.InputTokens, "output_tokens": usage.OutputTokens}, clientIP(c))
	}
}
