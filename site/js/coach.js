// 教练点评（deepseek-v4.1-flash）与「带走 Jev」skill 生成。
// skill 生成有确定性的离线兜底：模型不可用时仍能导出一份完整可用的 skill。

import { chat, embed, rerank, MODELS } from './td.js';
import { downloadZip } from './zip.js';

const BASE_URL = 'https://tokendance.space';

const COACH_SYSTEM = [
  '你是《Jev 汤铺》的教练，任务是教玩家把结构化判断模型 Jev 用进产品。',
  'Jev（bocha-jev-v1）是「判断器」不是生成器：输入事实文本 state 与若干结构化问题，只返回概率，不生成自然语言。',
  '三种题型：noul 是非题（type+instructions，返回为真概率）；choice 选择题（criteria 是对象：标签->定义，返回各标签概率与选中项）；score 分级题（criteria 是字符串数组，按序定档 0..n-1，返回期望档位）。',
  '要点：问原子事实不问综合印象；criteria 互斥且穷尽（含噪声兜底分支）；档位描述要对应不同业务动作；一次请求可多问共享 state；confidence 是最大候选概率、不是正确率；判不动要转人工兜底。',
  '点评要具体、克制、可执行，直接指出题面里哪个词该改成什么。中文，不超过 120 字，不要用列表标题。',
].join('\n');

/** 点评玩家当前的问题措辞（可选功能，问之前先让教练看一眼）。 */
export async function coachQuestion(draft, levelTitle) {
  const criteria =
    draft.type === 'choice'
      ? draft.rows.filter((r) => r.label.trim()).map((r) => `${r.label.trim()} = ${r.desc.trim() || '(未定义)'}`).join('；')
      : draft.type === 'score'
        ? draft.rows.filter((r) => r.label.trim()).map((r) => r.label.trim()).join(' > ')
        : '(无，是非题)';
  const user = [
    `关卡：${levelTitle}`,
    `题型：${draft.type}`,
    `instructions：${draft.instructions.trim() || '(空)'}`,
    `criteria：${criteria}`,
    '请点评这个问题写得好不好，以及具体怎么改。',
  ].join('\n');
  return chat(COACH_SYSTEM, user, { maxTokens: 900, temperature: 0.5 });
}

/** 复盘点评：把玩家整局的提问序列交给教练总结。 */
export async function coachReview(levelTitle, asked, decision, gradeText) {
  const lines = asked.map(
    (a, i) =>
      `${i + 1}. [${a.type}] ${a.question.instructions}${
        a.question.criteria ? ' | criteria: ' + JSON.stringify(a.question.criteria) : ''
      } → 锐度 ${(a.sharp * 100).toFixed(0)}%`,
  );
  const user = [
    `关卡：${levelTitle}`,
    '玩家提问序列：',
    lines.join('\n') || '(没问任何问题)',
    `最终决策：${decision}`,
    `判分：${gradeText}`,
    '请点评：哪些问题问得干脆、哪些白问了、问题该怎么重写。3 句以内。',
  ].join('\n');
  return chat(COACH_SYSTEM, user, { maxTokens: 900, temperature: 0.6 });
}

/** 用 embedding + rerank 从实践手册里挑出与本局最相关的条目。 */
export async function retrievePractices(query, practices, topN = 4) {
  try {
    const docs = practices.map((p) => `${p.title}：${p.text}`);
    const embs = await embed(docs);
    // 本地余弦做粗召回（省一次查询向量化调用也能工作），再交给 rerank 精排。
    const qEmb = (await embed([query]))[0];
    const cos = (a, b) => {
      let d = 0;
      for (let i = 0; i < a.length; i++) d += a[i] * b[i];
      return d;
    };
    const shortlist = practices
      .map((p, i) => ({ p, s: cos(qEmb, embs[i]) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, Math.min(8, practices.length));
    const ranked = await rerank(
      query,
      shortlist.map((x) => `${x.p.title}：${x.p.text}`),
      {
        topN,
        instruct: 'Given a query about how to apply a structured judgment model in a product, retrieve the most relevant engineering practices.',
      },
    );
    return ranked.map((r) => shortlist[r.index].p);
  } catch (e) {
    console.warn('语料检索失败，退回本地排序', e);
    return practices.slice(0, topN);
  }
}

const SKILL_SYSTEM = [
  '你是 agent skill 的作者。写一份可以直接安装到 AI 编程助手里、教它在产品代码中正确使用 Jev 结构化判断模型的 SKILL.md 正文（不要 YAML 头，不要代码围栏包住全文）。',
  'Jev 契约：POST https://tokendance.space/gateway/typesafe/v1/systemone，body = {"model":"bocha-jev-v1","state":"事实文本","questions":{"名称":{"type":"noul|choice|score","instructions":"...","criteria":{...}|[...]}}}，返回 {answers, usage, metadata}。noul 只有 type+instructions；choice 的 criteria 是对象（标签->定义）；score 的 criteria 是字符串数组（档位自动编号 0..n-1，返回期望档位 score）。',
  '多题可一次请求、共享 state、独立返回。confidence 是最大候选概率、不是正确率（metadata.confidence_definition 原文如此），必须配阈值与转人工兜底。',
  '要求：用第二人称对 AI 助手写；小标题分节；给出可复制的调用示例与决策策略示例；把提供的实践条目融进正文；把玩家真实用过的问题集写成「真实调用示例」小节。',
  '语气：工程师写给工程师，具体、无套话。总长 1200 字以内。',
].join('\n');

function fallbackSkillMd(meta) {
  return `# 用 Jev 做结构化判断

## 什么时候用
需要在产品里做**分类、路由、打分、开关**这类确定性决策时使用 Jev（bocha-jev-v1）。它只返回结构化概率，不生成自然语言——写周报、生成解释话术请改用生成式模型。

## 怎么调用
\`\`\`bash
curl https://tokendance.space/gateway/typesafe/v1/systemone \\
  -H "Authorization: Bearer $TOKENDANCE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"bocha-jev-v1","state":"<事实文本>","questions":{"is_urgent":{"type":"noul","instructions":"现在紧急吗？"}}}'
\`\`\`

三种题型：
- \`noul\` 是非题：\`{type, instructions}\` → 返回为真的概率
- \`choice\` 选择题：\`{type, instructions, criteria: {"标签":"定义"}}\` → 各标签概率 + 选中项
- \`score\` 分级题：\`{type, instructions, criteria: ["档1","档2"]}\` → 各档概率 + 期望档位（自动编号 0..n-1）

## 决策策略
confidence 是**最大候选概率，不是正确率**。设阈值：高于阈值走自动动作，低于阈值转人工/转更强模型。criteria 的项数会抬高随机基线，阈值按题型分别设。

## 真实调用示例
${meta.runsText || '(本次运行未留下提问记录)'}
`;
}

/**
 * 生成「带走 Jev」skill 文件集。
 * @param {{playerRuns, practices, levelTitles}} arg
 * @returns {Promise<{files: {path:string,text:string}[], usedModel: boolean}>}
 */
export async function buildSkill({ playerRuns, practices, levelTitles }) {
  const picked = await retrievePractices(
    '如何在产品里正确使用 Jev 结构化判断模型：题型选择、criteria 设计、置信度阈值与兜底、批量提问、state 构造',
    practices,
    6,
  );
  const runsText = playerRuns
    .map(
      (r, i) =>
        `### ${i + 1}. ${r.levelTitle}\n\`\`\`json\n${JSON.stringify(
          { state: '<事实文本>', questions: r.questions },
          null,
          2,
        )}\n\`\`\``,
    )
    .join('\n\n');

  const meta = { runsText };
  let body;
  let usedModel = false;
  try {
    body = await chat(
      SKILL_SYSTEM,
      [
        '玩家真实用过的问题集：',
        runsText || '(无)',
        '要融进正文的实践条目：',
        picked.map((p) => `【${p.title}】${p.text}`).join('\n'),
        '已通关的关卡与对应产品模式：',
        levelTitles.join('；'),
      ].join('\n\n'),
      { maxTokens: 4000, temperature: 0.5 },
    );
    usedModel = body.length > 200;
  } catch (e) {
    console.warn('skill 生成走离线兜底', e);
  }
  if (!usedModel) body = fallbackSkillMd(meta);

  const contract = `# Jev 调用手册

- 端点：\`POST ${BASE_URL}/gateway/typesafe/v1/systemone\`
- 鉴权：\`Authorization: Bearer $TOKENDANCE_API_KEY\`
- 请求体：\`{"model":"bocha-jev-v1","state":"...","questions":{<名称>: <问题>}}\`
- 响应：\`{answers, usage:{input_tokens,output_tokens}, metadata:{inference_ms, calibrated, confidence_definition, checkpoint_status}}\`

## 问题类型

| type | 请求字段 | criteria 形态 | 返回 |
| --- | --- | --- | --- |
| \`noul\` | \`{type, instructions}\` | 无 | \`noul\`: 0~1 为真概率 |
| \`choice\` | \`{type, instructions, criteria}\` | 对象：标签 → 定义（2~5 项） | \`probabilities\`, \`confidence\`, \`choice\` |
| \`score\` | \`{type, instructions, criteria}\` | 字符串数组：有序档位（2~5 项） | \`probabilities\`, \`score\`(期望档位), \`legend\`, \`confidence\` |

严格字段校验：多写字段会被拒（\`extra_forbidden\`）。一次请求可含多个问题，共享同一 state，独立返回。

## 已知边界
- 不生成自然语言，不支持流式输出与会话历史
- \`confidence\` = maximum candidate probability; not guaranteed correctness
- \`score\` 档位自动编号 0..n-1，与你在 criteria 文案里写的数字无关
- 模型当前 \`checkpoint_status\` 为 experimental，上线前请在自己的场景抽样验证校准
`;

  const practicesMd = `# 实践手册（检索自 ${MODELS.embed} + ${MODELS.rerank} 精排）

${picked.map((p) => `## ${p.title}\n\n${p.text}\n`).join('\n')}`;

  const readme = `# 带走 Jev

这是一份由《Jev 汤铺》现场导出的 skill 包：

- \`SKILL.md\` — 主文档，交给你的 AI 助手
- \`references/contract.md\` — Jev 接口契约（字段级）
- \`references/practices.md\` — 实践手册条目（本次按你的提问检索精排）
- \`examples/your-questions.json\` — 你在汤铺里真实问过的问题集
- \`references/models.json\` — 本次用到的模型清单

安装方式：把本目录放进项目的 \`.qoder/skills/jev/\` 或 \`.claude/skills/jev/\` 即可被 agent 识别。

导出时间：${new Date().toISOString()}
`;

  return {
    usedModel,
    files: [
      { path: 'SKILL.md', text: body },
      { path: 'references/contract.md', text: contract },
      { path: 'references/practices.md', text: practicesMd },
      { path: 'references/models.json', text: JSON.stringify(MODELS, null, 2) },
      { path: 'examples/your-questions.json', text: JSON.stringify(playerRuns, null, 2) },
      { path: 'README.md', text: readme },
    ],
  };
}

export function downloadSkill(files) {
  downloadZip('jev-skill.zip', files);
}
