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

	"ai.provider_unknown":      {"penyedia AI '%s' tidak dikenal", "unknown AI provider '%s'"},
	"ai.not_configured":        {"%s belum dikonfigurasi: isi API key di Konfigurasi (ai.*)", "%s is not configured: set its API key in Configuration (ai.*)"},
	"ai.provider_error":        {"%s gagal menjawab: %s", "%s failed to respond: %s"},
	"gis.ssot_duplicate":       {"Kode SSOT %s sudah dipakai %s #%d", "SSOT code %s is already used by %s #%d"},
	"admin.attributes_invalid": {"skema atribut harus berupa array JSON", "attribute schema must be a JSON array"},
	"power.not_switch":         {"objek #%d (%s) bukan alat switching", "object #%d (%s) is not a switching device"},
	"power.action_invalid":     {"action harus open/close", "action must be open or close"},
	"power.kind_invalid":       {"jenis manuver harus GANGGUAN, PEMELIHARAAN, atau MLS", "maneuver kind must be GANGGUAN, PEMELIHARAAN or MLS"},
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
