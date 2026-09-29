"""Server LLM tiruan (OpenAI-compatible & Anthropic) untuk menguji streaming QuadranGIS tanpa API key asli."""
import json, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG = sys.argv[1] if len(sys.argv) > 1 else "mock_llm.log"

class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        rec = {"path": self.path, "auth": self.headers.get("Authorization", "")[:12], "x_api_key": (self.headers.get("x-api-key") or "")[:8],
               "anthropic_version": self.headers.get("anthropic-version"), "x_title": self.headers.get("X-Title"),
               "model": body.get("model"), "keys": sorted(body.keys()), "n_messages": len(body.get("messages", []))}
        system = body.get("system") or next((m["content"] for m in body.get("messages", []) if m.get("role") == "system"), "")
        rec["system_has_context"] = "Data jaringan terkini" in system
        rec["system_excerpt"] = system[system.find("Rekap"):system.find("Rekap") + 160] if "Rekap" in system else ""
        rec["system"] = system
        rec["messages"] = [m for m in body.get("messages", []) if m.get("role") != "system"]
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec) + "\n")
        if "bad" in (self.headers.get("Authorization", "") + (self.headers.get("x-api-key") or "")):
            self.send_response(401); self.send_header("Content-Type", "application/json"); self.end_headers()
            self.wfile.write(json.dumps({"error": {"message": "Incorrect API key provided", "type": "auth"}}).encode()); return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        words = ["## Ringkasan\n", "- Seksi **SWJ-GMB-02-05-J1** ", "paling mungkin.\n", "- Langkah:\n", "  1. BUKA **SWJ-GMB-02-05-J1**\n", "  2. TUTUP **REC-GMB-02-05**\n", "Selesai."]
        def ev(obj, event=None):
            if event:
                self.wfile.write(f"event: {event}\n".encode())
            self.wfile.write(f"data: {json.dumps(obj)}\n\n".encode()); self.wfile.flush(); time.sleep(0.05)
        if self.path.endswith("/messages"):
            ev({"type": "message_start", "message": {"usage": {"input_tokens": 321}}}, "message_start")
            for w in words:
                ev({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": w}}, "content_block_delta")
            ev({"type": "message_delta", "usage": {"output_tokens": 12}}, "message_delta")
            ev({"type": "message_stop"}, "message_stop")
        else:
            for w in words:
                ev({"choices": [{"delta": {"content": w}}]})
            ev({"choices": [], "usage": {"prompt_tokens": 300, "completion_tokens": 11}})
            self.wfile.write(b"data: [DONE]\n\n"); self.wfile.flush()

ThreadingHTTPServer(("0.0.0.0", 9911), H).serve_forever()
