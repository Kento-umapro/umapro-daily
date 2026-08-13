// 専用プロファイルのブラウザを開く。ログインが切れたら、これで開いて本人がログインし直す。
//   node scripts/browser.mjs
// ダイニー（dashboard.self.dinii.jp）と blayn（secure.blayn.com）の両方にログインしておくこと。
import { chromium } from 'playwright';
import path from 'node:path';
import os from 'node:os';

const PROFILE = path.join(os.homedir(), 'umapro-daily', '.profile');
const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false, viewport: { width: 1440, height: 950 }, locale: 'ja-JP', timezoneId: 'Asia/Tokyo',
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto('https://dashboard.self.dinii.jp/bi/flDashboard');
for (const url of ['https://secure.blayn.com/mng/sales/view',
  'https://multiweb.jp/web/Contents/UF/006/UF006-05.aspx']) {
  const p = await ctx.newPage();
  await p.goto(url).catch(() => {});
}

console.log(`
  ─────────────────────────────────────────────────────
  タブが3つ開きます。ログインが切れているものだけ入れ直してください。
    1枚目: ダイニー（法人は「東洋企業」）
    2枚目: blayn（なんば北心斎橋駅前店）
    3枚目: MPS / multiweb（てっぱん本部）
  終わったらウィンドウを閉じてください。
  ※ 閉じないと毎朝の自動取得がこのプロファイルを掴めません。
  ─────────────────────────────────────────────────────
`);
await new Promise((r) => ctx.on('close', r));
