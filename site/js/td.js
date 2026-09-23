// TokenDance gateway client (browser-side).
// Docs: https://tokendance.space/docs/ai-integration.md
// One API key covers every protocol; per-model base paths differ.

export const BASE = 'https://tokendance.space';

export const MODELS = {
  jev: 'bocha-jev-v1', // typesafe:systemone — 结构化判断（是非/选择/分级）
  chat: 'deepseek-v4.1-flash', // openai:chat-completions — 教练点评 / 叙事 / skill 生成
  embed: 'qwen3.7-text-embedding', // openai:embeddings — 实践语料向量化
  rerank: 'qwen3.7-text-rerank', // qwen:text-rerank — 实践语料重排
  image: 'seedream-5.0-pro', // ark:image-generations — 关卡插画
};

const KEY_STORE = 'jev.td.key';
const VERIFIER_STORE = 'jev.td.pkce';

export function saveKey(key) {
  localStorage.setItem(KEY_STORE, key.trim());
}
export function loadKey() {
  return localStorage.getItem(KEY_STORE) || '';
}
export function clearKey() {
  localStorage.removeItem(KEY_STORE);
}

// 应用归因：App URL 是归因的唯一要素，必须唯一且稳定（协议/端口/路径/尾斜杠都算数）。
// 固定成 origin + '/'，避免玩家用 /index.html 进来时被算成另一个应用。
function appUrl() {
  return location.origin + '/';
}

// https://tokendance.space/docs/api-key-oauth.md#recover-key
const RECOVERY = {
  top_up_balance: '账户余额不足，请先到 TokenDance 充值（这把 Key 仍然有效），再回来重试',
  reauthorize_api_key: '这把 Key 已失效（被删除、禁用、过期，或总额度用尽），请重新连接 Token 钱包',
  api_key_quota: '这把 Key 的周期额度用完了：等额度刷新，或重新连接 Token 钱包换一把',
};

async function request(path, body, { method = 'POST' } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'X-App-Url': appUrl(),
  };
  const key = loadKey();
  if (key) headers.Authorization = 'Bearer ' + key;

  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const recovery = res.headers.get('Tokendance-Recovery-Action');
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    const detail = data && data.detail;
    const msg =
      (detail && (detail[0]?.msg || detail.message || detail)) ||
      (data && data.error && data.error.message) ||
      text ||
      res.status;
    const hint = RECOVERY[recovery];
    const raw = typeof msg === 'string' ? msg : JSON.stringify(msg);
    const err = new Error(hint ? hint : raw);
    err.status = res.status;
    err.recovery = recovery;
    err.detail = detail;
    if (hint) err.raw = raw;
    throw err;
  }
  return data;
}

/** 验证 Key 是否可用：用一次最便宜的 Jev 判断题试探。 */
export async function verifyKey() {
  const r = await request('/gateway/typesafe/v1/systemone', {
    model: MODELS.jev,
    state: '连通性测试',
    questions: { ping: { type: 'noul', instructions: '这是一条连通性测试吗？' } },
  });
  return !!r.answers;
}

/**
 * Jev 结构化判断：一次可问多题，各题共享同一份 state，独立返回概率。
 * @param {string} state 事实档案（隐藏真相）
 * @param {Record<string, object>} questions
 */
export async function askJev(state, questions) {
  return request('/gateway/typesafe/v1/systemone', {
    model: MODELS.jev,
    state,
    questions,
  });
}

/** 生成式模型：教练点评、汤底叙事、skill 撰写。 */
export async function chat(system, user, { maxTokens = 2200, temperature = 0.6 } = {}) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });
  const r = await request('/gateway/v1/chat/completions', {
    model: MODELS.chat,
    messages,
    temperature,
    max_tokens: maxTokens,
  });
  const m = r.choices?.[0]?.message || {};
  return (m.content || '').trim();
}

export async function embed(texts) {
  const r = await request('/gateway/v1/embeddings', {
    model: MODELS.embed,
    input: texts,
  });
  return r.data.map((d) => d.embedding);
}

/** @returns {Promise<{index:number, relevance_score:number}[]>} 按相关性降序 */
export async function rerank(query, documents, { topN, instruct } = {}) {
  const parameters = {};
  if (topN) parameters.top_n = topN;
  if (instruct) parameters.instruct = instruct;
  const r = await request('/gateway/alibaba/text-rerank/v1', {
    model: MODELS.rerank,
    input: { query, documents },
    parameters,
  });
  return r.output.results;
}

/** 文生图：返回可直接 <img src> 的 data URL。 */
export async function genImage(prompt, { size = '2K' } = {}) {
  const r = await request('/gateway/ark/v3/images/generations', {
    model: MODELS.image,
    prompt,
    size,
    output_format: 'jpeg',
    response_format: 'url',
    watermark: false,
  });
  const item = r.data?.[0] || r;
  const url = item.url;
  if (!url) throw new Error('图像生成未返回 url');
  const blob = await (await fetch(url)).blob();
  return await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

// ── OAuth 式 API Key 授权（S256 PKCE）────────────────────────────────
// https://tokendance.space/docs/api-key-oauth.md

const VERIFIER_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
const b64url = (bytes) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function makeVerifier() {
  const bytes = crypto.getRandomValues(new Uint8Array(64));
  return Array.from(bytes, (b) => VERIFIER_CHARS[b % VERIFIER_CHARS.length]).join('');
}

async function challengeS256(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

/** 跳转到 TokenDance 授权页，换一个属于玩家自己的新 Key。 */
export async function beginAuth(keyName = 'Jev 汤铺') {
  const verifier = makeVerifier();
  sessionStorage.setItem(VERIFIER_STORE, verifier);
  const challenge = await challengeS256(verifier);
  const params = new URLSearchParams({
    callback_url: appUrl(),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    app_url: appUrl(),
    key_name: keyName,
  });
  location.assign(BASE + '/auth?' + params.toString());
}

/** 授权页带回 ?code= 后，用它换 API Key。 */
export async function finishAuth(code) {
  const verifier = sessionStorage.getItem(VERIFIER_STORE);
  if (!verifier) throw new Error('缺少 PKCE verifier，请重新发起授权');
  sessionStorage.removeItem(VERIFIER_STORE);
  const r = await request('/portal/api/v1/auth/keys', {
    code,
    code_verifier: verifier,
    code_challenge_method: 'S256',
  });
  const key = r.key || r.api_key || r.token || (r.data && (r.data.key || r.data.api_key));
  if (!key) throw new Error('授权响应里没有 API Key');
  saveKey(key);
  return key;
}
