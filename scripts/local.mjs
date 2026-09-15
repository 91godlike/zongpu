import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { createPool, migrate, ensureInitialAdmin } from "../server/db.mjs";
import { createApp } from "../server/app.mjs";

const directory = await mkdtemp(path.join(tmpdir(), "zongpu-preview-"));
const uploadDir = path.join(directory, "uploads");
await mkdir(uploadDir);
const db = await createPool(
  pathToFileURL(path.join(directory, "zongpu.sqlite")).href,
);
await migrate(db);
await ensureInitialAdmin(db, {
  username: "demo",
  password: "DemoOnly2026!",
  name: "演示管理员",
});
await db.query("UPDATE family SET data=$1 WHERE id=1", [
  {
    name: "林氏家谱",
    description: "一脉相承，世代有迹。界面演示均为虚构内容。",
    origin: "福建福州",
    generationPoem: "世 文 知 予",
  },
]);

const people = [
  ["root1", "林世安", "male", "1", "1935", "2010", "长房", "deceased"],
  ["root2", "沈秀兰", "female", "1", "1938", "2012", "长房", "deceased"],
  ["son1", "林文远", "male", "2", "1962", "", "长房", "living"],
  ["wife1", "周静", "female", "2", "1964", "", "长房", "living"],
  ["son2", "林文清", "male", "2", "1966", "", "二房", "living"],
  ["wife2", "许岚", "female", "2", "1968", "", "二房", "living"],
  ["g1", "林知行", "male", "3", "1992", "", "长房", "living"],
  ["g2", "林知夏", "female", "3", "1995", "", "长房", "living"],
  ["g3", "林予宁", "female", "3", "1998", "", "二房", "living"],
];
const ids = new Map();
for (const [key, name, gender, generation, birth, death, branch, status] of people) {
  const id = randomUUID();
  ids.set(key, id);
  await db.query("INSERT INTO people(id,data) VALUES($1,$2)", [
    id,
    {
      name,
      alias: "",
      gender,
      branch,
      generation,
      birth,
      death,
      calendar: "solar",
      status,
      origin: "福建福州",
      residence: "",
      phone: "",
      biography: name === "林文远" ? "热爱摄影，整理过多册家族老照片。" : "",
      source: "家族口述，待逐条核实",
      certainty: "pending",
    },
  ]);
}
const relations = [
  ["root1", "root2", "partner"],
  ["root1", "son1", "parent"],
  ["root2", "son1", "parent"],
  ["root1", "son2", "parent"],
  ["root2", "son2", "parent"],
  ["son1", "wife1", "partner"],
  ["son2", "wife2", "partner"],
  ["son1", "g1", "parent"],
  ["wife1", "g1", "parent"],
  ["son1", "g2", "parent"],
  ["wife1", "g2", "parent"],
  ["son2", "g3", "parent"],
  ["wife2", "g3", "parent"],
];
for (const [source, target, type] of relations)
  await db.query(
    "INSERT INTO relations(id,source,target,type,data) VALUES($1,$2,$3,$4,$5)",
    [randomUUID(), ids.get(source), ids.get(target), type, {}],
  );

const app = createApp(db, {
  origin: "http://127.0.0.1:4173",
  uploadDir,
  distDir: path.resolve("dist"),
  allowFrames: true,
});
const server = app.listen(4173, "127.0.0.1", () =>
  console.log("演示地址：http://127.0.0.1:4173\n账号：demo\n密码：DemoOnly2026!"),
);
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close(async () => {
    await db.end();
    await rm(directory, { recursive: true, force: true });
    process.exit(0);
  });
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, shutdown);
