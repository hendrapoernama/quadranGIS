import { getToken, wsUrl } from './api';
import type { RealtimeEvent } from './types';

type Listener = (ev: RealtimeEvent) => void;
type StatusListener = (connected: boolean) => void;

// Koneksi WebSocket tunggal dengan reconnect otomatis (backoff).
class RealtimeClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<StatusListener>();
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  connected = false;

  connect() {
    if (typeof window === 'undefined') return;
    this.closed = false;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    let url = wsUrl();
    const token = getToken();
    if (token) url += (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
    try {
      this.ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws.onopen = () => {
      this.retry = 0;
      this.connected = true;
      this.statusListeners.forEach((l) => l(true));
    };
    this.ws.onmessage = (m) => {
      try {
        const ev = JSON.parse(m.data) as RealtimeEvent;
        this.listeners.forEach((l) => l(ev));
      } catch {
        /* abaikan */
      }
    };
    this.ws.onclose = () => {
      this.connected = false;
      this.statusListeners.forEach((l) => l(false));
      if (!this.closed) this.scheduleReconnect();
    };
    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  private scheduleReconnect() {
    if (this.timer) clearTimeout(this.timer);
    const delay = Math.min(30000, 1000 * Math.pow(2, this.retry++));
    this.timer = setTimeout(() => this.connect(), delay);
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
  }

  subscribe(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  onStatus(l: StatusListener) {
    this.statusListeners.add(l);
    l(this.connected);
    return () => this.statusListeners.delete(l);
  }
}

export const realtime = new RealtimeClient();
