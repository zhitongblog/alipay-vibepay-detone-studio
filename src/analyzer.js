"use strict";

/**
 * 确定性中文文章「三层去 AI 味」体检与精修引擎
 * 零外部依赖，支持 A 级机械套话、B 级结构腔调、C 级节奏指标的精准定位与改写建议。
 */

const A_TIER_PATTERNS = [
  { term: "值得注意的是", replace: "其实", tip: "删除翻译腔过渡词，直接说事实" },
  { term: "不可否认的是", replace: "确实", tip: "去掉空洞让步词，直接给观点" },
  { term: "显而易见", replace: "很明显", tip: "口语化表达，避免居高临下感" },
  { term: "综上所述", replace: "说到底", tip: "收尾不用公文总结词，用具体结论收口" },
  { term: "总而言之", replace: "一句话", tip: "换短句直接下判断" },
  { term: "与此同时", replace: "同时", tip: "精简连接词，减少 AI 衔接连环" },
  { term: "换言之", replace: "说白了", tip: "用人话解释，不要书面倒装" },
  { term: "从某种意义上说", replace: "", tip: "典型 AI 骑墙废话，直接删除" },
  { term: "在当今这个", replace: "现在", tip: "删掉宏大空洞的时间状语" },
  { term: "随着人工智能的飞速发展", replace: "这两年 AI 普及之后", tip: "用具体时间锚点替代套话开头" },
  { term: "赋能", replace: "帮到", tip: "黑话降维为具体动词" },
  { term: "抓手", replace: "切入点", tip: "替换为可落地的具体动作" },
  { term: "形成闭环", replace: "跑通整套流程", tip: "说出具体哪一步接哪一步" },
  { term: "降维打击", replace: "明显拉开差距", tip: "高频 AI 爽文词，改用真实对比数据" },
  { term: "重塑格局", replace: "改变现有玩法", tip: "去掉宏大叙事词，说具体变化" },
  { term: "是一把双刃剑", replace: "既有好处也有代价", tip: "典型模板句，直接列举正反两面" },
  { term: "毫无疑问", replace: "", tip: "去掉绝对化填充词，让证据说话" },
  { term: "更重要的是", replace: "更关键的是", tip: "控制递进套词密度" },
  { term: "不仅如此", replace: "另外", tip: "避免机械递进连环" },
  { term: "归根结底", replace: "说到底", tip: "简化为自然口语" }
];

const B_TIER_PATTERNS = [
  {
    id: "colon_conclusions",
    label: "结论冒号轰炸（如“核心原因：……”“关键在于：……”）",
    regex: /[：:]\s*[^。\n]{4,28}[。\n]/g,
    threshold: 3,
    weight: 10,
    tip: "AI 喜欢每段都用“小标签+冒号”做 PPT 列表，建议把至少一半改成自然叙述句。"
  },
  {
    id: "not_only_but_also",
    label: "高频“不仅……而且/更是……”平衡对仗句",
    regex: /不仅[^，。！？\n]{2,30}[，,]?\s*(?:而且|还|更是|更)/g,
    threshold: 1,
    weight: 9,
    tip: "人类口语很少频繁使用工整的“不仅…而且…”，拆成两句短句更有呼吸感。"
  },
  {
    id: "dash_overuse",
    label: "破折号（——）过度解释",
    regex: /——/g,
    threshold: 2,
    weight: 8,
    tip: "破折号过密是典型大模型译制腔指纹，改为逗号、括号或直接另起一句。"
  },
  {
    id: "parallel_triplets",
    label: "同构三连排比（第一/第二/第三 或 首先/其次/最后）",
    regex: /(?:首先[\s\S]{0,220}其次[\s\S]{0,220}(?:最后|此外)|第一[，,、][\s\S]{0,180}第二[，,、][\s\S]{0,180}第三[，,、])/g,
    threshold: 1,
    weight: 12,
    tip: "连续工整三段式像教科书答案，把最关键的一点直接前置展开，其余用自然过渡带出。"
  },
  {
    id: "empty_not_but",
    label: "模板反差句（“不是……而是……”）",
    regex: /不是[^，。！？\n]{2,26}[，,]\s*而是/g,
    threshold: 2,
    weight: 10,
    tip: "“不是A，而是B”是 AI 爆款文最高频金句模板，全篇保留 1 处即可，其余改直陈句。"
  }
];

function splitSentences(text) {
  return text
    .split(/(?<=[。！？!?;\n])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function analyzeArticle(rawText) {
  const text = (rawText || "").trim();
  const charCount = text.replace(/\s+/g, "").length;
  const sentences = splitSentences(text);
  const avgSentenceLen = sentences.length
    ? Number((charCount / sentences.length).toFixed(1))
    : 0;
  const longSentences = sentences.filter((s) => s.length >= 48);

  // Layer 1: A-tier mechanical phrases
  const aHits = [];
  for (const rule of A_TIER_PATTERNS) {
    let idx = text.indexOf(rule.term);
    let count = 0;
    while (idx !== -1) {
      count += 1;
      idx = text.indexOf(rule.term, idx + rule.term.length);
    }
    if (count > 0) {
      aHits.push({
        tier: "A",
        term: rule.term,
        count,
        replace: rule.replace,
        tip: rule.tip
      });
    }
  }
  const totalAHits = aHits.reduce((acc, h) => acc + h.count, 0);

  // Layer 2: B-tier structural & cadence fingerprints
  const bHits = [];
  for (const rule of B_TIER_PATTERNS) {
    const matches = text.match(rule.regex) || [];
    if (matches.length >= rule.threshold) {
      bHits.push({
        tier: "B",
        id: rule.id,
        label: rule.label,
        count: matches.length,
        weight: rule.weight,
        samples: matches.slice(0, 3).map((m) => m.trim().slice(0, 60)),
        tip: rule.tip
      });
    }
  }

  // Layer 3: Sentence-level diagnosis + deterministic rewrite preview
  const sentenceDiagnostics = [];
  const rewrittenSentences = [];

  for (let i = 0; i < sentences.length; i++) {
    const original = sentences[i];
    let revised = original;
    const issues = [];

    for (const rule of A_TIER_PATTERNS) {
      if (revised.includes(rule.term)) {
        issues.push(`含 A 级套话「${rule.term}」→ ${rule.tip}`);
        revised = revised.split(rule.term).join(rule.replace);
      }
    }
    if (original.includes("——")) {
      issues.push("含破折号解释腔，建议改用逗号或拆短句");
      revised = revised.replace(/\s*——\s*/g, "，");
    }
    if (original.length >= 52) {
      issues.push(`单句偏长（${original.length}字），建议在从句处断句`);
    }

    // Clean leading punctuation left by deletions
    revised = revised.replace(/^[，,、；;]+/, "").replace(/，，+/g, "，").trim();
    rewrittenSentences.push(revised);

    if (issues.length > 0) {
      sentenceDiagnostics.push({
        index: i + 1,
        original,
        revised,
        issues
      });
    }
  }

  // Compute AI Tone Index (0 = natural human, 100 = heavy AI template)
  const densityScore = charCount > 0 ? Math.min(48, Math.round((totalAHits / Math.max(charCount / 220, 1)) * 18)) : 0;
  const structScore = Math.min(36, bHits.reduce((acc, b) => acc + b.weight, 0));
  const lengthScore = avgSentenceLen > 34 ? Math.min(16, Math.round((avgSentenceLen - 34) * 0.9)) : 0;
  const aiScore = Math.min(99, Math.max(4, densityScore + structScore + lengthScore));

  let grade = "自然人味";
  let verdict = "整体读感自然，微调局部长句即可直接发布。";
  if (aiScore >= 65) {
    grade = "重度 AI 味（强烈建议精修）";
    verdict = "存在高频 AI 过渡词与工整模板结构，直接发布易触发读者审美疲劳与平台限流。";
  } else if (aiScore >= 35) {
    grade = "中度 AI 味（建议去腔）";
    verdict = "有明显模型衔接习惯与套话残留，替换 A/B 级命中项后可读性将大幅提升。";
  }

  const rewrittenText = rewrittenSentences.join("\n");

  return {
    charCount,
    sentenceCount: sentences.length,
    avgSentenceLen,
    longSentenceCount: longSentences.length,
    aiScore,
    grade,
    verdict,
    summary: {
      aTierHitTypes: aHits.length,
      aTierTotalHits: totalAHits,
      bTierIssues: bHits.length,
      flaggedSentences: sentenceDiagnostics.length
    },
    aHits,
    bHits,
    sentenceDiagnostics,
    rewrittenText
  };
}

function toFreePreview(fullReport) {
  return {
    charCount: fullReport.charCount,
    sentenceCount: fullReport.sentenceCount,
    avgSentenceLen: fullReport.avgSentenceLen,
    longSentenceCount: fullReport.longSentenceCount,
    aiScore: fullReport.aiScore,
    grade: fullReport.grade,
    verdict: fullReport.verdict,
    summary: fullReport.summary,
    aHits: fullReport.aHits.slice(0, 4),
    bHits: fullReport.bHits.slice(0, 2),
    sentenceDiagnostics: fullReport.sentenceDiagnostics.slice(0, 2),
    locked: true,
    lockedCounts: {
      remainingAHits: Math.max(0, fullReport.aHits.length - 4),
      remainingBHits: Math.max(0, fullReport.bHits.length - 2),
      remainingSentences: Math.max(0, fullReport.sentenceDiagnostics.length - 2)
    }
  };
}

module.exports = { analyzeArticle, toFreePreview };
