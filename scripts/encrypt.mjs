// .cache/payload.json を合言葉で暗号化して docs/data/payload.json に置く。
// GitHub Pages は公開なので、金額そのものは暗号化して置く（合言葉を知らないと読めない）。
// 合言葉は .env の PASSPHRASE。.env はコミットしない。
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.join(os.homedir(), 'umapro-daily');

let pass = process.env.PASSPHRASE;
if (!pass) {
  const env = await fs.readFile(path.join(ROOT, '.env'), 'utf8').catch(() => '');
  pass = (/^PASSPHRASE=(.*)$/m.exec(env) ?? [])[1]?.trim();
}
if (!pass) throw new Error('.env に PASSPHRASE= がありません');

const plain = await fs.readFile(path.join(ROOT, '.cache', 'payload.json'));
const salt = crypto.randomBytes(16);
const iv = crypto.randomBytes(12);
const key = crypto.pbkdf2Sync(pass, salt, 250000, 32, 'sha256');
const c = crypto.createCipheriv('aes-256-gcm', key, iv);
const enc = Buffer.concat([c.update(plain), c.final()]);
const tag = c.getAuthTag();

await fs.mkdir(path.join(ROOT, 'docs', 'data'), { recursive: true });
await fs.writeFile(path.join(ROOT, 'docs', 'data', 'payload.json'), JSON.stringify({
  v: 1, alg: 'AES-GCM', kdf: 'PBKDF2-SHA256', iter: 250000,
  salt: salt.toString('base64'), iv: iv.toString('base64'),
  data: Buffer.concat([enc, tag]).toString('base64'),
  updatedAt: new Date().toISOString(),
}));
console.log(`暗号化して保存（${(enc.length / 1024).toFixed(0)}KB）`);
