// 毎朝の取得。ダイニー11店＋blayn（なんば）の日別売上（税込）と、MPSの月別請求を .cache に落とす。
//   node scripts/fetch.mjs [開始日]      既定は今日から180日前
//
// ログインは専用プロファイル ~/umapro-daily/.profile。切れたら node scripts/browser.mjs
import { chromium } from 'playwright';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

const ROOT = path.join(os.homedir(), 'umapro-daily');
const PROFILE = path.join(ROOT, '.profile');
const GQL = 'https://hasura-query.self.dinii.jp/v1/graphql';

const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); // JST
// 毎朝は直近45日ぶんだけ取り直して、前回ぶんにマージする（履歴は .cache に貯める）。
// 初回や取り直しは開始日を渡す:  node scripts/fetch.mjs 2025-01-01
const FROM = process.argv[2] ?? new Date(Date.now() + 9 * 3600 * 1000 - 45 * 86400_000).toISOString().slice(0, 10);

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: true, viewport: { width: 1600, height: 1200 }, locale: 'ja-JP', timezoneId: 'Asia/Tokyo',
});
const out = { fetchedAt: new Date().toISOString(), today, dinii: [], blayn: [], mps: [], errors: [] };

try {
  // ═══ ダイニー ═══════════════════════════════════════════
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  let headers = null;
  page.on('request', (r) => { if (r.url() === GQL && !headers) headers = r.headers(); });
  await page.goto('https://dashboard.self.dinii.jp/bi/flDashboard', { waitUntil: 'domcontentloaded', timeout: 60000 });
  for (let i = 0; i < 45 && !headers; i++) await page.waitForTimeout(1000);
  if (!headers) throw new Error('ダイニーのログインが切れています → node scripts/browser.mjs');

  const h = { 'content-type': 'application/json' };
  for (const [k, v] of Object.entries(headers)) {
    if (k === 'authorization' || k === 'accept' || k.startsWith('x-')) h[k] = v;
  }
  const gql = async (body) => {
    const res = await page.request.post(GQL, { headers: h, data: body });
    const j = await res.json();
    if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 300));
    return j.data;
  };

  const cs = await gql({
    operationName: 'GetCompaniesAndShops', variables: {},
    query: 'query GetCompaniesAndShops { company(where: {archivedAt: {_is_null: true}}) { corporationId shops(where: {archivedAt: {_is_null: true}}) { name shopId } } }',
  });
  const shops = [];
  for (const c of cs.company) for (const s of c.shops) {
    const code = (s.name.match(/\d{6}/) ?? [])[0];
    if (code && !s.name.includes('未使用')) shops.push({ code, shopId: s.shopId });
  }
  shops.sort((a, b) => a.code.localeCompare(b.code));
  log(`ダイニー ${shops.length}店 / ${FROM} 〜 ${today}`);

  const Q = `query GetShopDailyDetailedMetrics($shopId: String!, $from: DateTime!, $to: DateTime!, $shouldUseDemoData: Boolean) {
    shopDailyDetailedMetrics(input: {shopId: $shopId, from: $from, to: $to, shouldUseDemoData: $shouldUseDemoData}) {
      dailyMetrics { businessDate totalTaxIncludedAmount }
    }
  }`;
  const months = [];
  for (const t = new Date(FROM + 'T00:00:00'); t <= new Date(today + 'T00:00:00'); t.setMonth(t.getMonth() + 1)) {
    const f = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
    const a = new Date(t.getFullYear(), t.getMonth(), 1), b = new Date(t.getFullYear(), t.getMonth() + 1, 0);
    months.push([f(a) < FROM ? FROM : f(a), f(b) > today ? today : f(b)]);
  }
  for (const s of shops) {
    for (const [a, b] of months) {
      try {
        const r = await gql({
          operationName: 'GetShopDailyDetailedMetrics',
          variables: {
            shopId: s.shopId, shouldUseDemoData: false,
            from: new Date(a + 'T00:00:00+09:00').toISOString(),
            to: new Date(b + 'T23:59:59+09:00').toISOString(),
          },
          query: Q,
        });
        for (const m of r.shopDailyDetailedMetrics?.dailyMetrics ?? []) {
          if (m.totalTaxIncludedAmount == null) continue;
          out.dinii.push({ code: s.code, date: m.businessDate, sales: Math.round(m.totalTaxIncludedAmount) });
        }
      } catch (e) { log(`  !! ${s.code} ${a}: ${String(e.message).slice(0, 90)}`); }
    }
  }
  log(`ダイニー ${out.dinii.length}行`);

  // ═══ blayn（なんば北心斎橋駅前店・税込表示）═══════════════
  try {
  const bp = await ctx.newPage();
  await bp.goto('https://secure.blayn.com/mng/sales/view', { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (/account\/login/.test(bp.url())) throw new Error('blaynのログインが切れています → node scripts/browser.mjs');
  const ymList = [];
  for (const t = new Date(FROM + 'T00:00:00'); t <= new Date(today + 'T00:00:00'); t.setMonth(t.getMonth() + 1)) {
    ymList.push([t.getFullYear(), t.getMonth() + 1]);
  }
  for (const [y, m] of ymList) {
    const rows = await bp.evaluate(async ({ y, m }) => {
      const res = await fetch(`/mng/sales/view?t=s&date=${y}${m}`, { credentials: 'include' });
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      const acc = [];
      for (const tr of doc.querySelectorAll('table tr')) {
        const c = [...tr.children].map((x) => x.textContent.trim());
        const d = /^(\d{1,2})\/(\d{1,2})/.exec(c[0] || '');
        if (!d) continue;
        const v = parseInt((c[2] || '0').replace(/,/g, ''), 10);
        if (Number.isFinite(v)) acc.push({ mm: +d[1], dd: +d[2], sales: v });
      }
      return acc;
    }, { y, m });
    for (const r of rows) {
      if (r.mm !== m) continue;                       // 念のため月がずれた行は捨てる
      if (r.sales <= 0) continue;                     // 未来日・休業日
      const date = `${y}-${String(m).padStart(2, '0')}-${String(r.dd).padStart(2, '0')}`;
      if (date <= today) out.blayn.push({ code: '000400', date, sales: r.sales });
    }
  }
  log(`blayn ${out.blayn.length}行`);
  } catch (e) { out.errors.push(`blayn: ${e.message}`); log(`  !! blayn: ${String(e.message).slice(0, 120)}`); }

  // ═══ MPS（発注の内部請求・月別／店別）═══════════════════
  try {
  const mp = await ctx.newPage();
  await mp.goto('https://multiweb.jp/web/Contents/UF/006/UF006-05.aspx', { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (/CF\/001/.test(mp.url())) {
    log('  !! MPSのログインが切れています（MPSはスキップ。前回値を使います）');
  } else {
    const years = [...new Set([today.slice(0, 4), String(+today.slice(0, 4) - 1)])];
    const mps = await mp.evaluate(async (years) => {
      const URL = '/web/Contents/UF/006/UF006-05.aspx';
      const parseVS = (doc) => {
        const o = {};
        for (const n of ['__VIEWSTATE', '__VIEWSTATEGENERATOR', '__EVENTVALIDATION', '__VIEWSTATEENCRYPTED']) {
          const el = doc.querySelector(`[name="${n}"]`); if (el) o[n] = el.value;
        }
        return o;
      };
      const post = async (body) => {
        const r = await fetch(URL, {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
        });
        return new DOMParser().parseFromString(await r.text(), 'text/html');
      };
      const SHOPS = ['000100', '000200', '000300', '000400', '000500', '000600',
        '000700', '000800', '000900', '001000', '001100', '001200'];
      const acc = [];
      for (const y of years) {
        const d0 = new DOMParser().parseFromString(await (await fetch(URL, { credentials: 'include' })).text(), 'text/html');
        const p = new URLSearchParams(parseVS(d0));
        p.set('__EVENTTARGET', 'ctl00$MainContent$SeikyuNenDropDownList');
        p.set('__EVENTARGUMENT', '');
        p.set('ctl00$MainContent$SeikyuNenDropDownList', y);
        p.set('ctl00$MainContent$SeikyuGetsuDropDownList', '');
        const d1 = await post(p.toString());
        const vsYear = parseVS(d1);
        const monthsY = [...d1.querySelectorAll('[name*=SeikyuGetsuDropDownList] option')]
          .map((o) => o.value).filter(Boolean);
        const search = async (vs, month, shop) => {
          const q = new URLSearchParams(vs);
          q.set('__EVENTTARGET', ''); q.set('__EVENTARGUMENT', '');
          q.set('ctl00$MainContent$SeikyuNenDropDownList', y);
          q.set('ctl00$MainContent$SeikyuGetsuDropDownList', month);
          q.set('ctl00$MainContent$ShiharaisakiListBox', '');
          q.set('ctl00$MainContent$FutanmotoSoshikiListBox', shop);
          q.set('ctl00$MainContent$FutanmotoBumonListBox', '');
          q.set('ctl00$MainContent$btnSearch', '検索');
          const doc = await post(q.toString());
          const txt = doc.body.innerText || doc.body.textContent;
          const gi = /内部総請求金額\(税込\)：¥([\d,]+)/.exec(txt);
          return { internal: gi ? +gi[1].replace(/,/g, '') : null, vs: parseVS(doc) };
        };
        for (const mm of monthsY) {
          // 店舗フィルタは「一度検索したあとのページ」のviewstateでないと効かない
          const base = await search(vsYear, mm, '');
          if (base.internal == null) continue;
          acc.push({ ym: `${y}-${mm}`, code: 'ALL', internal: base.internal });
          for (const sc of SHOPS) {
            const r = await search(base.vs, mm, sc);
            if (r.internal != null && r.internal !== base.internal) {
              acc.push({ ym: `${y}-${mm}`, code: sc, internal: r.internal });
            }
          }
        }
      }
      return acc;
    }, years);
    out.mps = mps;
    log(`MPS ${out.mps.length}行`);
  }
  } catch (e) { out.errors.push(`MPS: ${e.message}`); log(`  !! MPS: ${String(e.message).slice(0, 120)}`); }
} catch (e) {
  out.errors.push(`dinii: ${e.message}`);
  log(`  !! ${String(e.message).slice(0, 160)}`);
} finally {
  await ctx.close();
}

// 前回ぶんとマージする。今回取れた日付は今回の値で上書き、それ以外は前回を残す。
// 1つのサイトがコケても、そこだけ前回の値が生き残る。
const cachePath = path.join(ROOT, '.cache', 'raw.json');
let prev = null;
try { prev = JSON.parse(await fs.readFile(cachePath, 'utf8')); } catch { /* 初回 */ }
if (prev) {
  for (const k of ['dinii', 'blayn']) {
    const m = new Map((prev[k] ?? []).map((r) => [`${r.code}|${r.date}`, r]));
    for (const r of out[k]) m.set(`${r.code}|${r.date}`, r);
    const before = out[k].length;
    out[k] = [...m.values()].sort((a, b) => a.date.localeCompare(b.date) || a.code.localeCompare(b.code));
    log(`${k} 今回${before}行 → 履歴込み${out[k].length}行`);
  }
  if (!out.mps.length && prev.mps?.length) {
    out.mps = prev.mps;
    log(`mps は前回値を流用（${out.mps.length}行）`);
  }
}
if (out.errors.length) log(`エラー: ${out.errors.join(' / ')}`);
await fs.mkdir(path.join(ROOT, '.cache'), { recursive: true });
await fs.writeFile(cachePath, JSON.stringify(out));
log(`保存 ${cachePath}`);
