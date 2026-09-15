import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createPool, migrate, ensureInitialAdmin } from "../server/db.mjs";
import { createApp } from "../server/app.mjs";

test("升级时删除历史人物的可见范围标记", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "zongpu-migration-"));
  const db = await createPool(
    pathToFileURL(path.join(directory, "zongpu.sqlite")).href,
  );
  t.after(async () => {
    await db.end();
    await rm(directory, { recursive: true, force: true });
  });
  await migrate(db);
  await db.query("DELETE FROM schema_versions WHERE version=4");
  await db.query(
    "INSERT INTO people(id,data) VALUES($1,$2)",
    ["legacy-person", { name: "历史人物", visibility: "restricted" }],
  );
  await migrate(db);
  const data = (
    await db.query("SELECT data FROM people WHERE id=$1", ["legacy-person"])
  ).rows[0].data;
  assert.equal("visibility" in data, false);
  assert.equal(
    (await db.query("SELECT 1 FROM schema_versions WHERE version=4")).rowCount,
    1,
  );
});

test("SQLite 单容器使用默认管理员并持久化家谱数据", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "zongpu-sqlite-"));
  const uploadDir = path.join(directory, "uploads");
  await mkdir(uploadDir);
  const db = await createPool(
    pathToFileURL(path.join(directory, "zongpu.sqlite")).href,
  );
  await migrate(db);
  assert.ok(
    (await db.query("PRAGMA table_info(users)")).rows.some(
      (column) => column.name === "phone",
    ),
  );
  assert.equal(
    (await db.query("SELECT 1 FROM schema_versions WHERE version=3")).rowCount,
    1,
  );
  assert.equal(
    (await db.query("SELECT 1 FROM schema_versions WHERE version=4")).rowCount,
    1,
  );
  assert.equal(await ensureInitialAdmin(db), true);
  assert.equal(await ensureInitialAdmin(db), false);

  const app = createApp(db, {
    origin: "",
    uploadDir,
    distDir: path.resolve("dist"),
  });
  const server = await new Promise((resolve) => {
    const value = app.listen(0, "127.0.0.1", () => resolve(value));
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await db.end();
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const browserOrigin = base.slice(0, -4);
  const login = await fetch(base + "/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: browserOrigin },
    body: JSON.stringify({ username: "admin", password: "admin" }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];

  const created = await fetch(base + "/people", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: browserOrigin,
      cookie,
    },
    body: JSON.stringify({
      name: "单容器测试",
      alias: "",
      gender: "unknown",
      branch: "测试支系",
      generation: "",
      birth: "",
      death: "",
      calendar: "unknown",
      status: "unknown",
      origin: "",
      residence: "",
      phone: "",
      biography: "",
      source: "",
      certainty: "pending",
    }),
  });
  assert.equal(created.status, 201);

  const graph = await fetch(base + "/graph", { headers: { cookie } });
  assert.equal(graph.status, 200);
  assert.equal((await graph.json()).people[0].name, "单容器测试");
  assert.equal(
    (await db.query("SELECT count(*)::int AS n FROM people")).rows[0].n,
    1,
  );
});
