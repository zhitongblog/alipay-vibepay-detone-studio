"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { analyzeArticle, toFreePreview } = require("../src/analyzer");
const { AlipayWebPayClient } = require("../src/alipay-client");
const { createApp } = require("../src/server");

test("analyzer detects A-tier cliches, B-tier structures, and rewrites cleanly", () => {
  const sample = "随着人工智能的飞速发展，值得注意的是，这不仅提升了效率，而且是一把双刃剑——我们需要赋能业务并形成闭环。综上所述，毫无疑问这很重要。";
  const r = analyzeArticle(sample);
  assert.ok(r.aiScore >= 50, `Expected high AI score, got ${r.aiScore}`);
  assert.ok(r.summary.aTierTotalHits >= 5);
  assert.ok(r.sentenceDiagnostics.length >= 2);
  assert.ok(!r.rewrittenText.includes("值得注意的是"));

  const preview = toFreePreview(r);
  assert.equal(preview.locked, true);
  assert.ok(preview.sentenceDiagnostics.length <= 2);
});

test("AlipayWebPayClient signs page pay URL and verifies RSA2 webhook signature", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
  const client = new AlipayWebPayClient({
    env: "sandbox",
    appId: "2026000000000001",
    privateKey,
    alipayPublicKey: publicKey
  });
  assert.equal(client.isConfigured(), true);

  const payUrl = client.createPagePayUrl({
    outTradeNo: "DTN_TEST_001",
    totalAmount: "1.99",
    subject: "单篇精修解锁",
    returnUrl: "http://127.0.0.1:3088/"
  });
  assert.ok(payUrl.startsWith("https://openapi-sandbox.dl.alipaydev.com/gateway.do?"));
  assert.ok(payUrl.includes("method=alipay.trade.page.pay"));
  assert.ok(payUrl.includes("sign="));

  const notifyPayload = {
    app_id: "2026000000000001",
    out_trade_no: "DTN_TEST_001",
    trade_no: "2026112622001400001",
    trade_status: "TRADE_SUCCESS",
    total_amount: "1.99",
    sign_type: "RSA2"
  };
  const { sign_type, ...signable } = notifyPayload;
  notifyPayload.sign = client.signParams(signable);
  assert.equal(client.verifyNotifySignature(notifyPayload), true);
  assert.equal(client.verifyNotifySignature({ ...notifyPayload, total_amount: "0.01" }), false);
});

test("End-to-end analyze -> order create -> Alipay notify unlock -> idempotent status check", async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
  const client = new AlipayWebPayClient({
    env: "sandbox",
    appId: "2026000000000001",
    privateKey,
    alipayPublicKey: publicKey
  });
  const app = createApp({ alipayClient: client });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const aRes = await fetch(`${base}/api/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "随着人工智能的飞速发展，值得注意的是，这不仅提升了效率，而且是一把双刃剑——我们需要赋能业务并形成闭环。综上所述，毫无疑问这很重要。"
      })
    });
    assert.equal(aRes.status, 200);
    const aData = await aRes.json();
    assert.ok(aData.reportId);

    const oRes = await fetch(`${base}/api/orders/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reportId: aData.reportId, planId: "single_unlock" })
    });
    assert.equal(oRes.status, 200);
    const oData = await oRes.json();
    assert.ok(oData.payUrl.includes("alipay.trade.page.pay"));

    // Simulate signed Alipay server-to-server notify webhook
    const notifyParams = {
      app_id: "2026000000000001",
      out_trade_no: oData.outTradeNo,
      trade_no: "2026112622001499999",
      trade_status: "TRADE_SUCCESS",
      total_amount: "1.99",
      sign_type: "RSA2"
    };
    const { sign_type, ...signable } = notifyParams;
    notifyParams.sign = client.signParams(signable);

    const nRes = await fetch(`${base}/api/alipay/notify`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(notifyParams).toString()
    });
    assert.equal(nRes.status, 200);
    assert.equal(await nRes.text(), "success");

    const sRes = await fetch(`${base}/api/orders/${oData.outTradeNo}/status`);
    const sData = await sRes.json();
    assert.equal(sData.status, "PAID");
    assert.ok(sData.fullReport && sData.fullReport.rewrittenText);
  } finally {
    server.close();
  }
});

test("WatchaPay personal Vibe Pay fail-closed and entitlement grant flow", async () => {
  let grantMode = "purchase_required";
  const fakeWatcha = {
    isConfigured: () => true,
    async checkAccess() {
      if (grantMode === "unavailable") {
        return { ok: false, access: "unavailable", reason: { code: "upstream_500" } };
      }
      if (grantMode === "granted") {
        return { ok: true, access: "granted", entitlement: { type: "permanent" }, purchase: null };
      }
      return {
        ok: true,
        access: "purchase_required",
        entitlement: { type: "permanent" },
        purchase: { url: "https://pay.watcha.cn/checkout/mock_ticket" }
      };
    }
  };
  const app = createApp({ watchaClient: fakeWatcha });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const aRes = await fetch(`${base}/api/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "随着人工智能的飞速发展，值得注意的是，这不仅提升了效率，而且是一把双刃剑——我们需要赋能业务并形成闭环。综上所述，毫无疑问这很重要。"
      })
    });
    const { reportId } = await aRes.json();

    // 1. Purchase required returns hosted checkout url
    const o1 = await fetch(`${base}/api/orders/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reportId })
    });
    assert.equal(o1.status, 200);
    const d1 = await o1.json();
    assert.equal(d1.mode, "watchapay-vibe-pay");
    assert.equal(d1.payUrl, "https://pay.watcha.cn/checkout/mock_ticket");

    // 2. Upstream failure must fail-closed (503)
    grantMode = "unavailable";
    const cFail = await fetch(`${base}/api/entitlement/check?report_id=${reportId}`);
    assert.equal(cFail.status, 503);

    // 3. After payment granted -> unlocks full report
    grantMode = "granted";
    const cOk = await fetch(`${base}/api/entitlement/check?report_id=${reportId}`);
    assert.equal(cOk.status, 200);
    const dOk = await cOk.json();
    assert.equal(dOk.access, "granted");
    assert.ok(dOk.fullReport && dOk.fullReport.rewrittenText);
  } finally {
    server.close();
  }
});
