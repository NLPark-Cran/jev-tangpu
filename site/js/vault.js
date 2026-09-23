// Spoiler vault: level truths are shipped encrypted and only unlocked when the
// game needs them (state on level start, reveal after the player commits).
//
// 这是防剧透（view-source / 顺手翻 JSON），不是防破解：纯静态托管下密钥必然到达客户端，
// 能看到网络请求的人也能看到 state。真正敏感的判断请走服务端代理调用 Jev。

const ITERATIONS = 200000;
const SALT = 'jev-tangpu-vault-v1';

// Passphrase is split across the bundle on purpose (see README).
const P1 = 'sc0re-b0ard-';
const P3 = 'system0ne';
const P2 = 'jev-t4ngpu-v4ult';

function passphrase() {
  const meta = document.querySelector('meta[name="vault-seed"]');
  const tail = meta ? meta.content : '';
  return P1 + tail + P2 + P3;
}

let cachedKey = null;

async function getKey() {
  if (cachedKey) return cachedKey;
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase()),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  cachedKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: new TextEncoder().encode(SALT), iterations: ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
  return cachedKey;
}

const b64decode = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** @param {{iv: string, ct: string}} record @returns {Promise<object>} parsed plaintext JSON */
export async function unlock(record) {
  const key = await getKey();
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64decode(record.iv) },
    key,
    b64decode(record.ct),
  );
  return JSON.parse(new TextDecoder().decode(plain));
}
