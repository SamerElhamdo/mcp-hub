import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import logger from "./utils/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { MCPHub } from "./MCPHub.js";
import { SSEManager, EventTypes, HubState, SubscriptionTypes } from "./utils/sse-manager.js";
import {
  router,
  registerRoute,
  generateStartupMessage,
} from "./utils/router.js";
import {
  ValidationError,
  ServerError,
  isMCPHubError,
  wrapError,
} from "./utils/errors.js";
import { getMarketplace } from "./marketplace.js";
import { MCPServerEndpoint } from "./mcp/server.js";
import { WorkspaceCacheManager } from "./utils/workspace-cache.js";
import { DbConfigManager } from "./utils/db-config.js";
import {
  createAuthCode,
  exchangeCodeForToken,
  isRedirectUriAllowed,
  getWWWAuthenticateHeader,
  getProtectedResourceMetadata,
  getAuthorizationServerMetadata,
} from "./utils/oauth-client-auth.js";
import {
  initAuthSchema,
  createUser,
  verifyUser,
} from "./utils/db-auth.js";
import { createSessionToken, getUserFromToken } from "./utils/auth.js";

const SERVER_ID = "mcp-hub";

const useMultiUser = () =>
  process.env.DATABASE_URL &&
  (process.env.MCP_HUB_MULTI_USER === "true" || process.env.MCP_HUB_MULTI_USER === "1");

// Auth: paths that skip UI token check (public)
const UI_AUTH_SKIP_PATHS = [
  "/mcp", "/sse", "/messages", "/api/health", "/api/oauth/callback",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-authorization-server",
  "/oauth/authorize",
  "/oauth/token",
  "/oauth/approve",
  "/authorize", "/token", "/register",
  "/api/auth/register", "/api/auth/login",
  "/login", "/register",
  "/oauth/approve-page",
];
const MCP_PATHS = ["/mcp", "/sse", "/messages"];

function getBaseUrl(req) {
  const envUrl = process.env.MCP_HUB_PUBLIC_URL;
  if (envUrl) return envUrl.replace(/\/$/, "");
  const proto = req.get("x-forwarded-proto") || req.protocol || "http";
  const host = req.get("x-forwarded-host") || req.get("host") || `localhost:${process.env.PORT || 3000}`;
  return `${proto}://${host}`;
}

function validateToken(req, token) {
  const authHeader = req.headers.authorization;
  const headerToken = req.headers["x-mcp-hub-token"] || req.headers["x-mcp-host-token"];
  const queryToken = req.query?.token;

  if (queryToken === token) return true;
  if (authHeader?.startsWith("Bearer ") && authHeader.slice(7) === token) return true;
  if (headerToken === token) return true;
  if (authHeader?.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
      const [, password] = decoded.split(":");
      if (password === token) return true;
    } catch (_) {}
  }
  return false;
}

function parseCookie(str) {
  const out = {};
  (str || "").split(";").forEach((part) => {
    const [k, v] = part.trim().split("=");
    if (k && v) out[k] = decodeURIComponent(v);
  });
  return out;
}

function getUserFromRequest(req) {
  const authHeader = req.headers.authorization;
  const token =
    authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : req.headers["x-mcp-hub-session"] || parseCookie(req.headers.cookie)["mcpHubSession"];
  return token ? getUserFromToken(token) : null;
}

function authMiddleware(req, res, next) {
  const mcpHostToken = process.env.MCP_HOST_TOKEN;
  const uiToken = process.env.MCP_HUB_UI_TOKEN;
  const multiUser = useMultiUser();

  // MCP endpoint: require MCP_HOST_TOKEN when set
  if (MCP_PATHS.includes(req.path)) {
    if (!mcpHostToken) return next();
    if (validateToken(req, mcpHostToken)) return next();
    res.setHeader("WWW-Authenticate", getWWWAuthenticateHeader(getBaseUrl(req)));
    return res.status(401).json({ error: "Unauthorized", code: "MCP_AUTH_REQUIRED" });
  }

  // Multi-user: require JWT session
  if (multiUser) {
    if (UI_AUTH_SKIP_PATHS.some((p) => req.path === p || req.path.startsWith(p + "/"))) {
      return next();
    }
    const user = getUserFromRequest(req);
    if (user) {
      req.user = user;
      return next();
    }
    if (req.accepts("json")) {
      return res.status(401).json({ error: "Unauthorized", code: "AUTH_REQUIRED" });
    }
    const returnUrl = encodeURIComponent(req.originalUrl || "/");
    return res.redirect(302, `/login?returnUrl=${returnUrl}`);
  }

  // Legacy: require MCP_HUB_UI_TOKEN when set
  if (!uiToken) return next();
  if (UI_AUTH_SKIP_PATHS.some((p) => req.path === p || req.path.startsWith(p + "/"))) {
    return next();
  }
  if (validateToken(req, uiToken)) return next();

  res.setHeader("WWW-Authenticate", 'Basic realm="MCP Hub"');
  if (req.accepts("json")) {
    res.status(401).json({ error: "Unauthorized", code: "AUTH_REQUIRED" });
  } else {
    res.status(401).send("Unauthorized");
  }
}

// Create Express app
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS for MCP and OAuth endpoints
const CORS_PATHS = ["/mcp", "/sse", "/messages", "/oauth", "/.well-known", "/authorize", "/token", "/register"];
app.use((req, res, next) => {
  if (CORS_PATHS.some((p) => req.path === p || req.path.startsWith(p + "/"))) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-MCP-Host-Token, X-MCP-Hub-Token");
    if (req.method === "OPTIONS") return res.sendStatus(204);
  }
  next();
});

// OAuth 2.0 endpoints for Claude.ai and other OAuth-only clients (when MCP_HOST_TOKEN is set)
app.get("/.well-known/oauth-protected-resource", (req, res) => {
  if (!process.env.MCP_HOST_TOKEN) return res.status(404).end();
  res.json(getProtectedResourceMetadata(getBaseUrl(req)));
});

app.get("/.well-known/oauth-authorization-server", (req, res) => {
  if (!process.env.MCP_HOST_TOKEN) return res.status(404).end();
  res.json(getAuthorizationServerMetadata(getBaseUrl(req)));
});

function renderApprovalPage(params) {
  const { redirect_uri, state, code_challenge, code_challenge_method, error } = params;
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Approve Connection</title><style>body{font-family:system-ui,sans-serif;max-width:400px;margin:2rem auto;padding:1.5rem;background:#f5f5f5}form{background:#fff;padding:1.5rem;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.1)}label{display:block;margin-bottom:.5rem;font-weight:500}input[type=password]{width:100%;padding:.5rem;border:1px solid #ccc;border-radius:4px;box-sizing:border-box}button{width:100%;margin-top:1rem;padding:.6rem;background:#333;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:1rem}button:hover{background:#555}.err{color:#c00;margin-bottom:.5rem;font-size:.9rem}</style></head><body><form method="post" action="/oauth/approve"><input type="hidden" name="redirect_uri" value="${esc(redirect_uri)}"><input type="hidden" name="state" value="${esc(state)}"><input type="hidden" name="code_challenge" value="${esc(code_challenge)}"><input type="hidden" name="code_challenge_method" value="${esc(code_challenge_method)}"><label for="pw">Connection approval password</label>${error ? `<p class="err">${esc(error)}</p>` : ""}<input type="password" id="pw" name="password" placeholder="Enter password" required autofocus><button type="submit">Approve</button></form></body></html>`;
}

function buildApprovalReturnUrl(redirect_uri, state, code_challenge, code_challenge_method) {
  const params = new URLSearchParams({ redirect_uri, code_challenge });
  if (state) params.set("state", state);
  if (code_challenge_method) params.set("code_challenge_method", code_challenge_method);
  return `/oauth/approve-page?${params.toString()}`;
}

app.get("/oauth/authorize", (req, res) => {
  const mcpHostToken = process.env.MCP_HOST_TOKEN;
  if (!mcpHostToken) return res.status(404).end();

  const { redirect_uri, state, code_challenge, code_challenge_method } = req.query;
  if (!redirect_uri || !code_challenge) {
    return res.status(400).json({ error: "invalid_request", error_description: "redirect_uri and code_challenge required" });
  }
  if (!isRedirectUriAllowed(redirect_uri)) {
    return res.status(400).json({ error: "invalid_request", error_description: "redirect_uri not allowed" });
  }

  const approvalPassword = process.env.MCP_OAUTH_APPROVAL_PASSWORD;
  const multiUser = useMultiUser();

  if (approvalPassword) {
    return res.type("html").send(renderApprovalPage({ redirect_uri, state, code_challenge, code_challenge_method }));
  }

  if (multiUser) {
    const user = getUserFromRequest(req);
    if (!user) {
      const returnUrl = buildApprovalReturnUrl(redirect_uri, state, code_challenge, code_challenge_method);
      return res.redirect(302, `/login?returnUrl=${encodeURIComponent(returnUrl)}`);
    }
  }

  const code = createAuthCode(code_challenge, code_challenge_method, redirect_uri, state);
  const url = new URL(redirect_uri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  res.redirect(302, url.toString());
});

app.get("/oauth/approve-page", (req, res) => {
  const mcpHostToken = process.env.MCP_HOST_TOKEN;
  if (!mcpHostToken || !useMultiUser()) return res.status(404).end();

  const { redirect_uri, state, code_challenge, code_challenge_method } = req.query;
  if (!redirect_uri || !code_challenge) {
    return res.status(400).send("Missing redirect_uri or code_challenge");
  }
  if (!isRedirectUriAllowed(redirect_uri)) {
    return res.status(400).send("Invalid redirect_uri");
  }

  const user = getUserFromRequest(req);
  if (!user) {
    const returnUrl = req.originalUrl;
    return res.redirect(302, `/login?returnUrl=${encodeURIComponent(returnUrl)}`);
  }

  const base = getBaseUrl(req);
  const approveUrl = `${base}/api/oauth/approve`;
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  res.type("html").send(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>الموافقة على الاتصال</title><link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap" rel="stylesheet"><style>*{box-sizing:border-box}body{font-family:'IBM Plex Sans Arabic',sans-serif;max-width:420px;margin:3rem auto;padding:2rem;background:linear-gradient(135deg,#0d1117 0%,#161b22 100%);color:#e6edf3;min-height:50vh;display:flex;flex-direction:column;justify-content:center;border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,.4)}h1{font-size:1.5rem;margin-bottom:.5rem;color:#58a6ff}p{color:#8b949e;margin-bottom:1.5rem;font-size:.95rem}form{display:flex;flex-direction:column;gap:1rem}button{padding:.75rem 1.5rem;background:#238636;color:#fff;border:none;border-radius:8px;font-size:1rem;font-weight:600;cursor:pointer;font-family:inherit;transition:background .2s}button:hover{background:#2ea043}.sec{background:transparent;border:1px solid #30363d;color:#8b949e}.sec:hover{background:#21262d;color:#e6edf3}</style></head><body><h1>الموافقة على الاتصال</h1><p>مرحباً، أنت مسجّل الدخول. اضغط الموافقة للسماح لـ Claude أو التطبيق بالاتصال بـ MCP Hub.</p><form id="f" method="post" action="${esc(approveUrl)}"><input type="hidden" name="redirect_uri" value="${esc(redirect_uri)}"><input type="hidden" name="state" value="${esc(state)}"><input type="hidden" name="code_challenge" value="${esc(code_challenge)}"><input type="hidden" name="code_challenge_method" value="${esc(code_challenge_method || "S256")}"><button type="submit">موافقة</button></form><script>var t=localStorage.getItem("mcpHubUiToken");if(t){var f=document.getElementById("f");var inp=document.createElement("input");inp.type="hidden";inp.name="token";inp.value=t;f.appendChild(inp)}</script></body></html>`);
});

app.post("/oauth/approve", (req, res) => {
  const mcpHostToken = process.env.MCP_HOST_TOKEN;
  const approvalPassword = process.env.MCP_OAUTH_APPROVAL_PASSWORD;
  const multiUser = useMultiUser();
  if (!mcpHostToken) return res.status(404).end();

  const { redirect_uri, state, code_challenge, code_challenge_method, password } = req.body || {};
  if (!redirect_uri || !code_challenge) {
    return res.status(400).json({ error: "invalid_request", error_description: "redirect_uri and code_challenge required" });
  }
  if (!isRedirectUriAllowed(redirect_uri)) {
    return res.status(400).json({ error: "invalid_request", error_description: "redirect_uri not allowed" });
  }

  if (approvalPassword) {
    if (password !== approvalPassword) {
      return res.type("html").status(400).send(renderApprovalPage({
        redirect_uri, state, code_challenge, code_challenge_method,
        error: "Incorrect password",
      }));
    }
  } else if (multiUser) {
    const user = getUserFromRequest(req);
    if (!user) {
      const returnUrl = buildApprovalReturnUrl(redirect_uri, state, code_challenge, code_challenge_method);
      return res.redirect(302, `/login?returnUrl=${encodeURIComponent(returnUrl)}`);
    }
  }

  const code = createAuthCode(code_challenge, code_challenge_method, redirect_uri, state);
  const url = new URL(redirect_uri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  res.redirect(302, url.toString());
});

// Claude.ai workaround: ignores metadata and hits /authorize, /token, /register at root
// See: https://github.com/anthropics/claude-ai-mcp/issues/82
app.get("/authorize", (req, res) => {
  const base = getBaseUrl(req);
  const qs = new URLSearchParams(req.query).toString();
  res.redirect(302, `${base}/oauth/authorize${qs ? `?${qs}` : ""}`);
});

const handleTokenExchange = (req, res) => {
  const mcpHostToken = process.env.MCP_HOST_TOKEN;
  if (!mcpHostToken) return res.status(404).end();
  const body = req.body || {};
  const { grant_type, code, code_verifier, redirect_uri } = { ...body, ...req.query };
  if (grant_type !== "authorization_code" || !code || !code_verifier || !redirect_uri) {
    return res.status(400).json({ error: "invalid_request", error_description: "grant_type, code, code_verifier, redirect_uri required" });
  }
  const accessToken = exchangeCodeForToken(code, code_verifier, redirect_uri, mcpHostToken);
  if (!accessToken) {
    logger.debug("OAuth token exchange failed", { code: !!code, hasVerifier: !!code_verifier });
    return res.status(400).json({ error: "invalid_grant", error_description: "Invalid or expired authorization code" });
  }
  res.json({ access_token: accessToken, token_type: "bearer", expires_in: 3600 });
};
app.post("/oauth/token", handleTokenExchange);
app.post("/token", handleTokenExchange);

// Minimal DCR for Claude.ai (returns client_id for public client)
app.post("/register", (req, res) => {
  if (!process.env.MCP_HOST_TOKEN) return res.status(404).end();
  const body = req.body || {};
  const clientId = `mcp-hub-${Math.random().toString(36).slice(2, 12)}`;
  res.status(201).json({
    client_id: clientId,
    client_secret_expires_at: 0,
    redirect_uris: body.redirect_uris || [],
  });
});

// Protect UI and API when MCP_HUB_UI_TOKEN is set
app.use(authMiddleware);

app.use("/api", router);

// Serve Web UI - resolve path for both dev (src/) and prod (dist/)
const publicPath = path.join(__dirname, "..", "public");
app.use("/", express.static(publicPath));
app.get(["/login", "/register"], (req, res) => {
  res.sendFile(path.join(publicPath, "index.html"));
});

// Helper to determine HTTP status code from error type
function getStatusCode(error) {
  if (error instanceof ValidationError) return 400;
  if (error instanceof ServerError) return 500;
  if (error.code === "SERVER_NOT_FOUND") return 404;
  if (error.code === "SERVER_NOT_CONNECTED") return 503;
  if (error.code === "TOOL_NOT_FOUND" || error.code === "RESOURCE_NOT_FOUND")
    return 404;
  return 500;
}

let serviceManager = null;
let marketplace = null;
let mcpServerEndpoint = null;

class ServiceManager {
  constructor(options = {}) {
    this.config = options.config;
    this.port = options.port;
    this.autoShutdown = options.autoShutdown;
    this.shutdownDelay = options.shutdownDelay;
    this.watch = options.watch;
    this.databaseUrl = options.databaseUrl;
    this.mcpHub = null;
    this.server = null;
    this.workspaceCache = new WorkspaceCacheManager(options);
    this.sseManager = new SSEManager({
      ...options,
      workspaceCache: this.workspaceCache,
      port: this.port
    });
    this.state = 'starting';
    // Connect logger to SSE manager
    logger.setSseManager(this.sseManager);
  }
  isReady() {
    return this.state === HubState.READY
  }

  getState(extraData = {}) {
    return {
      state: this.state,
      server_id: SERVER_ID,
      pid: process.pid,
      port: this.port,
      timestamp: new Date().toISOString(),
      ...extraData
    }
  }

  setState(newState, extraData) {
    this.state = newState;
    this.broadcastHubState(extraData);

    // Emit state change event via MCPHub for MCP endpoint to sync tools
    if (this.mcpHub) {
      this.mcpHub.emit('hubStateChanged', { state: newState, extraData });
    }
  }

  /**
   * Broadcasts current hub state to all clients
   * @private
   */
  broadcastHubState(extraData = {}) {
    this.sseManager.broadcast(EventTypes.HUB_STATE, this.getState(extraData));
  }

  broadcastSubscriptionEvent(eventType, data = {}) {
    this.sseManager.broadcast(EventTypes.SUBSCRIPTION_EVENT, {
      type: eventType,
      ...data
    });
  }

  async initializeMCPHub() {
    // Initialize workspace cache first
    logger.info("Initializing workspace cache");
    await this.workspaceCache.initialize();
    await this.workspaceCache.register(this.port, this.databaseUrl ? ["postgresql"] : this.config);
    await this.workspaceCache.startWatching();

    // Setup workspace cache event handlers
    this.workspaceCache.on('workspacesUpdated', (workspaces) => {
      this.broadcastSubscriptionEvent(SubscriptionTypes.WORKSPACES_UPDATED, { workspaces });
    });

    // Initialize marketplace second
    logger.info("Initializing marketplace catalog");
    marketplace = getMarketplace();
    await marketplace.initialize();
    logger.info(`Marketplace initialized with ${marketplace.cache.registry?.servers?.length || 0}`);

    // Then initialize MCP Hub
    logger.info("Initializing MCP Hub");
    let configManager = null;
    if (this.databaseUrl) {
      const multiUser = useMultiUser();
      if (multiUser) {
        await initAuthSchema(this.databaseUrl);
      }
      logger.info("Using PostgreSQL for config storage", { multiUser: !!multiUser });
      configManager = new DbConfigManager(this.databaseUrl, multiUser);
    }
    this.mcpHub = new MCPHub(this.config, {
      watch: this.watch,
      port: this.port,
      marketplace,
      configManager,
    });

    // Setup event handlers
    this.mcpHub.on("configChangeDetected", (data) => {
      this.broadcastSubscriptionEvent(SubscriptionTypes.CONFIG_CHANGED, data)
    });

    // Setup event handlers
    this.mcpHub.on("importantConfigChanged", (changes) => {
      this.broadcastSubscriptionEvent(SubscriptionTypes.SERVERS_UPDATING, { changes })
    });
    this.mcpHub.on("importantConfigChangeHandled", (changes) => {
      this.broadcastSubscriptionEvent(SubscriptionTypes.SERVERS_UPDATED, { changes })
    });

    // Server-specific events
    this.mcpHub.on("toolsChanged", (data) => {
      this.broadcastSubscriptionEvent(SubscriptionTypes.TOOL_LIST_CHANGED, data)
    });

    this.mcpHub.on("resourcesChanged", (data) => {
      this.broadcastSubscriptionEvent(SubscriptionTypes.RESOURCE_LIST_CHANGED, data)
    });

    this.mcpHub.on("promptsChanged", (data) => {
      this.broadcastSubscriptionEvent(SubscriptionTypes.PROMPT_LIST_CHANGED, data)
    });

    // Dev mode event handlers
    this.mcpHub.on("devServerRestarting", (data) => {
      this.broadcastSubscriptionEvent(SubscriptionTypes.SERVERS_UPDATING, data);
    });
    this.mcpHub.on("devServerRestarted", (data) => {
      this.broadcastSubscriptionEvent(SubscriptionTypes.SERVERS_UPDATED, data);
    });

    // Initialize MCP server endpoint
    try {
      mcpServerEndpoint = new MCPServerEndpoint(this.mcpHub);
      logger.info(`Hub endpoint ready: Use \`${mcpServerEndpoint.getEndpointUrl()}\` endpoint with any other MCP clients`);
    } catch (error) {
      logger.error("MCP_ENDPOINT_INIT_ERROR", "Failed to initialize MCP server endpoint", {
        error: error.message
      }, false);
    }

    await this.mcpHub.initialize();
    this.setState(HubState.READY)
  }

  async restartHub() {
    if (this.mcpHub) {
      this.setState(HubState.RESTARTING)
      logger.info("Restarting MCP Hub");
      await this.mcpHub.initialize(true);
      logger.info("MCP Hub restarted successfully");
      this.setState(HubState.RESTARTED, { has_restarted: true })
    }
  }

  async startServer() {
    return new Promise((resolve, reject) => {
      logger.info(`Starting HTTP server on port ${this.port}`, {
        port: this.port,
      });

      //INFO: this doesn't throw EADDRINUSE in express@v5 but is thrown inside on("error")
      this.server = app.listen(this.port, () => {
        logger.info("HTTP_SERVER_STARTED");
        resolve();
      });

      this.server.on("error", (error) => {
        this.setState(HubState.ERROR, { message: error.message, code: error.code })
        logger.info(`HTTP_SERVER_START_ERROR: ${error.code}: ${error.message}`);
        reject(
          wrapError(error, "HTTP_SERVER_ERROR", {
            port: this.port,
          })
        );
      });
    });
  }

  async stopServer() {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        logger.warn(
          "HTTP server is already stopped and cannot be stopped again"
        );
        resolve();
        return;
      }

      logger.info("Stopping HTTP server and closing all connections");
      this.server.close((error) => {
        if (error) {
          logger.error(
            "SERVER_STOP_ERROR",
            "Failed to stop HTTP server",
            {
              error: error.message,
              stack: error.stack,
            },
            false
          );
          reject(wrapError(error, "SERVER_STOP_ERROR"));
          return;
        }

        logger.info("HTTP server has been successfully stopped");
        this.server = null;
        resolve();
      });
    });
  }

  async stopMCPHub() {
    if (!this.mcpHub) {
      logger.warn("MCP Hub is already stopped and cannot be stopped again");
      return;
    }

    logger.info("Stopping MCP Hub and cleaning up resources");
    try {
      await this.mcpHub.cleanup();
      logger.info("MCP Hub has been successfully stopped and cleaned up");
      this.mcpHub = null;
    } catch (error) {
      logger.error(
        "HUB_STOP_ERROR",
        "Failed to stop MCP Hub",
        {
          error: error.message,
          stack: error.stack,
        },
        false
      );
    }
  }

  setupSignalHandlers() {
    const shutdown = (signal) => async () => {
      logger.info(`Received ${signal} signal - initiating graceful shutdown`, {
        signal,
      });
      try {
        await this.shutdown();
        logger.info("Graceful shutdown completed successfully");
        process.exit(0);
      } catch (error) {
        logger.error(
          "SHUTDOWN_ERROR",
          "Shutdown failed",
          {
            error: error.message,
            stack: error.stack,
          },
          true,
          1
        );
      }
    };

    process.on("SIGTERM", shutdown("SIGTERM"));
    process.on("SIGINT", shutdown("SIGINT"));
  }

  async shutdown() {
    this.setState(HubState.STOPPING)
    logger.info("Starting graceful shutdown process");

    // Close MCP server endpoint
    if (mcpServerEndpoint) {
      try {
        await mcpServerEndpoint.close();
        mcpServerEndpoint = null;
      } catch (error) {
        logger.debug(`Error closing MCP server endpoint: ${error.message}`);
      }
    }

    //INFO:Sometimes this might take some time, keeping the process alive, this might cause issue when restarting 
    //INFO: MUST catch the error here to avoid unhandled rejection, which will again call shutdown() leading to infinite loop
    this.stopServer().catch((error) => {
      // Mostly happens when the server is already stopped (race condition)
      logger.debug(`Error stopping HTTP server: ${error.message}`);
    })
    await Promise.allSettled([
      this.stopMCPHub(),
      this.sseManager.shutdown(),
      this.workspaceCache.shutdown()
    ]);
    this.setState(HubState.STOPPED)
  }
}

// Auth routes (multi-user mode only, public)
registerRoute("POST", "/auth/register", "Register new user", async (req, res) => {
  if (!useMultiUser()) {
    throw new ValidationError("Registration not available in single-tenant mode");
  }
  const { email, password } = req.body || {};
  if (!email || !password) {
    throw new ValidationError("email and password required");
  }
  const emailStr = String(email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailStr)) {
    throw new ValidationError("Invalid email format");
  }
  if (String(password).length < 6) {
    throw new ValidationError("Password must be at least 6 characters");
  }
  try {
    const user = await createUser(process.env.DATABASE_URL, emailStr, password);
    const token = createSessionToken(user);
    const isSecure = (req.get("x-forwarded-proto") || req.protocol) === "https";
    res.setHeader(
      "Set-Cookie",
      `mcpHubSession=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${isSecure ? "; Secure" : ""}`
    );
    res.status(201).json({ token, user: { id: user.id, email: user.email } });
  } catch (e) {
    if (e?.code === "23505") {
      throw new ValidationError("البريد مسجّل مسبقاً");
    }
    throw e;
  }
});

registerRoute("POST", "/auth/login", "Login user", async (req, res) => {
  if (!useMultiUser()) {
    throw new ValidationError("Login not available in single-tenant mode");
  }
  const { email, password } = req.body || {};
  if (!email || !password) {
    throw new ValidationError("email and password required");
  }
  const user = await verifyUser(process.env.DATABASE_URL, email, password);
  if (!user) {
    throw new ValidationError("Invalid email or password");
  }
  const token = createSessionToken(user);
  const isSecure = (req.get("x-forwarded-proto") || req.protocol) === "https";
  res.setHeader(
    "Set-Cookie",
    `mcpHubSession=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${isSecure ? "; Secure" : ""}`
  );
  res.json({ token, user: { id: user.id, email: user.email } });
});

registerRoute("GET", "/auth/me", "Get current user", async (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  res.json({ user });
});

// Register SSE endpoint
registerRoute("GET", "/events", "Subscribe to server events", async (req, res) => {
  try {
    if (!serviceManager?.sseManager) {
      throw new ServerError("SSE manager not initialized");
    }
    // Add client connection
    const connection = await serviceManager.sseManager.addConnection(req, res);
    // Send initial state
    connection.send(EventTypes.HUB_STATE, serviceManager.getState());
  } catch (error) {
    logger.error('SSE_SETUP_ERROR', 'Failed to setup SSE connection', {
      error: error.message,
      stack: error.stack
    });

    // Ensure response is ended
    if (!res.writableEnded) {
      res.status(500).end();
    }
  }
});

// Register MCP SSE endpoint (/mcp and /sse for clients that expect either)
app.get(["/mcp", "/sse"], async (req, res) => {
  try {
    if (!mcpServerEndpoint) {
      throw new ServerError("MCP server endpoint not initialized");
    }
    await mcpServerEndpoint.handleSSEConnection(req, res);
  } catch (error) {
    logger.warn(`Failed to setup MCP SSE connection: ${error.message}`)
    if (!res.headersSent) {
      res.status(500).send('Error establishing MCP connection');
    }
  }
});

// Register MCP messages endpoint
app.post("/messages", async (req, res) => {
  try {
    if (!mcpServerEndpoint) {
      throw new ServerError("MCP server endpoint not initialized");
    }
    await mcpServerEndpoint.handleMCPMessage(req, res);
  } catch (error) {
    logger.warn('Failed to handle MCP message');
    if (!res.headersSent) {
      res.status(500).send('Error handling MCP message');
    }
  }
});

// Register marketplace endpoints
registerRoute(
  "GET",
  "/marketplace",
  "Get marketplace catalog with filtering and sorting",
  async (req, res) => {
    const { search, category, tags, sort } = req.query;
    try {
      const servers = await marketplace.getCatalog({
        search,
        category,
        tags: tags ? tags.split(",") : undefined,
        sort,
      });
      res.json({
        servers,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      throw wrapError(error, "MARKETPLACE_ERROR", {
        query: req.query,
      });
    }
  }
);

registerRoute(
  "POST",
  "/marketplace/details",
  "Get detailed server information",
  async (req, res) => {
    const { mcpId } = req.body;
    try {
      if (!mcpId) {
        throw new ValidationError("Missing mcpId in request body");
      }

      const details = await marketplace.getServerDetails(mcpId);
      if (!details) {
        throw new ValidationError("Server not found", { mcpId });
      }

      res.json({
        server: details,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      throw wrapError(error, "MARKETPLACE_ERROR", {
        mcpId: req.body.mcpId,
      });
    }
  }
);

// Config endpoints for Web UI
registerRoute(
  "GET",
  "/config",
  "Get current config for editing",
  async (req, res) => {
    try {
      const configManager = serviceManager?.mcpHub?.configManager;
      const useDatabase = configManager?.useDatabase;
      const configPaths = configManager?.configPaths;
      const canEdit = useDatabase || (configPaths && configPaths.length > 0);

      let config;
      if (useMultiUser() && req.user) {
        config = await configManager.getConfigForUser(req.user.id);
      } else {
        config = configManager?.getConfig() || { mcpServers: {} };
      }

      res.json({
        config: config || { mcpServers: {} },
        configPath: useDatabase ? "postgresql" : configPaths?.[0] || null,
        canEdit,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      throw wrapError(error, "CONFIG_READ_ERROR");
    }
  }
);

registerRoute(
  "POST",
  "/config",
  "Save config and restart hub",
  async (req, res) => {
    const { mcpServers } = req.body;
    try {
      if (!mcpServers || typeof mcpServers !== "object") {
        throw new ValidationError("Missing or invalid mcpServers in request body");
      }
      const configManager = serviceManager?.mcpHub?.configManager;
      const canSave = configManager?.useDatabase || (configManager?.configPaths?.length > 0);
      if (!canSave) {
        throw new ValidationError("Config is not file or database based; cannot save from UI");
      }
      if (useMultiUser() && req.user) {
        await configManager.saveConfigForUser(req.user.id, { mcpServers });
      } else {
        await configManager.saveConfig({ mcpServers });
      }
      await serviceManager.restartHub();
      res.json({
        status: "ok",
        message: "Config saved and hub restarted",
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      throw wrapError(error, "CONFIG_SAVE_ERROR");
    }
  }
);

// Register workspaces endpoint
registerRoute(
  "GET",
  "/workspaces",
  "Get all active workspaces",
  async (req, res) => {
    try {
      const workspaces = await serviceManager.workspaceCache.getActiveWorkspaces();
      res.json({
        workspaces,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      throw wrapError(error, "WORKSPACE_ERROR", {
        operation: "list_workspaces",
      });
    }
  }
);

// Register server start endpoint
registerRoute(
  "POST",
  "/servers/start",
  "Start a server",
  async (req, res) => {
    const { server_name } = req.body;
    try {
      if (!server_name) {
        throw new ValidationError("Missing server name", { field: "server_name" });
      }
      const status = await serviceManager.mcpHub.startServer(server_name);
      res.json({
        status: "ok",
        server: status,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      throw wrapError(error, "SERVER_START_ERROR", { server: server_name });
    } finally {
      serviceManager.broadcastSubscriptionEvent(SubscriptionTypes.SERVERS_UPDATED, {
        changes: {
          modified: [server_name],
        }
      })
    }
  }
);

// Register server stop endpoint
registerRoute(
  "POST",
  "/servers/stop",
  "Stop a server",
  async (req, res) => {
    const { server_name } = req.body;
    try {
      if (!server_name) {
        throw new ValidationError("Missing server name", { field: "server_name" });
      }
      const { disable } = req.query;
      const status = await serviceManager.mcpHub.stopServer(
        server_name,
        disable === "true"
      );
      res.json({
        status: "ok",
        server: status,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      throw wrapError(error, "SERVER_STOP_ERROR", { server: server_name });
    } finally {
      serviceManager.broadcastSubscriptionEvent(SubscriptionTypes.SERVERS_UPDATED, {
        changes: {
          modified: [server_name],
        }
      })
    }
  }
);

// Register health check endpoint
registerRoute("GET", "/health", "Check server health", async (req, res) => {
  const healthData = {
    status: "ok",
    state: serviceManager?.state || HubState.STARTING,
    server_id: SERVER_ID,
    version: process.env.VERSION,
    activeClients: serviceManager?.sseManager?.connections.size || 0,
    timestamp: new Date().toISOString(),
    servers: serviceManager?.mcpHub?.getAllServerStatuses() || [],
    connections: serviceManager?.sseManager?.getStats() || { totalConnections: 0, connections: [] }
  };

  // Add MCP endpoint stats if available
  if (mcpServerEndpoint) {
    healthData.mcpEndpoint = mcpServerEndpoint.getStats();
  }

  // Add workspace information if available
  if (serviceManager?.workspaceCache) {
    try {
      healthData.workspaces = {
        current: serviceManager.workspaceCache.getWorkspaceKey(),
        allActive: await serviceManager.workspaceCache.getActiveWorkspaces()
      };
    } catch (error) {
      logger.debug(`Failed to get workspace info for health check: ${error.message}`);
    }
  }

  res.json(healthData);
});

// Register server list endpoint
registerRoute(
  "GET",
  "/servers",
  "List all MCP servers and their status",
  (req, res) => {
    const servers = serviceManager.mcpHub.getAllServerStatuses();
    res.json({
      servers,
      timestamp: new Date().toISOString(),
    });
  }
);

// Register server info endpoint
registerRoute(
  "POST",
  "/servers/info",
  "Get status of a specific server",
  (req, res) => {
    const { server_name } = req.body;
    try {
      if (!server_name) {
        throw new ValidationError("Missing server name", { field: "server_name" });
      }
      const status = serviceManager.mcpHub.getServerStatus(server_name
      );
      res.json({
        server: status,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      throw wrapError(error, "SERVER_NOT_FOUND", {
        server: server_name
      });
    }
  }
);

// Reloads the config file, disconnects all existing servers, and reconnects servers from the new config
registerRoute("POST", "/restart", "Restart MCP Hub", async (req, res) => {
  try {
    await serviceManager.restartHub();
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    throw wrapError(error, "HUB_RESTART_ERROR");
  }
})

// Sends a hard-restarting signal to all the clients. ON receiving clients should kill the process and start it again
// This is needed in order to load the latest process.env
// For usual restarts use the /restart endpoint
registerRoute("POST", "/hard-restart", "Hard Restart MCP Hub", async (req, res) => {
  try {

    if (serviceManager.mcpHub) {
      serviceManager.setState(HubState.RESTARTING)
      process.emit('SIGTERM')
    }
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    throw wrapError(error, "HUB_HARD_RESTART_ERROR");
  }
})

// Register server refresh endpoint
registerRoute(
  "POST",
  "/servers/refresh",
  "Refresh a server's capabilities",
  async (req, res) => {
    const { server_name } = req.body;
    try {
      if (!server_name) {
        throw new ValidationError("Missing server name", { field: "server_name" });
      }
      const info = await serviceManager.mcpHub.refreshServer(server_name);
      res.json({
        status: "ok",
        server: info,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      throw wrapError(error, "SERVER_REFRESH_ERROR", { server: server_name });
    }
  }
);

// Register all servers refresh endpoint
registerRoute(
  "GET",
  "/refresh",
  "Refresh all servers' capabilities",
  async (req, res) => {
    try {
      const results = await serviceManager.mcpHub.refreshAllServers();
      res.json({
        status: "ok",
        servers: results,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      throw wrapError(error, "SERVERS_REFRESH_ERROR");
    }
  }
);

//Register prompt endpoint

registerRoute(
  "POST",
  "/servers/prompts",
  "Get a prompt from a specific server",
  async (req, res) => {

    const { server_name, prompt, arguments: args, request_options } = req.body;
    try {

      if (!server_name) {
        throw new ValidationError("Missing server name", { field: "server_name" });
      }
      if (!prompt) {
        throw new ValidationError("Missing prompt name", { field: "prompt" });
      }
      const result = await serviceManager.mcpHub.getPrompt(
        server_name,
        prompt,
        args || {},
        request_options
      );
      res.json({
        result,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      throw wrapError(error, error.code || "PROMPT_EXECUTION_ERROR", {
        server: server_name,
        prompt,
        ...(error.data || {}),
      });
    }
  }
)



// Register tool execution endpoint
registerRoute(
  "POST",
  "/servers/tools",
  "Execute a tool on a specific server",
  async (req, res) => {

    const { server_name, tool, arguments: args, request_options } = req.body;
    try {

      if (!server_name) {
        throw new ValidationError("Missing server name", { field: "server_name" });
      }
      if (!tool) {
        throw new ValidationError("Missing tool name", { field: "tool" });
      }
      const result = await serviceManager.mcpHub.callTool(
        server_name,
        tool,
        args || {},
        request_options
      );
      res.json({
        result,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      throw wrapError(error, error.code || "TOOL_EXECUTION_ERROR", {
        server: server_name,
        tool,
        ...(error.data || {}),
      });
    }
  }
);

// Register resource access endpoint
registerRoute(
  "POST",
  "/servers/resources",
  "Access a resource on a specific server",
  async (req, res) => {

    const { server_name, uri, request_options } = req.body;
    try {

      if (!server_name) {
        throw new ValidationError("Missing server name", { field: "server_name" });
      }

      if (!uri) {
        throw new ValidationError("Missing resource URI", { field: "uri" });
      }
      const result = await serviceManager.mcpHub.readResource(server_name, uri, request_options);
      res.json({
        result,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      throw wrapError(error, error.code || "RESOURCE_READ_ERROR", {
        server: server_name,
        uri,
        ...(error.data || {}),
      });
    }
  }
);


registerRoute(
  "POST",
  "/servers/authorize",
  "Handles opening different kinds of uris",
  async (req, res) => {
    const { server_name } = req.body;
    try {
      if (!server_name) {
        throw new ValidationError("Missing server name", { field: "server_name" });
      }
      const connection = serviceManager.mcpHub.getConnection(server_name)
      const result = await connection.authorize()
      res.json(result);
    } catch (error) {
      throw wrapError(error, "OPEN_REQUEST_ERROR", error.data || {});
    }
  }
)

//For cases where mcp-hub is running on a remote system and the oauth callback points to localhost
registerRoute(
  "POST",
  "/oauth/manual_callback",
  "Handle OAuth callback for manual authorization",
  async (req, res) => {
    let code, server_name
    try {

      const { url } = req.body || {}
      if (!url) {
        throw new ValidationError("Missing URL parameter", { field: "url" });
      }
      const url_with_code = new URL(url)
      if (url_with_code.searchParams.has('code')) {
        code = url_with_code.searchParams.get('code')
      }
      if (url_with_code.searchParams.has('server_name')) {
        server_name = url_with_code.searchParams.get('server_name')
      }
      if (!code || !server_name) {
        throw new ValidationError("Missing code or server_name parameter");
      }
      //simulate delay
      // await new Promise(resolve => setTimeout(resolve, 3000));
      const connection = serviceManager.mcpHub.getConnection(server_name);
      await connection.handleAuthCallback(code)
      // // Still broadcast the update for consistency
      serviceManager.broadcastSubscriptionEvent(SubscriptionTypes.SERVERS_UPDATED, {
        changes: {
          modified: [server_name],
        }
      });
      return res.json({
        status: "ok",
        message: `Authorization successful for server '${server_name}'`,
        server_name,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      throw wrapError(error, "MANUAL_OAUTH_CALLBACK_ERROR", {
        url: req.body?.url || null,
      });
    }
  }
)
registerRoute(
  "GET",
  "/oauth/callback",
  "Handle OAuth callback",
  async (req, res) => {
    const { code, server_name } = req.query;

    try {
      if (!code || !server_name) {
        throw new ValidationError("Missing code or server_name parameter");
      }
      // Send initial processing page
      res.write(`
        <html>
          <head>
            <title>MCP HUB</title>
            <style>
              body { font-family: Arial, sans-serif; text-align: center; margin-top: 50px; }
              .loader { border: 5px solid #f3f3f3; border-top: 5px solid #3498db; border-radius: 50%; width: 50px; height: 50px; animation: spin 1s linear infinite; margin: 20px auto; }
              @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
              .hidden { display: none; }
              .message { margin: 20px 0; font-size: 18px; }
            </style>
            <script>
              function updateStatus(status, message) {
                document.getElementById('processing').style.display = status === 'processing' ? 'block' : 'none';
                document.getElementById('success').style.display = status === 'success' ? 'block' : 'none';
                document.getElementById('error').style.display = status === 'error' ? 'block' : 'none';
                if (message) {
                  document.getElementById('errorMessage').textContent = message;
                }
              }
            </script>
          </head>
          <body>
            <div id="processing">
              <h1>MCP HUB</h1>
              <h2><code>${server_name}<code> Authorization Processing</h2>
              <div class="loader"></div>
              <p class="message">Please wait while mcp-hub completes the authorization...</p>
            </div>
            <div id="success" class="hidden">
              <h1>MCP HUB</h1>
              <h2><code>${server_name}<code> Authorization Successful</h2>
              <p class="message">Your server has been authorized successfully!</p>
              <p>You can close this window and return to the application.</p>
            </div>
            <div id="error" class="hidden">
              <h1>MCP HUB</h1>
              <h2><code>${server_name}<code> Authorization Failed</h2>
              <p class="message">An error occurred during authorization:</p>
              <p id="errorMessage" style="color: red;"></p>
              <p class="message">For errors like 'fetch failed' (serverless hosting might take time to startup), stopping and starting the MCP Server should help. </p>
            </div>
          </body>
        </html>
      `);

      const connection = serviceManager.mcpHub.getConnection(server_name);

      await connection.handleAuthCallback(code)
      res.write('<script>updateStatus("success");</script>');

    } catch (error) {
      logger.error('OAUTH_CALLBACK_ERROR', `Error during OAuth callback: ${error.message}`, {}, false)
      res.write(`<script>updateStatus("error", "${error.message.replace(/"/g, '\\"')}");</script>`);
    } finally {
      // Still broadcast the update for consistency
      serviceManager.broadcastSubscriptionEvent(SubscriptionTypes.SERVERS_UPDATED, {
        changes: {
          modified: [server_name],
        }
      });
      res.end();
    }
  }
);



// Error handler middleware
router.use((err, req, res, next) => {
  // Determine if it's our custom error or needs wrapping
  const error = isMCPHubError(err)
    ? err
    : wrapError(err, "REQUEST_ERROR", {
      path: req.path,
      method: req.method,
    });

  // Only send error response if headers haven't been sent
  if (!res.headersSent) {
    res.status(getStatusCode(error)).json({
      error: error.message,
      code: error.code,
      data: error.data,
      timestamp: new Date().toISOString(),
    });
  }
});

// Start the server with options
export async function startServer(options = {}) {
  serviceManager = new ServiceManager({
    ...options,
    databaseUrl: options.databaseUrl || process.env.DATABASE_URL,
  });

  try {
    serviceManager.setupSignalHandlers();

    // Start HTTP server first to fail fast on port conflicts
    await serviceManager.startServer();

    // Then initialize MCP Hub
    await serviceManager.initializeMCPHub();
  } catch (error) {
    const wrappedError = wrapError(error, error.code || "SERVER_START_ERROR");
    try {
      this.setState(HubState.ERROR, {
        message: wrappedError.message,
        code: wrappedError.code,
        data: wrappedError.data,
      })
      await serviceManager.shutdown()
    } catch (e) {
    } finally {
      logger.error(
        wrappedError.code,
        wrappedError.message,
        wrappedError.data,
        true,
        1
      );
    }
  }
}

export default app;
