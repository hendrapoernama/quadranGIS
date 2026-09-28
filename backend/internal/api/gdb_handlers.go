package api

import (
	"context"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/gin-gonic/gin"

	"quadrangis/internal/gdbimport"
	"quadrangis/internal/stream"
)

// gdbManager dibuat sekali per server: hook memuat ulang graf & menetapkan unit batch.
func (s *Server) newGDBManager() *gdbimport.Manager {
	return gdbimport.New(s.d.Pool, s.d.Cfg.DatabaseURL, gdbimport.Hooks{
		AssignUnits: func(ctx context.Context, tag string) (int, error) {
			res, err := s.d.Units.AutoAssign(ctx, true, false, tag)
			if err != nil {
				return 0, err
			}
			s.afterUnitsChanged()
			return res.Total - res.Unmatched, nil
		},
		Reload: func(ctx context.Context) error {
			if err := s.d.Graph.Load(ctx, s.d.Pool); err != nil {
				log.Printf("[gdb-import] muat ulang graf gagal: %v", err)
				return err
			}
			s.d.Tiles.BumpVersion(ctx) // geometri batch berubah: tile lama tidak dipakai
			s.d.Hub.Publish(stream.Event{Type: "topology.rebuilt", At: time.Now()})
			return nil
		},
	})
}

// POST /api/admin/gdb-import?tag=&name=&assign_units=1&keep_staging=0 (badan: ZIP berisi folder .gdb)
func (s *Server) gdbImportStart(c *gin.Context) {
	tag := c.Query("tag")
	if !gdbimport.ValidTag(tag) {
		fail(c, http.StatusBadRequest, pick(c, "Tag wajib diisi: huruf, angka, titik, garis bawah, tanda hubung (maks. 40).",
			"Tag is required: letters, digits, dot, underscore, hyphen (max 40)."))
		return
	}
	if s.gdb.Running() {
		fail(c, http.StatusConflict, pick(c, "Impor lain sedang berjalan.", "Another import is running."))
		return
	}
	f, err := os.CreateTemp("", "gdbimp-*.zip")
	if err != nil {
		handleErr(c, err)
		return
	}
	n, err := io.Copy(f, io.LimitReader(c.Request.Body, gdbimport.MaxZipBytes+1))
	f.Close()
	if err != nil {
		os.Remove(f.Name())
		failT(c, http.StatusBadRequest, "common.bad_payload")
		return
	}
	if n > gdbimport.MaxZipBytes {
		os.Remove(f.Name())
		fail(c, http.StatusRequestEntityTooLarge, pick(c, "Berkas ZIP lebih dari 1 GB.", "The ZIP file exceeds 1 GB."))
		return
	}
	opt := gdbimport.Options{AssignUnits: c.Query("assign_units") != "0", KeepStaging: c.Query("keep_staging") == "1"}
	p := s.person(c)
	job, err := s.gdb.Start(f.Name(), c.Query("name"), n, tag, p.Username, opt)
	if err != nil {
		os.Remove(f.Name())
		if errors.Is(err, gdbimport.ErrBusy) {
			fail(c, http.StatusConflict, pick(c, "Impor lain sedang berjalan.", "Another import is running."))
			return
		}
		handleErr(c, err)
		return
	}
	s.d.Audit.Log(&p.UserID, p.Username, "gdb.import", "gdb_import", tag, gin.H{"file": c.Query("name"), "bytes": n, "options": opt}, clientIP(c))
	c.JSON(http.StatusAccepted, job)
}

// GET /api/admin/gdb-import/status — job yang sedang / terakhir berjalan (sejak server hidup)
func (s *Server) gdbImportStatus(c *gin.Context) {
	ok(c, gin.H{"job": s.gdb.Current(), "layers": gdbimport.Layers})
}

// GET /api/admin/gdb-import/batches — riwayat impor + jumlah objek per batch
func (s *Server) gdbImportBatches(c *gin.Context) {
	list, err := s.gdb.List(c.Request.Context())
	if err != nil {
		handleErr(c, err)
		return
	}
	ok(c, gin.H{"items": list})
}

// DELETE /api/admin/gdb-import/batches/:tag?apply=0|1 — hapus semua objek batch (apply=0: pratinjau)
func (s *Server) gdbImportDelete(c *gin.Context) {
	tag := c.Param("tag")
	apply := c.Query("apply") == "1"
	res, err := s.gdb.Delete(c.Request.Context(), tag, apply)
	switch {
	case errors.Is(err, gdbimport.ErrBusy):
		fail(c, http.StatusConflict, pick(c, "Impor sedang berjalan.", "An import is running."))
		return
	case errors.Is(err, gdbimport.ErrNotFound):
		fail(c, http.StatusNotFound, pick(c, "Batch impor tidak ditemukan.", "Import batch not found."))
		return
	case err != nil:
		handleErr(c, err)
		return
	}
	if apply {
		p := s.person(c)
		s.d.Audit.Log(&p.UserID, p.Username, "gdb.delete", "gdb_import", tag, gin.H{"nodes": res.Nodes, "edges": res.Edges, "foreign_edges": res.ForeignEdges}, clientIP(c))
	}
	ok(c, res)
}
