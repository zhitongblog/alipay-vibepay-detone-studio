// Cloudflare Worker entry for DeTone Studio (Live Alipay Vibe Pay via WatchaPay)
// Zero external dependencies, stateless edge-native, fail-closed entitlement verification,
// and HMAC-SHA256 signed permanent passcode cross-device recovery.

const COOKIE_MAX_AGE_SECONDS = 31536000; // 1 year
const PASSCODE_DOMAIN = "detone:passcode:v1:";
const USER_ID_RE = /^u_([0-9a-f]{24})$/i;

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
  { id: "colon_conclusions", label: "结论冒号轰炸（如“核心原因：……”“关键在于：……”）", regex: /[：:]\s*[^。\n]{4,28}[。\n]/g, threshold: 3, weight: 10, tip: "AI 喜欢每段都用“小标签+冒号”做 PPT 列表，建议把至少一半改成自然叙述句。" },
  { id: "not_only_but_also", label: "高频“不仅……而且/更是……”平衡对仗句", regex: /不仅[^，。！？\n]{2,30}[，,]?\s*(?:而且|还|更是|更)/g, threshold: 1, weight: 9, tip: "人类口语很少频繁使用工整的“不仅…而且…”，拆成两句短句更有呼吸感。" },
  { id: "dash_overuse", label: "破折号（——）过度解释", regex: /——/g, threshold: 2, weight: 8, tip: "破折号过密是典型大模型译制腔指纹，改为逗号、括号或直接另起一句。" },
  { id: "parallel_triplets", label: "同构三连排比（第一/第二/第三 或 首先/其次/最后）", regex: /(?:首先[\s\S]{0,220}其次[\s\S]{0,220}(?:最后|此外)|第一[，,、][\s\S]{0,180}第二[，,、][\s\S]{0,180}第三[，,、])/g, threshold: 1, weight: 12, tip: "连续工整三段式像教科书答案，把最关键的一点直接前置展开，其余用自然过渡带出。" },
  { id: "empty_not_but", label: "模板反差句（“不是……而是……”）", regex: /不是[^，。！？\n]{2,26}[，,]\s*而是/g, threshold: 2, weight: 10, tip: "“不是A，而是B”是 AI 爆款文最高频金句模板，全篇保留 1 处即可，其余改直陈句。" }
];

function analyzeArticle(rawText) {
  const text = (rawText || "").trim();
  const charCount = text.replace(/\s+/g, "").length;
  const sentences = text.split(/(?<=[。！？!?;\n])/).map((s) => s.trim()).filter(Boolean);
  const avgSentenceLen = sentences.length ? Number((charCount / sentences.length).toFixed(1)) : 0;
  const longSentences = sentences.filter((s) => s.length >= 48);

  const aHits = [];
  for (const rule of A_TIER_PATTERNS) {
    let idx = text.indexOf(rule.term);
    let count = 0;
    while (idx !== -1) {
      count += 1;
      idx = text.indexOf(rule.term, idx + rule.term.length);
    }
    if (count > 0) aHits.push({ tier: "A", term: rule.term, count, replace: rule.replace, tip: rule.tip });
  }
  const totalAHits = aHits.reduce((acc, h) => acc + h.count, 0);

  const bHits = [];
  for (const rule of B_TIER_PATTERNS) {
    const matches = text.match(rule.regex) || [];
    if (matches.length >= rule.threshold) {
      bHits.push({ tier: "B", id: rule.id, label: rule.label, count: matches.length, weight: rule.weight, tip: rule.tip });
    }
  }

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
    revised = revised.replace(/^[，,、；;]+/, "").replace(/，，+/g, "，").trim();
    rewrittenSentences.push(revised);
    if (issues.length > 0) sentenceDiagnostics.push({ index: i + 1, original, revised, issues });
  }

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

  return {
    charCount,
    sentenceCount: sentences.length,
    avgSentenceLen,
    longSentenceCount: longSentences.length,
    aiScore,
    grade,
    verdict,
    summary: { aTierHitTypes: aHits.length, aTierTotalHits: totalAHits, bTierIssues: bHits.length, flaggedSentences: sentenceDiagnostics.length },
    aHits,
    bHits,
    sentenceDiagnostics,
    rewrittenText: rewrittenSentences.join("\n")
  };
}

function toFreePreview(full) {
  return {
    charCount: full.charCount,
    sentenceCount: full.sentenceCount,
    avgSentenceLen: full.avgSentenceLen,
    longSentenceCount: full.longSentenceCount,
    aiScore: full.aiScore,
    grade: full.grade,
    verdict: full.verdict,
    summary: full.summary,
    aHits: full.aHits.slice(0, 4),
    bHits: full.bHits.slice(0, 2),
    sentenceDiagnostics: full.sentenceDiagnostics.slice(0, 2),
    locked: true,
    lockedCounts: {
      remainingAHits: Math.max(0, full.aHits.length - 4),
      remainingBHits: Math.max(0, full.bHits.length - 2),
      remainingSentences: Math.max(0, full.sentenceDiagnostics.length - 2)
    }
  };
}

function buildUserCookie(userId) {
  return `detone_uid=${userId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_SECONDS}`;
}

function getOrCreateUserId(request) {
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(/(?:^|;\s*)detone_uid=(u_[0-9a-f]{24})(?:$|;)/i);
  if (m) return { userId: m[1].toLowerCase(), setCookie: null };
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const userId = "u_" + hex;
  return {
    userId,
    setCookie: buildUserCookie(userId)
  };
}

function formatPasscode(rawHex24, sigHex12) {
  const h = rawHex24.toUpperCase();
  const s = sigHex12.toUpperCase();
  return `DTN-${h.slice(0, 8)}-${h.slice(8, 16)}-${h.slice(16, 24)}-${s}`;
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function computeHmacHex12(userId, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(String(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(`${PASSCODE_DOMAIN}${userId.toLowerCase()}`));
  const bytes = new Uint8Array(sigBuf);
  return Array.from(bytes.slice(0, 6), (b) => b.toString(16).padStart(2, "0")).join("");
}

function hasSessionSecret(env) {
  return Boolean(env && env.SESSION_SECRET && String(env.SESSION_SECRET).trim().length >= 16);
}

async function issuePasscode(userId, env) {
  if (!hasSessionSecret(env)) return null;
  const m = String(userId || "").match(USER_ID_RE);
  if (!m) return null;
  const normalizedUid = `u_${m[1].toLowerCase()}`;
  const sigHex12 = await computeHmacHex12(normalizedUid, env.SESSION_SECRET);
  return formatPasscode(m[1], sigHex12);
}

async function verifyPasscode(input, env) {
  if (!hasSessionSecret(env)) return { valid: false, reason: "secret_not_configured" };
  const cleaned = String(input || "").trim().toUpperCase();
  const body = cleaned.replace(/^DTN-?/, "").replace(/[\s-]+/g, "");
  if (!/^[0-9A-F]{36}$/.test(body)) {
    return { valid: false, reason: "invalid_format" };
  }
  const rawHex24 = body.slice(0, 24).toLowerCase();
  const providedSig = body.slice(24, 36).toLowerCase();
  const userId = `u_${rawHex24}`;
  const expectedSig = await computeHmacHex12(userId, env.SESSION_SECRET);
  if (!constantTimeEqual(providedSig, expectedSig)) {
    return { valid: false, reason: "invalid_signature" };
  }
  return {
    valid: true,
    userId,
    passcode: formatPasscode(rawHex24, expectedSig)
  };
}

function jsonResp(data, status = 200, setCookie = null) {
  const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
  if (setCookie) headers["Set-Cookie"] = setCookie;
  return new Response(JSON.stringify(data), { status, headers });
}

async function checkWatchaAccess(env, userId, returnUrl) {
  const baseUrl = (env.WATCHA_BASE_URL || "https://pay.watcha.cn").replace(/\/+$/, "");
  const body = { entitlement_id: env.WATCHA_ENTITLEMENT_ID, user_id: userId };
  if (returnUrl && /^https?:\/\//i.test(returnUrl)) body.return_url = returnUrl;
  const res = await fetch(`${baseUrl}/v1/entitlements/access`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.WATCHA_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, access: "unavailable", reason: data.error || data.reason || { code: `http_${res.status}` } };
  if (!["granted", "purchase_required", "unavailable"].includes(data.access)) {
    return { ok: false, access: "unavailable", reason: { code: "unknown_response" } };
  }
  return { ok: true, access: data.access, entitlement: data.entitlement || {}, purchase: data.purchase && data.purchase.url ? data.purchase : null, reason: data.reason || null };
}

const HTML_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DeTone Studio｜文章去 AI 味三层体检与精修工作台（支付宝 Vibe Pay）</title>
  <style>
    :root{--bg:#080d1a;--card:#111a2e;--card-2:#17233d;--border:#25355a;--text:#eef3ff;--muted:#93a6ce;--cyan:#38bdf8;--ok:#34d399;--warn:#fbbf24;--danger:#f87171}
    *{box-sizing:border-box}
    body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;background:radial-gradient(circle at top right,#122146 0%,var(--bg) 55%);color:var(--text);min-height:100vh}
    header{border-bottom:1px solid var(--border);background:rgba(8,13,26,.92);padding:14px 24px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px}
    .logo h1{margin:0;font-size:19px}.logo p{margin:3px 0 0;font-size:12.5px;color:var(--muted)}
    .header-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
    .badge{padding:6px 12px;border-radius:999px;font-size:12px;border:1px solid #1d4ed8;background:rgba(22,119,255,.16);color:#93c5fd}
    .badge.pro{border-color:var(--ok);background:rgba(52,211,153,.16);color:#a7f3d0}
    .btn-ghost{padding:6px 12px;border-radius:999px;font-size:12px;border:1px solid var(--border);background:var(--card-2);color:#cbd5e1;cursor:pointer;font-weight:600}
    .btn-ghost:hover{border-color:var(--cyan);color:#fff}
    .top-drawer{max-width:1220px;margin:14px auto 0;padding:0 20px;display:none}
    .drawer-box{background:var(--card);border:1px solid var(--cyan);border-radius:14px;padding:14px 16px;display:flex;flex-direction:column;gap:10px}
    .drawer-row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
    .drawer-box input{flex:1;min-width:260px;padding:10px 12px;border-radius:10px;border:1px solid var(--border);background:#0a1020;color:var(--text);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13.5px;letter-spacing:.4px}
    .drawer-box input:focus{outline:none;border-color:var(--cyan)}
    .passcode-bar{max-width:1220px;margin:14px auto 0;padding:0 20px;display:none}
    .passcode-card{background:linear-gradient(135deg,rgba(16,185,129,.14),rgba(56,189,248,.10));border:1px solid var(--ok);border-radius:14px;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px}
    .passcode-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:14px;font-weight:700;color:#ecfdf5;background:rgba(8,13,26,.7);border:1px solid rgba(52,211,153,.45);padding:6px 12px;border-radius:8px;letter-spacing:.6px;user-select:all}
    .container{max-width:1220px;margin:0 auto;padding:20px;display:grid;grid-template-columns:1fr 1fr;gap:18px}
    @media(max-width:900px){.container{grid-template-columns:1fr}}
    .card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:18px;display:flex;flex-direction:column;gap:14px}
    .card h2{margin:0;font-size:15px;display:flex;justify-content:space-between;align-items:center;gap:8px}
    textarea{width:100%;min-height:320px;border-radius:12px;border:1px solid var(--border);background:#0a1020;color:var(--text);padding:14px;font-size:14px;line-height:1.7;resize:vertical;font-family:inherit}
    textarea:focus{outline:none;border-color:var(--cyan)}
    .row{display:flex;gap:10px;flex-wrap:wrap}
    button{padding:11px 18px;border-radius:10px;border:1px solid var(--border);background:var(--card-2);color:var(--text);font-size:13.5px;font-weight:600;cursor:pointer}
    button.primary{background:linear-gradient(135deg,#1677ff,#2563eb);border-color:#3b82f6}
    button.pay{background:linear-gradient(135deg,#0ea5e9,#1677ff);border-color:#38bdf8;width:100%;padding:13px;font-size:15px}
    button:disabled{opacity:.55;cursor:not-allowed}
    .kpi-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
    @media(max-width:560px){.kpi-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
    .kpi{background:var(--card-2);border:1px solid var(--border);border-radius:10px;padding:10px}
    .kpi span{display:block;font-size:11px;color:var(--muted)}.kpi strong{display:block;margin-top:4px;font-size:20px;color:var(--cyan)}
    .kpi strong.high{color:var(--danger)}.kpi strong.mid{color:var(--warn)}.kpi strong.low{color:var(--ok)}
    .pill-list{display:flex;flex-wrap:wrap;gap:8px}
    .hit-pill{padding:5px 10px;border-radius:8px;background:rgba(248,113,113,.14);border:1px solid rgba(248,113,113,.45);color:#fecaca;font-size:12.5px}
    .diag-item{border:1px solid var(--border);background:rgba(15,23,42,.72);border-radius:10px;padding:12px;font-size:13px;line-height:1.65}
    .diag-item .orig{color:#fca5a5}.diag-item .rev{color:#86efac;margin-top:6px}
    .paywall{border:1px dashed #38bdf8;background:linear-gradient(180deg,rgba(22,119,255,.12),rgba(14,165,233,.06));border-radius:12px;padding:16px}
    .paywall h3{margin:0 0 6px;font-size:15px;color:#bae6fd}.paywall p{margin:0 0 12px;font-size:13px;color:var(--muted);line-height:1.6}
    .qr-box{margin-top:12px;text-align:center;background:#fff;color:#0f172a;padding:14px;border-radius:12px;display:none}
    .qr-box img{width:190px;height:190px;display:block;margin:0 auto 8px}
    .unlocked-banner{background:rgba(52,211,153,.14);border:1px solid var(--ok);color:#a7f3d0;padding:10px 14px;border-radius:10px;font-size:13px}
    pre.rewrite-box{white-space:pre-wrap;background:#0a1020;border:1px solid var(--border);border-radius:10px;padding:12px;font-family:inherit;font-size:13.5px;line-height:1.75;margin:0}
  </style>
</head>
<body>
  <header>
    <div class="logo">
      <h1>DeTone Studio · 文章去 AI 味三层体检精修台</h1>
      <p>确定性 A/B/C 三层中文去腔扫描 · 支付宝 Vibe Pay 永久买断（免注册 · 通行码跨设备恢复）</p>
    </div>
    <div class="header-actions">
      <button class="btn-ghost" id="btnToggleRecover" type="button">已有通行码？恢复永久权益</button>
      <div class="badge" id="modeBadge">支付宝 Vibe Pay 正式收款已就绪</div>
    </div>
  </header>

  <section class="top-drawer" id="recoverDrawer">
    <div class="drawer-box">
      <div style="font-size:13.5px;font-weight:600;color:#bae6fd;">跨设备 / 清缓存恢复永久专业版权益</div>
      <div style="font-size:12.5px;color:#93a6ce;">输入买断后获得的防伪通行码（服务端将校验 HMAC 签名并实时向支付宝 Vibe Pay 复核买断权益）：</div>
      <div class="drawer-row">
        <input id="passcodeInput" type="text" placeholder="粘贴永久通行码，例如 DTN-XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXXXXXX" autocomplete="off" spellcheck="false">
        <button class="primary" id="btnRecoverSubmit" type="button">验证并恢复权益</button>
        <button id="btnRecoverClose" type="button">收起</button>
      </div>
      <div id="recoverMsg" style="font-size:12.5px;color:#93a6ce;"></div>
    </div>
  </section>

  <section class="passcode-bar" id="passcodeBar">
    <div class="passcode-card">
      <div>
        <div style="font-size:13.5px;font-weight:700;color:#a7f3d0;">永久专业版通行证（已为本浏览器保存 1 年免登凭证）</div>
        <div style="font-size:12px;color:#cbd5e1;margin-top:3px;">换设备或清理浏览器缓存后，凭此防伪通行码可一键恢复永久买断权益，请复制妥善保存。</div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <span class="passcode-code" id="passcodeText"></span>
        <button class="primary" id="btnCopyPasscode" type="button" style="padding:8px 14px;font-size:12.5px;">复制通行码</button>
      </div>
    </div>
  </section>

  <main class="container">
    <section class="card">
      <h2><span>1. 粘贴待体检中文文章</span><button id="btnSample" type="button">填入典型 AI 味样稿</button></h2>
      <textarea id="articleInput" placeholder="请粘贴至少 30 字中文文章内容，点击「免费三层扫描」查看 AI 味评分与初步诊断…"></textarea>
      <div class="row">
        <button class="primary" id="btnAnalyze" type="button">立即免费三层扫描</button>
        <button id="btnRecheck" type="button">我已付款，刷新核验权益</button>
      </div>
      <div id="statusMsg" style="font-size:12.5px;color:#93a6ce;"></div>
    </section>
    <section class="card">
      <h2><span>2. 三层体检报告与精修交付</span><span id="gradeTag" style="font-size:12px;color:#93a6ce;">等待扫描</span></h2>
      <div id="emptyHint" style="color:#93a6ce;font-size:13.5px;line-height:1.7;">
        • <strong>A 级机械套话层</strong>：识别“值得注意的是、综上所述、赋能、抓手、形成闭环”等 20+ 高频黑话；<br>
        • <strong>B 级结构指纹层</strong>：检测结论冒号轰炸、破折号译制腔、三连排比与“不是…而是…”模板；<br>
        • <strong>C 级逐句精修层</strong>：一次支付宝永久买断，自动生成防伪通行码，支持换设备恢复与 Markdown 导出。
      </div>
      <div id="reportBody" style="display:none;flex-direction:column;gap:14px;">
        <div class="kpi-grid">
          <div class="kpi"><span>AI 味指数</span><strong id="kScore">0</strong></div>
          <div class="kpi"><span>A 级套话命中</span><strong id="kAHits">0</strong></div>
          <div class="kpi"><span>B 级结构指纹</span><strong id="kBIssues">0</strong></div>
          <div class="kpi"><span>待精修句子</span><strong id="kSentences">0</strong></div>
        </div>
        <div id="verdictBox" style="font-size:13px;color:#cbd5e1;line-height:1.6;"></div>
        <div><div style="font-size:13px;font-weight:600;margin-bottom:8px;">A 级高频套话命中</div><div class="pill-list" id="aHitsList"></div></div>
        <div><div style="font-size:13px;font-weight:600;margin-bottom:8px;">B 级结构指纹诊断</div><div id="bHitsList" style="display:flex;flex-direction:column;gap:8px;"></div></div>
        <div><div style="font-size:13px;font-weight:600;margin-bottom:8px;">逐句诊断与人味改写对照</div><div id="diagList" style="display:flex;flex-direction:column;gap:8px;"></div></div>
        <div class="paywall" id="paywallBox">
          <h3>支付宝永久买断 · 解锁全篇精修与防伪通行码</h3>
          <p id="paywallDesc">通过支付宝 Vibe Pay（即刻收）完成一次买断，本机 1 年免登自动解锁，并立即生成专属防伪通行码，换电脑/手机也能一键恢复永久权益。</p>
          <button class="pay" id="btnPay" type="button">支付宝扫码 / 跳转付款，永久解锁专业版</button>
          <div class="qr-box" id="qrBox">
            <img id="qrImg" alt="支付宝收款码">
            <div style="font-size:13px;font-weight:600;margin-bottom:6px;">请使用支付宝 App 扫码支付，或点击下方直达链接</div>
            <a id="payDirectLink" target="_blank" rel="noopener" style="color:#1677ff;font-size:13px;word-break:break-all;">前往支付宝付款页 →</a>
            <div style="margin-top:8px;"><button id="btnAfterQr" class="primary" type="button">付款已完成，立即刷新解锁</button></div>
          </div>
        </div>
        <div id="unlockedArea" style="display:none;flex-direction:column;gap:10px;">
          <div class="unlocked-banner">支付宝 Vibe Pay 永久专业版权益已核验！已解锁全部逐句精修与完整改写稿（上方可复制您的永久通行码）。</div>
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <strong style="font-size:13.5px;">完整去 AI 味参考改写稿</strong>
            <button id="btnDownload" type="button">下载 Markdown 完整报告</button>
          </div>
          <pre class="rewrite-box" id="rewriteBox"></pre>
        </div>
      </div>
    </section>
  </main>
  <script>
    const SAMPLE = "随着人工智能的飞速发展，内容创作行业正在经历前所未有的变革。值得注意的是，越来越多的创作者开始依赖大模型生成文章，这无疑是一把双刃剑。\\n\\n首先，AI 写作不仅大幅提升了生产效率，而且降低了创作门槛。其次，不可否认的是，过度依赖模板会导致文章同质化严重——读者一眼就能看出浓重的机器腔调。最后，从某种意义上说，真正拉开差距的不是工具本身，而是创作者的真实思考。\\n\\n核心结论：要让内容重新获得信任，我们需要打造差异化抓手，赋能个人表达，并形成闭环。换言之，去 AI 味不是简单的同义词替换，而是回到真实人话。综上所述，毫无疑问，保持独立视角才是最重要的护城河。";
    let currentFull = null;
    let currentPasscode = "";
    const savedDraft = sessionStorage.getItem("detone_draft");
    if (savedDraft) document.getElementById("articleInput").value = savedDraft;

    function showProStatus(passcode) {
      const badge = document.getElementById("modeBadge");
      badge.textContent = "永久专业版已激活";
      badge.className = "badge pro";
      if (passcode) {
        currentPasscode = passcode;
        document.getElementById("passcodeText").textContent = passcode;
        document.getElementById("passcodeBar").style.display = "block";
      }
    }

    function renderReport(report, isUnlocked, passcode) {
      document.getElementById("emptyHint").style.display = "none";
      document.getElementById("reportBody").style.display = "flex";
      const sEl = document.getElementById("kScore");
      sEl.textContent = report.aiScore + " / 100";
      sEl.className = report.aiScore >= 65 ? "high" : (report.aiScore >= 35 ? "mid" : "low");
      document.getElementById("kAHits").textContent = report.summary.aTierTotalHits;
      document.getElementById("kBIssues").textContent = report.summary.bTierIssues;
      document.getElementById("kSentences").textContent = report.summary.flaggedSentences;
      document.getElementById("gradeTag").textContent = report.grade;
      document.getElementById("verdictBox").textContent = \`全文字数 \${report.charCount} 字 · 平均句长 \${report.avgSentenceLen} 字 · \${report.verdict}\`;
      document.getElementById("aHitsList").innerHTML = report.aHits.length
        ? report.aHits.map(h => \`<span class="hit-pill">「\${h.term}」×\${h.count} → 改「\${h.replace || "删去"}」</span>\`).join("")
        : '<span style="color:#86efac;font-size:13px;">未检出高频 A 级套话</span>';
      document.getElementById("bHitsList").innerHTML = report.bHits.length
        ? report.bHits.map(b => \`<div class="diag-item"><strong>\${b.label}（命中 \${b.count} 处）</strong><div style="color:#93a6ce;margin-top:4px;">\${b.tip}</div></div>\`).join("")
        : '<div style="color:#86efac;font-size:13px;">未检出显著 B 级结构排比/冒号腔</div>';
      document.getElementById("diagList").innerHTML = report.sentenceDiagnostics.length
        ? report.sentenceDiagnostics.map(d => \`<div class="diag-item"><div class="orig">原句 #\${d.index}：\${d.original}</div><div class="rev">建议改写：\${d.revised}</div><div style="color:#94a3b8;font-size:12px;margin-top:4px;">诊断：\${d.issues.join("；")}</div></div>\`).join("")
        : '<div style="color:#86efac;font-size:13px;">当前段落无高危病句。</div>';
      if (isUnlocked) {
        currentFull = report;
        showProStatus(passcode || currentPasscode);
        document.getElementById("paywallBox").style.display = "none";
        document.getElementById("unlockedArea").style.display = "flex";
        document.getElementById("rewriteBox").textContent = report.rewrittenText;
      } else {
        document.getElementById("paywallBox").style.display = "block";
        document.getElementById("unlockedArea").style.display = "none";
      }
    }

    async function checkInitialStatus() {
      try {
        const res = await fetch("/api/entitlement/status");
        const data = await res.json();
        if (res.ok && data.access === "granted") {
          showProStatus(data.passcode);
        }
      } catch (_e) {}
    }

    async function runAnalyze() {
      const text = document.getElementById("articleInput").value.trim();
      if (text.length < 30) { document.getElementById("statusMsg").textContent = "请至少输入 30 字中文文章内容。"; return; }
      sessionStorage.setItem("detone_draft", text);
      document.getElementById("statusMsg").textContent = "正在执行三层确定性体检并检查权益…";
      const res = await fetch("/api/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
      const data = await res.json();
      if (!res.ok) { document.getElementById("statusMsg").textContent = data.error || "扫描失败"; return; }
      if (data.unlocked && data.fullReport) {
        document.getElementById("statusMsg").textContent = "已核验永久专业版权益，直接展示完整精修报告！";
        renderReport(data.fullReport, true, data.passcode);
      } else {
        document.getElementById("statusMsg").textContent = "免费初检完成！付费永久买断后立即解锁全篇逐句精修与防伪通行码。";
        renderReport(data.preview, false);
      }
    }

    async function startPay() {
      const btn = document.getElementById("btnPay");
      btn.disabled = true; btn.textContent = "正在获取支付宝正式收款入口…";
      try {
        const res = await fetch("/api/checkout", { method: "POST" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "获取购买入口失败");
        if (data.access === "granted") {
          showProStatus(data.passcode);
          await runAnalyze();
          return;
        }
        if (data.qrCodeUrl) {
          document.getElementById("qrImg").src = data.qrCodeUrl;
          document.getElementById("payDirectLink").href = data.payUrl;
          document.getElementById("qrBox").style.display = "block";
          btn.textContent = "已生成支付宝收款码与直达链接";
        } else {
          window.location.href = data.payUrl;
        }
      } catch (e) {
        alert(e.message);
        btn.disabled = false; btn.textContent = "支付宝扫码 / 跳转付款，永久解锁专业版";
      }
    }

    async function submitRecover() {
      const input = document.getElementById("passcodeInput").value.trim();
      const msg = document.getElementById("recoverMsg");
      if (!input) { msg.style.color = "#f87171"; msg.textContent = "请先粘贴您的永久通行码。"; return; }
      const btn = document.getElementById("btnRecoverSubmit");
      btn.disabled = true;
      msg.style.color = "#93a6ce";
      msg.textContent = "正在校验 HMAC 防伪签名并实时核验支付宝买断权益…";
      try {
        const res = await fetch("/api/entitlement/recover", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ passcode: input })
        });
        const data = await res.json();
        if (!res.ok) {
          msg.style.color = "#f87171";
          msg.textContent = data.error || "恢复失败，请确认通行码正确且已完成买断。";
          return;
        }
        msg.style.color = "#34d399";
        msg.textContent = "校验通过！已为当前浏览器恢复 1 年免登永久专业版权益。";
        showProStatus(data.passcode);
        document.getElementById("recoverDrawer").style.display = "none";
        if (document.getElementById("articleInput").value.trim().length >= 30) {
          await runAnalyze();
        }
      } catch (_e) {
        msg.style.color = "#f87171";
        msg.textContent = "网络请求异常，请稍后重试。";
      } finally {
        btn.disabled = false;
      }
    }

    document.getElementById("btnToggleRecover").addEventListener("click", () => {
      const d = document.getElementById("recoverDrawer");
      d.style.display = d.style.display === "block" ? "none" : "block";
      if (d.style.display === "block") document.getElementById("passcodeInput").focus();
    });
    document.getElementById("btnRecoverClose").addEventListener("click", () => {
      document.getElementById("recoverDrawer").style.display = "none";
    });
    document.getElementById("btnRecoverSubmit").addEventListener("click", submitRecover);
    document.getElementById("passcodeInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") submitRecover();
    });
    document.getElementById("btnCopyPasscode").addEventListener("click", async () => {
      if (!currentPasscode) return;
      const btn = document.getElementById("btnCopyPasscode");
      try {
        await navigator.clipboard.writeText(currentPasscode);
      } catch (_e) {
        const ta = document.createElement("textarea");
        ta.value = currentPasscode;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      btn.textContent = "已复制到剪贴板！";
      setTimeout(() => { btn.textContent = "复制通行码"; }, 2200);
    });

    document.getElementById("btnSample").addEventListener("click", () => { document.getElementById("articleInput").value = SAMPLE; });
    document.getElementById("btnAnalyze").addEventListener("click", runAnalyze);
    document.getElementById("btnRecheck").addEventListener("click", async () => {
      await checkInitialStatus();
      if (document.getElementById("articleInput").value.trim().length >= 30) await runAnalyze();
    });
    document.getElementById("btnPay").addEventListener("click", startPay);
    document.getElementById("btnAfterQr").addEventListener("click", async () => {
      await checkInitialStatus();
      await runAnalyze();
    });
    document.getElementById("btnDownload").addEventListener("click", () => {
      if (!currentFull) return;
      const r = currentFull;
      const md = ["# 文章去 AI 味三层体检精修报告", \`- AI 味指数：\${r.aiScore}/100（\${r.grade}）\`, "", "## 一、逐句诊断", ...r.sentenceDiagnostics.map(d => \`- 原句 #\${d.index}：\${d.original}\\n  - 建议改写：\${d.revised}\`), "", "## 二、完整改写稿", r.rewrittenText].join("\\n");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([md], { type: "text/markdown;charset=utf-8" }));
      a.download = "detone-studio-report.md";
      a.click();
    });

    checkInitialStatus();
    if (new URLSearchParams(location.search).get("check_entitlement") && savedDraft) runAnalyze();
  </script>
</body>
</html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { userId, setCookie } = getOrCreateUserId(request);
    const configured = Boolean(env.WATCHA_API_KEY && env.WATCHA_ENTITLEMENT_ID);
    const passcodeRecoveryEnabled = hasSessionSecret(env);

    if (request.method === "GET" && url.pathname === "/") {
      const headers = { "Content-Type": "text/html; charset=utf-8" };
      if (setCookie) headers["Set-Cookie"] = setCookie;
      return new Response(HTML_PAGE, { status: 200, headers });
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      return jsonResp({
        status: "ok",
        product: "DeTone Studio · 文章去 AI 味三层体检精修台",
        runtime: "cloudflare-workers",
        paymentMode: configured ? "watchapay-vibe-pay-live" : "unconfigured",
        watchaConfigured: configured,
        passcodeRecoveryEnabled
      }, 200, setCookie);
    }

    if (request.method === "GET" && url.pathname === "/api/entitlement/status") {
      if (!configured) {
        return jsonResp({ access: "unavailable", error: "服务端支付凭证未配置。" }, 503, setCookie);
      }
      const acc = await checkWatchaAccess(env, userId, `${url.origin}/?check_entitlement=1`);
      if (!acc.ok || acc.access === "unavailable") {
        return jsonResp({ access: "unavailable", reason: acc.reason }, 503, setCookie);
      }
      if (acc.access === "granted") {
        const passcode = await issuePasscode(userId, env);
        return jsonResp({ access: "granted", entitlement: acc.entitlement, passcode }, 200, setCookie);
      }
      return jsonResp({ access: "purchase_required" }, 200, setCookie);
    }

    if (request.method === "POST" && url.pathname === "/api/entitlement/recover") {
      if (!configured || !passcodeRecoveryEnabled) {
        return jsonResp({ error: "服务端通行码恢复功能暂未就绪（失败关闭保护）。" }, 503, setCookie);
      }
      const body = await request.json().catch(() => ({}));
      const verified = await verifyPasscode(body.passcode, env);
      if (!verified.valid) {
        return jsonResp({ error: "通行码格式错误或防伪签名校验失败，请确认是否完整复制。" }, 400, setCookie);
      }
      const acc = await checkWatchaAccess(env, verified.userId, `${url.origin}/?check_entitlement=1`);
      if (!acc.ok || acc.access === "unavailable") {
        return jsonResp({ error: "支付宝 Vibe Pay 权益核验服务暂不可用，请稍后重试。", reason: acc.reason }, 503, setCookie);
      }
      if (acc.access !== "granted") {
        return jsonResp({ error: "该通行码尚未检测到有效买断权益，请确认是否已完成支付宝付款。" }, 403, setCookie);
      }
      return jsonResp(
        {
          recovered: true,
          access: "granted",
          passcode: verified.passcode,
          entitlement: acc.entitlement
        },
        200,
        buildUserCookie(verified.userId)
      );
    }

    if (request.method === "POST" && url.pathname === "/api/analyze") {
      const body = await request.json().catch(() => ({}));
      const text = String(body.text || "").trim();
      if (text.length < 30) return jsonResp({ error: "请粘贴至少 30 字的中文文章内容。" }, 400, setCookie);
      const full = analyzeArticle(text);
      let unlocked = false;
      let passcode = null;
      if (configured) {
        const acc = await checkWatchaAccess(env, userId, `${url.origin}/?check_entitlement=1`);
        if (acc.ok && acc.access === "granted") {
          unlocked = true;
          passcode = await issuePasscode(userId, env);
        }
      }
      return jsonResp(
        unlocked ? { unlocked: true, passcode, fullReport: full } : { unlocked: false, preview: toFreePreview(full) },
        200,
        setCookie
      );
    }

    if (request.method === "POST" && url.pathname === "/api/checkout") {
      if (!configured) return jsonResp({ error: "服务端支付凭证未配置（失败关闭保护）。" }, 503, setCookie);
      const acc = await checkWatchaAccess(env, userId, `${url.origin}/?check_entitlement=1`);
      if (!acc.ok || acc.access === "unavailable") {
        return jsonResp({ error: "支付宝 Vibe Pay 权益服务暂不可用，请稍后重试。", reason: acc.reason }, 503, setCookie);
      }
      if (acc.access === "granted") {
        const passcode = await issuePasscode(userId, env);
        return jsonResp({ access: "granted", passcode, entitlement: acc.entitlement }, 200, setCookie);
      }
      if (!acc.purchase || !acc.purchase.url) {
        return jsonResp({ error: "当前商品暂无可用购买入口。" }, 503, setCookie);
      }
      return jsonResp({
        access: "purchase_required",
        payUrl: acc.purchase.url,
        qrCodeUrl: acc.purchase.qr_code_url || null
      }, 200, setCookie);
    }

    return jsonResp({ error: "Not found" }, 404, setCookie);
  }
};
