// Package push mengirim Web Push (RFC 8030) dengan enkripsi aes128gcm (RFC 8291) dan
// autentikasi VAPID (RFC 8292) memakai pustaka standar Go, tanpa layanan pihak ketiga.
package push

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"strings"
	"time"
)

var b64 = base64.RawURLEncoding

// decodeB64 menerima base64url dengan/tanpa padding (format kunci dari browser bervariasi).
func decodeB64(s string) ([]byte, error) {
	s = strings.TrimRight(strings.TrimSpace(s), "=")
	s = strings.NewReplacer("+", "-", "/", "_").Replace(s)
	return b64.DecodeString(s)
}

// GenerateVAPID membuat pasangan kunci VAPID P-256: publik (65 byte tak terkompresi) dan privat (32 byte), base64url.
func GenerateVAPID() (pub, priv string, err error) {
	k, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return "", "", err
	}
	return b64.EncodeToString(k.PublicKey().Bytes()), b64.EncodeToString(k.Bytes()), nil
}

// Subscription adalah langganan push dari browser (PushSubscription.toJSON()).
type Subscription struct {
	Endpoint string `json:"endpoint"`
	P256dh   string `json:"p256dh"`
	Auth     string `json:"auth"`
}

// Message adalah isi notifikasi yang dibaca service worker.
type Message struct {
	Title string `json:"title"`
	Body  string `json:"body"`
	URL   string `json:"url,omitempty"`
	Tag   string `json:"tag,omitempty"`
	Topic string `json:"topic,omitempty"`
}

// Sender mengirim pesan terenkripsi ke layanan push browser.
type Sender struct {
	pubB64  string
	priv    *ecdsa.PrivateKey
	subject string
	client  *http.Client
}

// ErrGone: langganan sudah tidak berlaku (404/410) dan sebaiknya dihapus.
var ErrGone = errors.New("push subscription gone")

// NewSender membuat pengirim dari kunci VAPID base64url.
func NewSender(pubB64, privB64, subject string) (*Sender, error) {
	d, err := decodeB64(privB64)
	if err != nil || len(d) != 32 {
		return nil, fmt.Errorf("kunci privat VAPID tidak valid")
	}
	pubRaw, err := decodeB64(pubB64)
	if err != nil || len(pubRaw) != 65 {
		return nil, fmt.Errorf("kunci publik VAPID tidak valid")
	}
	x, y := elliptic.Unmarshal(elliptic.P256(), pubRaw) //nolint:staticcheck // format tak terkompresi dari browser
	if x == nil {
		return nil, fmt.Errorf("kunci publik VAPID tidak valid")
	}
	priv := &ecdsa.PrivateKey{PublicKey: ecdsa.PublicKey{Curve: elliptic.P256(), X: x, Y: y}, D: new(big.Int).SetBytes(d)}
	if subject == "" {
		subject = "mailto:admin@quadrangis.local"
	}
	return &Sender{pubB64: b64.EncodeToString(pubRaw), priv: priv, subject: subject, client: &http.Client{Timeout: 15 * time.Second}}, nil
}

// PublicKey mengembalikan kunci publik VAPID (applicationServerKey untuk browser).
func (s *Sender) PublicKey() string { return s.pubB64 }

// Send mengenkripsi dan mengirim satu pesan. ttl dalam detik; urgency: very-low|low|normal|high.
func (s *Sender) Send(ctx context.Context, sub Subscription, msg Message, ttl int, urgency string) error {
	payload, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	uaPub, err := decodeB64(sub.P256dh)
	if err != nil {
		return fmt.Errorf("p256dh: %w", err)
	}
	auth, err := decodeB64(sub.Auth)
	if err != nil {
		return fmt.Errorf("auth: %w", err)
	}
	as, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return err
	}
	body, err := Encrypt(payload, uaPub, auth, as, salt)
	if err != nil {
		return err
	}
	jwt, err := s.vapidJWT(sub.Endpoint, time.Now().Add(12*time.Hour))
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, sub.Endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	if urgency == "" {
		urgency = "normal"
	}
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("Content-Encoding", "aes128gcm")
	req.Header.Set("TTL", fmt.Sprint(ttl))
	req.Header.Set("Urgency", urgency)
	if msg.Tag != "" {
		req.Header.Set("Topic", sanitizeTopic(msg.Tag))
	}
	req.Header.Set("Authorization", "vapid t="+jwt+", k="+s.pubB64)
	res, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotFound || res.StatusCode == http.StatusGone {
		return ErrGone
	}
	if res.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(res.Body, 512))
		return fmt.Errorf("push HTTP %d: %s", res.StatusCode, strings.TrimSpace(string(raw)))
	}
	return nil
}

// sanitizeTopic: header Topic hanya boleh karakter base64url, maks. 32.
func sanitizeTopic(t string) string {
	var b strings.Builder
	for _, r := range t {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			b.WriteRune(r)
		}
		if b.Len() >= 32 {
			break
		}
	}
	return b.String()
}

// vapidJWT menyusun token ES256 dengan aud = origin endpoint.
func (s *Sender) vapidJWT(endpoint string, exp time.Time) (string, error) {
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return "", fmt.Errorf("endpoint push tidak valid")
	}
	head := b64.EncodeToString([]byte(`{"typ":"JWT","alg":"ES256"}`))
	claims, _ := json.Marshal(map[string]any{"aud": u.Scheme + "://" + u.Host, "exp": exp.Unix(), "sub": s.subject})
	signing := head + "." + b64.EncodeToString(claims)
	h := sha256.Sum256([]byte(signing))
	r, sgn, err := ecdsa.Sign(rand.Reader, s.priv, h[:])
	if err != nil {
		return "", err
	}
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	sgn.FillBytes(sig[32:])
	return signing + "." + b64.EncodeToString(sig), nil
}

func hmacSHA256(key, data []byte) []byte {
	m := hmac.New(sha256.New, key)
	m.Write(data)
	return m.Sum(nil)
}

// Encrypt mengenkripsi payload menurut RFC 8291 (satu record aes128gcm, rs 4096).
func Encrypt(payload, uaPublic, authSecret []byte, as *ecdh.PrivateKey, salt []byte) ([]byte, error) {
	if len(salt) != 16 || len(authSecret) < 16 {
		return nil, fmt.Errorf("salt/auth tidak valid")
	}
	if len(payload) > 3993 {
		return nil, fmt.Errorf("payload terlalu besar")
	}
	uaKey, err := ecdh.P256().NewPublicKey(uaPublic)
	if err != nil {
		return nil, fmt.Errorf("p256dh: %w", err)
	}
	shared, err := as.ECDH(uaKey)
	if err != nil {
		return nil, err
	}
	asPublic := as.PublicKey().Bytes()
	// IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0x00 || ua_public || as_public, 32)
	prkKey := hmacSHA256(authSecret, shared)
	info := append([]byte("WebPush: info\x00"), uaPublic...)
	info = append(info, asPublic...)
	ikm := hmacSHA256(prkKey, append(info, 0x01))
	prk := hmacSHA256(salt, ikm)
	cek := hmacSHA256(prk, []byte("Content-Encoding: aes128gcm\x00\x01"))[:16]
	nonce := hmacSHA256(prk, []byte("Content-Encoding: nonce\x00\x01"))[:12]
	block, err := aes.NewCipher(cek)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	plain := append(append([]byte{}, payload...), 0x02) // pembatas record terakhir
	ct := gcm.Seal(nil, nonce, plain, nil)
	header := make([]byte, 0, 16+4+1+len(asPublic))
	header = append(header, salt...)
	rs := make([]byte, 4)
	binary.BigEndian.PutUint32(rs, 4096)
	header = append(header, rs...)
	header = append(header, byte(len(asPublic)))
	header = append(header, asPublic...)
	return append(header, ct...), nil
}

// Decrypt membuka pesan aes128gcm sebagai user agent (dipakai pengujian).
func Decrypt(body []byte, ua *ecdh.PrivateKey, authSecret []byte) ([]byte, error) {
	if len(body) < 21 {
		return nil, fmt.Errorf("pesan terlalu pendek")
	}
	salt := body[:16]
	idlen := int(body[20])
	if len(body) < 21+idlen {
		return nil, fmt.Errorf("header rusak")
	}
	asPub, err := ecdh.P256().NewPublicKey(body[21 : 21+idlen])
	if err != nil {
		return nil, err
	}
	shared, err := ua.ECDH(asPub)
	if err != nil {
		return nil, err
	}
	prkKey := hmacSHA256(authSecret, shared)
	info := append([]byte("WebPush: info\x00"), ua.PublicKey().Bytes()...)
	info = append(info, asPub.Bytes()...)
	ikm := hmacSHA256(prkKey, append(info, 0x01))
	prk := hmacSHA256(salt, ikm)
	cek := hmacSHA256(prk, []byte("Content-Encoding: aes128gcm\x00\x01"))[:16]
	nonce := hmacSHA256(prk, []byte("Content-Encoding: nonce\x00\x01"))[:12]
	block, err := aes.NewCipher(cek)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	plain, err := gcm.Open(nil, nonce, body[21+idlen:], nil)
	if err != nil {
		return nil, err
	}
	i := bytes.LastIndexByte(plain, 0x02)
	if i < 0 {
		return nil, fmt.Errorf("pembatas record tidak ada")
	}
	return plain[:i], nil
}
