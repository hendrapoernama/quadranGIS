// Package ai menghubungkan QuadranGIS ke penyedia LLM (Claude, ChatGPT, Kimi, OpenRouter)
// dengan respons streaming. Kunci API dibaca dari konfigurasi aplikasi (tipe secret).
package ai

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"quadrangis/internal/repo"
)

// Provider mendeskripsikan satu penyedia LLM.
type Provider struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Kind         string `json:"-"` // anthropic | openai-compatible
	DefaultModel string `json:"default_model"`
	DefaultBase  string `json:"-"`
	TokenParam   string `json:"-"` // nama parameter batas token untuk API kompatibel OpenAI
}

// Providers adalah daftar penyedia yang didukung. Model bawaan dapat diganti di konfigurasi.
var Providers = []Provider{
	{ID: "anthropic", Name: "Claude (Anthropic)", Kind: "anthropic", DefaultModel: "claude-sonnet-5", DefaultBase: "https://api.anthropic.com"},
	{ID: "openai", Name: "ChatGPT (OpenAI)", Kind: "openai", DefaultModel: "gpt-5-mini", DefaultBase: "https://api.openai.com/v1", TokenParam: "max_completion_tokens"},
	{ID: "kimi", Name: "Kimi (Moonshot AI)", Kind: "openai", DefaultModel: "kimi-k2-0905-preview", DefaultBase: "https://api.moonshot.ai/v1", TokenParam: "max_tokens"},
	{ID: "openrouter", Name: "OpenRouter", Kind: "openai", DefaultModel: "openrouter/auto", DefaultBase: "https://openrouter.ai/api/v1", TokenParam: "max_tokens"},
}

// Find mencari penyedia berdasarkan id.
func Find(id string) (Provider, bool) {
	for _, p := range Providers {
		if p.ID == id {
			return p, true
		}
	}
	return Provider{}, false
}

// Message adalah satu pesan percakapan.
type Message struct {
	Role    string `json:"role"` // user | assistant
	Content string `json:"content"`
}

// Request adalah permintaan chat ke penyedia.
type Request struct {
	Provider  Provider
	APIKey    string
	BaseURL   string
	Model     string
	System    string
	Messages  []Message
	MaxTokens int
}

// Usage adalah jumlah token yang dilaporkan penyedia (bila ada).
type Usage struct {
	InputTokens  int `json:"input_tokens"`
	OutputTokens int `json:"output_tokens"`
}

// ErrNotConfigured: kunci API penyedia belum diisi.
var ErrNotConfigured = errors.New("provider not configured")

// Settings membaca pengaturan penyedia dari konfigurasi aplikasi.
func Settings(cfg *repo.Configs, p Provider) (apiKey, baseURL, model string) {
	apiKey = strings.TrimSpace(cfg.Str("ai."+p.ID+".api_key", ""))
	baseURL = strings.TrimRight(strings.TrimSpace(cfg.Str("ai."+p.ID+".base_url", p.DefaultBase)), "/")
	model = strings.TrimSpace(cfg.Str("ai."+p.ID+".model", p.DefaultModel))
	return
}

var client = &http.Client{Timeout: 10 * time.Minute}

// Stream mengirim permintaan dan memanggil onDelta untuk setiap potongan teks jawaban.
func Stream(ctx context.Context, r Request, onDelta func(string) error) (Usage, error) {
	if r.APIKey == "" {
		return Usage{}, ErrNotConfigured
	}
	if r.MaxTokens <= 0 {
		r.MaxTokens = 2048
	}
	if r.Provider.Kind == "anthropic" {
		return streamAnthropic(ctx, r, onDelta)
	}
	return streamOpenAI(ctx, r, onDelta)
}

func post(ctx context.Context, url string, body any, headers map[string]string) (*http.Response, error) {
	b, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode >= 300 {
		defer res.Body.Close()
		raw, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
		return nil, fmt.Errorf("HTTP %d: %s", res.StatusCode, providerError(raw))
	}
	return res, nil
}

// providerError mengambil pesan galat dari badan respons penyedia (format OpenAI / Anthropic).
func providerError(raw []byte) string {
	var e struct {
		Error struct {
			Message string `json:"message"`
			Type    string `json:"type"`
		} `json:"error"`
		Message string `json:"message"`
	}
	if json.Unmarshal(raw, &e) == nil {
		if e.Error.Message != "" {
			return e.Error.Message
		}
		if e.Message != "" {
			return e.Message
		}
	}
	s := strings.TrimSpace(string(raw))
	if len(s) > 300 {
		s = s[:300]
	}
	return s
}

// readSSE membaca aliran server-sent events dan memanggil fn(event, data) per pesan.
func readSSE(body io.Reader, fn func(event, data string) (bool, error)) error {
	sc := bufio.NewScanner(body)
	sc.Buffer(make([]byte, 64*1024), 4*1024*1024)
	event := ""
	var data strings.Builder
	flush := func() (bool, error) {
		if data.Len() == 0 {
			event = ""
			return false, nil
		}
		stop, err := fn(event, data.String())
		event = ""
		data.Reset()
		return stop, err
	}
	for sc.Scan() {
		line := sc.Text()
		switch {
		case line == "":
			if stop, err := flush(); stop || err != nil {
				return err
			}
		case strings.HasPrefix(line, ":"):
			// komentar / keep-alive
		case strings.HasPrefix(line, "event:"):
			event = strings.TrimSpace(line[len("event:"):])
		case strings.HasPrefix(line, "data:"):
			if data.Len() > 0 {
				data.WriteByte('\n')
			}
			data.WriteString(strings.TrimPrefix(line[len("data:"):], " "))
		}
	}
	if err := sc.Err(); err != nil {
		return err
	}
	_, err := flush()
	return err
}

func streamOpenAI(ctx context.Context, r Request, onDelta func(string) error) (Usage, error) {
	msgs := make([]map[string]string, 0, len(r.Messages)+1)
	if r.System != "" {
		msgs = append(msgs, map[string]string{"role": "system", "content": r.System})
	}
	for _, m := range r.Messages {
		msgs = append(msgs, map[string]string{"role": m.Role, "content": m.Content})
	}
	body := map[string]any{
		"model":          r.Model,
		"messages":       msgs,
		"stream":         true,
		"stream_options": map[string]any{"include_usage": true},
	}
	body[r.Provider.TokenParam] = r.MaxTokens
	headers := map[string]string{"Authorization": "Bearer " + r.APIKey}
	if r.Provider.ID == "openrouter" {
		headers["HTTP-Referer"] = "https://quadrangis.local"
		headers["X-Title"] = "QuadranGIS"
	}
	res, err := post(ctx, r.BaseURL+"/chat/completions", body, headers)
	if err != nil {
		return Usage{}, err
	}
	defer res.Body.Close()
	var usage Usage
	err = readSSE(res.Body, func(_, data string) (bool, error) {
		if data == "[DONE]" {
			return true, nil
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
			Usage *struct {
				PromptTokens     int `json:"prompt_tokens"`
				CompletionTokens int `json:"completion_tokens"`
			} `json:"usage"`
			Error *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			return false, nil // potongan yang tidak dikenal diabaikan
		}
		if chunk.Error != nil {
			return true, errors.New(chunk.Error.Message)
		}
		if chunk.Usage != nil {
			usage = Usage{InputTokens: chunk.Usage.PromptTokens, OutputTokens: chunk.Usage.CompletionTokens}
		}
		for _, c := range chunk.Choices {
			if c.Delta.Content != "" {
				if err := onDelta(c.Delta.Content); err != nil {
					return true, err
				}
			}
		}
		return false, nil
	})
	return usage, err
}

func streamAnthropic(ctx context.Context, r Request, onDelta func(string) error) (Usage, error) {
	msgs := make([]map[string]string, 0, len(r.Messages))
	for _, m := range r.Messages {
		msgs = append(msgs, map[string]string{"role": m.Role, "content": m.Content})
	}
	body := map[string]any{
		"model":      r.Model,
		"max_tokens": r.MaxTokens,
		"messages":   msgs,
		"stream":     true,
	}
	if r.System != "" {
		body["system"] = r.System
	}
	base := r.BaseURL
	if !strings.HasSuffix(base, "/v1") {
		base += "/v1"
	}
	res, err := post(ctx, base+"/messages", body, map[string]string{"x-api-key": r.APIKey, "anthropic-version": "2023-06-01"})
	if err != nil {
		return Usage{}, err
	}
	defer res.Body.Close()
	var usage Usage
	err = readSSE(res.Body, func(event, data string) (bool, error) {
		var ev struct {
			Type    string `json:"type"`
			Message struct {
				Usage struct {
					InputTokens int `json:"input_tokens"`
				} `json:"usage"`
			} `json:"message"`
			Delta struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"delta"`
			Usage struct {
				OutputTokens int `json:"output_tokens"`
			} `json:"usage"`
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal([]byte(data), &ev); err != nil {
			return false, nil
		}
		switch ev.Type {
		case "message_start":
			usage.InputTokens = ev.Message.Usage.InputTokens
		case "content_block_delta":
			if ev.Delta.Type == "text_delta" && ev.Delta.Text != "" {
				if err := onDelta(ev.Delta.Text); err != nil {
					return true, err
				}
			}
		case "message_delta":
			if ev.Usage.OutputTokens > 0 {
				usage.OutputTokens = ev.Usage.OutputTokens
			}
		case "message_stop":
			return true, nil
		case "error":
			return true, errors.New(ev.Error.Message)
		}
		return false, nil
	})
	return usage, err
}
