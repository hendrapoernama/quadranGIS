// QuadranGIS backend: GIS kelistrikan berbasis web.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"quadrangis/internal/api"
	"quadrangis/internal/auth"
	"quadrangis/internal/cache"
	"quadrangis/internal/config"
	"quadrangis/internal/database"
	"quadrangis/internal/gis"
	"quadrangis/internal/middleware"
	"quadrangis/internal/models"
	"quadrangis/internal/monitor"
	"quadrangis/internal/realtime"
	"quadrangis/internal/repo"
	"quadrangis/internal/stream"
)

func main() {
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	cfg := config.Load()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// ---------- Database ----------
	pool, err := database.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("[db] %v", err)
	}
	defer pool.Close()
	if err := database.Migrate(ctx, pool); err != nil {
		log.Fatalf("[db] migrasi gagal: %v", err)
	}

	// ---------- Redis ----------
	rdb := cache.New(cfg.RedisAddr, cfg.RedisPassword, cfg.RedisDB)
	defer rdb.Close()

	// ---------- Repositori ----------
	configs := repo.NewConfigs(pool)
	if err := configs.Refresh(ctx); err != nil {
		log.Fatalf("[config] %v", err)
	}
	configs.StartAutoRefresh(ctx, 30*time.Second)
	users := repo.NewUsers(pool)
	roles := repo.NewRoles(pool)
	menus := repo.NewMenus(pool)
	audit := repo.NewAudit(pool)
	metricsRepo := repo.NewMetrics(pool)

	seedAdmin(ctx, cfg, users, roles)

	// ---------- GIS ----------
	types := gis.NewTypes(pool)
	if err := types.Refresh(ctx); err != nil {
		log.Fatalf("[gis] muat tipe komponen: %v", err)
	}
	tiles := gis.NewTiles(pool, rdb, configs, types)
	tiles.StartDensityRefresher(ctx)
	features := gis.NewFeatures(pool, configs, types)
	power := gis.NewPower(pool)
	graph := gis.NewGraph(types)
	graph.SetDefaultLoadVA(configs.Float("monitoring.default_daya_va", 1300))

	// ---------- Realtime & stream ----------
	hub := realtime.New(ctx, rdb)
	producer := stream.NewProducer(cfg.KafkaBrokers, cfg.KafkaTopic, cfg.KafkaEnabled)
	defer producer.Close()

	// status nyala/padam yang berubah karena muat/edit disimpan ke DB & disiarkan
	graph.OnEnergyChange(func(d gis.EnergyDiff) {
		pctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		if err := power.ApplyEnergized(pctx, d); err != nil {
			log.Printf("[power] simpan energisasi gagal: %v", err)
			return
		}
		v := tiles.BumpVersion(pctx)
		data, _ := json.Marshal(map[string]int{"nodes_on": len(d.NodesOn), "nodes_off": len(d.NodesOff), "edges_on": len(d.EdgesOn), "edges_off": len(d.EdgesOff)})
		hub.Publish(stream.Event{Type: "energized", Version: v, At: time.Now(), Data: data})
		log.Printf("[power] energisasi disimpan: +%d/-%d node, +%d/-%d edge", len(d.NodesOn), len(d.NodesOff), len(d.EdgesOn), len(d.EdgesOff))
	})
	go func() {
		if err := graph.Load(ctx, pool); err != nil {
			log.Printf("[graph] muat graf gagal: %v", err)
		}
	}()
	if cfg.KafkaEnabled {
		go stream.Consume(ctx, cfg.KafkaBrokers, cfg.KafkaTopic, cfg.KafkaGroupID, func(ctx context.Context, m stream.Message) error {
			return metricsRepo.InsertStreamEvent(ctx, m.Time, m.Topic, m.Partition, m.Offset, m.Key, m.Value)
		})
	}

	// ---------- Auth ----------
	jwtSvc := auth.NewJWT(cfg.JWTSecret, time.Duration(configs.Int("auth.session_hours", int(cfg.JWTTTL.Hours())))*time.Hour)
	captcha := auth.NewCaptcha(rdb, time.Duration(configs.Int("auth.captcha_ttl_seconds", 300))*time.Second)

	// ---------- Monitoring ----------
	httpMetrics := &middleware.Metrics{}
	collector := monitor.New(pool, rdb, producer, hub, httpMetrics, metricsRepo, configs)
	collector.Start(ctx)

	// ---------- HTTP ----------
	router := api.NewRouter(&api.Deps{
		Cfg: cfg, Pool: pool, Cache: rdb, JWT: jwtSvc, Captcha: captcha,
		Users: users, Roles: roles, Menus: menus, Configs: configs, Audit: audit, MetricsRepo: metricsRepo,
		Types: types, Tiles: tiles, Features: features, Graph: graph, Power: power,
		Hub: hub, Producer: producer, Collector: collector, HTTPMetrics: httpMetrics,
	})
	srv := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      120 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	go func() {
		var err error
		if cfg.TLSCert != "" && cfg.TLSKey != "" {
			log.Printf("[http] HTTPS aktif di %s", cfg.HTTPAddr)
			err = srv.ListenAndServeTLS(cfg.TLSCert, cfg.TLSKey)
		} else {
			log.Printf("[http] HTTP aktif di %s (TLS diterminasi oleh nginx)", cfg.HTTPAddr)
			err = srv.ListenAndServe()
		}
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("[http] %v", err)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	log.Println("[app] mematikan server...")
	cancel()
	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelShutdown()
	_ = srv.Shutdown(shutdownCtx)
	log.Println("[app] selesai")
}

// seedAdmin membuat akun admin awal bila belum ada pengguna sama sekali.
func seedAdmin(ctx context.Context, cfg config.Config, users *repo.Users, roles *repo.Roles) {
	n, err := users.Count(ctx)
	if err != nil || n > 0 {
		return
	}
	hash, err := auth.HashPassword(cfg.AdminPassword)
	if err != nil {
		log.Printf("[seed] hash kata sandi gagal: %v", err)
		return
	}
	var roleID *string
	if r, err := roles.GetByName(ctx, "admin"); err == nil {
		roleID = &r.ID
	}
	if _, err := users.Create(ctx, models.User{Username: cfg.AdminUsername, FullName: "Administrator", Email: "", PasswordHash: hash, RoleID: roleID, IsActive: true}); err != nil {
		log.Printf("[seed] buat admin gagal: %v", err)
		return
	}
	log.Printf("[seed] akun admin awal dibuat: %s", cfg.AdminUsername)
}
