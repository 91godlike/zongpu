import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { transaction } from "./db.mjs";

const MANAGED_PREFIX = "managed-";
const BACKUP_LIMIT = 3;

async function exists(filename) {
  try {
    await stat(filename);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function hashFile(filename) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(filename)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

async function inventory(root, relative = "") {
  const base = path.join(root, relative);
  const entries = await readdir(base, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === "manifest.json" && !relative) continue;
    const child = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error("备份目录中不能包含符号链接");
    if (entry.isDirectory()) files.push(...(await inventory(root, child)));
    else if (entry.isFile()) {
      const filename = path.join(root, child);
      const info = await stat(filename);
      files.push({
        path: child.split(path.sep).join("/"),
        size: info.size,
        sha256: await hashFile(filename),
      });
    }
  }
  return files;
}

async function copyDirectory(source, target) {
  await mkdir(target, { recursive: true });
  if (await exists(source)) await cp(source, target, { recursive: true, force: true });
}

async function readManifest(directory) {
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  if (!manifest?.id || !Array.isArray(manifest.files)) throw new Error("备份清单无效");
  return manifest;
}

async function validateBackup(directory, expectedId) {
  const manifest = await readManifest(directory);
  if (manifest.id !== expectedId) throw new Error("备份编号与清单不一致");
  const files = await inventory(directory);
  if (JSON.stringify(files) !== JSON.stringify(manifest.files))
    throw new Error("备份文件校验失败，文件可能不完整");
  return manifest;
}

async function swapDirectory(live, staged, rollback) {
  await mkdir(path.dirname(live), { recursive: true });
  if (await exists(rollback)) await rm(rollback, { recursive: true, force: true });
  if (await exists(live)) await rename(live, rollback);
  try {
    await rename(staged, live);
  } catch (error) {
    if (await exists(rollback)) await rename(rollback, live);
    throw error;
  }
}

export class BackupManager {
  #tail = Promise.resolve();

  constructor(db, { backupDir, uploadDir, documentDir }) {
    this.db = db;
    this.backupDir = backupDir;
    this.uploadDir = uploadDir;
    this.documentDir = documentDir;
  }

  async #exclusive(fn) {
    const previous = this.#tail;
    let release;
    this.#tail = new Promise((resolve) => (release = resolve));
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async #listDirect() {
    await mkdir(this.backupDir, { recursive: true });
    const entries = await readdir(this.backupDir, { withFileTypes: true });
    const manifests = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(MANAGED_PREFIX)) continue;
      try {
        manifests.push(await readManifest(path.join(this.backupDir, entry.name)));
      } catch {
        // Incomplete directories are never offered for restoration.
      }
    }
    return manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async list() {
    return this.#exclusive(async () =>
      (await this.#listDirect()).map(({ files, ...backup }) => ({
        ...backup,
        fileCount: files.length,
      })),
    );
  }

  async #createDirect(reason = "手动备份") {
    await mkdir(this.backupDir, { recursive: true });
    const createdAt = new Date().toISOString();
    const id = `${MANAGED_PREFIX}${createdAt.replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
    const staging = path.join(this.backupDir, `.building-${randomUUID()}`);
    const destination = path.join(this.backupDir, id);
    await mkdir(staging, { recursive: true });
    try {
      await this.db.backupTo(path.join(staging, "zongpu.sqlite"));
      await copyDirectory(this.uploadDir, path.join(staging, "uploads"));
      await copyDirectory(this.documentDir, path.join(staging, "family-documents"));
      const files = await inventory(staging);
      const manifest = {
        format: 1,
        id,
        createdAt,
        reason,
        size: files.reduce((sum, file) => sum + file.size, 0),
        files,
      };
      await writeFile(path.join(staging, "manifest.json"), JSON.stringify(manifest, null, 2), {
        flag: "wx",
      });
      await rename(staging, destination);
      const backups = await this.#listDirect();
      for (const old of backups.slice(BACKUP_LIMIT))
        await rm(path.join(this.backupDir, old.id), { recursive: true, force: true });
      return manifest;
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  async create(reason = "手动备份") {
    return this.#exclusive(() => this.#createDirect(reason));
  }

  async restore(id) {
    if (!/^managed-\d{14}-[0-9a-f]{8}$/.test(id)) throw new Error("备份编号无效");
    return this.#exclusive(async () => {
      const source = path.join(this.backupDir, id);
      const manifest = await validateBackup(source, id);
      const stageRoot = path.join(path.dirname(this.uploadDir), `.restore-${randomUUID()}`);
      const stagedUploads = path.join(stageRoot, "uploads");
      const stagedDocuments = path.join(stageRoot, "family-documents");
      const rollbackUploads = `${this.uploadDir}.before-restore`;
      const rollbackDocuments = `${this.documentDir}.before-restore`;
      await mkdir(stageRoot, { recursive: true });
      try {
        await cp(path.join(source, "zongpu.sqlite"), path.join(stageRoot, "zongpu.sqlite"));
        await copyDirectory(path.join(source, "uploads"), stagedUploads);
        await copyDirectory(path.join(source, "family-documents"), stagedDocuments);
        const safety = await this.#createDirect("恢复前自动备份");
        await swapDirectory(this.uploadDir, stagedUploads, rollbackUploads);
        try {
          await swapDirectory(this.documentDir, stagedDocuments, rollbackDocuments);
          try {
            await this.db.restoreFrom(path.join(stageRoot, "zongpu.sqlite"), id);
          } catch (error) {
            await rm(this.documentDir, { recursive: true, force: true });
            if (await exists(rollbackDocuments)) await rename(rollbackDocuments, this.documentDir);
            throw error;
          }
        } catch (error) {
          await rm(this.uploadDir, { recursive: true, force: true });
          if (await exists(rollbackUploads)) await rename(rollbackUploads, this.uploadDir);
          throw error;
        }
        await rm(rollbackUploads, { recursive: true, force: true });
        await rm(rollbackDocuments, { recursive: true, force: true });
        return { restored: manifest, safety };
      } finally {
        await rm(stageRoot, { recursive: true, force: true });
      }
    });
  }
}

export async function purgeExpiredTrash(db, uploadDir) {
  const files = [];
  const purged = await transaction(db, async (client) => {
    const expired = (
      await client.query(
        "SELECT id FROM people WHERE deleted_at IS NOT NULL AND deleted_at<=datetime('now','-7 days')",
      )
    ).rows;
    for (const person of expired) {
      const attachments = (
        await client.query("SELECT id FROM attachments WHERE person_id=$1", [person.id])
      ).rows;
      const relations = (
        await client.query("SELECT id FROM relations WHERE source=$1 OR target=$1", [person.id])
      ).rows;
      for (const attachment of attachments) {
        files.push(attachment.id, `${attachment.id}.thumb`);
        await client.query("DELETE FROM audit WHERE entity='attachment' AND entity_id=$1", [attachment.id]);
      }
      for (const relation of relations)
        await client.query("DELETE FROM audit WHERE entity='relation' AND entity_id=$1", [relation.id]);
      await client.query("DELETE FROM attachments WHERE person_id=$1", [person.id]);
      await client.query("DELETE FROM relations WHERE source=$1 OR target=$1", [person.id]);
      await client.query("DELETE FROM audit WHERE entity='person' AND entity_id=$1", [person.id]);
      await client.query(
        "DELETE FROM audit WHERE entity='merge' AND (json_extract(before_data,'$.source.id')=$1 OR json_extract(before_data,'$.target.id')=$1 OR json_extract(after_data,'$.source')=$1 OR json_extract(after_data,'$.target')=$1)",
        [person.id],
      );
      await client.query("DELETE FROM people WHERE id=$1", [person.id]);
    }
    return expired.length;
  });
  for (const filename of files)
    await unlink(path.join(uploadDir, filename)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  return purged;
}
