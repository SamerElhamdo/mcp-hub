/**
 * PostgreSQL-backed configuration storage for MCP Hub.
 * Stores mcpServers and their env/headers in PostgreSQL.
 */

import pg from "pg";
import { EventEmitter } from "events";
import logger from "./logger.js";
import { ConfigError, wrapError } from "./errors.js";
import deepEqual from "fast-deep-equal";

const { Pool } = pg;

// Legacy table (single-tenant)
const INIT_SQL = `
CREATE TABLE IF NOT EXISTS mcp_servers (
  name TEXT PRIMARY KEY,
  config JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mcp_servers_updated ON mcp_servers(updated_at);
`;

// Multi-tenant: per-user config (users table must exist from db-auth)
const INIT_USER_SERVERS_SQL = `
CREATE TABLE IF NOT EXISTS user_mcp_servers (
  user_id UUID NOT NULL,
  name TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_user_mcp_servers_user ON user_mcp_servers(user_id);
`;

const KEY_FIELDS = ['command', 'args', 'env', 'disabled', 'url', 'headers', 'dev', 'name', 'cwd'];

export class DbConfigManager extends EventEmitter {
  #pool = null;
  #config = null;
  #previousConfig = null;
  #useMultiUser = false;

  constructor(databaseUrl, useMultiUser = false) {
    super();
    this.databaseUrl = databaseUrl;
    this.configPaths = null;
    this.useDatabase = true;
    this.#useMultiUser = useMultiUser;
  }

  async #getPool() {
    if (!this.#pool) {
      this.#pool = new Pool({
        connectionString: this.databaseUrl,
        max: 5,
        idleTimeoutMillis: 30000,
      });
    }
    return this.#pool;
  }

  async #initSchema() {
    const pool = await this.#getPool();
    await pool.query(INIT_SQL);
    if (this.#useMultiUser) {
      await pool.query(INIT_USER_SERVERS_SQL);
    }
    logger.debug("Database schema initialized", { multiUser: this.#useMultiUser });
  }

  #diffConfigs(oldServers = {}, newServers = {}) {
    const changes = { added: [], removed: [], modified: [], unchanged: [], details: {} };
    Object.keys(oldServers || {}).forEach((name) => {
      if (!newServers[name]) changes.removed.push(name);
    });
    Object.entries(newServers).forEach(([name, newConfig]) => {
      if (!oldServers?.[name]) {
        changes.added.push(name);
      } else {
        const modifiedFields = KEY_FIELDS.filter((field) => {
          if (!oldServers[name].hasOwnProperty(field) && !newConfig.hasOwnProperty(field)) return false;
          if (!oldServers[name].hasOwnProperty(field) || !newConfig.hasOwnProperty(field)) return true;
          if (['args', 'env', 'headers', 'dev'].includes(field)) {
            return !deepEqual(oldServers[name][field], newConfig[field]);
          }
          return oldServers[name][field] !== newConfig[field];
        });
        if (modifiedFields.length > 0) {
          changes.modified.push(name);
          changes.details[name] = { modifiedFields };
        } else {
          changes.unchanged.push(name);
        }
      }
    });
    return changes;
  }

  async loadConfig() {
    try {
      await this.#initSchema();
      const pool = await this.#getPool();
      let rows;
      if (this.#useMultiUser) {
        const r = await pool.query(
          "SELECT name, config FROM user_mcp_servers ORDER BY name"
        );
        rows = r.rows;
      } else {
        const r = await pool.query("SELECT name, config FROM mcp_servers ORDER BY name");
        rows = r.rows;
      }
      const mcpServers = {};
      for (const row of rows) {
        const config = row.config || {};
        mcpServers[row.name] = {
          ...config,
          type: config.command ? "stdio" : "sse",
        };
      }
      const newConfig = { mcpServers };
      const changes = this.#diffConfigs(this.#previousConfig?.mcpServers, mcpServers);
      this.#config = newConfig;
      this.#previousConfig = JSON.parse(JSON.stringify(newConfig));
      logger.debug("Config loaded from database", { count: Object.keys(mcpServers).length });
      return { config: newConfig, changes };
    } catch (error) {
      throw wrapError(error, "CONFIG_DB_READ_ERROR", {});
    }
  }

  async getConfigForUser(userId) {
    if (!this.#useMultiUser) return this.getConfig();
    const pool = await this.#getPool();
    const { rows } = await pool.query(
      "SELECT name, config FROM user_mcp_servers WHERE user_id = $1 ORDER BY name",
      [userId]
    );
    const mcpServers = {};
    for (const row of rows) {
      const config = row.config || {};
      mcpServers[row.name] = { ...config, type: config.command ? "stdio" : "sse" };
    }
    return { mcpServers };
  }

  async saveConfigForUser(userId, config) {
    if (!this.#useMultiUser) return this.saveConfig(config);
    if (!config || typeof config.mcpServers !== "object") {
      throw new ConfigError("Invalid config: mcpServers must be an object");
    }
    const pool = await this.#getPool();
    const cleanServers = {};
    for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
      const { config_source, type, ...clean } = serverConfig;
      cleanServers[name] = clean;
    }
    await pool.query("BEGIN");
    const { rows } = await pool.query(
      "SELECT name FROM user_mcp_servers WHERE user_id = $1",
      [userId]
    );
    const existingNames = new Set(rows.map((r) => r.name));
    const toUpsert = Object.keys(cleanServers);
    const toDelete = [...existingNames].filter((n) => !toUpsert.includes(n));
    for (const name of toDelete) {
      await pool.query("DELETE FROM user_mcp_servers WHERE user_id = $1 AND name = $2", [userId, name]);
    }
    for (const [name, serverConfig] of Object.entries(cleanServers)) {
      await pool.query(
        `INSERT INTO user_mcp_servers (user_id, name, config, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (user_id, name) DO UPDATE SET config = $3, updated_at = NOW()`,
        [userId, name, JSON.stringify(serverConfig)]
      );
    }
    await pool.query("COMMIT");
    await this.loadConfig();
    logger.info("User config saved to database", { userId });
  }

  async saveConfig(config) {
    if (this.#useMultiUser) {
      throw new ConfigError("Use saveConfigForUser in multi-user mode");
    }
    if (!config || typeof config.mcpServers !== "object") {
      throw new ConfigError("Invalid config: mcpServers must be an object");
    }
    try {
      const pool = await this.#getPool();
      const cleanServers = {};
      for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
        const { config_source, type, ...clean } = serverConfig;
        cleanServers[name] = clean;
      }
      await pool.query("BEGIN");
      const existing = await pool.query("SELECT name FROM mcp_servers");
      const existingNames = new Set(existing.rows.map((r) => r.name));
      const toUpsert = Object.keys(cleanServers);
      const toDelete = [...existingNames].filter((n) => !toUpsert.includes(n));
      for (const name of toDelete) {
        await pool.query("DELETE FROM mcp_servers WHERE name = $1", [name]);
      }
      for (const [name, serverConfig] of Object.entries(cleanServers)) {
        await pool.query(
          `INSERT INTO mcp_servers (name, config, updated_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (name) DO UPDATE SET config = $2, updated_at = NOW()`,
          [name, JSON.stringify(serverConfig)]
        );
      }
      await pool.query("COMMIT");
      await this.updateConfig({ ...this.#config, mcpServers: config.mcpServers });
      logger.info("Config saved to database");
    } catch (error) {
      const pool = await this.#getPool();
      await pool.query("ROLLBACK").catch(() => {});
      throw wrapError(error, "CONFIG_DB_SAVE_ERROR", {});
    }
  }

  async updateConfig(newConfig) {
    if (newConfig && typeof newConfig === "object") {
      this.#config = newConfig;
      this.#previousConfig = JSON.parse(JSON.stringify(newConfig));
    }
  }

  getConfig() {
    return this.#config || { mcpServers: {} };
  }

  getServerConfig(serverName) {
    return this.#config?.mcpServers?.[serverName];
  }

  watchConfig() {
    logger.debug("Database config: watch not supported (use polling if needed)");
  }

  stopWatching() {}

  async close() {
    if (this.#pool) {
      await this.#pool.end();
      this.#pool = null;
    }
  }
}
