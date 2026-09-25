// Package api mendefinisikan router HTTP dan seluruh handler.
package api

import (
	"errors"
	"log"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	"quadrangis/internal/gis"
	"quadrangis/internal/i18n"
	"quadrangis/internal/middleware"
	"quadrangis/internal/repo"
)

func ok(c *gin.Context, data any) { c.JSON(http.StatusOK, data) }

func fail(c *gin.Context, status int, msg string) {
	c.AbortWithStatusJSON(status, gin.H{"error": msg})
}

// tr menerjemahkan pesan sesuai bahasa permintaan.
func tr(c *gin.Context, key string, args ...any) string {
	return i18n.T(middleware.GetLang(c), key, args...)
}

// failT mengirim error dengan pesan terjemahan.
func failT(c *gin.Context, status int, key string, args ...any) {
	fail(c, status, tr(c, key, args...))
}

// domainMsg memakai pesan error domain yang sudah diterjemahkan (gis.Error) atau fallback key.
func domainMsg(c *gin.Context, err error, fallbackKey string) string {
	var ge *gis.Error
	if errors.As(err, &ge) {
		return ge.Error()
	}
	return tr(c, fallbackKey)
}

// handleErr memetakan error domain ke kode HTTP.
func handleErr(c *gin.Context, err error) {
	switch {
	case errors.Is(err, repo.ErrNotFound), errors.Is(err, gis.ErrNotFound):
		fail(c, http.StatusNotFound, domainMsg(c, err, "common.not_found"))
	case errors.Is(err, repo.ErrConflict), errors.Is(err, gis.ErrConflict):
		fail(c, http.StatusConflict, domainMsg(c, err, "common.conflict"))
	case errors.Is(err, gis.ErrBadRequest):
		fail(c, http.StatusBadRequest, domainMsg(c, err, "common.bad_payload"))
	case errors.Is(err, repo.ErrSystemRole):
		failT(c, http.StatusBadRequest, "admin.system_role")
	default:
		log.Printf("[api] %s %s: %v", c.Request.Method, c.Request.URL.Path, err)
		failT(c, http.StatusInternalServerError, "common.server_error")
	}
}

func queryInt(c *gin.Context, key string, def int) int {
	if v, err := strconv.Atoi(c.Query(key)); err == nil {
		return v
	}
	return def
}

func queryFloat(c *gin.Context, key string, def float64) float64 {
	if v, err := strconv.ParseFloat(c.Query(key), 64); err == nil {
		return v
	}
	return def
}

func paramInt64(c *gin.Context, key string) (int64, bool) {
	v, err := strconv.ParseInt(c.Param(key), 10, 64)
	if err != nil || v <= 0 {
		failT(c, http.StatusBadRequest, "common.invalid_id")
		return 0, false
	}
	return v, true
}

func validKind(c *gin.Context) bool {
	k := c.Param("kind")
	if k != "node" && k != "edge" {
		failT(c, http.StatusBadRequest, "gis.kind_invalid")
		return false
	}
	return true
}

func clientIP(c *gin.Context) string { return c.ClientIP() }
