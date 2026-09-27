// Package i18n menyediakan pesan dwibahasa (Indonesia/Inggris) untuk respons API.
package i18n

import (
	"fmt"
	"strings"
)

// Lang adalah kode bahasa yang didukung.
type Lang string

// Bahasa yang didukung.
const (
	ID Lang = "id"
	EN Lang = "en"
)

// Parse menentukan bahasa dari header Accept-Language / X-Lang.
func Parse(v string) Lang {
	v = strings.ToLower(strings.TrimSpace(v))
	if strings.HasPrefix(v, "en") {
		return EN
	}
	return ID
}

var msgs = map[string][2]string{
	// [0]=id, [1]=en
	"common.not_found":    {"data tidak ditemukan", "data not found"},
	"common.forbidden":    {"tidak diizinkan", "not allowed"},
	"common.conflict":     {"data sudah ada", "data already exists"},
	"common.server_error": {"terjadi kesalahan pada server", "an internal server error occurred"},
	"common.bad_payload":  {"payload tidak valid", "invalid payload"},
	"common.invalid_id":   {"id tidak valid", "invalid id"},
	"common.endpoint_404": {"endpoint tidak ditemukan", "endpoint not found"},
	"common.ok":           {"berhasil", "ok"},

	"auth.not_logged_in":     {"belum login", "not logged in"},
	"auth.session_invalid":   {"sesi tidak valid atau kedaluwarsa", "session is invalid or has expired"},
	"auth.no_permission":     {"tidak memiliki izin: %s", "missing permission: %s"},
	"auth.no_permission_any": {"tidak memiliki izin yang diperlukan", "you do not have the required permission"},
	"auth.required_fields":   {"username dan kata sandi wajib diisi", "username and password are required"},
	"auth.too_many_attempts": {"terlalu banyak percobaan login, coba lagi dalam 15 menit", "too many login attempts, try again in 15 minutes"},
	"auth.captcha_wrong":     {"jawaban captcha salah atau kedaluwarsa", "captcha answer is wrong or has expired"},
	"auth.bad_credentials":   {"username atau kata sandi salah", "wrong username or password"},
	"auth.account_disabled":  {"akun dinonaktifkan", "account is disabled"},
	"auth.user_not_found":    {"pengguna tidak ditemukan", "user not found"},
	"auth.old_password":      {"kata sandi lama salah", "old password is wrong"},
	"auth.pw_too_short":      {"kata sandi minimal 8 karakter", "password must be at least 8 characters"},
	"auth.pw_letters_digits": {"kata sandi harus mengandung huruf dan angka", "password must contain letters and digits"},

	"admin.username_required":   {"username wajib diisi", "username is required"},
	"admin.role_name_required":  {"nama role wajib diisi", "role name is required"},
	"admin.menu_title_required": {"judul menu wajib diisi", "menu title is required"},
	"admin.config_key_required": {"key konfigurasi wajib diisi", "configuration key is required"},
	"admin.cannot_disable_self": {"tidak dapat menonaktifkan akun sendiri", "you cannot deactivate your own account"},
	"admin.cannot_delete_self":  {"tidak dapat menghapus akun sendiri", "you cannot delete your own account"},
	"admin.system_role":         {"peran bawaan sistem tidak dapat dihapus", "built-in system roles cannot be deleted"},
	"admin.type_not_found":      {"tipe komponen tidak ditemukan", "component type not found"},
	"admin.min_zoom_range":      {"min_zoom harus 0..22", "min_zoom must be between 0 and 22"},
	"admin.graph_reloading":     {"graf topologi sedang dimuat ulang", "topology graph is being reloaded"},

	"gis.tile_invalid":       {"koordinat tile tidak valid", "invalid tile coordinates"},
	"gis.kind_invalid":       {"kind harus node/edge", "kind must be node or edge"},
	"gis.type_unknown":       {"tipe komponen '%s' tidak dikenal", "unknown component type '%s'"},
	"gis.type_not_kind":      {"tipe '%s' bukan %s", "type '%s' is not a %s"},
	"gis.kind_point":         {"titik", "point"},
	"gis.kind_line":          {"garis", "line"},
	"gis.status_invalid":     {"status harus closed/open", "status must be closed or open"},
	"gis.geom_point":         {"geometri harus Point", "geometry must be a Point"},
	"gis.point_invalid":      {"koordinat Point tidak valid", "invalid Point coordinates"},
	"gis.coords_range":       {"koordinat di luar jangkauan", "coordinates are out of range"},
	"gis.geom_line":          {"geometri harus LineString", "geometry must be a LineString"},
	"gis.line_min":           {"LineString minimal 2 titik", "a LineString needs at least 2 points"},
	"gis.coords_invalid":     {"koordinat tidak valid", "invalid coordinates"},
	"gis.line_min_distinct":  {"LineString minimal 2 titik berbeda", "a LineString needs at least 2 distinct points"},
	"gis.node_exists":        {"sudah ada %s #%d pada lokasi ini", "there is already a %s #%d at this location"},
	"gis.same_endpoints":     {"ujung awal dan akhir garis menyambung ke node yang sama (#%d)", "both ends of the line connect to the same node (#%d)"},
	"gis.endpoint_free":      {"ujung %s tidak terhubung ke node mana pun", "the line's %s is not connected to any node"},
	"gis.overlap_new_loc":    {"lokasi baru bertumpuk dengan %s #%d", "the new location overlaps %s #%d"},
	"gis.end_start":          {"awal", "start"},
	"gis.end_end":            {"akhir", "end"},
	"gis.msg_split":          {"Garis #%d dipisah otomatis menjadi #%d dan #%d pada titik baru #%d", "Line #%d was automatically split into #%d and #%d at new point #%d"},
	"gis.msg_snapped_node":   {"Ujung %s disambungkan ke %s #%d", "The line's %s was connected to %s #%d"},
	"gis.msg_snapped_bldg":   {"Ujung %s berada di dalam bangunan %s #%d dan disambungkan ke titik sambungnya", "The line's %s lies inside building %s #%d and was connected to its connection point"},
	"gis.geom_polygon":       {"geometri harus Polygon (atau Point untuk bangunan dengan ukuran bawaan)", "geometry must be a Polygon (or a Point for a building with default size)"},
	"gis.polygon_invalid":    {"Polygon tidak valid: cincin luar minimal 3 titik", "invalid Polygon: the outer ring needs at least 3 points"},
	"gis.split_point":        {"lng & lat titik pisah wajib diisi", "split point lng & lat are required"},
	"xchg.dup_in_file":       {"kode %s ganda di dalam berkas (sama dengan fitur #%d)", "code %s is duplicated in the file (same as feature #%d)"},
	"cs.proposed":            {"Diusulkan ke paket perubahan #%d — jaringan aktif belum berubah sampai paket disetujui & dirilis", "Proposed in change set #%d — the live network changes only after the set is approved & released"},
	"cs.import_proposed":     {"%d perubahan impor dimasukkan ke paket perubahan #%d untuk disetujui", "%d imported changes added to change set #%d for approval"},
	"gis.split_not_edge":     {"pemisahan hanya untuk garis", "only lines can be split"},
	"gis.msg_split_done":     {"Garis #%d dipisah pada titik baru #%d", "Line #%d was split at new point #%d"},
	"gis.merge_not_junction": {"penggabungan hanya pada junction", "merging is only possible at a junction"},
	"gis.merge_degree":       {"junction harus terhubung tepat dua garis (saat ini %d)", "the junction must connect exactly two lines (currently %d)"},
	"gis.merge_type":         {"kedua garis harus bertipe sama (%s vs %s)", "both lines must have the same type (%s vs %s)"},
	"gis.merge_loop":         {"kedua garis berujung pada node yang sama; tidak dapat digabung", "both lines end at the same node; cannot merge"},
	"gis.msg_merged":         {"Garis #%d dan #%d digabung menjadi #%d; junction #%d dihapus", "Lines #%d and #%d were merged into #%d; junction #%d removed"},
	"gis.msg_snapped_edge":   {"Ujung %s disambungkan ke garis #%d", "The line's %s was connected to line #%d"},
	"gis.msg_junction_new":   {"Junction baru #%d dibuat pada ujung %s", "New junction #%d created at the line's %s"},
	"gis.msg_junction_conv":  {"Junction #%d diubah menjadi %s (posisi sama)", "Junction #%d converted to %s (same position)"},
	"gis.msg_junction_gone":  {"Junction yatim #%d dihapus", "Orphan junction #%d removed"},
	"gis.msg_edges_moved":    {"%d garis terhubung ikut dipindahkan", "%d connected lines were moved as well"},
	"gis.msg_edges_removed":  {"%d garis terhubung ikut dihapus", "%d connected lines were removed as well"},
	"gis.bbox_format":        {"bbox harus minx,miny,maxx,maxy", "bbox must be minx,miny,maxx,maxy"},
	"gis.bbox_invalid":       {"bbox tidak valid", "invalid bbox"},
	"gis.lnglat_required":    {"lng & lat wajib", "lng & lat are required"},
	"gis.node_id_required":   {"node_id wajib diisi", "node_id is required"},
	"gis.direction_invalid":  {"direction harus down/up/connected", "direction must be down, up or connected"},
	"trace.no_start":         {"node awal tidak ditemukan di graf", "start node not found in the graph"},
	"trace.dist_updating":    {"jarak sumber sedang diperbarui; arah trace mungkin belum akurat", "source distances are being recalculated; trace direction may be inaccurate"},
	"trace.unreachable":      {"node awal tidak terhubung ke sumber daya; trace dilakukan tanpa arah (connected)", "start node is not connected to a power source; running an undirected (connected) trace"},
	"trace.start_open":       {"node awal berstatus open; penelusuran tetap dimulai dari node ini", "start node is open; the trace still starts from this node"},
	"trace.truncated":        {"hasil dipotong: melebihi batas jumlah node", "result truncated: node limit exceeded"},
	"valid.junction_no_edge": {"junction tanpa garis", "junction without lines"},
	"valid.isolated":         {"node terisolasi (tidak terhubung garis)", "isolated node (no connected lines)"},
	"valid.unreachable":      {"tidak terjangkau dari sumber (jalur terputus / switch open)", "unreachable from any source (broken path / open switch)"},

	"xchg.selection_required":  {"pilih area (tampilan peta / poligon) dan minimal satu layer", "select an area (map view / polygon) and at least one layer"},
	"xchg.too_large":           {"data terpilih melebihi %d MB (lebih dari %d fitur); perkecil area atau kurangi layer", "the selection exceeds %d MB (more than %d features); shrink the area or pick fewer layers"},
	"xchg.format_invalid":      {"format harus geojson atau gdb", "format must be geojson or gdb"},
	"xchg.file_too_large":      {"file melebihi batas %d MB", "the file exceeds the %d MB limit"},
	"xchg.not_geojson":         {"file bukan GeoJSON FeatureCollection yang valid", "the file is not a valid GeoJSON FeatureCollection"},
	"xchg.bad_geometry":        {"geometri tidak valid / multipart lebih dari satu bagian", "invalid geometry / multipart with more than one part"},
	"xchg.edge_needs_line":     {"garis (qgis_kind=edge) harus LineString", "a line (qgis_kind=edge) must be a LineString"},
	"xchg.node_needs_point":    {"titik/bangunan (qgis_kind=node) harus Point atau Polygon", "a point/building (qgis_kind=node) must be a Point or Polygon"},
	"xchg.id_not_found":        {"%s #%d tidak ditemukan (mungkin sudah dihapus)", "%s #%d was not found (it may have been deleted)"},
	"xchg.type_required":       {"fitur baru wajib punya type_code", "new features need a type_code"},
	"xchg.too_many_changes":    {"%d perubahan melebihi batas %d per import; bagi menjadi beberapa file", "%d changes exceed the limit of %d per import; split the file"},
	"pf.head_required":         {"head_id (kepala penyulang) wajib diisi", "head_id (feeder head) is required"},
	"pf.head_not_found":        {"kepala penyulang tidak ditemukan di graf", "feeder head not found in the graph"},
	"pf.not_head":              {"objek bukan kepala penyulang (kubikel outgoing di busbar GI)", "object is not a feeder head (outgoing cubicle on a substation busbar)"},
	"pf.not_energized":         {"penyulang tidak bertegangan (padam / kubikel terbuka); aliran daya tidak dapat dihitung", "feeder is not energized (outage / open cubicle); power flow cannot be computed"},
	"ai.provider_unknown":      {"penyedia AI '%s' tidak dikenal", "unknown AI provider '%s'"},
	"ai.not_configured":        {"%s belum dikonfigurasi: isi API key di Konfigurasi (ai.*)", "%s is not configured: set its API key in Configuration (ai.*)"},
	"ai.provider_error":        {"%s gagal menjawab: %s", "%s failed to respond: %s"},
	"gis.ssot_duplicate":       {"Kode SSOT %s sudah dipakai %s #%d", "SSOT code %s is already used by %s #%d"},
	"admin.attributes_invalid": {"skema atribut harus berupa array JSON", "attribute schema must be a JSON array"},
	"power.not_switch":         {"objek #%d (%s) bukan alat switching", "object #%d (%s) is not a switching device"},
	"power.action_invalid":     {"action harus open/close", "action must be open or close"},
	"ops.flisr_source":         {"gangguan di sisi sumber / gardu induk: di luar cakupan FLISR penyulang", "fault on the source / substation side: outside feeder FLISR scope"},
	"ops.flisr_no_switch":      {"tidak ada alat switching untuk mengisolasi seksi ini", "no switching device can isolate this section"},
	"ops.plan_invalid":         {"rencana tidak valid: isi judul, kategori, dan langkah yang benar", "invalid plan: fill in title, category and valid steps"},
	"ops.plan_not_draft":       {"hanya rencana berstatus draft yang dapat diubah / dihapus", "only draft plans can be changed / deleted"},
	"ops.plan_bad_status":      {"status rencana tidak sesuai untuk tindakan ini", "plan status does not allow this action"},
	"ops.plan_not_approved":    {"rencana harus disetujui sebelum dijalankan", "the plan must be approved before execution"},
	"ops.step_order":           {"jalankan langkah secara berurutan: langkah sebelumnya belum selesai", "run steps in order: a previous step is not finished"},
	"ops.step_done":            {"langkah ini sudah dijalankan / dilewati", "this step was already executed / skipped"},
	"ops.report_invalid":       {"kanal, kategori, status, atau prioritas laporan tidak valid", "invalid report channel, category, status or priority"},
	"field.photo_target":       {"foto harus ditautkan ke aset (node/saluran) atau laporan", "a photo must be linked to an asset (node/line) or a report"},
	"field.photo_invalid":      {"berkas foto tidak valid (JPEG/PNG)", "invalid photo file (JPEG/PNG)"},
	"field.photo_too_large":    {"foto terlalu besar (maks. %d KB)", "photo too large (max %d KB)"},
	"field.push_test_body":     {"Notifikasi uji berhasil diterima di perangkat ini.", "Test notification received on this device."},
	"exec.future_period":       {"periode laporan belum dimulai", "the report period has not started yet"},
	"ai.ops_bad_task":          {"tugas AI operasi tidak dikenal", "unknown AI operations task"},
	"ai.ops_need_target":       {"pilih kejadian padam / rencana / laporan untuk dianalisis", "select an outage / plan / report to analyze"},
	"ops.report_location":      {"isi pelanggan (kode/idpel), alamat, atau titik lokasi laporan", "provide a customer (code/idpel), address or location for the report"},
	"sld.graph_loading":        {"graf jaringan sedang dimuat setelah server dimulai ulang, diagram akan dicoba lagi otomatis", "the network graph is still loading after a server restart; the diagram will retry automatically"},
	"power.kind_invalid":       {"kategori pemadaman harus GANGGUAN, PEMELIHARAAN, MLS, MANUVER, atau BENCANA ALAM", "outage category must be GANGGUAN, PEMELIHARAAN, MLS, MANUVER or BENCANA ALAM"},
	"power.way_not_allowed":    {"manuver per arah hanya untuk alat multi-arah (LBS 3 way)", "per-way maneuvers are only for multi-way devices (3-way LBS)"},
	"power.way_invalid":        {"garis #%d tidak menempel pada alat #%d", "line #%d is not attached to device #%d"},
	"power.not_in_graph":       {"objek belum ada di graf jaringan (graf sedang dimuat?)", "object is not in the network graph (graph still loading?)"},
	"power.msg_open":           {"%s #%d dibuka (%s): %d objek padam, %d pelanggan", "%s #%d opened (%s): %d objects de-energized, %d customers"},
	"power.msg_close":          {"%s #%d ditutup (%s): %d objek menyala, %d pelanggan", "%s #%d closed (%s): %d objects energized, %d customers"},
}

// T mengembalikan pesan dalam bahasa yang diminta (fallback: Indonesia, lalu key).
func T(l Lang, key string, args ...any) string {
	pair, ok := msgs[key]
	if !ok {
		return key
	}
	tpl := pair[0]
	if l == EN {
		tpl = pair[1]
	}
	if len(args) == 0 {
		return tpl
	}
	return fmt.Sprintf(tpl, args...)
}
