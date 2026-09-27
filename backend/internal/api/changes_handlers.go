package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"quadrangis/internal/gis"
	"quadrangis/internal/middleware"
	"quadrangis/internal/stream"
)

// ---------------------------------------------------------------- identitas pelaku (audit)

type personCacheEntry struct {
	fullName, role string
	at             time.Time
}

var (
	personMu    sync.Mutex
	personCache = map[string]personCacheEntry{}
)

// userInfo mengembalikan nama lengkap & role pengguna (disimpan 5 menit).
func (s *Server) userInfo(ctx context.Context, userID string) (string, string) {
	personMu.Lock()
	if e, ok := personCache[userID]; ok && time.Since(e.at) < 5*time.Minute {
		personMu.Unlock()
		return e.fullName, e.role
	}
	personMu.Unlock()
	var full, role string
	_ = s.d.Pool.QueryRow(ctx, `SELECT u.full_name, COALESCE(r.name, '') FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id::text = $1`, userID).Scan(&full, &role)
	personMu.Lock()
	personCache[userID] = personCacheEntry{full, role, time.Now()}
	personMu.Unlock()
	return full, role
}

func (s *Server) person(c *gin.Context) gis.Person {
	cl := middleware.GetClaims(c)
	p := gis.Person{Lang: middleware.GetLang(c)}
	if cl != nil {
		p.UserID, p.Username = cl.UserID, cl.Username
		p.FullName, p.Role = s.userInfo(c.Request.Context(), cl.UserID)
		if p.Role == "" {
			p.Role = cl.Role
		}
	}
	return p
}

// approvalOn: editing jaringan lewat paket perubahan.
func (s *Server) approvalOn() bool { return s.d.Changes != nil && s.d.Changes.Enabled() }

func csParam(c *gin.Context) int64 {
	v, _ := strconv.ParseInt(c.Query("cs"), 10, 64)
	return v
}

// proposeEdit menyimpan perubahan editor sebagai operasi tertunda lalu membalas seperti EditResult
// (dengan penanda pending, paket, dan fitur hasil usulan).
func (s *Server) proposeEdit(c *gin.Context, op, kind string, id int64, body json.RawMessage) {
	p := s.person(c)
	res, err := s.d.Changes.Propose(c.Request.Context(), csParam(c), op, kind, id, body, p)
	if err != nil {
		handleErr(c, err)
		return
	}
	outID := id
	if op == "create" && res.Item != nil {
		outID = -res.Item.ID
	}
	msgs := []string{tr(c, "cs.proposed", res.Changeset.ID)}
	s.d.Audit.Log(&p.UserID, p.Username, "changeset.item", "changeset", strconv.FormatInt(res.Changeset.ID, 10),
		gin.H{"op": op, "kind": kind, "target": id}, clientIP(c))
	ok(c, gin.H{"action": op, "kind": kind, "id": outID, "feature": res.Feature, "pending": true, "removed": res.Removed,
		"changeset": res.Changeset, "item": res.Item, "messages": msgs, "touched_nodes": []int64{}, "touched_edges": []int64{}})
}

func (s *Server) changesetEvent(c *gin.Context, action string, cs gis.Changeset, note string) {
	p := s.person(c)
	data, _ := json.Marshal(gin.H{"id": cs.ID, "title": cs.Title, "status": cs.Status, "by": p.FullNameOr(), "author": cs.CreatedByName, "note": note})
	s.d.Hub.Publish(stream.Event{Type: "changeset." + action, ID: cs.ID, Username: p.Username, At: time.Now(), Data: data})
	s.d.Audit.Log(&p.UserID, p.Username, "changeset."+action, "changeset", strconv.FormatInt(cs.ID, 10), gin.H{"title": cs.Title, "note": note}, clientIP(c))
}

// ---------------------------------------------------------------- endpoint paket perubahan

// GET /api/gis/changesets?status=a,b&mine=1
func (s *Server) csList(c *gin.Context) {
	var status []string
	if v := strings.TrimSpace(c.Query("status")); v != "" {
		status = strings.Split(v, ",")
	}
	mine := ""
	if c.Query("mine") == "1" {
		mine = s.person(c).UserID
	}
	items, err := s.d.Changes.List(c.Request.Context(), status, mine, queryInt(c, "limit", 200))
	if err != nil {
		handleErr(c, err)
		return
	}
	sub, appr := s.d.Changes.PendingCount(c.Request.Context())
	ok(c, gin.H{"items": items, "submitted": sub, "approved": appr, "enabled": s.approvalOn(),
		"active": s.d.Changes.ActiveDraft(c.Request.Context(), s.person(c).UserID), "allow_self": s.d.Configs.Bool("gis.approval_allow_self", false)})
}

// GET /api/gis/changesets/:id — paket + item + jejak audit (+ konflik untuk paket yang disetujui)
func (s *Server) csGet(c *gin.Context) {
	id, okID := paramInt64(c, "id")
	if !okID {
		return
	}
	ctx := c.Request.Context()
	cs, err := s.d.Changes.Get(ctx, id)
	if err != nil {
		handleErr(c, err)
		return
	}
	items, _ := s.d.Changes.Items(ctx, id)
	logs, _ := s.d.Changes.Logs(ctx, id)
	res := gin.H{"changeset": cs, "items": items, "log": logs}
	if cs.Status == "approved" || cs.Status == "submitted" || gis.Editable(cs.Status) {
		conf, _ := s.d.Changes.Conflicts(ctx, id, middleware.GetLang(c))
		res["conflicts"] = conf
	}
	ok(c, res)
}

// GET /api/gis/changesets/:id/geojson — lapisan pratinjau paket
func (s *Server) csGeoJSON(c *gin.Context) {
	id, okID := paramInt64(c, "id")
	if !okID {
		return
	}
	fc, err := s.d.Changes.GeoJSON(c.Request.Context(), id)
	if err != nil {
		handleErr(c, err)
		return
	}
	ok(c, fc)
}

// POST /api/gis/changesets {title, description}
func (s *Server) csCreate(c *gin.Context) {
	var req struct {
		Title       string `json:"title"`
		Description string `json:"description"`
	}
	_ = c.ShouldBindJSON(&req)
	cs, err := s.d.Changes.Create(c.Request.Context(), req.Title, req.Description, "editor", s.person(c))
	if err != nil {
		handleErr(c, err)
		return
	}
	s.changesetEvent(c, "create", cs, "")
	ok(c, cs)
}

// PUT /api/gis/changesets/:id {title, description}
func (s *Server) csUpdate(c *gin.Context) {
	id, okID := paramInt64(c, "id")
	if !okID {
		return
	}
	var req struct {
		Title       string `json:"title"`
		Description string `json:"description"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		failT(c, http.StatusBadRequest, "common.bad_payload")
		return
	}
	if err := s.d.Changes.Update(c.Request.Context(), id, req.Title, req.Description, s.person(c)); err != nil {
		handleErr(c, err)
		return
	}
	cs, _ := s.d.Changes.Get(c.Request.Context(), id)
	ok(c, cs)
}

// POST /api/gis/changesets/:id/:action {note} — submit | approve | reject | release | cancel
func (s *Server) csAction(c *gin.Context) {
	id, okID := paramInt64(c, "id")
	if !okID {
		return
	}
	var req struct {
		Note string `json:"note"`
	}
	_ = c.ShouldBindJSON(&req)
	req.Note = strings.TrimSpace(req.Note)
	ctx := c.Request.Context()
	p := s.person(c)
	cl := middleware.GetClaims(c)
	need := map[string]string{"submit": "gis.edit", "cancel": "gis.edit", "approve": "gis.approve", "reject": "gis.approve", "release": "gis.release"}
	action := c.Param("action")
	perm, known := need[action]
	if !known {
		failT(c, http.StatusNotFound, "common.not_found")
		return
	}
	if cl == nil || !cl.Has(perm) {
		failT(c, http.StatusForbidden, "common.forbidden")
		return
	}
	var err error
	extra := gin.H{}
	switch action {
	case "submit":
		err = s.d.Changes.Submit(ctx, id, req.Note, p)
	case "cancel":
		err = s.d.Changes.Cancel(ctx, id, req.Note, p)
	case "approve":
		err = s.d.Changes.Review(ctx, id, true, req.Note, p)
	case "reject":
		err = s.d.Changes.Review(ctx, id, false, req.Note, p)
	case "release":
		var rr *gis.ReleaseResult
		var conflicts []gis.Conflict
		rr, conflicts, err = s.d.Changes.Release(ctx, id, req.Note, p)
		if len(conflicts) > 0 {
			c.JSON(http.StatusConflict, gin.H{"error": err.Error(), "conflicts": conflicts})
			return
		}
		if err == nil {
			s.applyEditResults(c, "release", rr.Results)
			extra = gin.H{"applied": rr.Applied, "failed": rr.Failed, "items": rr.Items}
		}
	}
	if err != nil {
		handleErr(c, err)
		return
	}
	cs, _ := s.d.Changes.Get(ctx, id)
	s.changesetEvent(c, action, cs, req.Note)
	extra["changeset"] = cs
	ok(c, extra)
}

// applyEditResults: efek samping gabungan beberapa perubahan (tile, graf, siaran, audit).
func (s *Server) applyEditResults(c *gin.Context, action string, results []*gis.EditResult) {
	if len(results) == 0 {
		return
	}
	agg := &gis.EditResult{Action: action, Kind: "node", TouchedNodes: []int64{}, TouchedEdges: []int64{}, Messages: []string{}}
	first := true
	for _, r := range results {
		if r == nil {
			continue
		}
		agg.TouchedNodes = append(agg.TouchedNodes, r.TouchedNodes...)
		agg.TouchedEdges = append(agg.TouchedEdges, r.TouchedEdges...)
		if first {
			agg.BBox, first = r.BBox, false
			continue
		}
		agg.BBox[0], agg.BBox[1] = minf(agg.BBox[0], r.BBox[0]), minf(agg.BBox[1], r.BBox[1])
		agg.BBox[2], agg.BBox[3] = maxf(agg.BBox[2], r.BBox[2]), maxf(agg.BBox[3], r.BBox[3])
	}
	s.afterEdit(c, agg)
}

// DELETE /api/gis/changesets/:id/items/:item
func (s *Server) csRemoveItem(c *gin.Context) {
	id, okID := paramInt64(c, "id")
	if !okID {
		return
	}
	item, err := strconv.ParseInt(c.Param("item"), 10, 64)
	if err != nil {
		failT(c, http.StatusBadRequest, "common.invalid_id")
		return
	}
	if err := s.d.Changes.RemoveItem(c.Request.Context(), id, item, s.person(c)); err != nil {
		handleErr(c, err)
		return
	}
	cs, _ := s.d.Changes.Get(c.Request.Context(), id)
	ok(c, gin.H{"changeset": cs})
}

// POST /api/gis/changesets/:id/items/:item/rebase — sinkronkan salinan objek aktif (setelah konflik)
func (s *Server) csRebaseItem(c *gin.Context) {
	id, okID := paramInt64(c, "id")
	if !okID {
		return
	}
	item, err := strconv.ParseInt(c.Param("item"), 10, 64)
	if err != nil {
		failT(c, http.StatusBadRequest, "common.invalid_id")
		return
	}
	if err := s.d.Changes.Rebase(c.Request.Context(), id, item, s.person(c)); err != nil {
		handleErr(c, err)
		return
	}
	ok(c, gin.H{"ok": true})
}

// ---------------------------------------------------------------- penyesuaian endpoint editor

// readBody membaca badan permintaan (untuk diteruskan sebagai usulan).
func readBody(c *gin.Context) (json.RawMessage, bool) {
	raw, err := io.ReadAll(io.LimitReader(c.Request.Body, 8<<20))
	if err != nil {
		failT(c, http.StatusBadRequest, "common.bad_payload")
		return nil, false
	}
	if len(strings.TrimSpace(string(raw))) == 0 {
		raw = []byte("{}")
	}
	if !json.Valid(raw) {
		failT(c, http.StatusBadRequest, "common.bad_payload")
		return nil, false
	}
	return raw, true
}

// draftFeature: objek usulan (id negatif) atau objek aktif dengan usulan paket diterapkan (?cs=).
func (s *Server) draftFeature(c *gin.Context, kind string, id int64) (bool, error) {
	ctx := c.Request.Context()
	if id < 0 {
		ft, err := s.d.Changes.Virtual(ctx, -id)
		if err != nil {
			return true, err
		}
		if k, _ := ft.Properties["kind"].(string); k != kind {
			return true, gis.ErrNotFound
		}
		ok(c, ft)
		return true, nil
	}
	if cs := csParam(c); cs > 0 {
		ft, err := s.d.Changes.Proposed(ctx, cs, kind, id)
		if err != nil {
			return true, err
		}
		if _, pending := ft.Properties["pending"]; pending {
			s.enrichFeature(ctx, &ft)
			ok(c, ft)
			return true, nil
		}
	}
	return false, nil
}
