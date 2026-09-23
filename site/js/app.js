import * as TD from './td.js';
import * as G from './game.js';
import * as C from './coach.js';
import { downloadZip } from './zip.js';

const $ = (s) => document.querySelector(s);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};
const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const S = {
  levels: [],
  secrets: {},
  practices: [],
  cur: null,
  curState: null,
  asked: [],
  tokens: 0,
  ms: 0,
  draft: null,
  progress: G.loadProgress(),
  runs: [],
  busy: false,
};

function newDraft() {
  return {
    type: 'noul',
    instructions: '',
    rows: [
      { label: '', desc: '' },
      { label: '', desc: '' },
    ],
  };
}
S.draft = newDraft();

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

function show(name) {
  for (const s of document.querySelectorAll('.screen')) s.classList.add('hidden');
  $('#screen-' + name).classList.remove('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

const starsHtml = (n) =>
  '★★★★★'.slice(0, n) + `<span class="off">${'★★★★★'.slice(n)}</span>`;

// ── Key 管理 ────────────────────────────────────────────────
function refreshKeyUI() {
  const key = TD.loadKey();
  const pill = $('#keyStatus');
  pill.textContent = key ? '已连接 ' + key.slice(0, 6) + '…' + key.slice(-4) : '未连接 TokenDance';
  pill.classList.toggle('on', !!key);
  renderConn();
}

function renderConn() {
  const box = $('#connBox');
  if (!box) return;
  if (TD.loadKey()) {
    box.innerHTML = `<h3>已连接 TokenDance</h3>
      <p>Key 存在你的浏览器里（localStorage），只用于向 TokenDance 发起模型调用。想换一把钥匙随时来这。</p>
      <div class="row"><button class="ghost" id="btnTest">测一下连通</button><button class="ghost" id="btnForget">忘记这把 Key</button></div>`;
    $('#btnTest').onclick = async () => {
      try {
        await TD.verifyKey();
        toast('连通正常，Jev 已就位');
      } catch (e) {
        toast('调用失败：' + e.message);
      }
    };
    $('#btnForget').onclick = () => {
      TD.clearKey();
      refreshKeyUI();
    };
  } else {
    box.innerHTML = `<h3>先接上 TokenDance</h3>
      <p>本游戏全部模型调用都发生在<b>你的浏览器</b>里，用的是<b>你自己的</b> TokenDance API Key——所以你问的每一句、每一次推理的延迟与 token 消耗，都真实计在你名下。</p>
      <div class="row">
        <button class="primary" id="btnAuthGo">用 TokenDance 授权一把新 Key</button>
        <input id="keyInput" type="text" placeholder="或粘贴已有 sk-… Key" autocomplete="off">
        <button class="ghost" id="btnKeySave">保存</button>
      </div>
      <p class="hint">授权走 OAuth 式 PKCE，TokenDance 会在确认页让你设定额度与有效期；Key 不会被本游戏上传到任何地方。</p>`;
    $('#btnAuthGo').onclick = () => TD.beginAuth('Jev 汤铺').catch((e) => toast(e.message));
    $('#btnKeySave').onclick = () => {
      const v = $('#keyInput').value.trim();
      if (!v) return toast('先粘贴一把 Key');
      TD.saveKey(v);
      refreshKeyUI();
      toast('Key 已保存到本地');
    };
  }
}

// ── 首页：汤单 ─────────────────────────────────────────────
function renderLevelList() {
  const wrap = $('#levelList');
  wrap.innerHTML = '';
  for (const lv of S.levels) {
    const p = S.progress[lv.id];
    const card = el('article', 'level-card');
    card.innerHTML = `
      <div class="art" style="background-image:url('assets/${lv.id}.jpg')" data-art="${lv.id}"></div>
      <div class="body">
        <div class="pattern">${esc(lv.pattern)}</div>
        <h3>${esc(lv.title)}</h3>
        <p class="soup">${esc(lv.soup.slice(0, 62))}…</p>
        <div class="foot-row">
          <span class="badge">预算 ${lv.budget} 问</span>
          <span class="stars">${p ? starsHtml(p.stars) : '<span class="off">未开汤</span>'}</span>
        </div>
      </div>`;
    const art = card.querySelector('.art');
    art.style.backgroundImage = `url('assets/${lv.id}.jpg')`;
    card.onclick = () => startLevel(lv.id);
    wrap.appendChild(card);
    probeArt(lv.id, art);
  }
}

function probeArt(id, node) {
  const img = new Image();
  img.onerror = () => {
    node.style.backgroundImage = 'none';
    node.style.background = 'linear-gradient(135deg, #2a221b, #3a2a1e)';
  };
  img.src = `assets/${id}.jpg`;
}

// ── 汤面 ───────────────────────────────────────────────────
function startLevel(id) {
  const lv = S.levels.find((l) => l.id === id);
  if (!TD.loadKey()) return toast('先在上面接上 TokenDance');
  S.cur = lv;
  S.asked = [];
  S.tokens = 0;
  S.ms = 0;
  S.draft = newDraft();

  const body = $('#screen-level');
  body.innerHTML = `<div class="card">
      <div class="tag">第 ${lv.index} 关 · ${esc(lv.pattern)}</div>
      <h2 class="title">${esc(lv.title)}</h2>
      <div class="soup-quote">${esc(lv.soup)}</div>
      <h3 class="sub">你拿到的东西</h3>
      <div class="ticket">${esc(lv.ticket)}</div>
      <h3 class="sub" style="margin-top:20px">后台可见数据</h3>
      <ul class="meta-list">${lv.visible.map((v) => `<li>${esc(v)}</li>`).join('')}</ul>
      <div class="goal"><b>你的目标：</b>${esc(lv.goal)}</div>
      <p class="hint">隐藏的事实档案会在你提问时才解密，并作为 state 交给 Jev。你一共有 ${lv.budget} 次提问机会。</p>
      <div class="actions-row">
        <button class="primary big" id="btnStart">开始问汤</button>
        <button class="ghost" id="btnBack">回汤单</button>
      </div>
    </div>`;
  $('#btnBack').onclick = () => show('gate');
  $('#btnStart').onclick = async () => {
    try {
      const r = await G.openLevel(S.secrets, lv.id);
      S.curState = r.state;
    } catch (e) {
      return toast('事实档案解密失败：' + e.message);
    }
    renderComposer();
    renderHud();
    $('#answers').innerHTML = '';
    show('ask');
  };
  show('level');
}

// ── 问汤：题面编辑器 ───────────────────────────────────────
function renderComposer() {
  const d = S.draft;
  const box = $('#composer');
  const isScore = d.type === 'score';
  const rows = d.rows
    .map((r, i) =>
      isScore
        ? `<div class="crit-row score-row">
             <span class="row-idx">档 ${i}</span>
             <input type="text" data-row="${i}" data-k="label" value="${esc(r.label)}" placeholder="这一档对应什么业务动作">
             <button data-del="${i}" title="删除">–</button>
           </div>`
        : `<div class="crit-row">
             <input type="text" data-row="${i}" data-k="label" value="${esc(r.label)}" placeholder="标签（返回值 key）">
             <input type="text" data-row="${i}" data-k="desc" value="${esc(r.desc)}" placeholder="这个标签的定义">
             <button data-del="${i}" title="删除">–</button>
           </div>`,
    )
    .join('');

  const hint =
    d.type === 'noul'
      ? '是非题只有两个字段。问<b>可判定的原子事实</b>（「轴体是否损坏」），别问综合印象（「是不是坏了」）。'
      : d.type === 'choice'
        ? 'criteria 是<b>对象</b>：标签 → 一句话定义。要<b>互斥且穷尽</b>，记得留一个噪声兜底分支。'
        : 'criteria 是<b>有序字符串数组</b>，按顺序定档 0…n-1。档位描述要对应<b>不同的业务动作</b>。';

  box.innerHTML = `
    <h3 class="sub">写一个 Jev 问题</h3>
    <div class="type-tabs">
      <button data-type="noul" class="${d.type === 'noul' ? 'on' : ''}">是非 noul</button>
      <button data-type="choice" class="${d.type === 'choice' ? 'on' : ''}">选择 choice</button>
      <button data-type="score" class="${d.type === 'score' ? 'on' : ''}">分级 score</button>
    </div>
    <label class="field">
      <span>instructions · 判断指令</span>
      <textarea id="fInstr" placeholder="${
        d.type === 'noul' ? '例：用户手上是否存在可核实的质量证据？' : d.type === 'choice' ? '例：这一单最可能属于哪一类？' : '例：这一单的紧急程度有多高？'
      }">${esc(d.instructions)}</textarea>
    </label>
    ${
      d.type === 'noul'
        ? ''
        : `<label class="field"><span>criteria · ${isScore ? '档位（按顺序）' : '候选标签与定义'}</span>
             <div class="crit-rows">${rows}</div>
             <button class="ghost" id="btnAddRow">+ 加一行</button></label>`
    }
    <p class="hint">${hint}</p>
    <div class="actions-row" style="margin-top:16px">
      <button class="primary" id="btnAsk">问！</button>
      <button class="ghost" id="btnCoachQ">让教练看一眼</button>
    </div>
    <div id="coachNote"></div>`;

  box.querySelectorAll('[data-type]').forEach((b) => {
    b.onclick = () => {
      S.draft.type = b.dataset.type;
      renderComposer();
    };
  });
  box.querySelector('#fInstr').oninput = (e) => (S.draft.instructions = e.target.value);
  box.querySelectorAll('[data-row]').forEach((inp) => {
    inp.oninput = (e) => {
      S.draft.rows[+e.target.dataset.row][e.target.dataset.k] = e.target.value;
    };
  });
  box.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = () => {
      if (S.draft.rows.length <= 2) return toast('至少留两行');
      S.draft.rows.splice(+b.dataset.del, 1);
      renderComposer();
    };
  });
  const add = box.querySelector('#btnAddRow');
  if (add)
    add.onclick = () => {
      if (S.draft.rows.length >= 5) return toast('criteria 最多五项');
      S.draft.rows.push({ label: '', desc: '' });
      renderComposer();
    };
  box.querySelector('#btnAsk').onclick = ask;
  box.querySelector('#btnCoachQ').onclick = askCoach;
}

function draftToQuestion() {
  return G.toJevQuestion(S.draft);
}

async function askCoach() {
  if (S.busy) return;
  S.busy = true;
  const note = $('#coachNote');
  note.innerHTML = `<div class="coach-note"><span class="spin"></span>教练在看…</div>`;
  try {
    const txt = await C.coachQuestion(S.draft, S.cur.title);
    note.innerHTML = `<div class="coach-note">${esc(txt)}</div>`;
  } catch (e) {
    note.innerHTML = `<div class="coach-note">教练没接上：${esc(e.message)}</div>`;
  } finally {
    S.busy = false;
  }
}

async function ask() {
  if (S.busy) return;
  if (S.asked.length >= S.cur.budget) return toast('问题预算用完了，开汤吧');
  const errors = G.validateDraft(S.draft);
  if (errors.length) return toast(errors.join('；'));

  const question = draftToQuestion();
  const name = 'q' + (S.asked.length + 1);
  S.busy = true;
  const btn = $('#btnAsk');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span>问汤中…';
  try {
    const t0 = performance.now();
    const res = await TD.askJev(S.curState, { [name]: question });
    const wall = Math.round(performance.now() - t0);
    const answer = res.answers[name];
    const optionCount =
      question.type === 'choice'
        ? Object.keys(question.criteria).length
        : question.type === 'score'
          ? question.criteria.length
          : 2;
    const sum = G.summarizeAnswer(question.type, answer, optionCount);
    const rec = {
      type: question.type,
      question,
      answer,
      optionCount,
      sharp: sum.sharp,
      summary: sum,
      usage: res.usage,
      metadata: res.metadata,
      wall,
    };
    S.asked.push(rec);
    S.tokens += res.usage?.input_tokens || 0;
    S.ms += res.metadata?.inference_ms || 0;
    renderAnswerCard(rec, S.asked.length);
    renderHud();
    S.draft.instructions = '';
    renderComposer();
  } catch (e) {
    toast('Jev 拒绝了这个问题：' + e.message);
  } finally {
    S.busy = false;
  }
}

function renderAnswerCard(rec, n) {
  const s = rec.summary;
  const card = el('article', 'answer');
  const bars = s.rows
    .map(
      ([lbl, p], i) => `<div class="bar-row ${i === 0 ? 'top' : ''}">
        <span class="lbl" title="${esc(lbl)}">${esc(lbl)}</span>
        <span class="bar-track"><i style="width:${Math.round(p * 100)}%"></i></span>
        <span class="pct">${(p * 100).toFixed(1)}%</span>
      </div>`,
    )
    .join('');
  card.innerHTML = `
    <div class="head">
      <div>
        <div class="kind">#${n} · ${s.title}</div>
        <div class="qtext">${esc(rec.question.instructions)}</div>
      </div>
      <div class="main">${esc(s.main)}</div>
    </div>
    <div class="bars">${bars}</div>
    <div class="sharp-row">
      <span>问题锐度</span>
      <span class="sharp-track"><i style="width:${Math.round(s.sharp * 100)}%"></i></span>
      <span>${Math.round(s.sharp * 100)}%</span>
    </div>
    <details class="raw">
      <summary>原始响应与元数据</summary>
      <pre>${esc(JSON.stringify({ answer: rec.answer, usage: rec.usage, metadata: rec.metadata }, null, 2))}</pre>
      <p class="hint">metadata.confidence_definition = maximum candidate probability; not guaranteed correctness。
      confidence 是最大候选概率，<b>不是正确率</b>；${(rec.wall)} ms 是端到端耗时，模型推理 ${(rec.metadata?.inference_ms ?? 0).toFixed(1)} ms。</p>
    </details>`;
  $('#answers').appendChild(card);
}

function renderHud() {
  const left = S.cur.budget - S.asked.length;
  $('#hud').innerHTML = `
    <span>预算 <b>${left}</b> / ${S.cur.budget}</span>
    <span class="budget-bar"><i style="width:${Math.round((S.asked.length / S.cur.budget) * 100)}%"></i></span>
    <span>已问 <b>${S.asked.length}</b></span>
    <span>累计 <b>${S.tokens}</b> input tokens</span>
    <span>推理 <b>${S.ms.toFixed(1)}</b> ms</span>`;
}

// ── 决策 ───────────────────────────────────────────────────
function goDecide() {
  const lv = S.cur;
  const body = $('#screen-decide');
  body.innerHTML = `<div class="card">
      <div class="tag">${esc(lv.title)} · 收工</div>
      <h2 class="title">你打算怎么办？</h2>
      <p class="muted">提交后就开汤了——真相、判分、标准流水线一次揭晓。你问了 ${S.asked.length} 个问题，还剩 ${lv.budget - S.asked.length} 个预算没用。</p>
      <div class="decide-grid">
        ${lv.actions
          .map(
            (a) => `<div class="action-card" data-act="${a.id}">
              <h4>${esc(a.label)}</h4><p>${esc(a.desc)}</p></div>`,
          )
          .join('')}
      </div>
      <div class="actions-row">
        <button class="ghost" id="btnBackAsk">再问几个</button>
      </div>
    </div>`;
  let picked = null;
  body.querySelectorAll('[data-act]').forEach((c) => {
    c.onclick = () => {
      body.querySelectorAll('.action-card').forEach((x) => x.classList.remove('on'));
      c.classList.add('on');
      picked = c.dataset.act;
    };
  });
  $('#btnBackAsk').onclick = () => show('ask');
  let submitted = false;
  const card = body.querySelector('.card');
  const go = el('button', 'primary big', '提交决策，开汤');
  go.style.marginTop = '22px';
  go.onclick = async () => {
    if (!picked) return toast('先选一个动作');
    if (submitted) return;
    submitted = true;
    go.disabled = true;
    go.innerHTML = '<span class="spin"></span>开汤中…';
    await submitDecision(picked);
  };
  card.appendChild(go);
  show('decide');
}

// ── 开汤复盘 ───────────────────────────────────────────────
async function submitDecision(actionId) {
  const lv = S.cur;
  let secret;
  try {
    secret = await G.openReveal(S.secrets, lv.id);
  } catch (e) {
    return toast('汤底解密失败：' + e.message);
  }
  const result = G.grade({ level: lv, asked: S.asked, action: actionId, secret });
  const key = secret.answerKey;
  const actLabel = (id) => lv.actions.find((a) => a.id === id)?.label || id;

  S.progress[lv.id] = {
    score: result.total,
    stars: result.stars,
    action: actionId,
    asked: S.asked.length,
    at: new Date().toISOString(),
  };
  G.saveProgress(S.progress);
  S.runs.push({
    levelTitle: lv.title + '（' + lv.pattern + '）',
    questions: S.asked.map((a) => a.question),
    decision: actLabel(actionId),
    score: result.total,
  });

  const ok = actionId === key.best;
  const half = !ok && key.acceptable.includes(actionId);
  const verdictCls = ok ? 'good' : half ? '' : 'bad';
  const verdictWord = ok ? '答对了' : half ? '合格，但不是最优' : '答错了';

  const body = $('#screen-reveal');
  body.innerHTML = `<div class="card">
      <div class="tag">第 ${lv.index} 关 · ${esc(lv.title)} · 开汤</div>
      <div class="score-head">
        <div class="score-num">${result.total}</div>
        <div>
          <div class="score-stars">${starsHtml(result.stars)}</div>
          <div class="dim">${verdictWord} · 用了 ${S.asked.length} 个问题 · ${S.tokens} tokens</div>
        </div>
      </div>

      <h3 class="sub" style="margin-top:26px">判分透明账</h3>
      <div class="breakdown">
        ${[
          ['决策对错', result.parts.decision, '对 100 / 合格 60 / 错 20'],
          ['问题锐度', result.parts.sharp, '平均锐度 ' + Math.round(result.meanSharp * 100) + '%'],
          ['预算效率', result.parts.eff, '理想 2 问，预算 ' + lv.budget + ' 问'],
          ['校准意识', result.parts.calib, '最强证据锐度 ' + Math.round(result.evidence * 100) + '%'],
        ]
          .map(
            ([lbl, p, note]) => `<div class="bd-row">
              <span class="lbl">${lbl} <span class="dim">×${Math.round(p.weight * 100)}%</span></span>
              <span class="bd-track"><i style="width:${p.value}%"></i></span>
              <span class="val">${p.value} · ${note}</span>
            </div>`,
          )
          .join('')}
      </div>

      <h3 class="sub" style="margin-top:26px">你的决策</h3>
      <div class="verdict ${verdictCls}">
        <p style="margin:0 0 8px"><b>${esc(actLabel(actionId))}</b> <span class="dim">（标准动作：<b>${esc(actLabel(key.best))}</b>）</span></p>
        <p class="muted" style="margin:0">${esc(key.why)}</p>
      </div>

      <h3 class="sub" style="margin-top:26px">汤底</h3>
      <div class="reveal-text">${esc(secret.reveal)}</div>

      <h3 class="sub" style="margin-top:26px">教练复盘</h3>
      <div id="coachReview"><span class="spin"></span>教练在读你的提问序列…</div>

      <h3 class="sub" style="margin-top:26px">这一关教的那一手</h3>
      <ul class="coach-list">${secret.coaching.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>

      <h3 class="sub" style="margin-top:26px">标准 Jev 流水线</h3>
      <p class="muted">${esc(secret.canonical.summary)}</p>
      <details class="raw" open>
        <pre>${esc(JSON.stringify({ model: TD.MODELS.jev, state: '<事实文本>', questions: secret.canonical.questions }, null, 2))}</pre>
      </details>
      <div class="policy"><b>决策策略：</b>${esc(secret.canonical.policy)}</div>

      <div class="actions-row">
        <button class="primary big" id="btnNext">下一关</button>
        <button class="ghost" id="btnRetry">重玩本关</button>
        <button class="ghost" id="btnToSkill">带走 skill</button>
      </div>
    </div>`;

  $('#btnNext').onclick = () => {
    const next = S.levels.find((l) => l.index === lv.index + 1);
    if (next) startLevel(next.id);
    else showSkill();
  };
  $('#btnRetry').onclick = () => startLevel(lv.id);
  $('#btnToSkill').onclick = showSkill;
  show('reveal');

  try {
    const txt = await C.coachReview(
      lv.title,
      S.asked.map((a) => ({ ...a, question: a.question })),
      actLabel(actionId),
      `${verdictWord}，总分 ${result.total}`,
    );
    $('#coachReview').innerHTML = `<div class="coach-note">${esc(txt)}</div>`;
  } catch (e) {
    $('#coachReview').innerHTML = `<div class="dim">教练这次没接上（${esc(e.message)}）。上面的透明判分和三条要点仍然算数。</div>`;
  }
}

// ── 带走 skill ─────────────────────────────────────────────
function showSkill() {
  const body = $('#screen-skill');
  const done = S.levels.filter((l) => S.progress[l.id]);
  body.innerHTML = `<div class="card">
      <div class="tag">带走</div>
      <h2 class="title">把 Jev 打包带走</h2>
      <p class="muted">你会的这些判断手法，不该只留在汤铺里。导出一份 skill，回到自己的项目里让 AI 助手照着用。
      生成时会用 <b>qwen3.7-text-embedding + qwen3.7-text-rerank</b> 从《Jev 实践手册》里检索与你这次提问最相关的条目，再交给 <b>deepseek-v4.1-flash</b> 写成主文档。</p>
      <div class="breakdown" style="margin-top:18px">
        <div class="bd-row"><span class="lbl">已开汤</span><span class="bd-track"><i style="width:${Math.round((done.length / S.levels.length) * 100)}%"></i></span><span class="val">${done.length} / ${S.levels.length} 关</span></div>
        <div class="bd-row"><span class="lbl">留下问题集</span><span class="bd-track"><i style="width:${Math.min(100, S.runs.length * 20)}%"></i></span><span class="val">${S.runs.length} 组真实调用</span></div>
      </div>
      <ul class="file-list">
        <li>SKILL.md · 主文档，交给你的 AI 助手</li>
        <li>references/contract.md · Jev 接口契约（字段级）</li>
        <li>references/practices.md · 本次检索精排的实践条目</li>
        <li>examples/your-questions.json · 你真实问过的问题集</li>
        <li>references/models.json · 用到的模型清单</li>
      </ul>
      <div id="skillResult"></div>
      <div class="actions-row">
        <button class="primary big" id="btnGenSkill">生成并下载 skill</button>
        <button class="ghost" id="btnBackGate">回汤单</button>
      </div>
    </div>`;
  $('#btnBackGate').onclick = () => show('gate');
  $('#btnGenSkill').onclick = async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span>检索实践手册 + 撰写 skill…';
    $('#skillResult').innerHTML = '';
    try {
      const practices = S.practices.entries || [];
      const { files, usedModel } = await C.buildSkill({
        playerRuns: S.runs,
        practices,
        levelTitles: S.levels.map((l) => `${l.title}：${l.pattern}`),
      });
      downloadZip('jev-skill.zip', files);
      $('#skillResult').innerHTML = `<div class="coach-note">已导出 <b>jev-skill.zip</b>（${files.length} 个文件）。${
        usedModel ? '主文档由 deepseek-v4.1-flash 撰写。' : '生成式模型这次没接上，主文档用了离线模板——契约与你的问题集仍然完整。'
      }</div>`;
    } catch (e) {
      $('#skillResult').innerHTML = `<div class="dim">导出失败：${esc(e.message)}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = '生成并下载 skill';
    }
  };
  show('skill');
}

// ── 启动 ───────────────────────────────────────────────────
async function boot() {
  $('#btnPaste').onclick = () => {
    show('gate');
    setTimeout(() => $('#keyInput')?.focus(), 60);
  };
  $('#btnAuth').onclick = () => TD.beginAuth('Jev 汤铺').catch((e) => toast(e.message));
  $('#btnSkill').onclick = showSkill;
  $('#btnDecide').onclick = goDecide;

  // OAuth 式授权回调
  const code = new URLSearchParams(location.search).get('code');
  if (code) {
    try {
      await TD.finishAuth(code);
      toast('授权成功，Key 已保存到本地');
    } catch (e) {
      toast('授权失败：' + e.message);
    }
    history.replaceState(null, '', location.pathname);
  }

  try {
    const [lv, , pr] = await Promise.all([
      G.loadLevels(),
      Promise.resolve(0),
      fetch('data/practices.json').then((r) => r.json()),
    ]);
    S.levels = lv.levels;
    S.secrets = lv.secrets;
    S.practices = pr;
  } catch (e) {
    $('#levelList').innerHTML = `<p class="dim">关卡数据加载失败：${esc(e.message)}</p>`;
    return;
  }

  refreshKeyUI();
  renderLevelList();
  show('gate');
}

boot();
