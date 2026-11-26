"use strict";

/**
 * 爱猹收（WatchaPay · 支付宝 Vibe Pay 官方个人合作平台）服务端接入客户端
 * 适用场景：无营业执照的独立开发者 / 个人创作者，通过支付宝即刻收直达个人收款账号。
 * 契约依据：https://watchapay.com/agent.md
 * - 查权益：POST /v1/entitlements/access
 * - 扣额度：POST /v1/entitlements/consume（仅额度包模式）
 * - 失败关闭（fail-closed）：非 2xx / unavailable / 未知结果一律不放行
 */

class WatchaPayClient {
  constructor(config = {}) {
    this.baseUrl = (config.baseUrl || process.env.WATCHA_BASE_URL || "https://pay.watcha.cn").replace(/\/+$/, "");
    this.apiKey = (config.apiKey || process.env.WATCHA_API_KEY || "").trim();
    this.entitlementId = (config.entitlementId || process.env.WATCHA_ENTITLEMENT_ID || "").trim();
    this.billingMode = (config.billingMode || process.env.WATCHA_BILLING_MODE || "one_time").toLowerCase(); // one_time | duration | quota
  }

  isConfigured() {
    return Boolean(this.apiKey && this.entitlementId);
  }

  async checkAccess({ userId, returnUrl }) {
    const body = {
      entitlement_id: this.entitlementId,
      user_id: userId
    };
    if (returnUrl && /^https?:\/\//i.test(returnUrl)) {
      body.return_url = returnUrl;
    }

    const res = await fetch(`${this.baseUrl}/v1/entitlements/access`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        access: "unavailable",
        httpStatus: res.status,
        reason: data.error || data.reason || { code: "http_error", message: `HTTP ${res.status}` }
      };
    }

    const access = data.access;
    if (access !== "granted" && access !== "purchase_required" && access !== "unavailable") {
      return {
        ok: false,
        access: "unavailable",
        reason: { code: "unknown_response", message: "Unexpected entitlement response" }
      };
    }

    return {
      ok: true,
      access,
      entitlement: data.entitlement || {},
      purchase: data.purchase && data.purchase.url ? data.purchase : null,
      reason: data.reason || null
    };
  }

  async consumeQuota({ userId, amount = 1, idempotencyKey }) {
    const res = await fetch(`${this.baseUrl}/v1/entitlements/consume`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        entitlement_id: this.entitlementId,
        user_id: userId,
        amount,
        idempotency_key: idempotencyKey
      })
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 409) {
      return { ok: false, insufficient: true, error: data.error || { code: "insufficient_quota" } };
    }
    if (!res.ok) {
      return { ok: false, insufficient: false, error: data.error || { code: `http_${res.status}` } };
    }
    return {
      ok: true,
      consumed: data.consumed,
      entitlement: data.entitlement || {}
    };
  }
}

module.exports = { WatchaPayClient };
