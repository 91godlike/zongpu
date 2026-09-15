import path from "node:path";
import { createPool, migrate, ensureInitialAdmin } from "./db.mjs";
import { createApp } from "./app.mjs";
import { purgeExpiredTrash } from "./maintenance.mjs";

const origin = (process.env.APP_ORIGIN || "").trim().replace(/\/$/, "");
const forceHttps = /^(1|true|yes|on)$/i.test(process.env.FORCE_HTTPS || "");
if (forceHttps && !origin.startsWith("https://"))
  throw new Error("已启用 FORCE_HTTPS，APP_ORIGIN 必须使用 HTTPS");

const db = await createPool(
  process.env.DATABASE_URL || "file:/app/data/zongpu.sqlite",
);
await migrate(db);

const uploadDir = path.resolve(process.env.UPLOAD_DIR || "/app/data/uploads");
const documentDir = path.resolve(
  process.env.DOCUMENT_DIR || "/app/data/family-documents",
);
const backupDir = path.resolve(process.env.BACKUP_DIR || "/app/backups");
await purgeExpiredTrash(db, uploadDir);

const initialUsername = process.env.INITIAL_ADMIN_USERNAME || "admin";
const initialPassword = process.env.INITIAL_ADMIN_PASSWORD || "admin";
const initialName = process.env.INITIAL_ADMIN_NAME || "管理员";
await ensureInitialAdmin(db, {
  username: initialUsername,
  password: initialPassword,
  name: initialName,
});

const app = createApp(db, {
  origin,
  setupToken: process.env.SETUP_TOKEN,
  uploadDir,
  documentDir,
  backupDir,
  distDir: path.resolve("dist"),
});
const server = app.listen(Number(process.env.PORT || 3000), "0.0.0.0", () =>
  console.log("宗谱应用已启动"),
);
server.requestTimeout = 5 * 60 * 1000;
const trashCleanup = setInterval(
  () => purgeExpiredTrash(db, uploadDir).catch((error) => console.error("清理过期回收站失败", error)),
  60 * 60 * 1000,
);
trashCleanup.unref();
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    clearInterval(trashCleanup);
    server.close(async () => {
      await db.end();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 15000).unref();
  });
