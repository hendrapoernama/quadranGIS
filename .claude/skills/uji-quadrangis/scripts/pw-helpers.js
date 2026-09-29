// Helper Playwright untuk uji UI QuadranGIS. Pakai dari skrip uji di scratchpad:
//   const { launch, login, go, apiOf, watchdog, sleep, log } = require('<repo>/.claude/skills/uji-quadrangis/scripts/pw-helpers.js');
// Playwright dipasang di luar repo (lihat SKILL.md) dan dicari lewat NODE_PATH.
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'https://127.0.0.1:8443'; // bukan localhost: Chromium kadang gagal lewat IPv6
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);

function solve(q) {
  const [a, op, b] = q.split(' ');
  const x = Number(a), y = Number(b);
  return op === '+' ? x + y : op === '-' ? x - y : x * y;
}

const launch = () => chromium.launch({ args: ['--ignore-certificate-errors'] });

/**
 * Konteks baru + login (captcha). scheme: 'dark' | 'light'. opts: opsi konteks tambahan, mis. ponsel
 * { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }. Mengembalikan { ctx, p, token }.
 */
async function login(browser, scheme = 'dark', user = 'admin', pass = 'quadran123', opts = {}) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1500, height: 950 }, colorScheme: scheme, ...opts });
  const p = await ctx.newPage();
  p.setDefaultTimeout(15000);
  p.errs = [];
  p.on('pageerror', (e) => p.errs.push(e.message));
  await p.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await p.waitForFunction(() => /\d+ .+ \d+ = \?/.test(document.body.innerText), null, { timeout: 60000 });
  const q = (await p.locator('div.font-mono.tracking-wider').innerText()).trim();
  await p.fill('#username', user);
  await p.fill('#password', pass);
  await p.fill('#captcha', String(solve(q)));
  await p.click('button[type=submit]');
  await p.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 });
  await p.evaluate((s) => localStorage.setItem('qgis_theme', s), scheme);
  await sleep(2500); // biarkan redirect halaman awal selesai, kalau tidak goto berikutnya "interrupted"
  const token = await p.evaluate(() => localStorage.getItem('qgis_token'));
  return { ctx, p, token };
}

/** goto yang diulang bila tertimpa redirect ("interrupted by another navigation"). */
async function go(p, path) {
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  for (let i = 0; i < 3; i++) {
    try {
      await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); // jangan networkidle: WebSocket realtime
      if (new URL(p.url()).pathname === new URL(url).pathname) return;
    } catch (e) {
      if (!/interrupted/.test(String(e))) throw e;
    }
    await sleep(1500);
  }
}

/**
 * Pemanggil API lewat request context Playwright (tidak bergantung pada halaman, jadi tetap jalan
 * walau halaman macet). Pakai ini untuk manuver & pemulihan.
 */
const apiOf = (ctx, token) => (method, path, data) =>
  ctx.request
    .fetch(`${BASE}${path}`, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, data, ignoreHTTPSErrors: true, timeout: 60000 })
    .then(async (r) => ({ status: r.status(), body: await r.json().catch(() => null) }));

/** Pengawas waktu: jalankan pemulihan lalu keluar bila skrip macet. Kembalikan fungsi pembatal. */
function watchdog(ms, restore) {
  const t = setTimeout(async () => {
    log('WATCHDOG: memulihkan');
    try {
      await restore();
    } finally {
      process.exit(2);
    }
  }, ms);
  return () => clearTimeout(t);
}

module.exports = { BASE, sleep, log, launch, login, go, apiOf, watchdog };
