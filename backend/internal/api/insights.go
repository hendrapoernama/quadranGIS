package api

import (
	"context"
	"fmt"
	"math"
	"sort"
	"time"

	"github.com/gin-gonic/gin"

	"quadrangis/internal/gis"
	"quadrangis/internal/middleware"
)

// insight adalah satu temuan operasi berbasis aturan (tanpa LLM).
type insight struct {
	Code     string         `json:"code"`
	Severity string         `json:"severity"` // critical | serious | warning | info
	Title    string         `json:"title"`
	Detail   string         `json:"detail"`
	Target   *insightTarget `json:"target,omitempty"`
	Value    float64        `json:"value"`
}

type insightTarget struct {
	Kind string `json:"kind"` // node | edge | outage | region | report | plan
	ID   int64  `json:"id"`
	Code string `json:"code"`
}

var severityRank = map[string]int{"critical": 0, "serious": 1, "warning": 2, "info": 3}

func fmtMinutes(m float64, en bool) string {
	h, mm := int(m)/60, int(m)%60
	if h == 0 {
		if en {
			return fmt.Sprintf("%d min", mm)
		}
		return fmt.Sprintf("%d mnt", mm)
	}
	if en {
		return fmt.Sprintf("%d h %d min", h, mm)
	}
	return fmt.Sprintf("%d j %d mnt", h, mm)
}

func fmtRp(v float64) string {
	switch {
	case v >= 1e9:
		return fmt.Sprintf("Rp %.2f M", v/1e9)
	case v >= 1e6:
		return fmt.Sprintf("Rp %.1f jt", v/1e6)
	}
	return fmt.Sprintf("Rp %.0f", v)
}

// buildInsights menyusun temuan operasi: padam lama, gangguan berulang, beban tinggi, keandalan
// wilayah vs target, laporan melewati SLA, dugaan gangguan belum tercatat, rencana tertunda.
func (s *Server) buildInsights(ctx context.Context, lang string) ([]insight, error) {
	en := lang == "en"
	L := func(id, e string) string {
		if en {
			return e
		}
		return id
	}
	out := []insight{}
	now := time.Now()
	rp := s.reliabilityParams()

	// 1. kejadian padam aktif yang lama
	if act, err := s.d.Power.ListOutages(ctx, true, 200); err == nil {
		for _, o := range act {
			gis.ApplyReliability(&o, time.Time{}, time.Time{}, rp)
			min := o.DurationSec / 60
			if min < 120 {
				continue
			}
			sev := "serious"
			if min >= 240 {
				sev = "critical"
			}
			out = append(out, insight{Code: "outage_long", Severity: sev, Value: min,
				Title:  fmt.Sprintf(L("Padam #%d %s (%s) sudah %s", "Outage #%d %s (%s) ongoing for %s"), o.ID, o.Kind, o.CauseNodeCode, fmtMinutes(min, en)),
				Detail: fmt.Sprintf(L("%d pelanggan padam, ENS berjalan %.0f kWh (%s).", "%d customers off, running ENS %.0f kWh (%s)."), o.Customers, o.ENSkWh, fmtRp(o.ENSRp)),
				Target: &insightTarget{Kind: "outage", ID: o.ID, Code: o.CauseNodeCode}})
		}
	}

	// 2–4. gangguan berulang 30 hari (penyulang, alat) & momentary 7 hari
	if rc, err := s.loadRel(ctx, now.AddDate(0, 0, -30), now); err == nil {
		isFault := func(i int) bool {
			k := rc.outages[i].Kind
			return k == "GANGGUAN" || k == "BENCANA ALAM"
		}
		for _, f := range rc.feeders(isFault) {
			if f.Faults < 3 {
				continue
			}
			out = append(out, insight{Code: "feeder_recurrent", Severity: "serious", Value: float64(f.Faults),
				Title:  fmt.Sprintf(L("Penyulang %s gangguan %d kali dalam 30 hari", "Feeder %s faulted %d times in 30 days"), f.Code, f.Faults),
				Detail: fmt.Sprintf(L("%.0f pelanggan·menit, ENS %s. Periksa titik lemah & jadwalkan inspeksi/pemeliharaan.", "%.0f customer-minutes, ENS %s. Inspect weak points & schedule maintenance."), f.CustomerMinutes, fmtRp(f.ENSRp)),
				Target: &insightTarget{Kind: "node", ID: f.ID, Code: f.Code}})
		}
		type dev struct {
			kind  string
			id    int64
			code  string
			n     int
			custs int
		}
		devs := map[string]*dev{}
		mom := map[int64]*feederAgg{}
		week := now.AddDate(0, 0, -7)
		for i, o := range rc.outages {
			if o.ParentID != nil {
				continue
			}
			if isFault(i) {
				key := fmt.Sprintf("%s:%d", o.CauseKind, o.CauseNodeID)
				d := devs[key]
				if d == nil {
					d = &dev{kind: o.CauseKind, id: o.CauseNodeID, code: o.CauseNodeCode}
					devs[key] = d
				}
				d.n++
				d.custs += o.Customers
			}
			if o.Momentary && o.StartedAt.After(week) {
				for _, f := range rc.sums[i].Feeders {
					a := mom[f.ID]
					if a == nil {
						a = &feederAgg{ID: f.ID, Code: f.Code}
						mom[f.ID] = a
					}
					a.Momentary++
				}
			}
		}
		for _, d := range devs {
			if d.n < 2 {
				continue
			}
			out = append(out, insight{Code: "device_recurrent", Severity: "warning", Value: float64(d.n),
				Title:  fmt.Sprintf(L("%s trip/gangguan %d kali dalam 30 hari", "%s tripped/faulted %d times in 30 days"), d.code, d.n),
				Detail: fmt.Sprintf(L("Total %d pelanggan terdampak. Kemungkinan gangguan berulang di seksi hilirnya; cek FLISR & riwayat seksi.", "%d customers affected in total. Likely a recurring fault downstream; check FLISR & section history."), d.custs),
				Target: &insightTarget{Kind: d.kind, ID: d.id, Code: d.code}})
		}
		for _, a := range mom {
			if a.Momentary < 3 {
				continue
			}
			out = append(out, insight{Code: "momentary_recurrent", Severity: "warning", Value: float64(a.Momentary),
				Title:  fmt.Sprintf(L("Penyulang %s padam sesaat %d kali dalam 7 hari", "Feeder %s had %d momentary outages in 7 days"), a.Code, a.Momentary),
				Detail: L("Pola padam sesaat berulang sering menandakan gangguan temporer (pohon, hewan, isolator retak).", "Recurring momentary outages often indicate transient faults (vegetation, animals, cracked insulators)."),
				Target: &insightTarget{Kind: "node", ID: a.ID, Code: a.Code}})
		}
	}

	// 5–6. keandalan tahun berjalan: sistem & per ULP vs target
	loc := jakartaLoc()
	y0 := time.Date(now.In(loc).Year(), 1, 1, 0, 0, 0, 0, loc)
	if yrc, err := s.loadRel(ctx, y0, now); err == nil {
		tg := s.targetsFor(y0, now)
		elapsed := now.Sub(y0).Hours() / (365 * 24)
		tot := yrc.total()
		if elapsed > 0.02 && tg.SAIDIYear > 0 {
			if p := tot.SAIDI / elapsed; p > tg.SAIDIYear {
				out = append(out, insight{Code: "saidi_projection", Severity: "serious", Value: p,
					Title:  fmt.Sprintf(L("Proyeksi SAIDI akhir tahun %.1f menit melebihi target %.0f", "Year-end SAIDI projection %.1f min exceeds target %.0f"), p, tg.SAIDIYear),
					Detail: fmt.Sprintf(L("SAIDI tahun berjalan %.2f menit/pelanggan (target pro-rata %.2f).", "Year-to-date SAIDI %.2f min/customer (pro-rated target %.2f)."), tot.SAIDI, tg.SAIDIPeriod)})
			}
		}
		if regs, err := s.regionReliability(ctx, yrc); err == nil {
			for _, r := range regs {
				if r.Level != "ulp" || r.Customers < 20 || tg.SAIDIPeriod <= 0 || r.Rel.SAIDI <= tg.SAIDIPeriod {
					continue
				}
				sev := "warning"
				if r.Rel.SAIDI > tg.SAIDIYear {
					sev = "critical"
				}
				out = append(out, insight{Code: "region_saidi", Severity: sev, Value: r.Rel.SAIDI,
					Title:  fmt.Sprintf(L("SAIDI ULP %s (%s) %.1f menit melewati target pro-rata %.1f", "SAIDI of ULP %s (%s) %.1f min exceeds pro-rated target %.1f"), r.Name, r.Parent, r.Rel.SAIDI, tg.SAIDIPeriod),
					Detail: fmt.Sprintf(L("%d kejadian, SAIFI %.2f, ENS %s pada tahun berjalan.", "%d events, SAIFI %.2f, ENS %s year to date."), r.Rel.Outages, r.Rel.SAIFI, fmtRp(r.Rel.ENSRp)),
					Target: &insightTarget{Kind: "region", ID: r.ID, Code: r.Name}})
			}
		}
	}

	// 7. beban penyulang tinggi (kondisi sekarang)
	if capVA := s.simParams().CapacityVA; capVA > 0 {
		_, feeders := s.d.Graph.PowerSummary()
		type fl struct {
			f   gis.FeederStatus
			pct float64
		}
		list := []fl{}
		for _, f := range feeders {
			pct := (f.LoadVA - f.LoadOffVA) * s.simParams().LoadFactor / capVA * 100
			if pct >= 80 {
				list = append(list, fl{f, pct})
			}
		}
		sort.Slice(list, func(i, j int) bool { return list[i].pct > list[j].pct })
		for i, x := range list {
			if i >= 5 {
				break
			}
			sev := "warning"
			if x.pct >= 100 {
				sev = "serious"
			}
			out = append(out, insight{Code: "feeder_load", Severity: sev, Value: math.Round(x.pct),
				Title:  fmt.Sprintf(L("Beban penyulang %s %.0f%% dari kapasitas", "Feeder %s loaded at %.0f%% of capacity"), x.f.Code, x.pct),
				Detail: L("Batasi pelimpahan beban lewat tie ke penyulang ini dan evaluasi pemecahan beban.", "Avoid transferring load onto this feeder via ties and evaluate load splitting."),
				Target: &insightTarget{Kind: "node", ID: x.f.Head, Code: x.f.Code}})
		}
	}

	// 8. laporan pelanggan melewati SLA
	sla := s.d.Configs.Float("ops.report_sla_minutes", 120)
	if rs, err := s.d.Exec.OverdueReports(ctx, sla, 100); err == nil && len(rs) > 0 {
		out = append(out, insight{Code: "reports_overdue", Severity: "serious", Value: float64(len(rs)),
			Title:  fmt.Sprintf(L("%d laporan pelanggan melewati SLA %.0f menit", "%d customer reports past the %.0f-minute SLA"), len(rs), sla),
			Detail: fmt.Sprintf(L("Tertua: %s (%s) sejak %s.", "Oldest: %s (%s) since %s."), rs[0].Ticket, rs[0].Category, rs[0].ReceivedAt.In(loc).Format("02/01 15:04")),
			Target: &insightTarget{Kind: "report", ID: rs[0].ID, Code: rs[0].Ticket}})
	}

	// 9. dugaan gangguan yang belum tercatat (kumpulan laporan tanpa kejadian padam)
	if sp, err := s.reportSuspects(ctx); err == nil {
		for _, x := range sp {
			if x.Reported < 2 {
				continue
			}
			out = append(out, insight{Code: "suspect_cluster", Severity: "warning", Value: float64(x.Reported),
				Title:  fmt.Sprintf(L("%d laporan mengarah ke %s tanpa kejadian padam tercatat", "%d reports point to %s with no recorded outage"), x.Reported, x.Code),
				Detail: fmt.Sprintf(L("%d dari %d pelanggan di hilirnya melapor (%.0f%%). Verifikasi lapangan.", "%d of %d downstream customers reported (%.0f%%). Verify in the field."), x.Reported, x.Customers, x.Ratio*100),
				Target: &insightTarget{Kind: "node", ID: x.NodeID, Code: x.Code}})
		}
	}

	// 10. rencana manuver disetujui tetapi tertunda
	if ps, err := s.d.Exec.PendingPlans(ctx, 24*time.Hour); err == nil {
		for _, p := range ps {
			out = append(out, insight{Code: "plan_pending", Severity: "info",
				Title:  fmt.Sprintf(L("Rencana #%d \"%s\" disetujui > 24 jam belum selesai", "Plan #%d \"%s\" approved > 24 h ago, not finished"), p.ID, p.Title),
				Detail: L("Eksekusi, batalkan, atau buka kembali agar status jaringan terencana tetap jelas.", "Execute, cancel or reopen it to keep planned network state clear."),
				Target: &insightTarget{Kind: "plan", ID: p.ID}})
		}
	}

	sort.SliceStable(out, func(i, j int) bool {
		if severityRank[out[i].Severity] != severityRank[out[j].Severity] {
			return severityRank[out[i].Severity] < severityRank[out[j].Severity]
		}
		return out[i].Value > out[j].Value
	})
	return out, nil
}

// GET /api/ops/insights
func (s *Server) opsInsights(c *gin.Context) {
	items, err := s.buildInsights(c.Request.Context(), string(middleware.GetLang(c)))
	if err != nil {
		handleErr(c, err)
		return
	}
	count := map[string]int{}
	for _, it := range items {
		count[it.Severity]++
	}
	ok(c, gin.H{"items": items, "count": count, "at": time.Now()})
}
