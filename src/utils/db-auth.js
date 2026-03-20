/**
 * User management and auth storage in PostgreSQL.
 */

import pg from "pg";
import { hashPassword, verifyPassword } from "./auth.js";
import logger from "./logger.js";

const { Pool } = pg;

const INIT_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
`;

let pool = null;

export async function getAuthPool(databaseUrl) {
  if (!pool) {
    pool = new Pool({
      connectionString: databaseUrl,
      max: 5,
      idleTimeoutMillis: 30000,
    });
  }
  return pool;
}

export async function initAuthSchema(databaseUrl) {
  const p = await getAuthPool(databaseUrl);
  await p.query(INIT_SQL);
  logger.debug("Auth schema initialized");
}

export async function createUser(databaseUrl, email, password) {
  const p = await getAuthPool(databaseUrl);
  const passwordHash = await hashPassword(password);
  const { rows } = await p.query(
    `INSERT INTO users (email, password_hash, updated_at)
     VALUES ($1, $2, NOW())
     RETURNING id, email, created_at`,
    [email.toLowerCase().trim(), passwordHash]
  );
  return rows[0];
}

export async function findUserByEmail(databaseUrl, email) {
  const p = await getAuthPool(databaseUrl);
  const { rows } = await p.query(
    "SELECT id, email, password_hash, created_at FROM users WHERE email = $1",
    [email.toLowerCase().trim()]
  );
  return rows[0] || null;
}

export async function verifyUser(databaseUrl, email, password) {
  const user = await findUserByEmail(databaseUrl, email);
  if (!user) return null;
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) return null;
  return { id: user.id, email: user.email };
}
