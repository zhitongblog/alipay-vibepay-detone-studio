"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");

// Zero-dep .env loader (never overwrites already-set process.env)
(() => {
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const k = trimmed.slice(0, eq).trim();
    const v = trimmed.slice(eq + 1).trim();
    if (k && process.env[k] === undefined) process.env[k] = v;
  }
})();

const { analyzeArticle, toFreePreview } = require("./analyzer");
const { AlipayWebPayClient } = require("./alipay-client");
const { WatchaPayClient } = require("./watchapay-client");

const PLANS = {
  single_unlock: {
    id: "single_unlock",
    name: "单篇深度去 AI 味精修报告 + 全文改写导出",
    amount: "1.99",
    credits: 1,
    desc: "解锁本篇全部逐句诊断、自然口语改写对照稿与 Markdown 导出"
  },
  pack_10: {
    id: "pack_10",
    name: "创作者 10 次专业体检包",
    amount: "9.90",
    credits: 10,
    desc: "高频写作者首选，单篇低至 ¥0.99"
  }
};

function createApp(options = {}) {
  const app = express();
  const alipay = options.alipayClient || new AlipayWebPayClient(options.alipayConfig);
  const watcha = options.watchaClient || new WatchaPayClient(options.watchaConfig);
  const publicBaseUrl = (options.publicBaseUrl || process.env.PUBLIC_BASE_URL || "http://127.0.0.1:3088").replace(/\/+$/, "");

  // In-memory store (persists for process lifetime; easily swappable to SQLite/Redis)
  const reports = new Map();
  const orders = new Map();

  // Stable server-issued user identity cookie (never trusts arbitrary client user_id)
  function getOrCreateUserId(req, res) {
    const cookieHeader = String(req.headers.cookie || "");
    const m = cookieHeader.match(/(?:^|;\s*)detone_uid=([a-zA-Z0-9_-]{12,64})/);
    if (m) return m[1];
    const uid = "u_" + crypto.randomBytes(12).toString("hex");
    res.setHeader("Set-Cookie", `detone_uid=${uid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
    return uid;
  }

  app.use(express.json({ limit: "512kb" }));
  app.use(express.urlencoded({ extended: true, limit: "512kb" }));
  app.use(express.static(path.join(__dirname, "..", "public")));

  app.get("/api/health", (_req, res) => {
    const paymentMode = watcha.isConfigured()
      ? "watchapay-vibe-pay"
      : (alipay.isConfigured() ? alipay.env : "demo-sandbox-preview");
    res.json({
      status: "ok",
      product: "DeTone Studio · 文章去 AI 味三层体检精修台",
      paymentMode,
      watchaConfigured: watcha.isConfigured(),
      alipayConfigured: alipay.isConfigured(),
      notifyUrlConfigured: Boolean(alipay.notifyUrl),
      plans: PLANS
    });
  });

  // 爱猹收（Vibe Pay 个人即刻收）权益检查与解锁接口
  app.get("/api/entitlement/check", async (req, res) => {
    const userId = getOrCreateUserId(req, res);
    const reportId = String(req.query.report_id || "").trim();
    const rec = reportId ? reports.get(reportId) : null;

    if (!watcha.isConfigured()) {
      return res.status(400).json({ error: "WatchaPay 未配置。" });
    }

    const returnUrl = reportId
      ? `${publicBaseUrl}/?report_id=${encodeURIComponent(reportId)}&check_entitlement=1`
      : `${publicBaseUrl}/?check_entitlement=1`;

    const result = await watcha.checkAccess({ userId, returnUrl });
    if (!result.ok || result.access === "unavailable") {
      return res.status(503).json({
        access: "unavailable",
        reason: result.reason || { code: "service_unavailable", message: "权益查询暂不可用（失败关闭保护）" }
      });
    }

    if (result.access === "granted") {
      if (rec) rec.unlocked = true;
      return res.json({
        access: "granted",
        entitlement: result.entitlement,
        fullReport: rec ? rec.full : null
      });
    }

    return res.json({
      access: "purchase_required",
      entitlement: result.entitlement,
      purchase: result.purchase
    });
  });

  // 1. 免费三层扫描（返回完整 AI 味评分 + 前置诊断预览）
  app.post("/api/analyze", (req, res) => {
    const text = String(req.body?.text || "").trim();
    if (text.length < 30) {
      return res.status(400).json({ error: "请粘贴至少 30 字的中文文章内容再进行体检。" });
    }
    const reportId = "rpt_" + crypto.randomBytes(8).toString("hex");
    const full = analyzeArticle(text);
    reports.set(reportId, {
      reportId,
      createdAt: new Date().toISOString(),
      originalText: text,
      full,
      unlocked: false
    });
    return res.json({
      reportId,
      preview: toFreePreview(full),
      plans: PLANS
    });
  });

  // 2. 创建支付宝 Vibe Pay 订单（优先爱猹收个人即刻收，否则 alipay.trade.page.pay）
  app.post("/api/orders/create", async (req, res) => {
    const userId = getOrCreateUserId(req, res);
    const { reportId, planId = "single_unlock" } = req.body || {};
    const record = reports.get(reportId);
    if (!record) {
      return res.status(404).json({ error: "未找到对应的体检报告，请先执行扫描。" });
    }
    const plan = PLANS[planId];
    if (!plan) {
      return res.status(400).json({ error: "无效的商品档位。" });
    }

    // 路径 A：爱猹收（Vibe Pay 个人即刻收模式）
    if (watcha.isConfigured()) {
      const returnUrl = `${publicBaseUrl}/?report_id=${encodeURIComponent(reportId)}&check_entitlement=1`;
      const accessRes = await watcha.checkAccess({ userId, returnUrl });
      if (!accessRes.ok || accessRes.access === "unavailable") {
        return res.status(503).json({ error: "支付权益服务暂时不可用，请稍后重试。" });
      }
      if (accessRes.access === "granted") {
        record.unlocked = true;
        return res.json({
          mode: "watchapay-vibe-pay",
          alreadyGranted: true,
          fullReport: record.full
        });
      }
      if (!accessRes.purchase || !accessRes.purchase.url) {
        return res.status(503).json({ error: "当前商品暂无可用购买入口。" });
      }
      return res.json({
        mode: "watchapay-vibe-pay",
        amount: plan.amount,
        subject: plan.name,
        payUrl: accessRes.purchase.url,
        qrCodeUrl: accessRes.purchase.qr_code_url || null
      });
    }

    const outTradeNo = `DTN${Date.now()}${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    const order = {
      outTradeNo,
      reportId,
      planId: plan.id,
      subject: plan.name,
      amount: plan.amount,
      status: "WAIT_BUYER_PAY",
      tradeNo: "",
      createdAt: new Date().toISOString(),
      paidAt: null
    };
    orders.set(outTradeNo, order);

    const returnUrl = `${publicBaseUrl}/?out_trade_no=${encodeURIComponent(outTradeNo)}&report_id=${encodeURIComponent(reportId)}`;

    if (alipay.isConfigured()) {
      const payUrl = alipay.createPagePayUrl({
        outTradeNo,
        totalAmount: plan.amount,
        subject: plan.name,
        returnUrl
      });
      return res.json({
        outTradeNo,
        amount: plan.amount,
        subject: plan.name,
        mode: alipay.env,
        payUrl
      });
    }

    // 未配置真实密钥时的本地沙箱演示收银台（清晰标明 Demo 模式，绝不伪造生产收款）
    const demoPayUrl = `${publicBaseUrl}/api/demo-checkout/${encodeURIComponent(outTradeNo)}`;
    return res.json({
      outTradeNo,
      amount: plan.amount,
      subject: plan.name,
      mode: "demo-sandbox-preview",
      payUrl: demoPayUrl,
      notice: "当前未配置 ALIPAY_APP_ID / 私钥，已启用本地模拟收银台演示完整支付状态机；配置真实沙箱/生产密钥后自动切换支付宝官方收银台。"
    });
  });

  // 3. 主动查单与权益放行（alipay.trade.query 幂等履约）
  app.get("/api/orders/:outTradeNo/status", async (req, res) => {
    const order = orders.get(req.params.outTradeNo);
    if (!order) {
      return res.status(404).json({ error: "订单不存在。" });
    }

    // 若尚未确认付款且已配置真实支付宝，则主动调 alipay.trade.query 核验
    if (order.status !== "PAID" && alipay.isConfigured()) {
      try {
        const queried = await alipay.queryTrade(order.outTradeNo);
        const amountMatches = Number(queried.totalAmount) === Number(order.amount);
        if (
          queried.ok &&
          (queried.tradeStatus === "TRADE_SUCCESS" || queried.tradeStatus === "TRADE_FINISHED") &&
          amountMatches
        ) {
          order.status = "PAID";
          order.tradeNo = queried.tradeNo;
          order.paidAt = new Date().toISOString();
          const rec = reports.get(order.reportId);
          if (rec) rec.unlocked = true;
        }
      } catch (err) {
        return res.status(502).json({
          outTradeNo: order.outTradeNo,
          status: order.status,
          error: `主动查单暂时不可用：${err.message}`
        });
      }
    }

    const rec = reports.get(order.reportId);
    return res.json({
      outTradeNo: order.outTradeNo,
      reportId: order.reportId,
      amount: order.amount,
      status: order.status,
      tradeNo: order.tradeNo,
      paidAt: order.paidAt,
      fullReport: order.status === "PAID" && rec ? rec.full : null
    });
  });

  // 4. 支付宝服务端异步通知（RSA2 验签 + 金额/订单校验 + 幂等更新 + 回写 success）
  app.post("/api/alipay/notify", (req, res) => {
    const params = req.body || {};
    if (!alipay.isConfigured()) {
      return res.status(503).send("failure");
    }
    if (!alipay.verifyNotifySignature(params)) {
      return res.status(400).send("failure");
    }
    const outTradeNo = params.out_trade_no;
    const tradeStatus = params.trade_status;
    const totalAmount = params.total_amount;
    const appId = params.app_id;

    const order = orders.get(outTradeNo);
    if (!order) return res.status(404).send("failure");
    if (appId !== alipay.appId) return res.status(400).send("failure");
    if (Number(totalAmount) !== Number(order.amount)) return res.status(400).send("failure");

    if (tradeStatus === "TRADE_SUCCESS" || tradeStatus === "TRADE_FINISHED") {
      if (order.status !== "PAID") {
        order.status = "PAID";
        order.tradeNo = params.trade_no || "";
        order.paidAt = new Date().toISOString();
        const rec = reports.get(order.reportId);
        if (rec) rec.unlocked = true;
      }
    }
    return res.status(200).send("success");
  });

  // 5. 本地无密钥演示收银台（仅在 ALIPAY 未配置时开放）
  app.get("/api/demo-checkout/:outTradeNo", (req, res) => {
    if (alipay.isConfigured()) {
      return res.status(403).send("Production/Sandbox Alipay configured; demo checkout disabled.");
    }
    const order = orders.get(req.params.outTradeNo);
    if (!order) return res.status(404).send("订单不存在");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>支付宝沙箱演示收银台 · DeTone Studio</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;background:#0b1220;color:#e5edf9;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:16px}
  .card{background:#121c33;border:1px solid #26375e;border-radius:16px;max-width:420px;width:100%;padding:24px}
  .tag{display:inline-block;padding:4px 10px;border-radius:999px;background:#1d4ed8;font-size:12px;margin-bottom:12px}
  h1{font-size:20px;margin:0 0 8px}
  .price{font-size:34px;font-weight:800;color:#38bdf8;margin:14px 0}
  .meta{font-size:13px;color:#94a3b8;line-height:1.7;margin-bottom:18px}
  button{width:100%;padding:13px;border:none;border-radius:10px;background:#1677ff;color:#fff;font-size:15px;font-weight:700;cursor:pointer}
  button:hover{background:#2563eb}
</style></head><body>
<div class="card">
  <span class="tag">支付宝 Vibe Pay · 本地沙箱演示模式</span>
  <h1>${order.subject}</h1>
  <div class="price">¥${order.amount}</div>
  <div class="meta">商户订单号：${order.outTradeNo}<br>配置 ALIPAY_APP_ID 与密钥后将自动跳转官方支付宝收银台（alipay.trade.page.pay）。</div>
  <form method="POST" action="/api/demo-checkout/${encodeURIComponent(order.outTradeNo)}/confirm">
    <button type="submit">确认模拟支付并返回解锁完整报告</button>
  </form>
</div></body></html>`);
  });

  app.post("/api/demo-checkout/:outTradeNo/confirm", (req, res) => {
    if (alipay.isConfigured()) {
      return res.status(403).send("Disabled");
    }
    const order = orders.get(req.params.outTradeNo);
    if (!order) return res.status(404).send("订单不存在");
    order.status = "PAID";
    order.tradeNo = "DEMO_ALIPAY_" + Date.now();
    order.paidAt = new Date().toISOString();
    const rec = reports.get(order.reportId);
    if (rec) rec.unlocked = true;
    return res.redirect(`/?out_trade_no=${encodeURIComponent(order.outTradeNo)}&report_id=${encodeURIComponent(order.reportId)}`);
  });

  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3088);
  const app = createApp();
  app.listen(port, () => {
    console.log(`DeTone Studio (Alipay Vibe Pay) running at http://127.0.0.1:${port}`);
  });
}

module.exports = { createApp, PLANS };
