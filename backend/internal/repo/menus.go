package repo

import (
	"context"
	"sort"

	"github.com/jackc/pgx/v5/pgxpool"

	"quadrangis/internal/models"
)

// Menus adalah repository menu navigasi.
type Menus struct{ pool *pgxpool.Pool }

// NewMenus membuat repository menu.
func NewMenus(pool *pgxpool.Pool) *Menus { return &Menus{pool: pool} }

// List mengembalikan seluruh menu (datar) beserta role yang boleh mengakses.
func (r *Menus) List(ctx context.Context) ([]models.Menu, error) {
	rows, err := r.pool.Query(ctx, `SELECT m.id::text, m.parent_id::text, m.title, m.title_en, m.path, m.icon, m.sort_order, m.is_active,
		COALESCE((SELECT array_agg(rm.role_id::text) FROM role_menus rm WHERE rm.menu_id=m.id), '{}')
		FROM menus m ORDER BY m.sort_order, m.title`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []models.Menu{}
	for rows.Next() {
		var m models.Menu
		if err := rows.Scan(&m.ID, &m.ParentID, &m.Title, &m.TitleEN, &m.Path, &m.Icon, &m.SortOrder, &m.IsActive, &m.RoleIDs); err != nil {
			return nil, err
		}
		if m.RoleIDs == nil {
			m.RoleIDs = []string{}
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// TreeForRole membangun pohon menu aktif yang boleh diakses sebuah role.
func (r *Menus) TreeForRole(ctx context.Context, roleID string) ([]*models.Menu, error) {
	all, err := r.List(ctx)
	if err != nil {
		return nil, err
	}
	allowed := map[string]*models.Menu{}
	for i := range all {
		m := all[i]
		if !m.IsActive {
			continue
		}
		for _, rid := range m.RoleIDs {
			if rid == roleID {
				mm := m
				mm.Children = []*models.Menu{}
				allowed[m.ID] = &mm
				break
			}
		}
	}
	return BuildTree(allowed), nil
}

// BuildTree menyusun pohon dari peta menu; anak tanpa induk yang diizinkan dinaikkan ke level atas.
func BuildTree(items map[string]*models.Menu) []*models.Menu {
	roots := []*models.Menu{}
	for _, m := range items {
		if m.ParentID != nil {
			if p, ok := items[*m.ParentID]; ok {
				p.Children = append(p.Children, m)
				continue
			}
		}
		roots = append(roots, m)
	}
	var sortRec func(list []*models.Menu)
	sortRec = func(list []*models.Menu) {
		sort.Slice(list, func(i, j int) bool {
			if list[i].SortOrder == list[j].SortOrder {
				return list[i].Title < list[j].Title
			}
			return list[i].SortOrder < list[j].SortOrder
		})
		for _, m := range list {
			if len(m.Children) > 0 {
				sortRec(m.Children)
			}
		}
	}
	sortRec(roots)
	out := roots[:0]
	for _, m := range roots {
		if m.Path == "" && len(m.Children) == 0 {
			continue
		}
		out = append(out, m)
	}
	return out
}

// Create menambahkan menu.
func (r *Menus) Create(ctx context.Context, m models.Menu) (models.Menu, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return m, err
	}
	defer tx.Rollback(ctx)
	var id string
	if err := tx.QueryRow(ctx, `INSERT INTO menus (parent_id, title, title_en, path, icon, sort_order, is_active) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id::text`,
		m.ParentID, m.Title, m.TitleEN, m.Path, m.Icon, m.SortOrder, m.IsActive).Scan(&id); err != nil {
		return m, err
	}
	for _, rid := range m.RoleIDs {
		if _, err := tx.Exec(ctx, `INSERT INTO role_menus (role_id, menu_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, rid, id); err != nil {
			return m, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return m, err
	}
	m.ID = id
	return m, nil
}

// Update memperbarui menu beserta role-nya.
func (r *Menus) Update(ctx context.Context, m models.Menu) (models.Menu, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return m, err
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, `UPDATE menus SET parent_id=$2, title=$3, title_en=$4, path=$5, icon=$6, sort_order=$7, is_active=$8, updated_at=now() WHERE id=$1`,
		m.ID, m.ParentID, m.Title, m.TitleEN, m.Path, m.Icon, m.SortOrder, m.IsActive)
	if err != nil {
		return m, err
	}
	if tag.RowsAffected() == 0 {
		return m, ErrNotFound
	}
	if _, err := tx.Exec(ctx, `DELETE FROM role_menus WHERE menu_id=$1`, m.ID); err != nil {
		return m, err
	}
	for _, rid := range m.RoleIDs {
		if _, err := tx.Exec(ctx, `INSERT INTO role_menus (role_id, menu_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, rid, m.ID); err != nil {
			return m, err
		}
	}
	return m, tx.Commit(ctx)
}

// Delete menghapus menu (beserta anak-anaknya).
func (r *Menus) Delete(ctx context.Context, id string) error {
	tag, err := r.pool.Exec(ctx, `DELETE FROM menus WHERE id=$1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
