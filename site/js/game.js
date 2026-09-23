// 游戏核心：关卡加载、问题预算、判分与复盘数据。
// 判分口径刻意做成透明公式，复盘时直接摊开给玩家看——这本身就是教学内容。

import { unlock } from './vault.js';

export const STORE_PROGRESS = 'jev.progress';

export async function loadLevels() {
  const [pub, enc] = await Promise.all([
    fetch('data/levels.json').then((r) => r.json()),
    fetch('data/secrets.enc.json').then((r) => r.json()),
  ]);
  return { levels: pub.levels, secrets: enc.levels };
}

export function loadProgress() {
  try {
    return JSON.parse(localStorage.getItem(STORE_PROGRESS)) || {};
  } catch {
    return {};
  }
}
export function saveProgress(p) {
  localStorage.setItem(STORE_PROGRESS, JSON.stringify(p));
}

/** 开关卡：解密「事实档案」，它是 Jev 的唯一真相来源。 */
export function openLevel(secrets, id) {
  return unlock(secrets[id].play);
}
/** 玩家提交决策后才解密汤底。 */
export function openReveal(secrets, id) {
  return unlock(secrets[id].reveal);
}

/** 把玩家写的题面组装成合法的 Jev questions 请求体。 */
export function toJevQuestion(draft) {
  const q = { type: draft.type, instructions: draft.instructions.trim() };
  if (draft.type === 'choice') {
    const criteria = {};
    for (const row of draft.rows) {
      const label = row.label.trim();
      const desc = row.desc.trim();
      if (label) criteria[label] = desc || label;
    }
    q.criteria = criteria;
  }
  if (draft.type === 'score') {
    q.criteria = draft.rows.map((r) => r.label.trim()).filter(Boolean);
  }
  return q;
}

export function validateDraft(draft) {
  const errors = [];
  if (!draft.instructions || !draft.instructions.trim()) errors.push('instructions 不能为空');
  if (draft.type === 'choice') {
    const labels = draft.rows.map((r) => r.label.trim()).filter(Boolean);
    if (labels.length < 2) errors.push('choice 的 criteria 至少两项');
    if (new Set(labels).size !== labels.length) errors.push('criteria 的标签不能重复');
  }
  if (draft.type === 'score') {
    const levels = draft.rows.map((r) => r.label.trim()).filter(Boolean);
    if (levels.length < 2) errors.push('score 的 criteria 至少两档');
  }
  return errors;
}

/**
 * 问题锐度：答案把可能性空间劈开的程度（0=白问，1=一刀见血）。
 * 这是本游戏的核心教学指标——好问题才问得出干脆的答案。
 */
export function sharpness(type, answer, optionCount) {
  if (type === 'noul') return Math.abs(2 * answer.noul - 1);
  const k = Math.max(2, optionCount);
  const c = answer.confidence ?? 0;
  return Math.max(0, (c - 1 / k) / (1 - 1 / k));
}

const WEIGHTS = { decision: 0.45, sharp: 0.3, eff: 0.15, calib: 0.1 };

/**
 * @param {{level, asked, action, secret}} arg
 * asked: [{type, question, answer, optionCount}]
 */
export function grade({ level, asked, action, secret }) {
  const key = secret.answerKey;
  let decision = 20;
  if (action === key.best) decision = 100;
  else if (key.acceptable.includes(action)) decision = 60;

  const d = asked.map((a) => sharpness(a.type, a.answer, a.optionCount));
  const meanSharp = d.length ? d.reduce((x, y) => x + y, 0) / d.length : 0;
  const sharp = meanSharp * 100;

  const ideal = 2;
  const span = Math.max(1, level.budget - ideal);
  const eff = Math.round(Math.max(0, Math.min(1, 1 - (asked.length - ideal) / span)) * 100);

  // 校准意识：证据不够硬就别自动拍板，证据很硬就别甩锅给人。
  const evidence = d.length ? Math.max(...d) : 0;
  const hedged = action === 'escalate';
  let calib = 75;
  if (!hedged && evidence < 0.45) calib = 25; // 证据软还敢自动拍
  else if (hedged && evidence < 0.45) calib = 100; // 证据软，转人工是对的
  else if (hedged && evidence > 0.85) calib = 50; // 证据硬还甩人，浪费 SLA
  else if (!hedged && evidence > 0.85) calib = 100; // 证据硬，果断拍

  const total = Math.round(
    WEIGHTS.decision * decision +
      WEIGHTS.sharp * sharp +
      WEIGHTS.eff * eff +
      WEIGHTS.calib * calib,
  );
  const stars = total >= 90 ? 5 : total >= 75 ? 4 : total >= 60 ? 3 : total >= 40 ? 2 : 1;
  return {
    total,
    stars,
    parts: {
      decision: { value: decision, weight: WEIGHTS.decision },
      sharp: { value: Math.round(sharp), weight: WEIGHTS.sharp },
      eff: { value: eff, weight: WEIGHTS.eff },
      calib: { value: calib, weight: WEIGHTS.calib },
    },
    meanSharp,
    evidence,
  };
}

/** 答案卡片的渲染数据（含元数据：延迟、token、confidence 免责说明）。 */
export function summarizeAnswer(type, answer, optionCount) {
  const s = sharpness(type, answer, optionCount);
  if (type === 'noul') {
    return {
      type,
      title: '是非',
      main: (answer.noul * 100).toFixed(1) + '% 为真',
      prob: answer.noul,
      rows: [['为真', answer.noul], ['为假', 1 - answer.noul]],
      sharp: s,
    };
  }
  if (type === 'choice') {
    const rows = Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1]);
    return {
      type,
      title: '选择',
      main: '判定：' + answer.choice,
      prob: answer.confidence,
      rows,
      sharp: s,
    };
  }
  const legend = answer.legend || {};
  const rows = Object.entries(answer.probabilities)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => [(legend[k] ?? k) + '', v]);
  return {
    type: 'score',
    title: '分级',
    main: '期望档位：' + answer.score.toFixed(2),
    prob: answer.confidence,
    rows,
    sharp: s,
  };
}
