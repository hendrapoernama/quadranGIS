package push

import (
	"context"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"encoding/json"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Vektor uji RFC 8291 Lampiran A.
func TestEncryptRFC8291Vector(t *testing.T) {
	must := func(s string) []byte {
		b, err := decodeB64(s)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	asPriv, err := ecdh.P256().NewPrivateKey(must("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"))
	if err != nil {
		t.Fatal(err)
	}
	uaPriv, err := ecdh.P256().NewPrivateKey(must("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"))
	if err != nil {
		t.Fatal(err)
	}
	auth := must("BTBZMqHH6r4Tts7J_aSIgg")
	salt := must("DGv6ra1nlYgDCS1FRnbzlw")
	msg := []byte("When I grow up, I want to be a watermelon")
	body, err := Encrypt(msg, uaPriv.PublicKey().Bytes(), auth, asPriv, salt)
	if err != nil {
		t.Fatal(err)
	}
	want := "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
	if got := b64.EncodeToString(body); got != want {
		t.Fatalf("ciphertext berbeda:\n got %s\nwant %s", got, want)
	}
	plain, err := Decrypt(body, uaPriv, auth)
	if err != nil || string(plain) != string(msg) {
		t.Fatalf("dekripsi: %q %v", plain, err)
	}
}

// Pengiriman ke server push tiruan: header VAPID valid (tanda tangan ES256) & isi dapat dibuka.
func TestSendVAPID(t *testing.T) {
	pub, priv, err := GenerateVAPID()
	if err != nil {
		t.Fatal(err)
	}
	s, err := NewSender(pub, priv, "mailto:ops@example.com")
	if err != nil {
		t.Fatal(err)
	}
	ua, _ := ecdh.P256().GenerateKey(strings.NewReader(strings.Repeat("k", 64)))
	auth := []byte("0123456789abcdef")
	var got Message
	var hdr http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hdr = r.Header.Clone()
		body, _ := io.ReadAll(r.Body)
		plain, err := Decrypt(body, ua, auth)
		if err != nil {
			t.Errorf("dekripsi: %v", err)
		}
		_ = json.Unmarshal(plain, &got)
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()
	sub := Subscription{Endpoint: srv.URL + "/push/abc", P256dh: b64.EncodeToString(ua.PublicKey().Bytes()), Auth: b64.EncodeToString(auth)}
	if err := s.Send(context.Background(), sub, Message{Title: "Padam", Body: "REC-01 trip", URL: "/monitoring", Tag: "outage-1"}, 60, "high"); err != nil {
		t.Fatal(err)
	}
	if got.Title != "Padam" || got.URL != "/monitoring" {
		t.Fatalf("pesan: %+v", got)
	}
	if hdr.Get("Content-Encoding") != "aes128gcm" || hdr.Get("Urgency") != "high" || hdr.Get("TTL") != "60" || hdr.Get("Topic") != "outage-1" {
		t.Fatalf("header: %v", hdr)
	}
	// verifikasi token VAPID dengan kunci publik
	a := hdr.Get("Authorization")
	if !strings.HasPrefix(a, "vapid t=") || !strings.Contains(a, ", k="+pub) {
		t.Fatalf("authorization: %s", a)
	}
	tok := strings.TrimSuffix(strings.TrimPrefix(a, "vapid t="), ", k="+pub)
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		t.Fatal("jwt rusak")
	}
	var claims map[string]any
	cb, _ := decodeB64(parts[1])
	_ = json.Unmarshal(cb, &claims)
	if claims["aud"] != srv.URL || claims["sub"] != "mailto:ops@example.com" {
		t.Fatalf("claims: %v", claims)
	}
	pubRaw, _ := decodeB64(pub)
	x, y := elliptic.Unmarshal(elliptic.P256(), pubRaw) //nolint:staticcheck
	sig, _ := decodeB64(parts[2])
	h := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if !ecdsa.Verify(&ecdsa.PublicKey{Curve: elliptic.P256(), X: x, Y: y}, h[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])) {
		t.Fatal("tanda tangan VAPID tidak valid")
	}
	// langganan kedaluwarsa
	gone := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusGone) }))
	defer gone.Close()
	sub.Endpoint = gone.URL
	if err := s.Send(context.Background(), sub, Message{Title: "x"}, 60, ""); err != ErrGone {
		t.Fatalf("harus ErrGone, dapat %v", err)
	}
}
