"use strict";

/**
 * 支付宝 AI 网页应用收款（Vibe Pay）服务端支付客户端
 * 严格遵循支付宝官方开放平台协议：
 * - 收单接口：alipay.trade.page.pay（同时覆盖 PC 网页与手机浏览器 H5）
 * - 主动查单：alipay.trade.query（防止用户关闭页面漏单，未配 notify_url 时依然完整闭环）
 * - 异步通知：RSA2（SHA256withRSA）服务端验签 + 订单号/金额校验 + 幂等落单 + 回写 success
 * - 安全红线：私钥仅存在于服务端环境变量，绝不暴露给浏览器前端
 */

const crypto = require("crypto");

function formatPem(key, type) {
  if (!key) return "";
  const trimmed = key.trim();
  if (trimmed.includes("BEGIN ")) return trimmed;
  const header = type === "PRIVATE" ? "-----BEGIN PRIVATE KEY-----" : "-----BEGIN PUBLIC KEY-----";
  const footer = type === "PRIVATE" ? "-----END PRIVATE KEY-----" : "-----END PUBLIC KEY-----";
  const body = trimmed.replace(/\s+/g, "").match(/.{1,64}/g).join("\n");
  return `${header}\n${body}\n${footer}`;
}

function formatTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

function buildSignContent(params) {
  return Object.keys(params)
    .filter((k) => k !== "sign" && params[k] !== undefined && params[k] !== null && params[k] !== "")
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
}

class AlipayWebPayClient {
  constructor(config = {}) {
    this.env = (config.env || process.env.ALIPAY_ENV || "sandbox").toLowerCase();
    this.appId = (config.appId || process.env.ALIPAY_APP_ID || "").trim();
    this.privateKey = formatPem(config.privateKey || process.env.ALIPAY_PRIVATE_KEY || "", "PRIVATE");
    this.alipayPublicKey = formatPem(config.alipayPublicKey || process.env.ALIPAY_PUBLIC_KEY || "", "PUBLIC");
    this.notifyUrl = (config.notifyUrl || process.env.ALIPAY_NOTIFY_URL || "").trim();
    this.gateway =
      this.env === "production"
        ? "https://openapi.alipay.com/gateway.do"
        : "https://openapi-sandbox.dl.alipaydev.com/gateway.do";
  }

  isConfigured() {
    return Boolean(this.appId && this.privateKey && this.alipayPublicKey);
  }

  signParams(params) {
    const content = buildSignContent(params);
    const signer = crypto.createSign("RSA-SHA256");
    signer.update(content, "utf8");
    return signer.sign(this.privateKey, "base64");
  }

  verifyNotifySignature(params) {
    if (!this.alipayPublicKey || !params || !params.sign) return false;
    const { sign, sign_type, ...rest } = params;
    const content = buildSignContent(rest);
    const verifier = crypto.createVerify("RSA-SHA256");
    verifier.update(content, "utf8");
    try {
      return verifier.verify(this.alipayPublicKey, sign, "base64");
    } catch {
      return false;
    }
  }

  /**
   * 构造 alipay.trade.page.pay 跳转 URL（PC 网页 / 移动 H5 统一收单）
   */
  createPagePayUrl({ outTradeNo, totalAmount, subject, returnUrl }) {
    const bizContent = {
      out_trade_no: outTradeNo,
      total_amount: Number(totalAmount).toFixed(2),
      subject,
      product_code: "FAST_INSTANT_TRADE_PAY"
    };

    const params = {
      app_id: this.appId,
      method: "alipay.trade.page.pay",
      format: "JSON",
      charset: "utf-8",
      sign_type: "RSA2",
      timestamp: formatTimestamp(),
      version: "1.0",
      return_url: returnUrl,
      biz_content: JSON.stringify(bizContent)
    };
    if (this.notifyUrl) {
      params.notify_url = this.notifyUrl;
    }

    params.sign = this.signParams(params);
    const query = new URLSearchParams(params).toString();
    return `${this.gateway}?${query}`;
  }

  /**
   * 主动调用 alipay.trade.query 查询交易状态（核心对账与防漏单能力）
   */
  async queryTrade(outTradeNo) {
    const params = {
      app_id: this.appId,
      method: "alipay.trade.query",
      format: "JSON",
      charset: "utf-8",
      sign_type: "RSA2",
      timestamp: formatTimestamp(),
      version: "1.0",
      biz_content: JSON.stringify({ out_trade_no: outTradeNo })
    };
    params.sign = this.signParams(params);

    const url = `${this.gateway}?${new URLSearchParams(params).toString()}`;
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) {
      throw new Error(`Alipay gateway HTTP ${res.status}`);
    }
    const data = await res.json();
    const payload = data.alipay_trade_query_response || {};
    return {
      ok: payload.code === "10000",
      code: payload.code,
      msg: payload.msg,
      subCode: payload.sub_code,
      subMsg: payload.sub_msg,
      tradeNo: payload.trade_no || "",
      tradeStatus: payload.trade_status || "UNKNOWN",
      totalAmount: payload.total_amount || "",
      outTradeNo: payload.out_trade_no || outTradeNo
    };
  }
}

module.exports = { AlipayWebPayClient, buildSignContent, formatPem };
