package repo

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"quadrangis/internal/models"
)

// ErrSystemRole dikembalikan saat mencoba menghapus peran bawaan sistem.
var ErrSystemRole = errors.New("peran bawaan sistem tidak dapat dihapus")

// Roles adalah repository peran.
type Roles struct{ pool *pgxpool.Pool }

// NewRoles membuat repository peran.
func NewRoles(pool *pgxpool.Pool) *Roles { return &Roles{pool: pool} }

const roleCols = `r.id::text, r.name, r.description, r.permissions, r.is_system,
	(SELECT count(*) FROM users u WHERE u.role_id=r.id)::int, r.created_at, r.updated_at`

func scanRole(row pgx.Row) (models.Role, error) {
	var ro models.Role
	var perms []byte
	err := row.Scan(&ro.ID, &ro.Name, &ro.Description, &perms, &ro.IsSystem, &ro.UserCount, &ro.CreatedAt, &ro.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return ro, ErrNotFound
	}
	if err != nil {
		return ro, err
	}
	_ = json.Unmarshal(perms, &ro.Permissions)
	if ro.Permissions == nil {
		ro.Permissions = []string{}
	}
	return ro, nil
}

// List mengembalikan semua peran.
func (r *Roles) List(ctx context.Context) ([]models.Role, error) {
	rows, err := r.pool.Query(ctx, `SELECT `+roleCols+` FROM roles r ORDER BY r.is_system DESC, r.name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []models.Role{}
	for rows.Next() {
		ro, err := scanRole(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, ro)
	}
	return out, rows.Err()
}

// Get mengambil peran berdasarkan id.
func (r *Roles) Get(ctx context.Context, id string) (models.Role, error) {
	return scanRole(r.pool.QueryRow(ctx, `SELECT `+roleCols+` FROM roles r WHERE r.id=$1`, id))
}

// GetByName mengambil peran berdasarkan nama.
func (r *Roles) GetByName(ctx context.Context, name string) (models.Role, error) {
	return scanRole(r.pool.QueryRow(ctx, `SELECT `+roleCols+` FROM roles r WHERE r.name=$1`, name))
}

// Create menambahkan peran.
func (r *Roles) Create(ctx context.Context, ro models.Role) (models.Role, error) {
	perms, _ := json.Marshal(ro.Permissions)
	var id string
	err := r.pool.QueryRow(ctx, `INSERT INTO roles (name, description, permissions) VALUES ($1,$2,$3) RETURNING id::text`,
		ro.Name, ro.Description, perms).Scan(&id)
	if err != nil {
		if isUnique(err) {
			return ro, ErrConflict
		}
		return ro, err
	}
	return r.Get(ctx, id)
}

// Update memperbarui peran.
func (r *Roles) Update(ctx context.Context, ro models.Role) (models.Role, error) {
	perms, _ := json.Marshal(ro.Permissions)
	tag, err := r.pool.Exec(ctx, `UPDATE roles SET name=$2, description=$3, permissions=$4, updated_at=now() WHERE id=$1`,
		ro.ID, ro.Name, ro.Description, perms)
	if err != nil {
		if isUnique(err) {
			return ro, ErrConflict
		}
		return ro, err
	}
	if tag.RowsAffected() == 0 {
		return ro, ErrNotFound
	}
	return r.Get(ctx, ro.ID)
}

// Delete menghapus peran non-sistem.
func (r *Roles) Delete(ctx context.Context, id string) error {
	ro, err := r.Get(ctx, id)
	if err != nil {
		return err
	}
	if ro.IsSystem {
		return ErrSystemRole
	}
	_, err = r.pool.Exec(ctx, `DELETE FROM roles WHERE id=$1`, id)
	return err
}
