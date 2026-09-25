export function fmtNum(n: number | undefined | null, digits = 0): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '-';
  return n.toLocaleString('id-ID', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export function fmtLength(m: number | undefined | null): string {
  if (m === undefined || m === null) return '-';
  if (m >= 1000) return `${fmtNum(m / 1000, 2)} km`;
  return `${fmtNum(m, 1)} m`;
}

export function fmtDate(s: string | null | undefined): string {
  if (!s) return '-';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
}

export function fmtTime(s: string | null | undefined): string {
  if (!s) return '-';
  const d = new Date(s);
  return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
}

export function fmtDuration(sec: number): string {
  if (sec < 60) return `${sec} dtk`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} mnt`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} jam ${m % 60} mnt`;
  const d = Math.floor(h / 24);
  return `${d} hari ${h % 24} jam`;
}

/** Daya/beban dalam VA -> VA / kVA / MVA. */
export function fmtVA(va: number | undefined | null): string {
  if (va === undefined || va === null || Number.isNaN(va)) return '-';
  if (va >= 1e6) return `${fmtNum(va / 1e6, 2)} MVA`;
  if (va >= 1e3) return `${fmtNum(va / 1e3, 1)} kVA`;
  return `${fmtNum(va, 0)} VA`;
}

export function fmtBytesMB(mb: number): string {
  if (mb >= 1024) return `${fmtNum(mb / 1024, 2)} GB`;
  return `${fmtNum(mb, 0)} MB`;
}
