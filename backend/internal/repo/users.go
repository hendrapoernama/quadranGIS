// Package repo berisi akses data untuk entitas administrasi.
package repo

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"quadrangis/internal/models"
)

// ErrNotFound dikembalikan bila data tidak ditemukan.
var ErrNotFound = errors.New("data tidak ditemukan")

// ErrConflict dikembalikan bila terjadi duplikasi.
var ErrConflict = errors.New("data sudah ada")

// Users adalah repository pengguna.
type Users struct{ pool *pgxpool.Pool }

// NewUsers membuat repository pengguna.
func NewUsers(pool *pgxpool.Pool) *Users { return &Users{pool: pool} }

const userCols = `u.id::text, u.username, u.email, u.full_name, u.role_id::text, COALESCE(r.name,''), u.is_active,
	u.last_login_at, u.created_at, u.updated_at, u.password_hash`

func scanUser(row pgx.Row) (models.User, error) {
	var u models.User
	err := row.Scan(&u.ID, &u.Username, &u.Email, &u.FullName, &u.RoleID, &u.RoleName, &u.IsActive,
		&u.LastLoginAt, &u.CreatedAt, &u.UpdatedAt, &u.PasswordHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return u, ErrNotFound
	}
	return u, err
}

// List mengembalikan pengguna dengan pencarian dan paginasi.
func (r *Users) List(ctx context.Context, q string, page, size int) ([]models.User, int, error) {
	if page < 1 {
		page = 1
	}
	if size < 1 || size > 200 {
		size = 25
	}
	where := "WHERE 1=1"
	args := []any{}
	if s := strings.TrimSpace(q); s != "" {
		args = append(args, "%"+strings.ToLower(s)+"%")
		where += fmt.Sprintf(" AND (lower(u.username) LIKE $%d OR lower(u.full_name) LIKE $%d OR lower(u.email) LIKE $%d)", len(args), len(args), len(args))
	}
	var total int
	if err := r.pool.QueryRow(ctx, `SELECT count(*) FROM users u `+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	args = append(args, size, (page-1)*size)
	rows, err := r.pool.Query(ctx, `SELECT `+userCols+` FROM users u LEFT JOIN roles r ON r.id=u.role_id `+where+
		fmt.Sprintf(` ORDER BY u.username LIMIT $%d OFFSET $%d`, len(args)-1, len(args)), args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := []models.User{}
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, u)
	}
	return out, total, rows.Err()
}

// Count mengembalikan jumlah pengguna.
func (r *Users) Count(ctx context.Context) (int, error) {
	var n int
	err := r.pool.QueryRow(ctx, `SELECT count(*) FROM users`).Scan(&n)
	return n, err
}

// Get mengambil pengguna berdasarkan id.
func (r *Users) Get(ctx context.Context, id string) (models.User, error) {
	return scanUser(r.pool.QueryRow(ctx, `SELECT `+userCols+` FROM users u LEFT JOIN roles r ON r.id=u.role_id WHERE u.id=$1`, id))
}

// GetByUsername mengambil pengguna berdasarkan username.
func (r *Users) GetByUsername(ctx context.Context, username string) (models.User, error) {
	return scanUser(r.pool.QueryRow(ctx, `SELECT `+userCols+` FROM users u LEFT JOIN roles r ON r.id=u.role_id WHERE lower(u.username)=lower($1)`, username))
}

// Create menambahkan pengguna baru.
func (r *Users) Create(ctx context.Context, u models.User) (models.User, error) {
	var id string
	err := r.pool.QueryRow(ctx, `INSERT INTO users (username, email, full_name, password_hash, role_id, is_active)
		VALUES ($1,$2,$3,$4,$5,$6) RETURNING id::text`,
		strings.TrimSpace(u.Username), u.Email, u.FullName, u.PasswordHash, u.RoleID, u.IsActive).Scan(&id)
	if err != nil {
		if isUnique(err) {
			return u, ErrConflict
		}
		return u, err
	}
	return r.Get(ctx, id)
}

// Update memperbarui profil pengguna (kata sandi opsional).
func (r *Users) Update(ctx context.Context, u models.User, newHash string) (models.User, error) {
	var err error
	if newHash != "" {
		_, err = r.pool.Exec(ctx, `UPDATE users SET username=$2, email=$3, full_name=$4, role_id=$5, is_active=$6, password_hash=$7, updated_at=now() WHERE id=$1`,
			u.ID, strings.TrimSpace(u.Username), u.Email, u.FullName, u.RoleID, u.IsActive, newHash)
	} else {
		_, err = r.pool.Exec(ctx, `UPDATE users SET username=$2, email=$3, full_name=$4, role_id=$5, is_active=$6, updated_at=now() WHERE id=$1`,
			u.ID, strings.TrimSpace(u.Username), u.Email, u.FullName, u.RoleID, u.IsActive)
	}
	if err != nil {
		if isUnique(err) {
			return u, ErrConflict
		}
		return u, err
	}
	return r.Get(ctx, u.ID)
}

// Delete menghapus pengguna.
func (r *Users) Delete(ctx context.Context, id string) error {
	tag, err := r.pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// TouchLogin mencatat waktu login terakhir.
func (r *Users) TouchLogin(ctx context.Context, id string) {
	_, _ = r.pool.Exec(ctx, `UPDATE users SET last_login_at=now() WHERE id=$1`, id)
}

func isUnique(err error) bool {
	return err != nil && strings.Contains(err.Error(), "23505")
}
