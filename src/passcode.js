"use strict";

const crypto = require("crypto");

const PASSCODE_DOMAIN = "detone:passcode:v1:";
const USER_ID_RE = /^u_([0-9a-f]{24})$/i;

function formatPasscode(rawHex24, sigHex12) {
  const h = rawHex24.toUpperCase();
  const s = sigHex12.toUpperCase();
  return `DTN-${h.slice(0, 8)}-${h.slice(8, 16)}-${h.slice(16, 24)}-${s}`;
}

function computeSignatureHex(userId, secret) {
  return crypto
    .createHmac("sha256", String(secret))
    .update(`${PASSCODE_DOMAIN}${userId.toLowerCase()}`)
    .digest("hex")
    .slice(0, 12);
}

function issuePasscode(userId, secret) {
  if (!secret || String(secret).trim().length < 16) return null;
  const m = String(userId || "").match(USER_ID_RE);
  if (!m) return null;
  const normalizedUid = `u_${m[1].toLowerCase()}`;
  const sig = computeSignatureHex(normalizedUid, secret);
  return formatPasscode(m[1], sig);
}

function verifyPasscode(input, secret) {
  if (!secret || String(secret).trim().length < 16) {
    return { valid: false, reason: "secret_not_configured" };
  }
  const cleaned = String(input || "").trim().toUpperCase();
  const body = cleaned.replace(/^DTN-?/, "").replace(/[\s-]+/g, "");
  if (!/^[0-9A-F]{36}$/.test(body)) {
    return { valid: false, reason: "invalid_format" };
  }
  const rawHex24 = body.slice(0, 24).toLowerCase();
  const providedSig = body.slice(24, 36).toLowerCase();
  const userId = `u_${rawHex24}`;
  const expectedSig = computeSignatureHex(userId, secret);

  const a = Buffer.from(providedSig, "utf8");
  const b = Buffer.from(expectedSig, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { valid: false, reason: "invalid_signature" };
  }
  return {
    valid: true,
    userId,
    passcode: formatPasscode(rawHex24, expectedSig)
  };
}

module.exports = {
  PASSCODE_DOMAIN,
  issuePasscode,
  verifyPasscode
};
