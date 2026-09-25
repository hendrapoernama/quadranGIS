package gis

import "context"

// TotalLength menjumlahkan panjang (meter) sekumpulan garis.
func (f *Features) TotalLength(ctx context.Context, edgeIDs []int64) (float64, error) {
	if len(edgeIDs) == 0 {
		return 0, nil
	}
	var total float64
	err := f.pool.QueryRow(ctx, `SELECT COALESCE(sum(length_m),0) FROM gis_edges WHERE id = ANY($1::bigint[])`, edgeIDs).Scan(&total)
	return total, err
}

// LengthByType mengelompokkan panjang garis hasil trace per tipe.
func (f *Features) LengthByType(ctx context.Context, edgeIDs []int64) (map[string]float64, error) {
	out := map[string]float64{}
	if len(edgeIDs) == 0 {
		return out, nil
	}
	rows, err := f.pool.Query(ctx, `SELECT type_code, COALESCE(sum(length_m),0) FROM gis_edges WHERE id = ANY($1::bigint[]) GROUP BY type_code`, edgeIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var t string
		var l float64
		if err := rows.Scan(&t, &l); err != nil {
			return nil, err
		}
		out[t] = l
	}
	return out, rows.Err()
}
