// 毎朝の取得。ダイニー11店＋blayn（なんば）の日別売上（税込）と、MPSの月別請求を .cache に落とす。
//   node scripts/fetch.mjs [開始日]      既定は今日から180日前
//
// ログインは専用プロファイル ~/umapro-daily/.profile。切れたら node scripts/browser.mjs
import { chromium } from 'playwright';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const ROOT = path.join(os.homedir(), 'umapro-daily');
const PROFILE = path.join(ROOT, '.profile');
const GQL = 'https://hasura-query.self.dinii.jp/v1/graphql';

const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); // JST
// 毎朝は直近45日ぶんだけ取り直して、前回ぶんにマージする（履歴は .cache に貯める）。
// 初回や取り直しは開始日を渡す:  node scripts/fetch.mjs 2025-01-01
const FROM = process.argv[2] ?? new Date(Date.now() + 9 * 3600 * 1000 - 45 * 86400_000).toISOString().slice(0, 10);

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// キーチェーンからパスワードを読む。中身は絶対にログに出さない。
function secret(service) {
  try {
    return execFileSync('security', ['find-generic-password', '-s', service, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\n$/, '');
  } catch { return null; }
}

// blayn / MPS のセッションは閉じると消えるcookieなので、browser.mjs が写しておいた
// .cache/state.json を読み込んで使う。無ければプロファイルだけで動く（ダイニーはそれで足りる）。
const STATE = path.join(ROOT, '.cache', 'state.json');
const hasState = await fs.access(STATE).then(() => true).catch(() => false);
let browser = null, ctx;
if (hasState) {
  browser = await chromium.launch({ headless: true });
  ctx = await browser.newContext({
    storageState: STATE, viewport: { width: 1600, height: 1200 },
    locale: 'ja-JP', timezoneId: 'Asia/Tokyo',
  });
} else {
  ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: true, viewport: { width: 1600, height: 1200 }, locale: 'ja-JP', timezoneId: 'Asia/Tokyo',
  });
}
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

  // ═══ blayn（なんば北心斎橋駅前店）═══════════════════════
  // ハマりどころ3つ:
  //   1. 店舗を切り替えないと全部0で返ってくる（/mng/account/switch?shop_id=...）
  //   2. 日別の日付は ?date=YYYYMM のゼロ埋め（YYYYM だと1月が返る）
  //   3. 税込/税抜は tax_inclusive_f cookie。既定が税抜なので、#tax_in を押して税込にする
  try {
  const CFG = JSON.parse(await fs.readFile(path.join(ROOT, 'config.json'), 'utf8'));
  const B = CFG.blayn;
  const bp = await ctx.newPage();
  await bp.goto(`https://secure.blayn.com/mng/account/switch?shop_id=${B.shop_id}`,
    { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (/account\/login/.test(bp.url())) {
    // セッションが切れている。キーチェーンにパスワードがあれば自分で入り直す
    const id = CFG.blayn?.login_id;
    const pw = id ? secret('umapro-blayn') : null;
    if (!pw) throw new Error('blaynのログインが切れています → login.command か setup-login.command');
    log('blayn 自動ログイン中…');
    await bp.goto('https://secure.blayn.com/mng/account/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await bp.fill('input[name=login_nm]', id);
    await bp.fill('input[name=login_pw]', pw);
    await bp.check('input[name=save]').catch(() => {});
    await Promise.all([
      bp.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}),
      bp.click('input[type=submit]'),
    ]);
    await bp.goto(`https://secure.blayn.com/mng/account/switch?shop_id=${B.shop_id}`,
      { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (/account\/login/.test(bp.url())) throw new Error('blaynの自動ログインに失敗（IDかパスワードが違うかも）');
    log('blayn ログインし直しました');
  }

  const curYm = today.slice(0, 4) + today.slice(5, 7);
  await bp.goto(`https://secure.blayn.com/mng/sales/view?date=${curYm}`,
    { waitUntil: 'domcontentloaded', timeout: 60000 });
  const mode = () => bp.evaluate(() => document.querySelector('.bt_common_text.history div')?.textContent.trim());
  if ((await mode()) !== '税込') {
    await bp.evaluate(() => document.querySelector('#tax_in')?.click());
    await bp.waitForTimeout(3500);
  }
  if ((await mode()) !== '税込') throw new Error('blaynを税込表示に切り替えられませんでした');

  const ymList = [];
  for (const t = new Date(FROM + 'T00:00:00'); t <= new Date(today + 'T00:00:00'); t.setMonth(t.getMonth() + 1)) {
    ymList.push([t.getFullYear(), t.getMonth() + 1]);
  }
  for (const [y, m] of ymList) {
    const rows = await bp.evaluate(async ({ y, m }) => {
      const res = await fetch(`/mng/sales/view?date=${y}${String(m).padStart(2, '0')}`, { credentials: 'include' });
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
      if (r.mm !== m || r.sales <= 0) continue;
      const date = `${y}-${String(m).padStart(2, '0')}-${String(r.dd).padStart(2, '0')}`;
      if (date <= today) out.blayn.push({ code: B.code, date, sales: r.sales });
    }
  }
  log(`blayn ${out.blayn.length}行`);
  } catch (e) { out.errors.push(`blayn: ${e.message}`); log(`  !! blayn: ${String(e.message).slice(0, 120)}`); }

  // ═══ MPS（発注の内部請求・月別／店別）═══════════════════
  try {
  const CFG2 = JSON.parse(await fs.readFile(path.join(ROOT, 'config.json'), 'utf8'));
  const mp = await ctx.newPage();
  const MPS_URL = 'https://multiweb.jp/web/Contents/UF/006/UF006-05.aspx';
  await mp.goto(MPS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  let title = await mp.title();
  if (/CF\/001/.test(mp.url()) || /タイムアウト|ログイン/.test(title)) {
    const m = CFG2.mps ?? {};
    const pw = m.account ? secret('umapro-mps') : null;
    if (pw) {
      log('MPS 自動ログイン中…');
      await mp.goto('https://multiweb.jp/web/Contents/CF/001/CF001.aspx', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await mp.fill('input[name*=KigyoCodeTextBox]', m.kigyo_code ?? '');
      await mp.fill('input[name*=AccountTextBox]', m.account);
      await mp.fill('input[name*=PasswordTextBox]', pw);
      await Promise.all([
        mp.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}),
        mp.click('input[name*=LoginButton]'),
      ]);
      await mp.goto(MPS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      title = await mp.title();
      log(/タイムアウト|ログイン/.test(title) ? 'MPS 自動ログインに失敗' : 'MPS ログインし直しました');
    }
  }
  if (/CF\/001/.test(mp.url()) || /タイムアウト|ログイン/.test(await mp.title())) {
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
  // 使ったあとのセッションを書き戻す。毎日つつくことで生き延びる可能性を上げる。
  if (hasState) { try { await ctx.storageState({ path: STATE }); } catch { /* 無視 */ } }
  await ctx.close();
  if (browser) await browser.close();
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
