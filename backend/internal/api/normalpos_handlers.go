package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	"quadrangis/internal/gis"
)

// ------------------------------------------------------------------ konfigurasi aktual → normal
//
// Editor Peta (tim data): alat switching yang posisinya saat ini berbeda dari posisi normal (mis. tie ditutup &
// kubikel dibuka untuk pemindahan beban permanen) dapat dijadikan posisi normal — atribut "normal" (dan
// "normal_open_ways" untuk LBS multi-arah) diisi posisi aktual. Lewat paket perubahan bila alur persetujuan aktif,
// sama seperti editing lain; setelah diterapkan keanggotaan penyulang normal dihitung ulang (normal = aktual).

// normalDeviation adalah satu baris daftar penyimpangan untuk UI.
type normalDeviation struct {
	gis.NormalDeviation
	Code           string `json:"code"`
	Name           string `json:"name"`
	FeederCode     string `json:"feeder_code"`
	LiveFeederCode string `json:"live_feeder_code"`
	OutageID       *int64 `json:"outage_id,omitempty"` // kejadian padam aktif yang disebabkan alat ini
	// disarankan dicentang: kedua sisi bertegangan & bukan penyebab padam aktif (bukan isolasi sementara)
	Suggest bool `json:"suggest"`
}

type feederTransfer struct {
	gis.FeederTransfer
	FromCode string `json:"from_code"`
	ToCode   string `json:"to_code"`
}

func parseIDList(v string) map[int64]bool {
	out := map[int64]bool{}
	for _, s := range strings.Split(v, ",") {
		if id, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64); err == nil && id > 0 {
			out[id] = true
		}
	}
	return out
}

// GET /api/gis/normal-deviations?feeders=1,2 — alat switching yang posisinya berbeda dari normal (opsional: hanya yang
// menyangkut penyulang tertentu, normal maupun aktual) dan perpindahan keanggotaan bila dijadikan normal.
func (s *Server) gisNormalDeviations(c *gin.Context) {
	ctx := c.Request.Context()
	only := parseIDList(c.Query("feeders"))
	in := func(ids ...int64) bool {
		if len(only) == 0 {
			return true
		}
		for _, id := range ids {
			if only[id] {
				return true
			}
		}
		return false
	}
	devs := s.d.Graph.NormalDeviations()
	ids := []int64{}
	codeIDs := []int64{}
	for _, d := range devs {
		if in(d.Feeder, d.LiveFeeder) {
			ids = append(ids, d.ID)
			codeIDs = append(codeIDs, d.ID, d.Feeder, d.LiveFeeder)
		}
	}
	transfers := []feederTransfer{}
	for _, t := range s.d.Graph.LiveTransfers() {
		if in(t.From, t.To) {
			transfers = append(transfers, feederTransfer{FeederTransfer: t})
			codeIDs = append(codeIDs, t.From, t.To)
		}
	}
	codes, err := s.d.Power.NodeCodes(ctx, codeIDs)
	if err != nil {
		handleErr(c, err)
		return
	}
	outages := map[int64]int64{}
	if len(ids) > 0 {
		rows, err := s.d.Pool.Query(ctx, `SELECT DISTINCT ON (cause_node_id) cause_node_id, id FROM outages
			WHERE ended_at IS NULL AND cause_kind = 'node' AND cause_node_id = ANY($1) ORDER BY cause_node_id, started_at`, ids)
		if err == nil {
			for rows.Next() {
				var nid, oid int64
				if rows.Scan(&nid, &oid) == nil {
					outages[nid] = oid
				}
			}
			rows.Close()
		}
	}
	items := make([]normalDeviation, 0, len(ids))
	for _, d := range devs {
		if !in(d.Feeder, d.LiveFeeder) {
			continue
		}
		x := normalDeviation{NormalDeviation: d, Code: codes[d.ID].Code, Name: codes[d.ID].Name,
			FeederCode: codes[d.Feeder].Code, LiveFeederCode: codes[d.LiveFeeder].Code}
		if oid, ok := outages[d.ID]; ok {
			o := oid
			x.OutageID = &o
		}
		x.Suggest = !d.DeadSide && x.OutageID == nil
		items = append(items, x)
	}
	for i := range transfers {
		transfers[i].FromCode, transfers[i].ToCode = codes[transfers[i].From].Code, codes[transfers[i].To].Code
	}
	ok(c, gin.H{"items": items, "transfers": transfers, "approval": s.approvalOn()})
}

// POST /api/gis/normal-positions?cs= {ids: [...]} — jadikan posisi saat ini alat-alat ini sebagai posisi normal.
// Posisi dibaca dari database saat itu (bukan dari klien). Alur persetujuan aktif → usulan di paket perubahan.
func (s *Server) gisSetNormalPositions(c *gin.Context) {
	var body struct {
		IDs []int64 `json:"ids"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || len(body.IDs) == 0 {
		failT(c, http.StatusBadRequest, "common.bad_payload")
		return
	}
	if len(body.IDs) > 500 {
		fail(c, http.StatusBadRequest, pick(c, "Maksimal 500 alat sekaligus.", "At most 500 devices at once."))
		return
	}
	ctx := c.Request.Context()
	approval := s.approvalOn()
	csID := csParam(c)
	var cs *gis.Changeset
	type failure struct {
		ID    int64  `json:"id"`
		Error string `json:"error"`
	}
	applied, skipped := 0, 0
	failed := []failure{}
	seen := map[int64]bool{}
	for _, id := range body.IDs {
		if seen[id] {
			continue
		}
		seen[id] = true
		var typ, status string
		var openWays []int64
		var raw []byte
		err := s.d.Pool.QueryRow(ctx, `SELECT type_code, status, coalesce(open_ways, '{}'), properties FROM gis_nodes WHERE id = $1`, id).
			Scan(&typ, &status, &openWays, &raw)
		if errors.Is(err, pgx.ErrNoRows) {
			failed = append(failed, failure{id, tr(c, "common.not_found")})
			continue
		} else if err != nil {
			handleErr(c, err)
			return
		}
		ct, okT := s.d.Types.Get(typ)
		if !okT || !ct.IsSwitch {
			failed = append(failed, failure{id, pick(c, "bukan alat switching", "not a switching device")})
			continue
		}
		props := map[string]any{}
		_ = json.Unmarshal(raw, &props)
		before, _ := json.Marshal(props)
		props["normal"] = status
		if ct.Ways > 2 || len(openWays) > 0 || props["normal_open_ways"] != nil {
			ways := openWays
			if ways == nil {
				ways = []int64{}
			}
			props["normal_open_ways"] = ways
		}
		if after, _ := json.Marshal(props); string(after) == string(before) {
			skipped++ // atribut sudah sama dengan posisi aktual (pengelompokan mengikuti setelah graf dimuat ulang)
			continue
		}
		if approval {
			in, _ := json.Marshal(gis.FeatureInput{Properties: props})
			res, err := s.d.Changes.Propose(ctx, csID, "update", "node", id, in, s.person(c))
			if err != nil {
				failed = append(failed, failure{id, err.Error()})
				continue
			}
			csID = res.Changeset.ID
			cs = &res.Changeset
		} else {
			res, err := s.d.Features.Update(ctx, "node", id, gis.FeatureInput{Properties: props}, actorFrom(c))
			if err != nil {
				failed = append(failed, failure{id, err.Error()})
				continue
			}
			s.afterEdit(c, res)
		}
		applied++
	}
	p := s.person(c)
	s.d.Audit.Log(&p.UserID, p.Username, "gis.normal_positions", "node", "", gin.H{"ids": body.IDs, "applied": applied, "skipped": skipped,
		"failed": len(failed), "pending": approval, "changeset": csID}, clientIP(c))
	ok(c, gin.H{"applied": applied, "skipped": skipped, "failed": failed, "pending": approval, "changeset": cs})
}
