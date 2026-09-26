// Tangkapan layar untuk buku panduan (menu Dokumentasi), mode gelap 1600x900. Tidak mengubah data.
// Pemakaian:  npm i -D playwright && npx playwright install chromium
//             node scripts/docs-screenshots.js frontend/public/guide
// Variabel: QG_BASE (bawaan https://127.0.0.1:8443), QG_USER, QG_PASS.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const BASE = process.env.QG_BASE || 'https://127.0.0.1:8443';
const USER = process.env.QG_USER || 'admin';
const PASS = process.env.QG_PASS || 'Admin#12345';
const OUT = process.argv[2] || path.join(__dirname, '..', 'frontend', 'public', 'guide');
function solve(q) { const [a, op, b] = q.split(' '); const x = Number(a), y = Number(b); return op === '+' ? x + y : op === '-' ? x - y : x * y; }

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 900 }, colorScheme: 'dark' });
  const page = await ctx.newPage();
  const res = {};
  const snap = async (name, opts = {}) => {
    await page.screenshot({ path: path.join(OUT, `${name}.jpg`), type: 'jpeg', quality: 82, ...opts });
    res[name] = 'ok';
  };
  const step = async (name, fn) => {
    try {
      await fn();
    } catch (e) {
      res[name] = 'GAGAL: ' + String(e.message).split('\n')[0];
    }
  };
  const mapReady = () => page.waitForFunction(() => window.__qgisMap && window.__qgisMap.loaded(), null, { timeout: 120000 });
  const jump = (c, z) => page.evaluate(([c, z]) => new Promise((r) => { const m = window.__qgisMap; m.once('idle', r); m.jumpTo({ center: c, zoom: z }); setTimeout(r, 8000); }), [c, z]);
  const search = async (code, re) => {
    await page.fill('input[placeholder="Cari kode / nama / id fitur..."]', code);
    await page.locator('div.absolute.z-30 button').filter({ hasText: re || code }).first().dispatchEvent('mousedown', {}, { timeout: 30000 });
  };

  // ---- login
  await step('login', async () => {
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForFunction(() => /\d+ .+ \d+ = \?/.test(document.body.innerText), null, { timeout: 60000 });
    await page.fill('#username', USER);
    await page.waitForTimeout(500);
    await snap('login');
  });
  const q = (await page.locator('div.font-mono.tracking-wider').innerText()).trim();
  await page.fill('#password', PASS);
  await page.fill('#captcha', String(solve(q)));
  await page.click('button[type=submit]');
  await page.waitForURL('**/map', { timeout: 30000 });
  await mapReady();

  // ---- editor peta
  await step('map-overview', async () => {
    await jump([106.8475, -6.1745], 15.2);
    await page.waitForTimeout(2500);
    await snap('map-overview');
  });
  await step('map-feature', async () => {
    await search('GD-GMB-02-06');
    await page.waitForSelector('text=Rekap', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);
    await snap('map-feature');
  });
  await step('map-trace', async () => {
    await search('KBK-GMB-02');
    await page.waitForSelector('button:has-text("Trace hilir")', { timeout: 30000 });
    await page.click('button:has-text("Trace hilir")');
    await page.waitForTimeout(4000);
    await snap('map-trace');
  });
  await step('map-draw', async () => {
    await page.locator('aside button, div button').filter({ hasText: /^Layer$/ }).first().click().catch(() => {});
    await page.evaluate(() => window.__qgisMap.getSource('trace')?.setData({ type: 'FeatureCollection', features: [] }));
    await jump([106.8505, -6.1765], 17.3);
    await page.locator('button[title="Gambar komponen garis"]').click();
    await page.waitForTimeout(800);
    await snap('map-draw');
    await page.keyboard.press('Escape');
    await page.locator('button[title="Gambar komponen garis"]').click().catch(() => {});
  });
  await step('map-layers', async () => {
    await page.locator('button').filter({ hasText: /^Layer$/ }).first().click();
    await jump([106.84, -6.2], 11.5);
    await page.waitForTimeout(2500);
    await snap('map-layers');
  });
  await step('map-data', async () => {
    await page.locator('button').filter({ hasText: /^Data$/ }).first().click();
    await jump([106.8475, -6.1745], 15);
    await page.waitForTimeout(2000);
    await snap('map-data');
  });

  // ---- monitoring kelistrikan
  await page.goto(`${BASE}/monitoring`, { waitUntil: 'domcontentloaded' });
  await mapReady();
  await page.waitForSelector('text=SAIDI', { timeout: 60000 });
  const aside = page.locator('aside').last();
  const tab = async (re) => aside.locator('div.border-b button').filter({ hasText: re }).first().click();
  await step('monitoring-overview', async () => {
    await jump([106.8445, -6.1765], 13.6);
    await page.waitForTimeout(2500);
    await snap('monitoring-overview');
  });
  await step('monitoring-outages', async () => {
    await page.check('text=Riwayat periode');
    await page.waitForTimeout(2500);
    await snap('monitoring-outages');
  });
  await step('monitoring-soe', async () => {
    await tab(/^SOE/);
    await page.waitForTimeout(2500);
    await snap('monitoring-soe');
  });
  await step('monitoring-gi', async () => {
    await tab(/^GI/);
    await page.waitForTimeout(2500);
    await snap('monitoring-gi');
  });
  await step('monitoring-feeders', async () => {
    await tab(/^Penyulang/);
    await page.waitForTimeout(2500);
    await snap('monitoring-feeders');
  });
  await step('monitoring-customers', async () => {
    await tab(/^Pelanggan/);
    await page.waitForSelector('aside >> text=Menampilkan', { timeout: 30000 });
    await page.waitForTimeout(1500);
    await snap('monitoring-customers');
  });
  await step('monitoring-operate', async () => {
    await search('REC-GMB-02-05');
    await page.waitForSelector('text=Kategori pemadaman', { timeout: 30000 });
    await page.waitForTimeout(2500);
    await snap('monitoring-operate');
  });
  await step('monitoring-trace', async () => {
    await page.click('button:has-text("Downtrace (hilir)")');
    await page.waitForTimeout(4000);
    await snap('monitoring-trace');
    await page.locator('div.w-80 button[aria-label="Tutup"]').first().click().catch(() => {});
  });
  await step('monitoring-up3', async () => {
    await page.click('button:has-text("UP3")');
    await jump([106.83, -6.2], 10.6);
    await page.waitForTimeout(3000);
    await snap('monitoring-up3');
    await page.click('button:has-text("UP3")');
  });
  await step('monitoring-export', async () => {
    await tab(/^Export/);
    await jump([106.8445, -6.1765], 14);
    await page.waitForTimeout(2000);
    await snap('monitoring-export');
  });

  // ---- aliran daya
  await step('powerflow', async () => {
    await page.goto(`${BASE}/powerflow`, { waitUntil: 'domcontentloaded' });
    await mapReady();
    await page.waitForTimeout(4000);
    await snap('powerflow');
  });

  // ---- single line diagram
  await step('sld', async () => {
    await page.goto(`${BASE}/sld?scope=feeder&id=28&level=tm`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#sld-body g', { state: 'attached', timeout: 60000 });
    await page.waitForTimeout(2500);
    await snap('sld');
  });
  await step('sld-operate', async () => {
    await page.locator('#sld-body > g[transform]').filter({ hasText: 'REC-GMB-02-05' }).first().click();
    await page.waitForSelector('text=Kategori pemadaman', { timeout: 30000 });
    await page.waitForTimeout(2000);
    await snap('sld-operate');
  });
  await step('sld-gd', async () => {
    await page.goto(`${BASE}/sld?scope=gd&id=348&level=pelanggan`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#sld-body g', { state: 'attached', timeout: 60000 });
    await page.waitForTimeout(2000);
    await page.locator('button', { hasText: 'Pas layar' }).click();
    await page.waitForTimeout(1000);
    await snap('sld-gd');
  });

  // ---- AI & administrasi
  const simple = async (name, url, wait) => {
    await step(name, async () => {
      await page.goto(`${BASE}${url}`, { waitUntil: 'domcontentloaded' });
      if (wait) await page.waitForSelector(wait, { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(3000);
      await snap(name);
    });
  };
  await simple('ai', '/ai');
  await simple('admin-users', '/admin/users', 'table');
  await simple('admin-roles', '/admin/roles', 'table');
  await simple('admin-menus', '/admin/menus', 'table');
  await simple('admin-config', '/admin/config');
  await simple('admin-layers', '/admin/layers', 'table');
  await simple('admin-monitoring', '/admin/monitoring');

  console.log(JSON.stringify(res, null, 1));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
