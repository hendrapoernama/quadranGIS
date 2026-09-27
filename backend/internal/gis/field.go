package gis

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Field adalah persistensi fitur lapangan (versi mobile): foto aset, langganan push, aset terdekat.
type Field struct {
	pool *pgxpool.Pool
}

// NewField membuat repositori lapangan.
func NewField(pool *pgxpool.Pool) *Field { return &Field{pool: pool} }

// Nearby adalah satu aset di sekitar posisi pengguna.
type Nearby struct {
	Kind      string  `json:"kind"` // node
	ID        int64   `json:"id"`
	Code      string  `json:"code"`
	Name      string  `json:"name"`
	TypeCode  string  `json:"type_code"`
	Energized bool    `json:"energized"`
	Status    string  `json:"status"`
	Lng       float64 `json:"lng"`
	Lat       float64 `json:"lat"`
	DistanceM float64 `json:"distance_m"`
	Photos    int     `json:"photos"`
}

// NearbyNodes mengembalikan aset (bukan junction) terdekat dalam radius, urut jarak (indeks KNN GiST).
func (f *Field) NearbyNodes(ctx context.Context, lng, lat, radiusM float64, types []string, limit int) ([]Nearby, error) {
	if limit <= 0 || limit > 200 {
		limit = 30
	}
	rows, err := f.pool.Query(ctx, `WITH p AS (SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326) AS g)
		SELECT n.id, n.code, n.name, n.type_code, n.energized, n.status, ST_X(n.geom), ST_Y(n.geom),
		       ST_Distance(n.geom::geography, p.g::geography) AS d,
		       (SELECT count(*) FROM asset_photos ph WHERE ph.target_kind = 'node' AND ph.target_id = n.id)
		FROM gis_nodes n, p
		WHERE n.type_code <> 'junction' AND ($5::text[] IS NULL OR n.type_code = ANY($5))
		  AND ST_DWithin(n.geom::geography, p.g::geography, $3)
		ORDER BY n.geom <-> p.g LIMIT $4`, lng, lat, radiusM, limit, nullIfEmpty(types))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Nearby{}
	for rows.Next() {
		n := Nearby{Kind: "node"}
		if err := rows.Scan(&n.ID, &n.Code, &n.Name, &n.TypeCode, &n.Energized, &n.Status, &n.Lng, &n.Lat, &n.DistanceM, &n.Photos); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

func nullIfEmpty(s []string) []string {
	if len(s) == 0 {
		return nil
	}
	return s
}

// Photo adalah metadata satu foto aset.
type Photo struct {
	ID            int64     `json:"id"`
	ClientID      *string   `json:"client_id,omitempty"`
	TargetKind    string    `json:"target_kind"`
	TargetID      int64     `json:"target_id"`
	Mime          string    `json:"mime"`
	Width         int       `json:"width"`
	Height        int       `json:"height"`
	Bytes         int       `json:"bytes"`
	Lng           *float64  `json:"lng"`
	Lat           *float64  `json:"lat"`
	AccuracyM     *float64  `json:"accuracy_m"`
	TakenAt       time.Time `json:"taken_at"`
	Note          string    `json:"note"`
	CreatedByName string    `json:"created_by_name"`
	CreatedAt     time.Time `json:"created_at"`
}

const photoCols = `id, client_id, target_kind, target_id, mime, width, height, bytes, lng, lat, accuracy_m, taken_at, note, created_by_name, created_at`

func scanPhoto(row pgx.Row) (Photo, error) {
	var p Photo
	err := row.Scan(&p.ID, &p.ClientID, &p.TargetKind, &p.TargetID, &p.Mime, &p.Width, &p.Height, &p.Bytes, &p.Lng, &p.Lat, &p.AccuracyM, &p.TakenAt, &p.Note, &p.CreatedByName, &p.CreatedAt)
	if err == pgx.ErrNoRows {
		return p, ErrNotFound
	}
	return p, err
}

// ListPhotos mengembalikan foto sebuah target (terbaru dulu).
func (f *Field) ListPhotos(ctx context.Context, kind string, id int64, limit int) ([]Photo, error) {
	if limit <= 0 || limit > 200 {
		limit = 60
	}
	rows, err := f.pool.Query(ctx, `SELECT `+photoCols+` FROM asset_photos WHERE target_kind = $1 AND target_id = $2 ORDER BY taken_at DESC, id DESC LIMIT $3`, kind, id, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Photo{}
	for rows.Next() {
		p, err := scanPhoto(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// RecentPhotos mengembalikan foto terbaru (semua target), opsional milik pengguna tertentu.
func (f *Field) RecentPhotos(ctx context.Context, username string, limit int) ([]Photo, error) {
	if limit <= 0 || limit > 200 {
		limit = 30
	}
	rows, err := f.pool.Query(ctx, `SELECT `+photoCols+` FROM asset_photos WHERE ($1 = '' OR created_by_name = $1) ORDER BY created_at DESC LIMIT $2`, username, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Photo{}
	for rows.Next() {
		p, err := scanPhoto(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// GetPhoto mengembalikan metadata satu foto.
func (f *Field) GetPhoto(ctx context.Context, id int64) (Photo, error) {
	return scanPhoto(f.pool.QueryRow(ctx, `SELECT `+photoCols+` FROM asset_photos WHERE id = $1`, id))
}

// PhotoData mengembalikan isi gambar (atau thumbnail bila ada dan diminta).
func (f *Field) PhotoData(ctx context.Context, id int64, thumb bool) ([]byte, string, error) {
	var data []byte
	var mime string
	q := `SELECT image, mime FROM asset_photos WHERE id = $1`
	if thumb {
		q = `SELECT COALESCE(thumb, image), CASE WHEN thumb IS NULL THEN mime ELSE 'image/jpeg' END FROM asset_photos WHERE id = $1`
	}
	err := f.pool.QueryRow(ctx, q, id).Scan(&data, &mime)
	if err == pgx.ErrNoRows {
		return nil, "", ErrNotFound
	}
	return data, mime, err
}

// SavePhoto menyimpan foto; bila client_id sudah ada, foto lama dikembalikan (idempoten). created=false bila sudah ada.
func (f *Field) SavePhoto(ctx context.Context, p Photo, image, thumb []byte, userID *string) (Photo, bool, error) {
	if p.ClientID != nil && *p.ClientID != "" {
		if old, err := scanPhoto(f.pool.QueryRow(ctx, `SELECT `+photoCols+` FROM asset_photos WHERE client_id = $1`, *p.ClientID)); err == nil {
			return old, false, nil
		}
	}
	saved, err := scanPhoto(f.pool.QueryRow(ctx, `INSERT INTO asset_photos (client_id, target_kind, target_id, mime, image, thumb, width, height, bytes,
		lng, lat, accuracy_m, taken_at, note, created_by, created_by_name)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
		ON CONFLICT (client_id) DO UPDATE SET client_id = EXCLUDED.client_id
		RETURNING `+photoCols, p.ClientID, p.TargetKind, p.TargetID, p.Mime, image, thumb, p.Width, p.Height, len(image),
		p.Lng, p.Lat, p.AccuracyM, p.TakenAt, p.Note, userID, p.CreatedByName))
	return saved, err == nil, err
}

// DeletePhoto menghapus foto; bila owner tidak kosong hanya foto milik pengguna itu.
func (f *Field) DeletePhoto(ctx context.Context, id int64, owner string) error {
	tag, err := f.pool.Exec(ctx, `DELETE FROM asset_photos WHERE id = $1 AND ($2 = '' OR created_by_name = $2)`, id, owner)
	if err == nil && tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return err
}

// PushSub adalah langganan Web Push seorang pengguna.
type PushSub struct {
	ID        int64      `json:"id"`
	UserID    *string    `json:"-"`
	Username  string     `json:"username"`
	Endpoint  string     `json:"endpoint"`
	P256dh    string     `json:"-"`
	Auth      string     `json:"-"`
	Topics    []string   `json:"topics"`
	UserAgent string     `json:"user_agent"`
	CreatedAt time.Time  `json:"created_at"`
	LastOKAt  *time.Time `json:"last_ok_at"`
}

// PushTopics adalah topik notifikasi yang tersedia.
var PushTopics = []string{"outage", "report", "plan"}

// SavePushSub menyimpan / memperbarui langganan (endpoint unik).
func (f *Field) SavePushSub(ctx context.Context, s PushSub) error {
	_, err := f.pool.Exec(ctx, `INSERT INTO push_subscriptions (user_id, username, endpoint, p256dh, auth, topics, user_agent)
		VALUES ($1,$2,$3,$4,$5,$6,$7)
		ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, username = EXCLUDED.username, p256dh = EXCLUDED.p256dh,
			auth = EXCLUDED.auth, topics = EXCLUDED.topics, user_agent = EXCLUDED.user_agent, fail_count = 0`,
		s.UserID, s.Username, s.Endpoint, s.P256dh, s.Auth, s.Topics, s.UserAgent)
	return err
}

// DeletePushSub menghapus langganan berdasarkan endpoint.
func (f *Field) DeletePushSub(ctx context.Context, endpoint string) error {
	_, err := f.pool.Exec(ctx, `DELETE FROM push_subscriptions WHERE endpoint = $1`, endpoint)
	return err
}

// PushSubs mengembalikan langganan untuk topik tertentu (atau milik pengguna bila username diisi).
func (f *Field) PushSubs(ctx context.Context, topic, username string) ([]PushSub, error) {
	rows, err := f.pool.Query(ctx, `SELECT id, user_id, username, endpoint, p256dh, auth, topics, user_agent, created_at, last_ok_at
		FROM push_subscriptions WHERE ($1 = '' OR $1 = ANY(topics)) AND ($2 = '' OR username = $2) ORDER BY id`, topic, username)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PushSub{}
	for rows.Next() {
		var s PushSub
		if err := rows.Scan(&s.ID, &s.UserID, &s.Username, &s.Endpoint, &s.P256dh, &s.Auth, &s.Topics, &s.UserAgent, &s.CreatedAt, &s.LastOKAt); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// MarkPush mencatat hasil pengiriman; langganan yang gagal terus (≥ 5) atau kedaluwarsa dihapus.
func (f *Field) MarkPush(ctx context.Context, id int64, ok, gone bool) {
	switch {
	case gone:
		_, _ = f.pool.Exec(ctx, `DELETE FROM push_subscriptions WHERE id = $1`, id)
	case ok:
		_, _ = f.pool.Exec(ctx, `UPDATE push_subscriptions SET last_ok_at = now(), fail_count = 0 WHERE id = $1`, id)
	default:
		_, _ = f.pool.Exec(ctx, `UPDATE push_subscriptions SET fail_count = fail_count + 1 WHERE id = $1`, id)
		_, _ = f.pool.Exec(ctx, `DELETE FROM push_subscriptions WHERE id = $1 AND fail_count >= 5`, id)
	}
}
