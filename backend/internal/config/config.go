// Package config memuat konfigurasi runtime dari environment variable.
package config

import (
	"os"
	"strconv"
	"strings"
	"time"
)

// Config berisi seluruh pengaturan yang dibutuhkan server.
type Config struct {
	Env      string
	HTTPAddr string
	TLSCert  string
	TLSKey   string

	DatabaseURL string

	RedisAddr     string
	RedisPassword string
	RedisDB       int

	KafkaEnabled bool
	KafkaBrokers []string
	KafkaTopic   string
	KafkaGroupID string

	JWTSecret    string
	JWTTTL       time.Duration
	CookieSecure bool

	AdminUsername string
	AdminPassword string

	CORSOrigins []string
}

func env(key, def string) string {
	if v, ok := os.LookupEnv(key); ok && strings.TrimSpace(v) != "" {
		return strings.TrimSpace(v)
	}
	return def
}

func envInt(key string, def int) int {
	if v, err := strconv.Atoi(env(key, "")); err == nil {
		return v
	}
	return def
}

func envBool(key string, def bool) bool {
	switch strings.ToLower(env(key, "")) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	}
	return def
}

func envList(key, def string) []string {
	raw := env(key, def)
	var out []string
	for _, p := range strings.Split(raw, ",") {
		if s := strings.TrimSpace(p); s != "" {
			out = append(out, s)
		}
	}
	return out
}

// Load membaca konfigurasi dari environment dengan nilai bawaan yang aman untuk pengembangan.
func Load() Config {
	return Config{
		Env:      env("APP_ENV", "development"),
		HTTPAddr: env("HTTP_ADDR", ":8080"),
		TLSCert:  env("TLS_CERT", ""),
		TLSKey:   env("TLS_KEY", ""),

		DatabaseURL: env("DATABASE_URL", "postgres://quadran:quadran@localhost:5434/quadrangis?sslmode=disable"),

		RedisAddr:     env("REDIS_ADDR", "localhost:6380"),
		RedisPassword: env("REDIS_PASSWORD", ""),
		RedisDB:       envInt("REDIS_DB", 0),

		KafkaEnabled: envBool("KAFKA_ENABLED", true),
		KafkaBrokers: envList("KAFKA_BROKERS", "localhost:29093"),
		KafkaTopic:   env("KAFKA_TOPIC", "quadran.gis.events"),
		KafkaGroupID: env("KAFKA_GROUP_ID", "quadran-gis-worker"),

		JWTSecret:    env("JWT_SECRET", "dev-secret-ganti-di-produksi"),
		JWTTTL:       time.Duration(envInt("JWT_TTL_HOURS", 12)) * time.Hour,
		CookieSecure: envBool("COOKIE_SECURE", false),

		AdminUsername: env("ADMIN_USERNAME", "admin"),
		AdminPassword: env("ADMIN_PASSWORD", "Admin#12345"),

		CORSOrigins: envList("CORS_ORIGINS", "http://localhost:3000,https://localhost"),
	}
}

// IsProduction menandakan mode produksi.
func (c Config) IsProduction() bool { return strings.ToLower(c.Env) == "production" }
