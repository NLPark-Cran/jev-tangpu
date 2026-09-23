// 观猹 OAuth2：Authorization Code + PKCE(S256)，纯前端公开客户端。
// 依据《观猹认证接入文档 / watcha_oauth2接入文档》：
//   GET  https://watcha.cn/oauth/authorize   授权
//   POST https://watcha.cn/oauth/api/token   换 token（x-www-form-urlencoded）
//   GET  https://watcha.cn/oauth/api/userinfo 取用户信息
// 公开客户端没有 client_secret，必须带 PKCE；client_id 里的 + 在 URL 中要编码成 %2B。

const AUTH_BASE = 'https://watcha.cn';
// 文档「常见问题」给出的非机密客户端测试 client_id。
// 正式上线前按《观猹 OAuth2.0 服务开通信息收集表》申请自己的 client_id 替换这里即可。
export const CLIENT_ID = '3p9Mcr+CNLPAMFC0';
const SCOPE = 'read'; // 只要 user_id / nickname / avatar_url，不要 email、phone
const STORE = 'jev.wa';
const PENDING = 'jev.wa.pkce';

const enc = new TextEncoder();
// 观猹表单里的 Domain 填的是「回调地址的 URI Schema」（如 http://localhost:3000，无尾斜杠），
// 所以 redirect_uri 只用 origin，前后两步必须一致。
const redirectUri = () => location.origin;
const b64url = (bytes) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const VERIFIER_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

function makeVerifier() {
  const b = crypto.getRandomValues(new Uint8Array(64));
  return Array.from(b, (x) => VERIFIER_CHARS[x % VERIFIER_CHARS.length]).join('');
}
async function challengeS256(verifier) {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(verifier))));
}

export function session() {
  try {
    return JSON.parse(localStorage.getItem(STORE)) || null;
  } catch {
    return null;
  }
}
export function logout() {
  localStorage.removeItem(STORE);
}

/** 跳去观猹授权页。state 里带上前缀，回调时用来跟 TokenDance 的 code 区分开。 */
export async function beginLogin() {
  const verifier = makeVerifier();
  const state = 'wa.' + b64url(crypto.getRandomValues(new Uint8Array(12)));
  sessionStorage.setItem(PENDING, JSON.stringify({ verifier, state }));
  const challenge = await challengeS256(verifier);
  const qs = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(),
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  location.assign(AUTH_BASE + '/oauth/authorize?' + qs.toString());
}

export function isWatchaCallback(params) {
  return (params.get('state') || '').startsWith('wa.');
}

/** 授权页带回 code 后换 token 并取用户信息。 */
export async function finishLogin(code, state) {
  const pending = JSON.parse(sessionStorage.getItem(PENDING) || 'null');
  sessionStorage.removeItem(PENDING);
  if (!pending) throw new Error('缺少 PKCE verifier，请重新登录');
  if (state !== pending.state) throw new Error('state 不匹配，可能是跨站请求，请重新登录');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
    client_id: CLIENT_ID,
    code_verifier: pending.verifier,
  });
  const tok = await call('/oauth/api/token', body);
  const user = await call('/oauth/api/userinfo', null, tok.access_token);
  const s = {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    scope: tok.scope,
    expires_at: Date.now() + (tok.expires_in || 1800) * 1000,
    user: user.data || user,
  };
  localStorage.setItem(STORE, JSON.stringify(s));
  return s;
}

/** access_token 只有 30 分钟，过期前用 refresh_token 续。 */
export async function ensureFresh() {
  const s = session();
  if (!s) return null;
  if (Date.now() < s.expires_at - 60000) return s;
  if (!s.refresh_token) return logout() || null;
  try {
    const tok = await call(
      '/oauth/api/token',
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: s.refresh_token }),
    );
    const next = {
      ...s,
      access_token: tok.access_token,
      refresh_token: tok.refresh_token || s.refresh_token,
      expires_at: Date.now() + (tok.expires_in || 1800) * 1000,
    };
    localStorage.setItem(STORE, JSON.stringify(next));
    return next;
  } catch {
    logout();
    return null;
  }
}

async function call(path, form, bearer) {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (bearer) headers.Authorization = 'Bearer ' + bearer;
  const res = await fetch(AUTH_BASE + path, {
    method: form ? 'POST' : 'GET',
    headers,
    body: form ? form.toString() : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.message || res.status);
  return data;
}
