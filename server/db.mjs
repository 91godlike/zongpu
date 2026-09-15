import { DatabaseSync, backup as sqliteBackup } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { hashPassword } from "./auth.mjs";

const jsonColumns = new Set(["data", "branches", "before_data", "after_data"]);
const booleanColumns = new Set(["disabled", "revoked", "ready"]);

class Mutex {
  #tail = Promise.resolve();
  async acquire() {
    const previous = this.#tail;
    let release;
    this.#tail = new Promise((resolve) => (release = resolve));
    await previous;
    return release;
  }
}

function sqliteValue(value) {
  if (value === undefined) return null;
  if (value instanceof Date)
    return value.toISOString().replace("T", " ").replace("Z", "");
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value && typeof value === "object" && !Buffer.isBuffer(value))
    return JSON.stringify(value);
  return value;
}

function sqliteSql(sql, params = []) {
  const values = [];
  let text = sql
    .trim()
    .replace(/\s+FOR UPDATE\b/gi, "")
    .replace(/count\(\*\)::int/gi, "CAST(count(*) AS INTEGER)")
    .replace(
      /now\(\)\s*\+\s*interval\s*'(\d+)\s+(days?|minutes?)'/gi,
      (_, amount, unit) => `datetime('now','+${amount} ${unit}')`,
    )
    .replace(/now\(\)/gi, "CURRENT_TIMESTAMP");
  text = text.replace(/\$(\d+)/g, (_, index) => {
    values.push(sqliteValue(params[Number(index) - 1]));
    return "?";
  });
  return { text, values };
}

function sqliteRows(rows) {
  return rows.map((row) => {
    const result = { ...row };
    for (const [key, value] of Object.entries(result)) {
      if (jsonColumns.has(key) && typeof value === "string") {
        try {
          result[key] = JSON.parse(value);
        } catch {
          // Keep malformed historical text visible instead of hiding the row.
        }
      }
      if (booleanColumns.has(key) && value !== null)
        result[key] = Boolean(value);
    }
    return result;
  });
}

class SQLitePool {
  dialect = "sqlite";
  #database;
  #mutex = new Mutex();

  constructor(filename) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.#database = new DatabaseSync(filename);
    this.#database.exec(`
      PRAGMA foreign_keys=ON;
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=NORMAL;
      PRAGMA busy_timeout=10000;
      PRAGMA temp_store=MEMORY;
    `);
  }

  exec(sql) {
    this.#database.exec(sql);
  }

  #queryDirect(sql, params = []) {
    const { text, values } = sqliteSql(sql, params);
    const statement = this.#database.prepare(text);
    const returnsRows =
      /^\s*(SELECT|WITH|PRAGMA)\b/i.test(text) || /\bRETURNING\b/i.test(text);
    if (returnsRows) {
      const rows = sqliteRows(statement.all(...values));
      return { rows, rowCount: rows.length };
    }
    const result = statement.run(...values);
    return { rows: [], rowCount: Number(result.changes) };
  }

  async query(sql, params = []) {
    const release = await this.#mutex.acquire();
    try {
      return this.#queryDirect(sql, params);
    } finally {
      release();
    }
  }

  async withTransaction(fn) {
    const release = await this.#mutex.acquire();
    const client = {
      query: async (sql, params = []) => this.#queryDirect(sql, params),
    };
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      const result = await fn(client);
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        // Preserve the original failure if SQLite already rolled back.
      }
      throw error;
    } finally {
      release();
    }
  }

  async backupTo(filename) {
    const release = await this.#mutex.acquire();
    try {
      await sqliteBackup(this.#database, filename);
    } finally {
      release();
    }
  }

  async restoreFrom(filename, backupId) {
    const release = await this.#mutex.acquire();
    const source = new DatabaseSync(filename, { readOnly: true });
    const tables = [
      ["family", ["id", "data", "version"]],
      ["users", ["id", "username", "name", "password", "role", "branches", "disabled", "created_at", "phone"]],
      ["invites", ["id", "token", "role", "branches", "expires_at", "used_at", "created_by"]],
      ["people", ["id", "data", "version", "deleted_at", "updated_at"]],
      ["relations", ["id", "source", "target", "type", "data", "deleted_at", "version"]],
      ["attachments", ["id", "person_id", "name", "mime", "size", "created_by", "created_at", "deleted_at"]],
      ["family_documents", ["id", "name", "mime", "size", "created_by", "created_at"]],
      ["audit", ["id", "actor", "action", "entity", "entity_id", "before_data", "after_data", "created_at"]],
      ["shares", ["id", "token", "branch", "expires_at", "revoked"]],
    ];
    try {
      if (source.prepare("PRAGMA integrity_check").get().integrity_check !== "ok")
        throw new Error("备份数据库完整性检查失败");
      const sourceVersion = Number(
        source.prepare("SELECT COALESCE(MAX(version),0) AS version FROM schema_versions").get().version,
      );
      const currentVersion = Number(
        this.#database.prepare("SELECT COALESCE(MAX(version),0) AS version FROM schema_versions").get().version,
      );
      if (sourceVersion !== currentVersion)
        throw new Error("备份版本与当前系统不一致，无法直接恢复");
      const snapshots = tables.map(([table, columns]) => {
        source.prepare(`SELECT 1 FROM ${table} LIMIT 1`);
        return [table, columns, source.prepare(`SELECT ${columns.join(",")} FROM ${table}`).all()];
      });
      this.#database.exec("BEGIN IMMEDIATE");
      try {
        this.#database.exec(`
          DELETE FROM sessions;
          DELETE FROM import_previews;
          DELETE FROM invites;
          DELETE FROM attachments;
          DELETE FROM family_documents;
          DELETE FROM relations;
          DELETE FROM audit;
          DELETE FROM shares;
          DELETE FROM people;
          DELETE FROM users;
          DELETE FROM family;
        `);
        for (const [table, columns, rows] of snapshots) {
          const placeholders = columns.map(() => "?").join(",");
          const insert = this.#database.prepare(
            `INSERT INTO ${table}(${columns.join(",")}) VALUES(${placeholders})`,
          );
          for (const row of rows) insert.run(...columns.map((column) => row[column]));
        }
        this.#database
          .prepare(
            "INSERT INTO audit(actor,action,entity,entity_id,before_data,after_data) VALUES(NULL,'恢复完整备份','backup',?,NULL,?)",
          )
          .run(backupId, JSON.stringify({ backupId }));
        this.#database.exec("COMMIT");
      } catch (error) {
        this.#database.exec("ROLLBACK");
        throw error;
      }
      if (this.#database.prepare("PRAGMA integrity_check").get().integrity_check !== "ok")
        throw new Error("恢复后数据库完整性检查失败");
    } finally {
      source.close();
      release();
    }
  }

  async end() {
    const release = await this.#mutex.acquire();
    try {
      this.#database.close();
    } finally {
      release();
    }
  }
}

function sqliteFilename(url) {
  if (url.startsWith("file:")) return new URL(url).pathname;
  const filename = url.slice("sqlite:".length);
  return path.resolve(filename || "data/zongpu.sqlite");
}

export async function createPool(url = "sqlite:./data/zongpu.sqlite") {
  if (!url.startsWith("sqlite:") && !url.startsWith("file:"))
    throw new Error("单容器版本只支持 SQLite 数据库地址");
  return new SQLitePool(sqliteFilename(url));
}

export async function migrate(db) {
  db.exec(`
      CREATE TABLE IF NOT EXISTS schema_versions(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS family(id INTEGER PRIMARY KEY DEFAULT 1 CHECK(id=1), data TEXT NOT NULL CHECK(json_valid(data)), version INTEGER NOT NULL DEFAULT 1);
      INSERT INTO family(id,data) VALUES(1,'{"name":"我的家谱","description":"把家人的故事，留给下一代。","origin":"","generationPoem":""}') ON CONFLICT DO NOTHING;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','editor','viewer')), branches TEXT CHECK(branches IS NULL OR json_valid(branches)), disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS sessions_exp ON sessions(expires_at);
      CREATE TABLE IF NOT EXISTS invites(id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, role TEXT NOT NULL CHECK(role IN ('editor','viewer')), branches TEXT CHECK(branches IS NULL OR json_valid(branches)), expires_at TEXT NOT NULL, used_at TEXT, created_by TEXT REFERENCES users(id));
      CREATE TABLE IF NOT EXISTS people(id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)), version INTEGER NOT NULL DEFAULT 1, deleted_at TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE INDEX IF NOT EXISTS people_updated ON people(updated_at,id);
      CREATE TABLE IF NOT EXISTS relations(id TEXT PRIMARY KEY, source TEXT NOT NULL REFERENCES people(id), target TEXT NOT NULL REFERENCES people(id), type TEXT NOT NULL CHECK(type IN ('parent','partner')), data TEXT NOT NULL DEFAULT '{}', deleted_at TEXT, version INTEGER NOT NULL DEFAULT 1, CHECK(source<>target), CHECK(json_valid(data)));
      CREATE UNIQUE INDEX IF NOT EXISTS relations_unique ON relations(source,target,type) WHERE deleted_at IS NULL;
      CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES people(id), name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, created_by TEXT REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, deleted_at TEXT);
      CREATE TABLE IF NOT EXISTS family_documents(id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, created_by TEXT REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT REFERENCES users(id), action TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT, before_data TEXT CHECK(before_data IS NULL OR json_valid(before_data)), after_data TEXT CHECK(after_data IS NULL OR json_valid(after_data)), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS import_previews(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), data TEXT NOT NULL CHECK(json_valid(data)), expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS shares(id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, branch TEXT NOT NULL, expires_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      INSERT INTO schema_versions(version) VALUES(1) ON CONFLICT DO NOTHING;
  `);
  const upgraded = (
    await db.query("SELECT 1 FROM schema_versions WHERE version=2")
  ).rowCount;
  if (!upgraded) {
    db.exec(`
      BEGIN IMMEDIATE;
      DROP INDEX IF EXISTS relations_unique;
      ALTER TABLE relations RENAME TO relations_v1;
      CREATE TABLE relations(id TEXT PRIMARY KEY, source TEXT NOT NULL REFERENCES people(id), target TEXT NOT NULL REFERENCES people(id), type TEXT NOT NULL CHECK(type IN ('parent','partner')), data TEXT NOT NULL DEFAULT '{}', deleted_at TEXT, version INTEGER NOT NULL DEFAULT 1, CHECK(source<>target), CHECK(json_valid(data)));
      INSERT INTO relations(id,source,target,type,data,deleted_at,version)
        SELECT id,source,target,CASE WHEN type='biological' THEN 'parent' ELSE type END,data,deleted_at,version FROM relations_v1;
      DROP TABLE relations_v1;
      CREATE UNIQUE INDEX relations_unique ON relations(source,target,type) WHERE deleted_at IS NULL;
      INSERT INTO schema_versions(version) VALUES(2);
      COMMIT;
    `);
  }
  const accountsUpgraded = (
    await db.query("SELECT 1 FROM schema_versions WHERE version=3")
  ).rowCount;
  if (!accountsUpgraded) {
    db.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE users ADD COLUMN phone TEXT;
      CREATE UNIQUE INDEX users_phone_unique ON users(phone) WHERE phone IS NOT NULL AND phone<>'';
      INSERT INTO schema_versions(version) VALUES(3);
      COMMIT;
    `);
  }
  const visibilityRemoved = (
    await db.query("SELECT 1 FROM schema_versions WHERE version=4")
  ).rowCount;
  if (!visibilityRemoved) {
    db.exec(`
      BEGIN IMMEDIATE;
      UPDATE people SET data=json_remove(data,'$.visibility')
        WHERE json_type(data,'$.visibility') IS NOT NULL;
      INSERT INTO schema_versions(version) VALUES(4);
      COMMIT;
    `);
  }
  const familyDocumentsAdded = (
    await db.query("SELECT 1 FROM schema_versions WHERE version=5")
  ).rowCount;
  if (!familyDocumentsAdded) {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS family_documents(id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, created_by TEXT REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      INSERT INTO schema_versions(version) VALUES(5);
      COMMIT;
    `);
  }
}

export async function transaction(db, fn) {
  return db.withTransaction(fn);
}

export async function audit(client, actor, action, entity, id, before, after) {
  await client.query(
    "INSERT INTO audit(actor,action,entity,entity_id,before_data,after_data) VALUES($1,$2,$3,$4,$5,$6)",
    [actor?.id || null, action, entity, id, JSON.stringify(before ?? null), JSON.stringify(after ?? null)],
  );
}

export async function ensureInitialAdmin(
  db,
  { username = "admin", password = "admin", name = "管理员" } = {},
) {
  return transaction(db, async (client) => {
    if ((await client.query("SELECT 1 FROM users LIMIT 1")).rowCount)
      return false;
    const user = { id: randomUUID(), username, name, role: "admin" };
    await client.query(
      "INSERT INTO users(id,username,name,password,role) VALUES($1,$2,$3,$4,$5)",
      [user.id, user.username, user.name, await hashPassword(password), user.role],
    );
    await audit(client, user, "自动创建管理员", "user", user.id, null, {
      name: user.name,
      username: user.username,
    });
    return true;
  });
}
