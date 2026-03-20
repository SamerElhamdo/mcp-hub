/**
 * User authentication for MCP Hub multi-tenant mode.
 * Uses JWT for sessions and scrypt for password hashing.
 */

import crypto from "crypto";
import { promisify } from "util";

const scryptAsync = promisify(crypto.scrypt);
const JWT_SECRET = process.env.JWT_SECRET || process.env.MCP_HUB_UI_TOKEN || "mcp-hub-secret-change-in-production";
const TOKEN_EXPIRY = "7d";

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = await scryptAsync(password, salt, 64);
  return `${salt}:${hash.toString("hex")}`;
}

export async function verifyPassword(password, stored) {
  const [salt, hash] = (stored || "").split(":");
  if (!salt || !hash) return false;
  const hashBuf = await scryptAsync(password, salt, 64);
  return hashBuf.toString("hex") === hash;
}

function base64UrlEncode(buf) {
  return Buffer.from(buf).toString("base64url");
}

function signJWT(payload) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const exp = now + (TOKEN_EXPIRY === "7d" ? 7 * 24 * 3600 : 3600);
  const payloadWithExp = { ...payload, iat: now, exp };
  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payloadWithExp));
  const sigInput = `${headerB64}.${payloadB64}`;
  const sig = crypto.createHmac("sha256", JWT_SECRET).update(sigInput).digest();
  return `${sigInput}.${base64UrlEncode(sig)}`;
}

export function verifyJWT(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts;
    const sigInput = `${headerB64}.${payloadB64}`;
    const expectedSig = crypto.createHmac("sha256", JWT_SECRET).update(sigInput).digest();
    const actualSig = Buffer.from(sigB64, "base64url");
    if (!crypto.timingSafeEqual(expectedSig, actualSig)) return null;
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function createSessionToken(user) {
  return signJWT({ sub: user.id, email: user.email });
}

export function getUserFromToken(token) {
  const payload = verifyJWT(token);
  if (!payload || !payload.sub) return null;
  return { id: payload.sub, email: payload.email };
}
