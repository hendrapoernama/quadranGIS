package api

import (
	"context"
	"net/http"
	"net/http/pprof"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5/pgxpool"

	"quadrangis/internal/auth"
	"quadrangis/internal/cache"
	"quadrangis/internal/config"
	"quadrangis/internal/gis"
	"quadrangis/internal/middleware"
	"quadrangis/internal/monitor"
	"quadrangis/internal/realtime"
	"quadrangis/internal/repo"
	"quadrangis/internal/stream"
)

// Deps adalah seluruh dependensi handler.
type Deps struct {
	Cfg         config.Config
	Pool        *pgxpool.Pool
	Cache       *cache.Cache
	JWT         *auth.JWT
	Captcha     *auth.Captcha
	Users       *repo.Users
	Roles       *repo.Roles
	Menus       *repo.Menus
	Configs     *repo.Configs
	Audit       *repo.Audit
	MetricsRepo *repo.Metrics
	Types       *gis.Types
	Tiles       *gis.Tiles
	Features    *gis.Features
	Graph       *gis.Graph
	Power       *gis.Power
	PowerFlow   *gis.PowerFlow
	Boundaries  *gis.Boundaries
	SLD         *gis.SLD
	Hub         *realtime.Hub
	Producer    *stream.Producer
	Collector   *monitor.Collector
	HTTPMetrics *middleware.Metrics
}

// Server membungkus dependensi untuk handler.
type Server struct {
	d        *Deps
	upgrader websocket.Upgrader
}

// NewRouter membangun router Gin lengkap.
func NewRouter(d *Deps) *gin.Engine {
	if d.Cfg.IsProduction() {
		gin.SetMode(gin.ReleaseMode)
	}
	s := &Server{d: d}
	allowed := map[string]struct{}{}
	for _, o := range d.Cfg.CORSOrigins {
		allowed[o] = struct{}{}
	}
	hostOnly := func(h string) string {
		if i := strings.LastIndex(h, ":"); i > 0 && !strings.Contains(h[i:], "]") {
			return strings.ToLower(h[:i])
		}
		return strings.ToLower(h)
	}
	s.upgrader = websocket.Upgrader{
		ReadBufferSize:  1024,
		WriteBufferSize: 4096,
		CheckOrigin: func(r *http.Request) bool {
			origin := r.Header.Get("Origin")
			if origin == "" {
				return true
			}
			if _, ok := allowed[origin]; ok {
				return true
			}
			// origin sama dengan host yang diminta (langsung atau di balik reverse proxy);
			// port diabaikan karena proxy dapat meneruskan Host tanpa port.
			u, err := url.Parse(origin)
			if err != nil {
				return false
			}
			oh := hostOnly(u.Host)
			if oh == hostOnly(r.Host) {
				return true
			}
			if fh := r.Header.Get("X-Forwarded-Host"); fh != "" && oh == hostOnly(fh) {
				return true
			}
			return false
		},
	}

	r := gin.New()
	r.Use(gin.Recovery())
	r.Use(middleware.Logger())
	r.Use(d.HTTPMetrics.Handler())
	r.Use(middleware.SecurityHeaders(d.Cfg.CookieSecure))
	r.Use(middleware.CORS(d.Cfg.CORSOrigins))
	r.Use(middleware.Locale())

	api := r.Group("/api")
	api.GET("/health", s.health)

	// autentikasi
	api.GET("/auth/captcha", s.captcha)
	api.POST("/auth/login", s.login)

	authed := api.Group("")
	authed.Use(middleware.Auth(d.JWT, func(ctx context.Context, userID string) ([]string, bool, error) {
		u, err := d.Users.Get(ctx, userID)
		if err != nil {
			return nil, false, err
		}
		if u.RoleID == nil {
			return []string{}, u.IsActive, nil
		}
		role, err := d.Roles.Get(ctx, *u.RoleID)
		if err != nil {
			return []string{}, u.IsActive, nil
		}
		return role.Permissions, u.IsActive, nil
	}))
	authed.POST("/auth/logout", s.logout)
	authed.GET("/auth/me", s.me)
	authed.POST("/auth/change-password", s.changePassword)
	authed.GET("/config/public", s.publicConfig)
	authed.GET("/ws", s.websocket)

	// GIS
	g := authed.Group("/gis")
	g.Use(middleware.RequirePermission("gis.view"))
	g.GET("/types", s.gisTypes)
	g.GET("/boundaries", s.gisBoundaries)
	g.GET("/tiles/:z/:x/:y", s.gisTile)
	g.GET("/features/bbox", s.gisBBox)
	g.GET("/features/:kind/:id", s.gisGetFeature)
	g.GET("/features/:kind/:id/history", s.gisFeatureHistory)
	g.GET("/nodes/:id/neighbors", s.gisNeighbors)
	g.GET("/snap", s.gisSnap)
	g.GET("/search", s.gisSearch)
	g.GET("/stats", s.gisStats)
	g.GET("/topology/status", s.topologyStatus)
	g.GET("/topology/validate", s.topologyValidate)

	ge := authed.Group("/gis")
	ge.Use(middleware.RequirePermission("gis.edit"))
	ge.POST("/features", s.gisCreateFeature)
	ge.PUT("/features/:kind/:id", s.gisUpdateFeature)
	ge.DELETE("/features/:kind/:id", s.gisDeleteFeature)
	ge.POST("/edges/:id/split", s.gisSplitEdge)
	ge.POST("/nodes/:id/merge", s.gisMergeAtJunction)
	ge.POST("/topology/rebuild", s.topologyRebuild)

	gt := authed.Group("/gis")
	gt.Use(middleware.RequirePermission("gis.trace"))
	gt.POST("/trace", s.gisTrace)

	// manuver jaringan & monitoring kelistrikan (nyala/padam)
	gm := authed.Group("/gis")
	gm.Use(middleware.RequireAnyPermission(OperatePermissions...))
	gm.POST("/maneuver", s.powerManeuver)

	// single line diagram
	sl := authed.Group("/sld")
	sl.Use(middleware.RequirePermission("gis.view"))
	sl.POST("/build", s.sldBuild)
	sl.GET("/resolve", s.sldResolve)
	sl.GET("/positions", s.sldPositions)
	sl.PUT("/positions", middleware.RequirePermission("gis.edit"), s.sldSavePositions)
	sl.DELETE("/positions", middleware.RequirePermission("gis.edit"), s.sldResetPositions)

	pw := authed.Group("/power")
	pw.Use(middleware.RequirePermission("gis.view"))
	pw.GET("/summary", s.powerSummary)
	pw.GET("/feeders", s.powerFeeders)
	pw.GET("/gi", s.powerGI)
	pw.GET("/customers", s.powerCustomers)
	pw.GET("/gardu", s.powerGardu)
	pw.GET("/outages", s.powerOutages)
	pw.GET("/outages/:id", s.powerOutage)
	pw.GET("/maneuvers", s.powerManeuvers)
	pw.GET("/reliability", s.powerReliability)
	pw.GET("/soe", s.powerSOE)

	// pertukaran data GIS: export (GeoJSON / GDB) butuh gis.view, import butuh gis.edit
	xg := authed.Group("/exchange")
	xg.POST("/export", middleware.RequirePermission("gis.view"), s.exchangeExport)
	xg.POST("/import", middleware.RequirePermission("gis.edit"), s.exchangeImport)

	// aliran daya (power flow)
	pf := authed.Group("/powerflow")
	pf.Use(middleware.RequirePermission("gis.view"))
	pf.GET("/params", s.pfGetParams)
	pf.GET("/results", s.pfResults)
	pf.POST("/feeder", s.pfFeeder)
	pf.POST("/run-all", s.pfRunAll)

	// asisten AI (LLM)
	aig := authed.Group("/ai")
	aig.Use(middleware.RequirePermission("ai.use"))
	aig.GET("/providers", s.aiProviders)
	aig.POST("/chat", s.aiChat)

	// administrasi
	adm := authed.Group("/admin")
	adm.GET("/users", middleware.RequirePermission("admin.users"), s.listUsers)
	adm.POST("/users", middleware.RequirePermission("admin.users"), s.createUser)
	adm.GET("/users/:id", middleware.RequirePermission("admin.users"), s.getUser)
	adm.PUT("/users/:id", middleware.RequirePermission("admin.users"), s.updateUser)
	adm.DELETE("/users/:id", middleware.RequirePermission("admin.users"), s.deleteUser)

	adm.GET("/roles", middleware.RequireAnyPermission("admin.roles", "admin.users", "admin.menus"), s.listRoles) // dipakai form pengguna & menu
	adm.GET("/permissions", middleware.RequirePermission("admin.roles"), s.listPermissions)
	adm.POST("/roles", middleware.RequirePermission("admin.roles"), s.createRole)
	adm.PUT("/roles/:id", middleware.RequirePermission("admin.roles"), s.updateRole)
	adm.DELETE("/roles/:id", middleware.RequirePermission("admin.roles"), s.deleteRole)

	adm.GET("/menus", middleware.RequirePermission("admin.menus"), s.listMenus)
	adm.POST("/menus", middleware.RequirePermission("admin.menus"), s.createMenu)
	adm.PUT("/menus/:id", middleware.RequirePermission("admin.menus"), s.updateMenu)
	adm.DELETE("/menus/:id", middleware.RequirePermission("admin.menus"), s.deleteMenu)

	adm.GET("/configs", middleware.RequirePermission("admin.config"), s.listConfigs)
	adm.PUT("/configs", middleware.RequirePermission("admin.config"), s.upsertConfigs)
	adm.DELETE("/configs/:key", middleware.RequirePermission("admin.config"), s.deleteConfig)

	adm.PUT("/layers/:code", middleware.RequirePermission("gis.settings"), s.updateLayerType)

	adm.GET("/monitoring/summary", middleware.RequirePermission("admin.monitoring"), s.monitoringSummary)
	adm.GET("/monitoring/series", middleware.RequirePermission("admin.monitoring"), s.monitoringSeries)
	adm.GET("/monitoring/audit", middleware.RequirePermission("admin.monitoring"), s.monitoringAudit)
	adm.GET("/monitoring/stream", middleware.RequirePermission("admin.monitoring"), s.monitoringStream)

	// profil runtime Go (pprof) untuk analisis performa; hanya admin monitoring
	pp := adm.Group("/monitoring/pprof", middleware.RequirePermission("admin.monitoring"))
	pp.GET("/", gin.WrapF(pprof.Index))
	pp.GET("/:name", func(c *gin.Context) {
		switch c.Param("name") {
		case "profile":
			pprof.Profile(c.Writer, c.Request)
		case "trace":
			pprof.Trace(c.Writer, c.Request)
		case "cmdline":
			pprof.Cmdline(c.Writer, c.Request)
		default:
			pprof.Handler(c.Param("name")).ServeHTTP(c.Writer, c.Request)
		}
	})

	r.NoRoute(func(c *gin.Context) { failT(c, http.StatusNotFound, "common.endpoint_404") })
	return r
}

// GET /api/health
func (s *Server) health(c *gin.Context) {
	ctx := c.Request.Context()
	dbOK := s.d.Pool.Ping(ctx) == nil
	_, redisOK := s.d.Cache.Ping(ctx)
	status := http.StatusOK
	if !dbOK {
		status = http.StatusServiceUnavailable
	}
	c.JSON(status, gin.H{
		"status": map[bool]string{true: "ok", false: "degraded"}[dbOK],
		"db":     dbOK,
		"redis":  redisOK,
		"kafka":  s.d.Producer.Healthy(),
		"time":   time.Now(),
	})
}

// GET /api/config/public
func (s *Server) publicConfig(c *gin.Context) {
	ok(c, gin.H{
		"configs":      s.d.Configs.Public(),
		"types":        s.d.Types.List(),
		"tile_version": s.d.Tiles.Version(c.Request.Context()),
		"graph":        s.d.Graph.Status(),
	})
}

// GET /api/ws
func (s *Server) websocket(c *gin.Context) {
	cl := middleware.GetClaims(c)
	conn, err := s.upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}
	username := ""
	if cl != nil {
		username = cl.Username
	}
	s.d.Hub.Serve(conn, username)
}
