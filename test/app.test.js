"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { analyzeArticle, toFreePreview } = require("../src/analyzer");
const { AlipayWebPayClient } = require("../src/alipay-client");
const { issuePasscode, verifyPasscode } = require("../src/passcode");
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
  const app = createApp({ alipayClient: client, watchaClient: { isConfigured: () => false } });
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

test("HMAC-SHA256 passcode issuance, verification, tamper rejection, and cross-device recovery", async () => {
  const secret = "test_secret_key_for_detone_hmac_2026_0123456789";
  const paidUid = "u_0123456789abcdef01234567";
  const unpaidUid = "u_fedcba9876543210fedcba98";

  // Unit verification of passcode helper
  const code = issuePasscode(paidUid, secret);
  assert.match(code, /^DTN-[0-9A-F]{8}-[0-9A-F]{8}-[0-9A-F]{8}-[0-9A-F]{12}$/);
  assert.deepEqual(verifyPasscode(code.toLowerCase().replace(/-/g, ""), secret), {
    valid: true,
    userId: paidUid,
    passcode: code
  });
  const tampered = code.slice(0, -1) + (code.endsWith("A") ? "B" : "A");
  assert.equal(verifyPasscode(tampered, secret).valid, false);
  assert.equal(verifyPasscode(code, "").valid, false);

  const paidUsers = new Set([paidUid]);
  const fakeWatcha = {
    isConfigured: () => true,
    async checkAccess({ userId }) {
      if (paidUsers.has(userId)) {
        return { ok: true, access: "granted", entitlement: { type: "permanent" }, purchase: null };
      }
      return {
        ok: true,
        access: "purchase_required",
        entitlement: { type: "permanent" },
        purchase: { url: "https://pay.watcha.cn/checkout/mock" }
      };
    }
  };

  const app = createApp({ watchaClient: fakeWatcha, sessionSecret: secret });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // 1. Forged passcode -> 400 and no Set-Cookie
    const badRes = await fetch(`${base}/api/entitlement/recover`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passcode: tampered })
    });
    assert.equal(badRes.status, 400);
    assert.equal(badRes.headers.get("set-cookie"), null);

    // 2. Valid HMAC but unpaid user -> 403 and no Set-Cookie
    const unpaidCode = issuePasscode(unpaidUid, secret);
    const unpaidRes = await fetch(`${base}/api/entitlement/recover`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passcode: unpaidCode })
    });
    assert.equal(unpaidRes.status, 403);
    assert.equal(unpaidRes.headers.get("set-cookie"), null);

    // 3. Valid HMAC + paid user -> 200 + 1-year HttpOnly cookie
    const okRes = await fetch(`${base}/api/entitlement/recover`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passcode: code })
    });
    assert.equal(okRes.status, 200);
    const okData = await okRes.json();
    assert.equal(okData.recovered, true);
    assert.equal(okData.passcode, code);
    const setCookie = okRes.headers.get("set-cookie") || "";
    assert.ok(setCookie.includes(`detone_uid=${paidUid}`));
    assert.ok(setCookie.includes("HttpOnly"));
    assert.ok(setCookie.includes("Max-Age=31536000"));
  } finally {
    server.close();
  }
});

test("Cloudflare Worker runtime parity: HMAC passcode, fail-closed recovery, and 1-year Secure cookie", async () => {
  const path = require("node:path");
  const { pathToFileURL } = require("node:url");
  const workerMod = await import(pathToFileURL(path.join(__dirname, "..", "worker", "index.js")).href);
  const worker = workerMod.default;

  const secret = "worker_parity_secret_2026_abcdef0123456789";
  const paidUid = "u_aabbccddeeff001122334455";
  const unpaidUid = "u_554433221100ffeeddccbbaa";
  const expectedPasscode = issuePasscode(paidUid, secret);
  const unpaidPasscode = issuePasscode(unpaidUid, secret);

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/v1/entitlements/access")) {
      const payload = JSON.parse(init.body);
      const granted = payload.user_id === paidUid;
      return new Response(
        JSON.stringify(
          granted
            ? { access: "granted", entitlement: { type: "permanent" } }
            : { access: "purchase_required", purchase: { url: "https://pay.watcha.cn/checkout/live" } }
        ),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return origFetch(url, init);
  };

  try {
    const env = {
      WATCHA_BASE_URL: "https://pay.watcha.cn",
      WATCHA_API_KEY: "key_mock",
      WATCHA_ENTITLEMENT_ID: "ent_mock",
      SESSION_SECRET: secret
    };

    // 1. Health reports passcodeRecoveryEnabled: true
    const hRes = await worker.fetch(new Request("https://detone.doaipm.com/api/health"), env);
    const hData = await hRes.json();
    assert.equal(hData.passcodeRecoveryEnabled, true);
    assert.ok((hRes.headers.get("Set-Cookie") || "").includes("Max-Age=31536000"));

    // 2. Paid user gets identical passcode from Worker as Node passcode.js
    const stRes = await worker.fetch(
      new Request("https://detone.doaipm.com/api/entitlement/status", {
        headers: { Cookie: `detone_uid=${paidUid}` }
      }),
      env
    );
    const stData = await stRes.json();
    assert.equal(stData.access, "granted");
    assert.equal(stData.passcode, expectedPasscode);

    // 3. Forged passcode rejected with 400
    const badRes = await worker.fetch(
      new Request("https://detone.doaipm.com/api/entitlement/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passcode: "DTN-00000000-00000000-00000000-1234567890AB" })
      }),
      env
    );
    assert.equal(badRes.status, 400);

    // 4. Valid HMAC but unpaid user rejected with 403
    const unpRes = await worker.fetch(
      new Request("https://detone.doaipm.com/api/entitlement/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passcode: unpaidPasscode })
      }),
      env
    );
    assert.equal(unpRes.status, 403);

    // 5. Valid paid passcode recovers on fresh device with Secure HttpOnly 1-year cookie
    const recRes = await worker.fetch(
      new Request("https://detone.doaipm.com/api/entitlement/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passcode: expectedPasscode })
      }),
      env
    );
    assert.equal(recRes.status, 200);
    const recData = await recRes.json();
    assert.equal(recData.recovered, true);
    assert.equal(recData.passcode, expectedPasscode);
    const recCookie = recRes.headers.get("Set-Cookie") || "";
    assert.ok(recCookie.includes(`detone_uid=${paidUid}`));
    assert.ok(recCookie.includes("HttpOnly"));
    assert.ok(recCookie.includes("Secure"));
    assert.ok(recCookie.includes("Max-Age=31536000"));

    // 6. Missing SESSION_SECRET fails closed with 503
    const noSecretRes = await worker.fetch(
      new Request("https://detone.doaipm.com/api/entitlement/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passcode: expectedPasscode })
      }),
      { ...env, SESSION_SECRET: "" }
    );
    assert.equal(noSecretRes.status, 503);
  } finally {
    globalThis.fetch = origFetch;
  }
});
