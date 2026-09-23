// Build-time data compiler (Node):
//   node dev/build-data.js
// Splits dev/level-*.json into
//   site/data/levels.json        — 汤面等公开部分，随包发布
//   site/data/secrets.enc.json   — state / 汤底 / 判分 / 标准流水线，AES-256-GCM 加密
// The plaintext level sources are intentionally NOT committed (anti-spoiler).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DEV = path.join(ROOT, 'dev');
const OUT = path.join(ROOT, 'site', 'data');

const ITERATIONS = 200000;
const SALT = 'jev-tangpu-vault-v1';
// Keep in sync with site/js/vault.js (P1 + meta[vault-seed] + P2 + P3)
const PASSPHRASE = 'sc0re-b0ard-' + 'x7-k3q' + 'jev-t4ngpu-v4ult' + 'system0ne';

const PUBLIC_FIELDS = [
  'id', 'index', 'title', 'pattern', 'patternKey', 'soup', 'ticket',
  'visible', 'goal', 'budget', 'actions',
];
const PLAY_FIELDS = ['state'];
const REVEAL_FIELDS = ['reveal', 'answerKey', 'canonical', 'coaching'];

function pick(src, fields) {
  const out = {};
  for (const f of fields) out[f] = src[f];
  return out;
}

function encrypt(obj) {
  const key = crypto.pbkdf2Sync(PASSPHRASE, Buffer.from(SALT, 'utf8'), ITERATIONS, 32, 'sha256');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: Buffer.concat([iv, body, tag]).subarray(0, 12).toString('base64'),
    ct: Buffer.concat([body, tag]).toString('base64'),
  };
}

function main() {
  const files = fs.readdirSync(DEV).filter((f) => /^level-.*\.json$/.test(f)).sort();
  if (files.length === 0) throw new Error('no dev/level-*.json found');

  const levels = [];
  const secrets = {};
  for (const f of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(DEV, f), 'utf8'));
    levels.push(pick(raw, PUBLIC_FIELDS));
    secrets[raw.id] = {
      play: encrypt(pick(raw, PLAY_FIELDS)),
      reveal: encrypt(pick(raw, REVEAL_FIELDS)),
    };
    console.log('packed', raw.id, raw.title);
  }
  levels.sort((a, b) => a.index - b.index);

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(
    path.join(OUT, 'levels.json'),
    JSON.stringify({ generated: new Date().toISOString(), levels }, null, 2),
    'utf8',
  );
  fs.writeFileSync(
    path.join(OUT, 'secrets.enc.json'),
    JSON.stringify({ v: 1, kdf: { name: 'PBKDF2-SHA256', iterations: ITERATIONS, salt: SALT }, levels: secrets }, null, 2),
    'utf8',
  );
  console.log('wrote', levels.length, 'levels ->', path.relative(ROOT, OUT));
}

main();
