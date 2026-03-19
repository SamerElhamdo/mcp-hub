/**
 * OAuth 2.0 Authorization Server for MCP Hub client authentication.
 * Enables Claude.ai and other OAuth-only clients to connect using MCP_HOST_TOKEN.
 *
 * Flow: Client gets 401 → fetches metadata → OAuth authorize → token exchange → access_token = MCP_HOST_TOKEN
 */
import crypto from "crypto";
import logger from "./logger.js";

// Claude.ai callback patterns - accept exact and subdomains
const ALLOWED_REDIRECT_PATTERNS = [
  /^https:\/\/([a-z0-9-]+\.)?claude\.ai(\/.*)?$/,
  /^https:\/\/([a-z0-9-]+\.)?claude\.com(\/.*)?$/,
];

// In-memory auth codes: { code -> { challenge, redirectUri, expiresAt } }
const authCodes = new Map();
const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function generateCode() {
  return crypto.randomBytes(32).toString("hex");
}

function sha256Base64Url(input) {
  return crypto.createHash("sha256").update(input).digest("base64url");
}

/**
 * Create authorization code for OAuth flow
 */
export function createAuthCode(codeChallenge, codeChallengeMethod, redirectUri, state) {
  const code = generateCode();
  authCodes.set(code, {
    codeChallenge,
    codeChallengeMethod: codeChallengeMethod || "S256",
    redirectUri,
    state,
    expiresAt: Date.now() + CODE_TTL_MS,
  });
  return code;
}

/**
 * Normalize redirect_uri for consistent comparison (handles encoding differences)
 */
function normalizeRedirectUri(uri) {
  if (!uri || typeof uri !== "string") return "";
  try {
    const u = new URL(uri);
    u.searchParams.sort();
    return u.toString();
  } catch {
    return uri;
  }
}

/**
 * Exchange authorization code for access token (MCP_HOST_TOKEN)
 */
export function exchangeCodeForToken(code, codeVerifier, redirectUri, mcpHostToken) {
  const stored = authCodes.get(code);
  if (!stored) return null;
  authCodes.delete(code);

  if (Date.now() > stored.expiresAt) return null;

  const normalizedStored = normalizeRedirectUri(stored.redirectUri);
  const normalizedIncoming = normalizeRedirectUri(redirectUri);
  if (normalizedStored !== normalizedIncoming) return null;

  const expectedChallenge =
    (stored.codeChallengeMethod || "S256") === "S256"
      ? sha256Base64Url(codeVerifier)
      : codeVerifier;
  if (expectedChallenge !== stored.codeChallenge) return null;

  return mcpHostToken;
}

/**
 * Validate redirect_uri against allowlist (Claude.ai, Claude.com, subdomains)
 */
export function isRedirectUriAllowed(uri) {
  if (!uri || typeof uri !== "string") return false;
  return ALLOWED_REDIRECT_PATTERNS.some((pattern) => pattern.test(uri));
}

/**
 * Build WWW-Authenticate header for 401 per RFC 9728
 */
export function getWWWAuthenticateHeader(baseUrl) {
  const base = baseUrl.replace(/\/$/, "");
  const resourceMetadata = `${base}/.well-known/oauth-protected-resource`;
  return `Bearer resource_metadata="${resourceMetadata}"`;
}

/**
 * Get protected resource metadata (RFC 9728)
 */
export function getProtectedResourceMetadata(baseUrl) {
  const base = baseUrl.replace(/\/$/, "");
  const resource = `${base}/mcp`;
  const authServer = `${base}/.well-known/oauth-authorization-server`;
  return {
    resource,
    authorization_servers: [{ uri: authServer }],
  };
}

/**
 * Get authorization server metadata (RFC 8414)
 */
export function getAuthorizationServerMetadata(baseUrl) {
  const base = baseUrl.replace(/\/$/, "");
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    grant_types_supported: ["authorization_code"],
  };
}

