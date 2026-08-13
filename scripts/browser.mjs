// 専用プロファイルのブラウザを開いてログインし直す。
//   node scripts/browser.mjs            … 開くだけ
//   node scripts/browser.mjs --fetch    … 閉じたあと、そのまま取得まで走る（MPS推奨）
//
// MPSはセッションが短いので、ログインした直後に取りにいく必要がある。
// ふだんは login.command をダブルクリックすればこれが --fetch で走る。
import { chromium } from 'playwright';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const ROOT = path.join(os.homedir(), 'umapro-daily');
const PROFILE = path.join(ROOT, '.profile');
const SITES = [
  ['ダイニー', 'https://dashboard.self.dinii.jp/bi/flDashboard', (u, t) => !/sign_in/.test(u)],
  ['blayn', 'https://secure.blayn.com/mng/sales/view', (u) => !/account\/login/.test(u)],
  ['MPS', 'https://multiweb.jp/web/Contents/UF/006/UF006-05.aspx', (u, t) => !/タイムアウト|ログイン/.test(t)],
];

const STATE = path.join(ROOT, '.cache', 'state.json');
const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false, viewport: { width: 1440, height: 950 }, locale: 'ja-JP', timezoneId: 'Asia/Tokyo',
});

// blayn と MPS のセッションは「ブラウザを閉じたら消えるcookie」なので、
// 開いているあいだに中身をファイルへ写しておく。取得側はこれを読み込む。
let saving = true;
const keep = (async () => {
  while (saving) {
    try { await ctx.storageState({ path: STATE }); } catch { /* 閉じた直後は無視 */ }
    await new Promise((r) => setTimeout(r, 3000));
  }
})();

const pages = [];
for (let i = 0; i < SITES.length; i++) {
  const p = i === 0 ? (ctx.pages()[0] ?? await ctx.newPage()) : await ctx.newPage();
  await p.goto(SITES[i][1]).catch(() => {});
  pages.push(p);
}

console.log(`
  ─────────────────────────────────────────────────────
   タブが3つ開きます。ログインが切れているものを入れ直してください。
     1枚目: ダイニー（法人は「東洋企業」）
     2枚目: blayn（なんば北心斎橋駅前店）
     3枚目: MPS / multiweb（てっぱん本部）

   ぜんぶ入れ終わったら、このウィンドウを閉じてください。
   閉じたあとで、ログインできているかを確認します。
  ─────────────────────────────────────────────────────
`);

// 何も出ないと固まって見えるので、待っていることを出し続ける
let waited = 0;
const beat = setInterval(() => {
  waited += 10;
  process.stdout.write(`\r  ブラウザを閉じるのを待っています… ${waited}秒経過（ログインが済んだらブラウザの窓を閉じてください）`);
}, 10000);

await new Promise((r) => ctx.on('close', r));
clearInterval(beat);
process.stdout.write('\n\n  ブラウザが閉じました。ログインを確認します…\n');
saving = false;
await keep;

// 保存したセッションで開き直して、本当にログインが残っているか見る
const br = await chromium.launch({ headless: true });
const chk = await br.newContext({ storageState: STATE, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
const cp = await chk.newPage();
const ok = {};
for (const [name, url, isIn] of SITES) {
  await cp.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await cp.waitForTimeout(2500);
  ok[name] = isIn(cp.url(), await cp.title());
  console.log(`  ${ok[name] ? '○ ログイン済み' : '× ログインできていません'} … ${name}`);
}
await chk.close();
await br.close();

const ng = Object.entries(ok).filter(([, v]) => !v).map(([k]) => k);
if (ng.length) {
  console.log(`\n  ${ng.join('・')} が入っていません。もう一度 login.command を実行してください。`);
  console.log('  （ログイン画面で「ログイン状態を保持」のチェックがあれば入れてください）\n');
} else {
  console.log('\n  3つとも入りました。\n');
}

if (process.argv.includes('--fetch') && ok['ダイニー']) {
  console.log('  続けて取得します（数分かかります）…\n');
  const from = process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const r = spawnSync('node', [path.join(ROOT, 'scripts', 'fetch.mjs'), ...(from ? [from] : [])],
    { stdio: 'inherit', cwd: ROOT });
  if (r.status === 0) {
    spawnSync('python3', [path.join(ROOT, 'scripts', 'build.py')], { stdio: 'inherit', cwd: ROOT });
    spawnSync('node', [path.join(ROOT, 'scripts', 'encrypt.mjs')], { stdio: 'inherit', cwd: ROOT });
    spawnSync('zsh', ['-c', 'git add docs && git commit -q -m "$(date +%F) 更新" && git push -q origin main && echo "  サイトを更新しました"'],
      { stdio: 'inherit', cwd: ROOT });
  }
}
