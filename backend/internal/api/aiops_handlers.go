package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"quadrangis/internal/ai"
	"quadrangis/internal/gis"
	"quadrangis/internal/load"
	"quadrangis/internal/middleware"
)

// AI untuk operasi: konteks disusun deterministik dari data aplikasi (kejadian padam, FLISR,
// simulasi rencana, laporan pelanggan, keandalan), LLM hanya menulis analisis/narasi.

var aiOpsTasks = []string{"outage", "plan", "shift", "report", "insights", "load"}

type aiOpsReq struct {
	Task     string       `json:"task"`
	OutageID int64        `json:"outage_id"`
	PlanID   int64        `json:"plan_id"`
	ReportID int64        `json:"report_id"`
	Hours    int          `json:"hours"`
	Provider string       `json:"provider"`
	Model    string       `json:"model"`
	Messages []ai.Message `json:"messages"` // pertanyaan lanjutan (opsional)
}

// aiTaskPrompt: instruksi bawaan per tugas.
func aiTaskPrompt(task string, en bool) string {
	id := map[string]string{
		"outage": "Analisis kejadian padam ini. Susun: (1) ringkasan situasi & dampak, (2) dugaan lokasi gangguan — seksi paling mungkin beserta alasannya (riwayat, laporan pelanggan), " +
			"(3) langkah isolasi & pemulihan yang disarankan berurutan dengan kode alat (mengacu usulan FLISR & batas kapasitas), (4) risiko & perhatian K3, " +
			"(5) draf pesan singkat informasi pemadaman untuk pelanggan (maks. 300 karakter).",
		"plan": "Tinjau rencana manuver ini. Nilai apakah urutan langkah aman dan logis, jelaskan risiko (paralel, beban lebih, pelanggan padam tambahan) dari hasil simulasi, " +
			"sarankan perbaikan urutan/langkah bila perlu, dan buat checklist K3 & koordinasi sebelum eksekusi. Akhiri dengan rekomendasi: LAYAK / PERLU PERBAIKAN.",
		"shift": "Buat laporan serah terima shift untuk operator berikutnya: ringkasan kejadian & manuver selama shift, kondisi jaringan saat ini, pekerjaan yang masih terbuka " +
			"(padam aktif, laporan pelanggan, rencana manuver), temuan yang perlu diawasi, dan prioritas tindakan shift berikutnya. Gunakan poin-poin singkat.",
		"report": "Tulis ringkasan eksekutif laporan berkala ini untuk manajemen (maks. 300 kata): kinerja keandalan (SAIDI, SAIFI, ENS) dibanding target & periode sebelumnya, " +
			"kejadian menonjol, wilayah & penyulang bermasalah, layanan laporan pelanggan (SLA), lalu 3 rekomendasi prioritas.",
		"load": "Analisis kondisi pembebanan trafo GI & penyulang berikut untuk perencana & operator: (1) ringkasan beban sistem (puncak, tren, prakiraan besok), " +
			"(2) trafo/penyulang kritis (beban lebih, jam di atas 80%/100%) dan risikonya, (3) anomali data & kondisi yang perlu ditindaklanjuti (bedakan masalah telemetri vs jaringan), " +
			"(4) rekomendasi: pelimpahan beban/manuver, pemecahan beban, uprating, perbaikan titik ukur, dengan prioritas.",
		"insights": "Analisis temuan operasi berikut. Kelompokkan menurut prioritas penanganan, jelaskan kemungkinan akar masalah tiap kelompok, " +
			"dan usulkan rencana tindakan (korektif segera & pemeliharaan preventif 30 hari) dengan penanggung jawab fungsi (operasi, pemeliharaan, pelayanan pelanggan).",
	}
	eng := map[string]string{
		"outage":   "Analyze this outage: (1) situation & impact summary, (2) likely fault location — most probable section and why (history, customer reports), (3) recommended isolation & restoration steps in order with device codes (based on the FLISR proposal & capacity limits), (4) risks & safety notes, (5) a short customer outage notice (max 300 characters).",
		"plan":     "Review this switching plan: is the step order safe and logical, what risks the simulation shows (paralleling, overload, extra customers off), suggested fixes, and a safety & coordination checklist before execution. End with a verdict: READY / NEEDS CHANGES.",
		"shift":    "Write a shift handover report for the next operator: events & switching during the shift, current network condition, open work (active outages, customer reports, switching plans), items to watch, and priorities for the next shift. Use short bullet points.",
		"report":   "Write an executive summary of this periodic report for management (max 300 words): reliability (SAIDI, SAIFI, ENS) vs targets and the previous period, notable events, problem regions & feeders, customer report service (SLA), then 3 priority recommendations.",
		"load":     "Analyze the transformer & feeder loading below for planners & operators: (1) system load summary (peak, trend, tomorrow's forecast), (2) critical transformers/feeders (overload, hours above 80%/100%) and risks, (3) data & condition anomalies to follow up (telemetry vs network issues), (4) prioritized recommendations: load transfer/switching, load splitting, uprating, metering fixes.",
		"insights": "Analyze the following operational findings. Group them by handling priority, explain likely root causes, and propose an action plan (immediate corrective & 30-day preventive maintenance) with the responsible function (operations, maintenance, customer service).",
	}
	if en {
		return eng[task]
	}
	return id[task]
}

func fmtT(t time.Time) string { return t.In(jakartaLoc()).Format("2006-01-02 15:04") }

// sig: indeks keandalan dengan 4 angka signifikan (SAIDI sistem bisa sangat kecil).
func sig(v float64) string { return strconv.FormatFloat(v, 'g', 4, 64) }

func (s *Server) nameOfRegions(ctx context.Context, regions map[string]int) string {
	if len(regions) == 0 {
		return ""
	}
	sum, _ := s.d.Graph.PowerSummary()
	regs, err := s.d.Boundaries.Regions(ctx, sum.Customers.Total)
	if err != nil {
		return ""
	}
	parts := []string{}
	for _, r := range regs {
		if n := regions[fmt.Sprint(r.ID)]; n > 0 && r.Level == "ulp" {
			parts = append(parts, fmt.Sprintf("ULP %s (UP3 %s): %d pelanggan", r.Name, r.Parent, n))
		}
	}
	return strings.Join(parts, "; ")
}

// aiOutageContext: kejadian, ringkasan dampak, kandidat seksi, usulan FLISR, laporan & riwayat.
func (s *Server) aiOutageContext(ctx context.Context, id int64) (string, error) {
	o, _, err := s.d.Power.GetOutage(ctx, id)
	if err != nil {
		return "", err
	}
	gis.ApplyReliability(&o, time.Time{}, time.Time{}, s.reliabilityParams())
	var sm outageSum
	_ = json.Unmarshal(o.Summary, &sm)
	var b strings.Builder
	state := "AKTIF"
	if o.EndedAt != nil {
		state = "selesai " + fmtT(*o.EndedAt)
	}
	fmt.Fprintf(&b, "Kejadian padam #%d kategori %s level %s, penyebab %s %s (%s), mulai %s, %s, durasi %.0f menit.\n",
		o.ID, o.Kind, o.Level, o.CauseNodeType, o.CauseNodeCode, o.CauseKind, fmtT(o.StartedAt), state, o.DurationSec/60)
	feeders := []string{}
	for _, f := range sm.Feeders {
		feeders = append(feeders, f.Code)
	}
	gis_ := []string{}
	for _, g := range sm.GI {
		gis_ = append(gis_, g.Code)
	}
	fmt.Fprintf(&b, "Dampak: %d pelanggan, %d gardu distribusi, beban kontrak %.0f kVA, pelanggan·menit %.0f, ENS %.1f kWh (%s). Penyulang: %s. GI: %s.\n",
		o.Customers, sm.GD, sm.LoadVA/1000, o.CustomerMinutes, o.ENSkWh, fmtRp(o.ENSRp), strings.Join(feeders, ", "), strings.Join(gis_, ", "))
	if rn := s.nameOfRegions(ctx, o.Regions); rn != "" {
		fmt.Fprintf(&b, "Wilayah terdampak: %s.\n", rn)
	}
	if o.ParentID != nil {
		fmt.Fprintf(&b, "Ini kejadian lanjutan (sisa padam) dari kejadian #%d.\n", *o.ParentID)
	}
	// riwayat gangguan di alat penyebab
	var hist int
	_ = s.d.Pool.QueryRow(ctx, `SELECT count(*) FROM outages WHERE cause_node_id = $1 AND id <> $2 AND kind IN ('GANGGUAN','BENCANA ALAM')
		AND started_at > now() - interval '365 days'`, o.CauseNodeID, o.ID).Scan(&hist)
	fmt.Fprintf(&b, "Riwayat: %s mengalami %d gangguan lain dalam 365 hari.\n", o.CauseNodeCode, hist)
	if mans, err := s.d.Power.ListManeuvers(ctx, o.CauseNodeID, 8); err == nil && len(mans) > 0 {
		b.WriteString("Manuver terakhir pada alat penyebab:\n")
		for _, m := range mans {
			fmt.Fprintf(&b, "- %s %s %s oleh %s %s\n", fmtT(m.CreatedAt), strings.ToUpper(m.Action), m.Kind, m.Username, strings.TrimSpace(m.Note))
		}
	}
	// laporan pelanggan yang tertaut
	if rows, err := s.d.Pool.Query(ctx, `SELECT ticket, category, priority, status, received_at, channel, left(description, 160), customer_code
		FROM customer_reports WHERE outage_id = $1 ORDER BY received_at LIMIT 25`, o.ID); err == nil {
		n := 0
		for rows.Next() {
			var t, cat, pri, st, ch, desc, cust string
			var at time.Time
			if rows.Scan(&t, &cat, &pri, &st, &at, &ch, &desc, &cust) == nil {
				if n == 0 {
					b.WriteString("Laporan pelanggan tertaut:\n")
				}
				n++
				fmt.Fprintf(&b, "- %s %s %s %s (%s, %s, pelanggan %s): %s\n", t, fmtT(at), cat, pri, st, ch, cust, desc)
			}
		}
		rows.Close()
		if n == 0 {
			b.WriteString("Belum ada laporan pelanggan yang tertaut.\n")
		}
	}
	// kandidat seksi gangguan & usulan FLISR untuk seksi paling mungkin
	if o.EndedAt == nil {
		secs, err := s.flisrSections(ctx, o.CauseKind, o.CauseNodeID)
		if err == nil && len(secs) > 0 {
			b.WriteString("Kandidat seksi gangguan di hilir alat penyebab (urut dari hulu):\n")
			best := 0
			for i, sec := range secs {
				if i < 12 {
					label := sec.Code
					if sec.EntryCode != "" {
						label = "masuk lewat " + sec.EntryCode
					}
					fmt.Fprintf(&b, "- seksi %s: %d pelanggan, panjang %.0f m, batas [%s], riwayat gangguan 365 hari %d, laporan terbuka %d\n",
						label, sec.Customers, sec.LengthM, strings.Join(sec.BoundaryCodes, ", "), sec.History, sec.Reports)
				}
				if sec.Reports*10+sec.History > secs[best].Reports*10+secs[best].History {
					best = i
				}
			}
			sec := secs[best]
			if res, err := s.d.Graph.FLISR("node", sec.ID, s.simParams(), 2000); err == nil {
				b.WriteString(s.describeFlisr(ctx, res, sec))
			}
		}
	}
	return b.String(), nil
}

func (s *Server) describeFlisr(ctx context.Context, res *gis.FlisrResult, sec flisrSection) string {
	refs := []int64{res.Upstream, res.Tripped}
	refs = append(refs, res.Downstream...)
	for _, a := range res.Actions {
		refs = append(refs, a.TargetID)
	}
	for _, isl := range res.Islands {
		refs = append(refs, isl.Boundary)
		if isl.Tie != nil {
			refs = append(refs, isl.Tie.SwitchID, isl.Tie.Supporting)
		}
	}
	codes := s.codesFor(ctx, refs)
	var b strings.Builder
	label := sec.Code
	if sec.EntryCode != "" {
		label = "masuk lewat " + sec.EntryCode
	}
	fmt.Fprintf(&b, "Usulan FLISR (penasihat, belum dijalankan) untuk seksi paling mungkin (%s): seksi %d pelanggan %.0f m; isolasi hulu %s",
		label, res.SectionCustomers, res.SectionLengthM, codes[res.Upstream].Code)
	if res.Tripped > 0 {
		fmt.Fprintf(&b, ", alat trip yang ditutup kembali %s", codes[res.Tripped].Code)
	}
	b.WriteString(".\n")
	for _, isl := range res.Islands {
		if isl.Tie != nil {
			fmt.Fprintf(&b, "- pulau hilir %s (%d pelanggan): dipulihkan lewat tie %s dari %s, beban akhir %.0f%%\n",
				codes[isl.Boundary].Code, isl.Customers, codes[isl.Tie.SwitchID].Code, codes[isl.Tie.Supporting].Code, isl.Tie.PctAfter)
		} else {
			fmt.Fprintf(&b, "- pulau hilir %s (%d pelanggan): tidak dapat dipulihkan (%s)\n", codes[isl.Boundary].Code, isl.Customers, isl.Reason)
		}
	}
	if len(res.Actions) > 0 {
		b.WriteString("Langkah usulan:\n")
		for i, a := range res.Actions {
			fmt.Fprintf(&b, "%d. %s %s %s\n", i+1, strings.ToUpper(a.Action), codes[a.TargetID].Code, a.Note)
		}
	}
	if res.Sim != nil {
		fmt.Fprintf(&b, "Hasil simulasi: pelanggan padam sekarang %d → setelah %d, pulih %d, padam baru %d.\n",
			res.Sim.BaseCustomersOff, res.Sim.CustomersOffAfter, res.Sim.CustomersRestored, res.Sim.CustomersNewOff)
		for _, st := range res.Sim.Steps {
			for _, w := range st.Warnings {
				fmt.Fprintf(&b, "Peringatan langkah %d: %s %.0f%%\n", st.Seq, w.Code, w.Pct)
			}
		}
	}
	return b.String()
}

// aiPlanContext: rencana, langkah, dan simulasinya.
func (s *Server) aiPlanContext(ctx context.Context, id int64) (string, error) {
	p, err := s.d.Ops.GetPlan(ctx, id)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Rencana manuver #%d \"%s\" kategori %s, status %s, sumber %s, dibuat oleh %s %s.\n",
		p.ID, p.Title, p.Kind, p.Status, p.Source, p.CreatedByName, fmtT(p.CreatedAt))
	if strings.TrimSpace(p.Note) != "" {
		fmt.Fprintf(&b, "Catatan: %s\n", p.Note)
	}
	b.WriteString("Langkah:\n")
	for _, st := range p.Steps {
		fmt.Fprintf(&b, "%d. %s %s (%s) [%s] %s\n", st.Seq, strings.ToUpper(st.Action), st.TargetCode, st.TargetType, st.Status, st.Note)
	}
	res, err := s.d.Graph.Simulate(planActions(p), s.simParams(), 0)
	if err == nil && res != nil {
		heads := []int64{}
		for _, st := range res.Steps {
			for _, f := range st.Feeders {
				heads = append(heads, f.Head)
			}
		}
		codes := s.codesFor(ctx, heads)
		fmt.Fprintf(&b, "Simulasi (dari kondisi jaringan sekarang): pelanggan padam %d → %d, pulih %d, padam baru %d, beban dipulihkan %.0f kVA, beban padam baru %.0f kVA.\n",
			res.BaseCustomersOff, res.CustomersOffAfter, res.CustomersRestored, res.CustomersNewOff, res.LoadRestoredVA/1000, res.LoadNewOffVA/1000)
		for _, st := range res.Steps {
			loads := []string{}
			for _, f := range st.Feeders {
				loads = append(loads, fmt.Sprintf("%s %.0f%%", codes[f.Head].Code, f.Pct))
			}
			warns := []string{}
			for _, w := range st.Warnings {
				warns = append(warns, fmt.Sprintf("%s %.0f%%", w.Code, w.Pct))
			}
			fmt.Fprintf(&b, "- setelah langkah %d: padam %d (%+d), beban penyulang [%s], peringatan [%s], valid=%v\n",
				st.Seq, st.CustomersOff, st.CustomersDiff, strings.Join(loads, ", "), strings.Join(warns, ", "), st.Valid)
		}
	}
	return b.String(), nil
}

// aiShiftContext: aktivitas selama `hours` jam terakhir + kondisi saat ini.
func (s *Server) aiShiftContext(ctx context.Context, hours int, lang string) string {
	now := time.Now()
	from := now.Add(-time.Duration(hours) * time.Hour)
	var b strings.Builder
	fmt.Fprintf(&b, "Periode shift: %s s.d. %s (%d jam).\n", fmtT(from), fmtT(now), hours)
	if rc, err := s.loadRel(ctx, from, now); err == nil {
		t := rc.total()
		fmt.Fprintf(&b, "Selama shift: %d kejadian padam (%d sesaat), pelanggan·menit %.0f, ENS %.1f kWh (%s).\n", t.Outages, t.Momentary, t.CustomerMinutes, t.ENSkWh, fmtRp(t.ENSRp))
		for i, o := range rc.outages {
			if i >= 25 {
				break
			}
			end := "masih aktif"
			if o.EndedAt != nil {
				end = "selesai " + fmtT(*o.EndedAt)
			}
			fmt.Fprintf(&b, "- #%d %s %s %s mulai %s, %s, %d pelanggan, %.0f menit\n", o.ID, o.Kind, o.Level, o.CauseNodeCode, fmtT(o.StartedAt), end, o.Customers, o.DurationSec/60)
		}
	}
	if st, err := s.d.Exec.OpsStatsBetween(ctx, from, now, s.d.Configs.Float("ops.report_sla_minutes", 120)); err == nil {
		fmt.Fprintf(&b, "Manuver: %d (buka %d, tutup %d). Rencana dibuat %d, selesai %d. Event SOE serius %d. Laporan pelanggan masuk %d, selesai %d, masih terbuka %d, melewati SLA %d.\n",
			st.Maneuvers, st.ManeuversOpen, st.ManeuversClose, st.PlansCreated, st.PlansDone, st.SOESerious, st.Reports, st.ReportsResolved, st.ReportsOpen, st.ReportsOverdue)
	}
	if rows, err := s.d.Pool.Query(ctx, `SELECT created_at, action, kind, node_code, username, left(note, 120) FROM maneuvers
		WHERE created_at >= $1 ORDER BY created_at LIMIT 40`, from); err == nil {
		n := 0
		for rows.Next() {
			var at time.Time
			var act, kind, code, user, note string
			if rows.Scan(&at, &act, &kind, &code, &user, &note) == nil {
				if n == 0 {
					b.WriteString("Log manuver shift:\n")
				}
				n++
				fmt.Fprintf(&b, "- %s %s %s %s oleh %s %s\n", fmtT(at), strings.ToUpper(act), code, kind, user, note)
			}
		}
		rows.Close()
	}
	b.WriteString("\nKondisi saat ini:\n")
	sum, _ := s.d.Graph.PowerSummary()
	fmt.Fprintf(&b, "Pelanggan padam %d dari %d; penyulang padam %d, sebagian %d; switch terbuka %d.\n",
		sum.Customers.Off, sum.Customers.Total, sum.Feeders.Off, sum.Feeders.Partial, sum.OpenSwitches)
	if act, err := s.d.Power.ListOutages(ctx, true, 20); err == nil {
		for _, o := range act {
			fmt.Fprintf(&b, "- padam aktif #%d %s %s sejak %s (%.0f menit)\n", o.ID, o.Kind, o.CauseNodeCode, fmtT(o.StartedAt), o.DurationSec/60)
		}
	}
	if plans, err := s.d.Ops.ListPlans(ctx, "active", 20); err == nil {
		for _, p := range plans {
			fmt.Fprintf(&b, "- rencana #%d \"%s\" status %s (%d/%d langkah)\n", p.ID, p.Title, p.Status, p.StepsDone, p.StepsTotal)
		}
	}
	if ins, err := s.buildInsights(ctx, lang); err == nil && len(ins) > 0 {
		b.WriteString("Temuan otomatis:\n")
		for i, x := range ins {
			if i >= 15 {
				break
			}
			fmt.Fprintf(&b, "- [%s] %s. %s\n", x.Severity, x.Title, x.Detail)
		}
	}
	return b.String()
}

// aiReportContext: isi laporan berkala dalam bentuk ringkas.
func (s *Server) aiReportContext(ctx context.Context, id int64) (string, error) {
	r, err := s.d.Exec.GetReport(ctx, id)
	if err != nil {
		return "", err
	}
	if r.Category == "load" {
		return aiLoadReportContext(r), nil
	}
	var d struct {
		CustomersServed int                              `json:"customers_served"`
		Targets         targets                          `json:"targets"`
		Total           gis.ReliabilityGroup             `json:"total"`
		MTTR            float64                          `json:"mttr_min"`
		ByKind          map[string]*gis.ReliabilityGroup `json:"by_kind"`
		Regions         []regionOut                      `json:"regions"`
		TopFeeders      []feederAgg                      `json:"top_feeders"`
		TopOutages      []outageBrief                    `json:"top_outages"`
		Ops             gis.OpsStats                     `json:"ops"`
		Previous        struct {
			Total     gis.ReliabilityGroup `json:"total"`
			MTTR      float64              `json:"mttr_min"`
			Reports   int                  `json:"reports"`
			Maneuvers int                  `json:"maneuvers"`
		} `json:"previous"`
	}
	if err := json.Unmarshal(r.Data, &d); err != nil {
		return "", err
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%s (periode %s s.d. %s). Pelanggan dilayani %d.\n", r.Title, fmtT(r.PeriodStart), fmtT(r.PeriodEnd), d.CustomersServed)
	t, p := d.Total, d.Previous.Total
	fmt.Fprintf(&b, "Keandalan: SAIDI %s menit/plg (sebelumnya %s; target pro-rata %s; target tahunan %s), SAIFI %s kali/plg (sebelumnya %s; target pro-rata %s; tahunan %s).\n",
		sig(t.SAIDI), sig(p.SAIDI), sig(d.Targets.SAIDIPeriod), sig(d.Targets.SAIDIYear), sig(t.SAIFI), sig(p.SAIFI), sig(d.Targets.SAIFIPeriod), sig(d.Targets.SAIFIYear))
	fmt.Fprintf(&b, "Kejadian %d (sesaat %d; sebelumnya %d), pelanggan padam %d, ENS %.1f kWh %s (sebelumnya %s), rata-rata lama padam %.0f menit (sebelumnya %.0f).\n",
		t.Outages, t.Momentary, p.Outages, t.CustomersOut, t.ENSkWh, fmtRp(t.ENSRp), fmtRp(p.ENSRp), d.MTTR, d.Previous.MTTR)
	kinds := []string{}
	for k, g := range d.ByKind {
		kinds = append(kinds, fmt.Sprintf("%s %d kejadian SAIDI %s", k, g.Outages, sig(g.SAIDI)))
	}
	sort.Strings(kinds)
	fmt.Fprintf(&b, "Per kategori: %s.\n", strings.Join(kinds, "; "))
	regs := []regionOut{}
	for _, rg := range d.Regions {
		if rg.Rel.CustomerMinutes > 0 {
			regs = append(regs, rg)
		}
	}
	sort.Slice(regs, func(i, j int) bool { return regs[i].Rel.SAIDI > regs[j].Rel.SAIDI })
	for i, rg := range regs {
		if i >= 8 {
			break
		}
		name := rg.Level + " " + rg.Name
		if rg.Level == "outside" {
			name = "di luar batas wilayah"
		}
		fmt.Fprintf(&b, "- wilayah %s (%d pelanggan): SAIDI %s, SAIFI %s, %d kejadian, ENS %s\n", name, rg.Customers, sig(rg.Rel.SAIDI), sig(rg.Rel.SAIFI), rg.Rel.Outages, fmtRp(rg.Rel.ENSRp))
	}
	for i, f := range d.TopFeeders {
		if i >= 8 {
			break
		}
		fmt.Fprintf(&b, "- penyulang %s: %d kejadian (%d gangguan), %.0f pelanggan·menit, ENS %s\n", f.Code, f.Outages, f.Faults, f.CustomerMinutes, fmtRp(f.ENSRp))
	}
	for i, o := range d.TopOutages {
		if i >= 8 {
			break
		}
		fmt.Fprintf(&b, "- kejadian #%d %s %s %s: %d pelanggan, %.0f menit, %.0f pelanggan·menit\n", o.ID, o.Kind, o.CauseCode, fmtT(o.StartedAt), o.Customers, o.DurationMin, o.CustomerMinutes)
	}
	st := d.Ops
	fmt.Fprintf(&b, "Operasi: %d manuver (sebelumnya %d), %d rencana selesai (%d dari FLISR). Laporan pelanggan %d (sebelumnya %d), selesai %d, melewati SLA %d, rata-rata penyelesaian %.0f menit, tertaut kejadian padam %d.\n",
		st.Maneuvers, d.Previous.Maneuvers, st.PlansDone, st.PlansFlisr, st.Reports, d.Previous.Reports, st.ReportsResolved, st.ReportsOverdue, st.ReportAvgResolveM, st.ReportsLinked)
	if strings.TrimSpace(r.Narrative) != "" {
		fmt.Fprintf(&b, "Ringkasan tersimpan sebelumnya:\n%s\n", r.Narrative)
	}
	return b.String(), nil
}

// aiInsightsContext: temuan otomatis + keandalan tahun berjalan & penyulang 30 hari.
func (s *Server) aiInsightsContext(ctx context.Context, lang string) string {
	var b strings.Builder
	now := time.Now()
	loc := jakartaLoc()
	y0 := time.Date(now.In(loc).Year(), 1, 1, 0, 0, 0, 0, loc)
	if yrc, err := s.loadRel(ctx, y0, now); err == nil {
		t := yrc.total()
		tg := s.targetsFor(y0, now)
		fmt.Fprintf(&b, "Tahun berjalan: SAIDI %s (target pro-rata %s, tahunan %s), SAIFI %s (target pro-rata %s, tahunan %s), %d kejadian, ENS %s.\n",
			sig(t.SAIDI), sig(tg.SAIDIPeriod), sig(tg.SAIDIYear), sig(t.SAIFI), sig(tg.SAIFIPeriod), sig(tg.SAIFIYear), t.Outages, fmtRp(t.ENSRp))
	}
	if rc, err := s.loadRel(ctx, now.AddDate(0, 0, -30), now); err == nil {
		b.WriteString("Penyulang terburuk 30 hari:\n")
		for i, f := range rc.feeders(nil) {
			if i >= 10 {
				break
			}
			fmt.Fprintf(&b, "- %s: %d kejadian (%d gangguan, %d sesaat), %.0f pelanggan·menit, ENS %s\n", f.Code, f.Outages, f.Faults, f.Momentary, f.CustomerMinutes, fmtRp(f.ENSRp))
		}
	}
	ins, _ := s.buildInsights(ctx, lang)
	if len(ins) == 0 {
		b.WriteString("Tidak ada temuan otomatis saat ini.\n")
	} else {
		b.WriteString("Temuan otomatis:\n")
		for _, x := range ins {
			fmt.Fprintf(&b, "- [%s] %s. %s\n", x.Severity, x.Title, x.Detail)
		}
	}
	return b.String()
}

// POST /api/ai/ops {task, outage_id|plan_id|report_id|hours, provider?, model?, messages?}
func (s *Server) aiOps(c *gin.Context) {
	var req aiOpsReq
	if err := c.ShouldBindJSON(&req); err != nil {
		failT(c, http.StatusBadRequest, "common.bad_payload")
		return
	}
	if !inList(req.Task, aiOpsTasks) {
		failT(c, http.StatusBadRequest, "ai.ops_bad_task")
		return
	}
	if (req.Task == "outage" && req.OutageID <= 0) || (req.Task == "plan" && req.PlanID <= 0) || (req.Task == "report" && req.ReportID <= 0) {
		failT(c, http.StatusBadRequest, "ai.ops_need_target")
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
	ctx := c.Request.Context()
	lang := string(middleware.GetLang(c))
	en := lang == "en"
	var data string
	var err error
	target := ""
	switch req.Task {
	case "outage":
		data, err = s.aiOutageContext(ctx, req.OutageID)
		target = fmt.Sprint(req.OutageID)
	case "plan":
		data, err = s.aiPlanContext(ctx, req.PlanID)
		target = fmt.Sprint(req.PlanID)
	case "report":
		data, err = s.aiReportContext(ctx, req.ReportID)
		target = fmt.Sprint(req.ReportID)
	case "shift":
		if req.Hours <= 0 || req.Hours > 24 {
			req.Hours = 8
		}
		data = s.aiShiftContext(ctx, req.Hours, lang)
		target = fmt.Sprint(req.Hours)
	case "insights":
		data = s.aiInsightsContext(ctx, lang)
	case "load":
		if s.d.Load == nil {
			failT(c, http.StatusBadRequest, "ai.ops_bad_task")
			return
		}
		data = s.aiLoadContext(ctx)
	}
	if err != nil {
		handleErr(c, err)
		return
	}
	if len(data) > 40000 {
		data = data[:40000]
	}
	system := "Anda adalah asisten AI pusat operasi (dispatcher) QuadranGIS untuk jaringan distribusi listrik 20 kV/TR PLN. " +
		"Anda membantu operator & manajemen: analisis gangguan, FLISR, manuver, keandalan (SAIDI/SAIFI/ENS), dan layanan pelanggan. " +
		"Gunakan HANYA data di bawah; jangan mengarang kode alat, angka, atau kejadian. Bila data kurang, sebutkan. " +
		"Semua langkah manuver bersifat saran: harus diverifikasi dan dijalankan operator berwenang sesuai SOP & K3. " +
		"Format: judul bagian singkat dan poin-poin; tebalkan kode alat penting."
	if en {
		system += " Reply in English."
	} else {
		system += " Jawab dalam bahasa Indonesia."
	}
	if extra := strings.TrimSpace(s.d.Configs.Str("ai.system_prompt", "")); extra != "" {
		system += "\n\n" + extra
	}
	system += "\n\nData (disusun otomatis oleh aplikasi, " + fmtT(time.Now()) + " WIB):\n" + data

	msgs := []ai.Message{{Role: "user", Content: aiTaskPrompt(req.Task, en)}}
	for _, m := range req.Messages {
		if (m.Role == "user" || m.Role == "assistant") && strings.TrimSpace(m.Content) != "" {
			msgs = append(msgs, ai.Message{Role: m.Role, Content: m.Content})
		}
	}
	if len(msgs) > aiMaxMessages {
		msgs = append(msgs[:1], msgs[len(msgs)-aiMaxMessages+1:]...)
	}
	// percakapan harus bergantian dan diakhiri pertanyaan pengguna
	clean := []ai.Message{}
	for _, m := range msgs {
		if len(clean) > 0 && clean[len(clean)-1].Role == m.Role {
			clean[len(clean)-1].Content += "\n\n" + m.Content
			continue
		}
		clean = append(clean, m)
	}
	if clean[len(clean)-1].Role != "user" {
		failT(c, http.StatusBadRequest, "common.bad_payload")
		return
	}
	s.streamLLM(c, p, key, base, model, system, clean, "ai.ops", gin.H{"task": req.Task, "target": target, "context_chars": len(data)})
}

// aiLoadContext: ringkasan pembebanan (puncak sistem, prakiraan, titik kritis, anomali, kesehatan trafo).
func (s *Server) aiLoadContext(ctx context.Context) string {
	var b strings.Builder
	ls := s.d.Load
	st := s.loadSettings()
	pts, err := ls.Repo.Points(ctx)
	if err != nil {
		return "Data pembebanan tidak tersedia."
	}
	base := basePoints(pts)
	ids := []int32{}
	cap := 0.0
	for _, p := range base {
		ids = append(ids, int32(p.ID))
		cap += p.CapMW(st.CapPF)
	}
	now := time.Now()
	l := now.In(load.Loc)
	today := time.Date(l.Year(), l.Month(), l.Day(), 0, 0, 0, 0, load.Loc)
	nGD := 0
	for _, p := range pts {
		if p.Kind == "gd" {
			nGD++
		}
	}
	fmt.Fprintf(&b, "Titik ukur SCADA/AMR: %d (trafo GI & penyulang %d, gardu distribusi %d). Beban dalam MW; daya mampu titik dasar %.0f MW (rating MVA × %.2f). Batas peringatan %.0f%%, beban lebih %.0f%%.\n",
		len(pts), len(pts)-nGD, nGD, cap, st.CapPF, st.Warn, st.Over)
	days, _ := ls.Repo.DailyGroup(ctx, ids, today.AddDate(0, 0, -30), today.AddDate(0, 0, 1), cap, st.Warn, st.Over)
	for i, d := range days {
		if i >= len(days)-7 {
			pt := ""
			if d.PeakTS != nil {
				pt = d.PeakTS.In(load.Loc).Format("15:04")
			}
			fmt.Fprintf(&b, "- %s: puncak sistem %.1f MW pukul %s (%.0f%%), energi %.0f MWh, faktor beban %.2f\n", d.Day, d.PeakMW, pt, d.PeakUtil, d.EnergyMWh, d.LoadFactor)
		}
	}
	hist, _ := ls.Repo.Series(ctx, ids, today.AddDate(0, 0, -35), today, cap)
	if _, info := load.Forecast(hist, today.AddDate(0, 0, 1), 1, st.Holidays, cap); info.PeakMW > 0 && info.PeakTS != nil {
		fmt.Fprintf(&b, "Prakiraan puncak sistem besok %.1f MW pukul %s (%.0f%% daya mampu, MAPE uji mundur %.1f%%).\n", info.PeakMW, info.PeakTS.In(load.Loc).Format("15:04"), info.PeakUtil, info.MAPE)
	}
	if lr, err := s.lossReport(ctx, today.AddDate(0, 0, -7), today); err == nil {
		d, g := lr["dist"].(load.BalanceResult), lr["gi"].(load.BalanceResult)
		fmt.Fprintf(&b, "Susut energi 7 hari (neraca meter): distribusi penyulang→gardu %.2f%% (%.0f MWh dari %.0f MWh, cakupan meter gardu %.0f%%, %d penyulang), trafo GI→penyulang %.2f%%, gabungan %.2f%%.\n",
			d.Pct, d.Loss, d.EIn, d.Coverage, d.Included, g.Pct, lr["combined_pct"])
		if w, ok := lr["worst_feeders"].([]lossRow); ok {
			for i, f := range w {
				if i >= 8 || f.Valid == 0 {
					break
				}
				fmt.Fprintf(&b, "- susut penyulang %s (UP3 %s): %.1f%% (%.1f MWh), cakupan %.0f%%\n", f.Code, f.UP3, f.Pct, f.Loss, f.Coverage)
			}
		}
	}
	rank, _ := s.loadRankItems(ctx, today.AddDate(0, 0, -7), today.AddDate(0, 0, 1), "")
	b.WriteString("Titik dengan pembebanan tertinggi 7 hari terakhir:\n")
	for i, r := range rank {
		if i >= 15 {
			break
		}
		kind := "penyulang"
		if r.Kind == "trafo_gi" {
			kind = "trafo GI"
		}
		fmt.Fprintf(&b, "- %s %s (UP3 %s): puncak %.2f MW = %.0f%%, jam >%.0f%%: %.1f, jam >%.0f%%: %.1f, faktor beban %.2f, ketidakseimbangan maks %.0f%%\n",
			kind, r.Code, r.UP3, r.PeakMW, r.PeakUtil, st.Warn, r.Hours80, st.Over, r.Hours100, r.LF, r.Imbalance)
	}
	if gds, _ := s.loadRankItems(ctx, today.AddDate(0, 0, -7), today.AddDate(0, 0, 1), "gd"); len(gds) > 0 {
		b.WriteString("Gardu distribusi dengan pembebanan tertinggi 7 hari terakhir:\n")
		for i, r := range gds {
			if i >= 10 {
				break
			}
			fmt.Fprintf(&b, "- gardu %s (penyulang %s): puncak %.0f kW = %.0f%%, jam >%.0f%%: %.1f\n", r.Code, r.Parent, r.PeakMW*1000, r.PeakUtil, st.Warn, r.Hours80)
		}
	}
	counts, open, _ := ls.Repo.AnomalyCounts(ctx, now.AddDate(0, 0, -7), now.Add(time.Hour))
	fmt.Fprintf(&b, "Anomali 7 hari (jenis → tingkat → jumlah): %v; masih terbuka %d.\n", counts, open)
	as, _ := ls.Repo.ListAnomalies(ctx, "", "", "active", 0, now.AddDate(0, 0, -7), now.Add(time.Hour), 400)
	pm := s.pointCodes(ctx)
	n := 0
	for _, a := range as {
		if a.Severity != "serious" && a.Severity != "critical" && a.Kind != "mismatch" && a.Kind != "level_shift" && a.Kind != "losses" {
			continue
		}
		if n >= 20 {
			break
		}
		n++
		v := ""
		if a.Value != nil {
			v = fmt.Sprintf(" nilai %.1f", *a.Value)
		}
		fmt.Fprintf(&b, "- [%s] %s pada %s %s s.d. %s (%d slot)%s %s\n", a.Severity, a.Kind, pm[a.PointID].Code, a.Start.In(load.Loc).Format("02/01 15:04"),
			a.End.In(load.Loc).Format("02/01 15:04"), a.Slots, v, a.Explanation)
	}
	return b.String()
}

// aiLoadReportContext: isi laporan beban dalam bentuk ringkas untuk ringkasan eksekutif.
func aiLoadReportContext(r gis.PeriodicReport) string {
	type stat struct {
		PeakMW     float64    `json:"peak_mw"`
		PeakTS     *time.Time `json:"peak_ts"`
		PeakUtil   float64    `json:"peak_util"`
		EnergyMWh  float64    `json:"energy_mwh"`
		LoadFactor float64    `json:"load_factor"`
		Hours80    float64    `json:"hours_over80"`
		Hours100   float64    `json:"hours_over100"`
	}
	type grp struct {
		Name     string  `json:"name"`
		PeakMW   float64 `json:"peak_mw"`
		PeakUtil float64 `json:"peak_util"`
		Energy   float64 `json:"energy_mwh"`
	}
	type rank struct {
		Code     string  `json:"code"`
		Kind     string  `json:"kind"`
		UP3      string  `json:"up3"`
		PeakMW   float64 `json:"peak_mw"`
		PeakUtil float64 `json:"peak_util"`
		Hours80  float64 `json:"hours_over80"`
		Hours100 float64 `json:"hours_over100"`
	}
	var d struct {
		CapMW  float64 `json:"cap_mw"`
		Losses *struct {
			Dist     load.BalanceResult `json:"dist"`
			GI       load.BalanceResult `json:"gi"`
			Combined float64            `json:"combined_pct"`
			Worst    []lossRow          `json:"worst_feeders"`
		} `json:"losses"`
		Active       int                       `json:"active"`
		System       stat                      `json:"system"`
		Previous     stat                      `json:"previous"`
		LastYear     stat                      `json:"last_year"`
		UP3          []grp                     `json:"up3"`
		GI           []grp                     `json:"gi"`
		TopFeeders   []rank                    `json:"top_feeders"`
		TopTrafos    []rank                    `json:"top_trafos"`
		Completeness float64                   `json:"completeness"`
		Counts       map[string]map[string]int `json:"anomaly_counts"`
	}
	_ = json.Unmarshal(r.Data, &d)
	var b strings.Builder
	fmt.Fprintf(&b, "%s (periode %s s.d. %s). %d titik ukur aktif, daya mampu titik dasar %.0f MW, kelengkapan data %.1f%%.\n", r.Title, fmtT(r.PeriodStart), fmtT(r.PeriodEnd), d.Active, d.CapMW, d.Completeness)
	pt := func(t *time.Time) string {
		if t == nil {
			return "-"
		}
		return fmtT(*t)
	}
	fmt.Fprintf(&b, "Beban puncak sistem %.1f MW (%s, %.0f%% daya mampu); periode sebelumnya %.1f MW; tahun lalu %.1f MW. Energi %.0f MWh (sebelumnya %.0f, tahun lalu %.0f). Faktor beban %.2f.\n",
		d.System.PeakMW, pt(d.System.PeakTS), d.System.PeakUtil, d.Previous.PeakMW, d.LastYear.PeakMW, d.System.EnergyMWh, d.Previous.EnergyMWh, d.LastYear.EnergyMWh, d.System.LoadFactor)
	for i, g := range d.UP3 {
		if i >= 8 {
			break
		}
		fmt.Fprintf(&b, "- UP3 %s: puncak %.1f MW (%.0f%%), energi %.0f MWh\n", g.Name, g.PeakMW, g.PeakUtil, g.Energy)
	}
	for i, g := range d.GI {
		if i >= 8 {
			break
		}
		fmt.Fprintf(&b, "- GI %s: puncak %.1f MW (%.0f%%)\n", g.Name, g.PeakMW, g.PeakUtil)
	}
	for _, l := range [][]rank{d.TopTrafos, d.TopFeeders} {
		for i, x := range l {
			if i >= 8 {
				break
			}
			fmt.Fprintf(&b, "- %s %s (UP3 %s): puncak %.2f MW = %.0f%%, jam ≥80%%: %.1f, jam ≥100%%: %.1f\n", x.Kind, x.Code, x.UP3, x.PeakMW, x.PeakUtil, x.Hours80, x.Hours100)
		}
	}
	if l := d.Losses; l != nil {
		fmt.Fprintf(&b, "Susut energi: distribusi %.2f%% (%.0f MWh, cakupan meter gardu %.0f%%), trafo GI→penyulang %.2f%%, gabungan %.2f%%.\n", l.Dist.Pct, l.Dist.Loss, l.Dist.Coverage, l.GI.Pct, l.Combined)
		for i, f := range l.Worst {
			if i >= 6 || f.Valid == 0 {
				break
			}
			fmt.Fprintf(&b, "- susut tertinggi: penyulang %s %.1f%% (%.1f MWh)\n", f.Code, f.Pct, f.Loss)
		}
	}
	fmt.Fprintf(&b, "Anomali per jenis & tingkat: %v\n", d.Counts)
	return b.String()
}
