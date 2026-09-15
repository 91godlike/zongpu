import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createPool, migrate } from "../server/db.mjs";
import { createApp } from "../server/app.mjs";
import ExcelJS from "exceljs";
import JSZip from "jszip";

const ORIGIN = "http://127.0.0.1";
async function harness() {
  const directory = await mkdtemp(path.join(tmpdir(), "zongpu-test-"));
  const db = await createPool(
    pathToFileURL(path.join(directory, "zongpu.sqlite")).href,
  );
  await migrate(db);
  const uploadDir = path.join(directory, "uploads");
  await mkdir(uploadDir);
  const app = createApp(db, {
    origin: ORIGIN,
    setupToken: "setup-secret",
    uploadDir,
    distDir: path.resolve("dist"),
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(
    url,
    { method = "GET", body, cookie, origin = ORIGIN, headers = {} } = {},
  ) {
    const response = await fetch(base + "/api" + url, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(origin ? { origin } : {}),
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return {
      status: response.status,
      data,
      cookie: response.headers.get("set-cookie")?.split(";")[0],
    };
  }
  return {
    db,
    request,
    base,
    close: () =>
      new Promise((resolve) =>
        server.close(async () => {
          await db.end();
          await rm(directory, { recursive: true, force: true });
          resolve();
        }),
      ),
  };
}
const person = (name, branch = "长房") => ({
  name,
  alias: "",
  gender: "unknown",
  branch,
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
});

test("初始化和个人修改密码允许至少六位，管理员可将成员密码重置为手机号", async (t) => {
  const h = await harness();
  t.after(h.close);
  let r = await h.request("/setup", {
    method: "POST",
    body: {
      setupToken: "setup-secret",
      username: "admin",
      name: "管理员",
      password: "123456",
    },
  });
  assert.equal(r.status, 201);
  const admin = r.cookie;
  r = await h.request("/password", {
    method: "POST",
    cookie: admin,
    body: { current: "123456", password: "654321" },
  });
  assert.equal(r.status, 200);
  r = await h.request("/login", {
    method: "POST",
    body: { identifier: "admin", password: "654321" },
  });
  assert.equal(r.status, 200);
  const reloggedAdmin = r.cookie;
  r = await h.request("/invites", {
    method: "POST",
    cookie: reloggedAdmin,
    body: { days: 7 },
  });
  const invite = new URL(r.data.url).searchParams.get("invite");
  const registered = await h.request("/register", {
    method: "POST",
    body: { token: invite, name: "六位密码成员", phone: "13800000000" },
  });
  r = await h.request("/users", { cookie: reloggedAdmin });
  const member = r.data.find((value) => value.name === "六位密码成员");
  r = await h.request("/users/" + member.id + "/reset-password", {
    method: "POST",
    cookie: reloggedAdmin,
    body: {},
  });
  assert.equal(r.status, 200);
  r = await h.request("/graph", { cookie: registered.cookie });
  assert.equal(r.status, 401);
  r = await h.request("/login", {
    method: "POST",
    body: { identifier: "六位密码成员", password: "13800000000" },
  });
  assert.equal(r.status, 200);
  r = await h.request("/password", {
    method: "POST",
    cookie: r.cookie,
    body: { current: "13800000000", password: "12345" },
  });
  assert.equal(r.status, 422);
  assert.match(r.data.error, /至少 6 位/);
});

test("管理员可以新建默认只读的成员账号", async (t) => {
  const h = await harness();
  t.after(h.close);
  let r = await h.request("/setup", {
    method: "POST",
    body: {
      setupToken: "setup-secret",
      username: "admin",
      name: "管理员",
      password: "123456",
    },
  });
  const admin = r.cookie;
  r = await h.request("/users", {
    method: "POST",
    cookie: admin,
    body: { name: "手工成员", phone: "+86 139-0000-0000" },
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.role, "viewer");
  assert.equal(r.data.phone, "13900000000");
  r = await h.request("/login", {
    method: "POST",
    body: { identifier: "手工成员", password: "13900000000" },
  });
  assert.equal(r.status, 200);
  const viewer = r.cookie;
  r = await h.request("/users", {
    method: "POST",
    cookie: viewer,
    body: { name: "越权账号", phone: "13700000000" },
  });
  assert.equal(r.status, 403);
  r = await h.request("/users", {
    method: "POST",
    cookie: admin,
    body: { name: "重复手机号", phone: "13900000000" },
  });
  assert.equal(r.status, 409);
});

test("邀请列表不显示已撤销或过期的记录", async (t) => {
  const h = await harness();
  t.after(h.close);
  let r = await h.request("/setup", {
    method: "POST",
    body: {
      setupToken: "setup-secret",
      username: "admin",
      name: "管理员",
      password: "123456",
    },
  });
  const admin = r.cookie;
  await h.request("/invites", {
    method: "POST",
    cookie: admin,
    body: { days: 7 },
  });
  r = await h.request("/invites", { cookie: admin });
  assert.equal(r.data.length, 1);
  const inviteId = r.data[0].id;
  r = await h.request("/invites/" + inviteId, {
    method: "DELETE",
    cookie: admin,
    body: {},
  });
  assert.equal(r.status, 200);
  r = await h.request("/invites", { cookie: admin });
  assert.deepEqual(r.data, []);
});

test("管理员、关系环、版本冲突、回收站和修改日志形成完整流程", async (t) => {
  const h = await harness();
  t.after(h.close);
  let r = await h.request("/setup", {
    method: "POST",
    body: {
      setupToken: "setup-secret",
      username: "admin",
      name: "管理员",
      password: "AdminPassword2026!",
    },
  });
  assert.equal(r.status, 201);
  const cookie = r.cookie;
  r = await h.request("/people", {
    method: "POST",
    cookie,
    body: person("林父"),
  });
  assert.equal(r.status, 201);
  const father = r.data.id;
  r = await h.request("/people", {
    method: "POST",
    cookie,
    body: person("林子"),
  });
  assert.equal(r.status, 201);
  const child = r.data.id;
  r = await h.request("/relations", {
    method: "POST",
    cookie,
    body: { source: father, target: child, type: "parent", data: {} },
  });
  assert.equal(r.status, 201);
  r = await h.request("/relations", {
    method: "POST",
    cookie,
    body: { source: child, target: father, type: "parent", data: {} },
  });
  assert.equal(r.status, 422);
  assert.match(r.data.error, /祖先循环/);
  let graph = (await h.request("/graph", { cookie })).data;
  const p = graph.people.find((x) => x.id === father);
  r = await h.request("/people/" + father, {
    method: "PUT",
    cookie,
    body: { version: p.version, data: { ...person("林父"), birth: "1935" } },
  });
  assert.equal(r.status, 200);
  r = await h.request("/people/" + father, {
    method: "PUT",
    cookie,
    body: { version: p.version, data: { ...person("过期修改") } },
  });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /其他人修改/);
  graph = (await h.request("/graph", { cookie })).data;
  const updated = graph.people.find((x) => x.id === father);
  r = await h.request("/people/" + father, {
    method: "DELETE",
    cookie,
    body: { version: updated.version },
  });
  assert.equal(r.status, 200);
  r = await h.request("/trash", { cookie });
  assert.equal(r.data.length, 1);
  r = await h.request("/people/" + father + "/restore", {
    method: "POST",
    cookie,
    body: {},
  });
  assert.equal(r.status, 200);
  r = await h.request("/audit", { cookie });
  assert.ok(r.data.some((x) => x.action === "恢复人物"));
});

test("新增和编辑人物时可直接设置父母，从父亲资料新增子女时默认关联双亲", async (t) => {
  const h = await harness();
  t.after(h.close);
  let r = await h.request("/setup", {
    method: "POST",
    body: {
      setupToken: "setup-secret",
      username: "admin",
      name: "管理员",
      password: "AdminPassword2026!",
    },
  });
  const cookie = r.cookie;

  r = await h.request("/people", {
    method: "POST",
    cookie,
    body: { ...person("林父"), gender: "male" },
  });
  const father = r.data.id;
  r = await h.request("/people", {
    method: "POST",
    cookie,
    body: { ...person("林母"), gender: "female" },
  });
  const mother = r.data.id;
  r = await h.request("/relations", {
    method: "POST",
    cookie,
    body: { source: father, target: mother, type: "partner", data: {} },
  });
  assert.equal(r.status, 201);

  r = await h.request("/people", {
    method: "POST",
    cookie,
    body: {
      ...person("林子"),
      gender: "male",
      link: { id: father, direction: "child" },
      parentIds: [father, mother],
    },
  });
  assert.equal(r.status, 201);
  const child = r.data.id;
  let graph = (await h.request("/graph", { cookie })).data;
  assert.deepEqual(
    graph.relations
      .filter((relation) => relation.type === "parent" && relation.target === child)
      .map((relation) => relation.source)
      .sort(),
    [father, mother].sort(),
  );

  const childRecord = graph.people.find((value) => value.id === child);
  r = await h.request("/people/" + child, {
    method: "PUT",
    cookie,
    body: {
      version: childRecord.version,
      data: { ...person("林子"), gender: "male" },
      parentIds: [father],
    },
  });
  assert.equal(r.status, 200);
  graph = (await h.request("/graph", { cookie })).data;
  assert.deepEqual(
    graph.relations
      .filter((relation) => relation.type === "parent" && relation.target === child)
      .map((relation) => relation.source),
    [father],
  );

  r = await h.request("/people", {
    method: "POST",
    cookie,
    body: { ...person("林女"), gender: "female", parentIds: [father, mother] },
  });
  assert.equal(r.status, 201);
  const daughter = r.data.id;
  graph = (await h.request("/graph", { cookie })).data;
  assert.deepEqual(
    graph.relations
      .filter((relation) => relation.type === "parent" && relation.target === daughter)
      .map((relation) => relation.source)
      .sort(),
    [father, mother].sort(),
  );
});

test("受邀成员用姓名或手机号登录，默认只读且只能由管理员授权编辑", async (t) => {
  const h = await harness();
  t.after(h.close);
  let r = await h.request("/setup", {
    method: "POST",
    body: {
      setupToken: "setup-secret",
      username: "admin",
      name: "管理员",
      password: "AdminPassword2026!",
    },
  });
  const admin = r.cookie;
  const privatePerson = {
    ...person("林在世"),
    status: "living",
    birth: "1990-01-01",
    phone: "13800000000",
    residence: "住址",
    biography: "个人经历",
    source: "身份证",
  };
  const privateCreated = await h.request("/people", {
    method: "POST",
    cookie: admin,
    body: privatePerson,
  });
  const privatePng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const privateFile = new FormData();
  privateFile.append(
    "file",
    new Blob([privatePng], { type: "image/png" }),
    "家族照片.png",
  );
  const uploaded = await fetch(
    h.base + "/api/people/" + privateCreated.data.id + "/attachments",
    {
      method: "POST",
      headers: { origin: ORIGIN, cookie: admin },
      body: privateFile,
    },
  );
  assert.equal(uploaded.status, 201);
  const privateAttachment = await uploaded.json();
  r = await h.request("/invites", {
    method: "POST",
    cookie: admin,
    body: { role: "editor", branches: ["长房"], days: 7 },
  });
  assert.equal(r.status, 201);
  const invite = new URL(r.data.url).searchParams.get("invite");
  r = await h.request("/invites", { cookie: admin });
  assert.equal(r.data[0].role, "viewer");
  assert.equal(r.data[0].branches, null);
  r = await h.request("/register", {
    method: "POST",
    body: {
      token: invite,
      name: "查看者",
      phone: "138 0000 0000",
    },
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.role, "viewer");
  assert.equal(r.data.phone, undefined);
  const viewer = r.cookie;
  r = await h.request("/register", {
    method: "POST",
    body: {
      token: invite,
      name: "查看者二",
      phone: "13900000000",
    },
  });
  assert.equal(r.status, 400);
  r = await h.request("/login", {
    method: "POST",
    body: { identifier: "查看者", password: "13800000000" },
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.role, "viewer");
  r = await h.request("/login", {
    method: "POST",
    body: { identifier: "+86 138-0000-0000", password: "13800000000" },
  });
  assert.equal(r.status, 200);
  r = await h.request("/graph", { cookie: viewer });
  assert.equal(r.status, 200);
  assert.equal(r.data.people[0].phone, "13800000000");
  assert.equal(r.data.people[0].birth, "1990-01-01");
  assert.equal(r.data.people[0].residence, "住址");
  assert.equal(r.data.people[0].biography, "个人经历");
  assert.equal(r.data.people[0].source, "身份证");
  assert.equal(r.data.people[0].avatarId, privateAttachment.id);
  r = await h.request(
    "/people/" + privateCreated.data.id + "/attachments",
    { cookie: viewer },
  );
  assert.equal(r.status, 200);
  assert.equal(r.data.length, 1);
  assert.equal(r.data[0].mime, "image/webp");
  const viewedAttachment = await fetch(
    h.base + "/api/attachments/" + privateAttachment.id,
    { headers: { cookie: viewer } },
  );
  assert.equal(viewedAttachment.status, 200);
  r = await h.request("/people", {
    method: "POST",
    cookie: viewer,
    body: person("不应创建"),
  });
  assert.equal(r.status, 403);

  r = await h.request("/users", { cookie: admin });
  const member = r.data.find((value) => value.name === "查看者");
  assert.equal(member.phone, "13800000000");
  assert.equal(member.role, "viewer");
  r = await h.request("/users/" + member.id, {
    method: "PATCH",
    cookie: admin,
    body: { role: "editor", branches: null, disabled: false },
  });
  assert.equal(r.status, 200);
  r = await h.request("/login", {
    method: "POST",
    body: { identifier: "13800000000", password: "13800000000" },
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.role, "editor");
  r = await h.request("/people", {
    method: "POST",
    cookie: r.cookie,
    body: person("授权后可创建"),
  });
  assert.equal(r.status, 201);

  r = await h.request("/invites", {
    method: "POST",
    cookie: admin,
    body: { days: 7 },
  });
  const sameNameInvite = new URL(r.data.url).searchParams.get("invite");
  r = await h.request("/register", {
    method: "POST",
    body: { token: sameNameInvite, name: "查看者", phone: "13900000000" },
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.role, "viewer");
  r = await h.request("/login", {
    method: "POST",
    body: { identifier: "查看者", password: "13900000000" },
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.role, "viewer");
});

test("写接口拒绝错误来源，只读分享覆盖全谱完整资料且禁止写入", async (t) => {
  const h = await harness();
  t.after(h.close);
  let r = await h.request("/setup", {
    method: "POST",
    body: {
      setupToken: "setup-secret",
      username: "admin",
      name: "管理员",
      password: "AdminPassword2026!",
    },
  });
  const admin = r.cookie;
  r = await h.request("/people", {
    method: "POST",
    cookie: admin,
    origin: "https://evil.example",
    body: person("攻击写入"),
  });
  assert.equal(r.status, 403);
  const visible = await h.request("/people", {
    method: "POST",
    cookie: admin,
    body: {
      ...person("长房成员", "长房"),
      status: "living",
      phone: "13800000000",
    },
  });
  await h.request("/people", {
    method: "POST",
    cookie: admin,
    body: person("二房成员", "二房"),
  });
  const connected = await h.request("/people", {
    method: "POST",
    cookie: admin,
    body: {
      ...person("连接成员", "长房"),
      status: "living",
      birth: "1930",
    },
  });
  await h.request("/relations", {
    method: "POST",
    cookie: admin,
    body: {
      source: visible.data.id,
      target: connected.data.id,
      type: "parent",
      data: {},
    },
  });
  r = await h.request("/shares", {
    method: "POST",
    cookie: admin,
    body: { days: 7 },
  });
  assert.equal(r.status, 201);
  const share = new URL(r.data.url).searchParams.get("share");
  r = await h.request("/graph?share=" + share, {
    cookie: admin,
    origin: null,
  });
  assert.equal(r.status, 200);
  assert.deepEqual(
    new Set(r.data.people.map((x) => x.name)),
    new Set(["长房成员", "二房成员", "连接成员"]),
  );
  assert.equal(r.data.people.find((x) => x.name === "长房成员").phone, "13800000000");
  assert.equal(r.data.people.find((x) => x.name === "连接成员").birth, "1930");
  assert.ok(
    r.data.relations.some(
      (relation) => relation.target === connected.data.id,
    ),
  );
  r = await h.request("/people?share=" + share, {
    method: "POST",
    cookie: admin,
    body: person("分享模式不能写入"),
  });
  assert.equal(r.status, 403);
  r = await h.request("/shares", {
    method: "POST",
    cookie: admin,
    body: { days: 2 },
  });
  assert.equal(r.status, 422);
});

test("Excel 先预览再导入，图片按权限读取", async (t) => {
  const h = await harness();
  t.after(h.close);
  let r = await h.request("/setup", {
    method: "POST",
    body: {
      setupToken: "setup-secret",
      username: "admin",
      name: "管理员",
      password: "AdminPassword2026!",
    },
  });
  const admin = r.cookie;
  const workbook = new ExcelJS.Workbook();
  const peopleSheet = workbook.addWorksheet("人物");
  const relationSheet = workbook.addWorksheet("关系");
  peopleSheet.addRow([
    "编号",
    "姓名",
    "曾用名",
    "性别",
    "支系",
    "谱载世次",
    "出生记载",
    "去世记载",
    "历法",
    "状态",
    "籍贯",
    "居住地",
    "联系方式",
    "生平简介",
    "资料来源",
    "核实状态",
  ]);
  peopleSheet.addRow([
    "p1",
    "林导入",
    "",
    "男",
    "长房",
    "四",
    "2001",
    "",
    "公历",
    "在世",
    "",
    "",
    "",
    "",
    "",
    "待核实",
  ]);
  relationSheet.addRow([
    "起点编号",
    "终点编号",
    "关系类型",
    "开始记载",
    "结束记载",
    "说明",
  ]);
  const importForm = new FormData();
  importForm.append(
    "file",
    new Blob([await workbook.xlsx.writeBuffer()], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    "import.xlsx",
  );
  let response = await fetch(h.base + "/api/import/preview", {
    method: "POST",
    headers: { origin: ORIGIN, cookie: admin },
    body: importForm,
  });
  assert.equal(response.status, 200);
  const preview = await response.json();
  assert.equal(preview.people.length, 1);
  r = await h.request("/import/commit", {
    method: "POST",
    cookie: admin,
    body: { id: preview.id },
  });
  assert.equal(r.status, 200);
  const graph = (await h.request("/graph", { cookie: admin })).data;
  assert.equal(graph.people[0].name, "林导入");

  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const photoForm = new FormData();
  photoForm.append("file", new Blob([png], { type: "image/png" }), "photo.png");
  response = await fetch(
    h.base + "/api/people/" + graph.people[0].id + "/attachments",
    {
      method: "POST",
      headers: { origin: ORIGIN, cookie: admin },
      body: photoForm,
    },
  );
  assert.equal(response.status, 201);
  const attachment = await response.json();
  response = await fetch(h.base + "/api/attachments/" + attachment.id, {
    headers: { cookie: admin },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/webp");

  response = await fetch(h.base + "/api/export.xlsx", {
    headers: { cookie: admin },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /spreadsheet/);
  const exported = new ExcelJS.Workbook();
  const exportedBytes = await response.arrayBuffer();
  await exported.xlsx.load(exportedBytes);
  assert.equal(exported.getWorksheet("人物").getRow(1).getCell(5).value, "出生日期（公历）");
  assert.equal(exported.getWorksheet("人物").getRow(1).getCell(6).value, "出生日期（农历）");
  assert.equal(exported.getWorksheet("人物").getRow(1).getCell(10).value, "生存状态");
  const currentForm = new FormData();
  currentForm.append("file", new Blob([exportedBytes]), "current.xlsx");
  const currentPreview = await fetch(h.base + "/api/import/preview", {
    method: "POST", headers: { origin: ORIGIN, cookie: admin }, body: currentForm,
  });
  assert.equal(currentPreview.status, 200);
  assert.equal((await currentPreview.json()).people.length, 1);
});

test("电子族谱允许编辑成员上传，查看成员可预览下载但不能上传", async (t) => {
  const h = await harness();
  t.after(h.close);
  let r = await h.request("/setup", {
    method: "POST",
    body: {
      setupToken: "setup-secret",
      username: "admin",
      name: "管理员",
      password: "123456",
    },
  });
  const admin = r.cookie;
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("word/document.xml", '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>电子族谱预览测试</w:t></w:r></w:p></w:body></w:document>');
  const word = await zip.generateAsync({ type: "nodebuffer" });
  const form = new FormData();
  form.append(
    "file",
    new Blob([word], {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }),
    "家谱.docx",
  );
  let response = await fetch(h.base + "/api/family-documents", {
    method: "POST",
    headers: { origin: ORIGIN, cookie: admin },
    body: form,
  });
  assert.equal(response.status, 201);
  const document = await response.json();

  r = await h.request("/users", {
    method: "POST",
    cookie: admin,
    body: { name: "只读成员", phone: "13900000001" },
  });
  r = await h.request("/login", {
    method: "POST",
    body: { identifier: "只读成员", password: "13900000001" },
  });
  const viewer = r.cookie;
  response = await fetch(h.base + `/api/family-documents/${document.id}/preview`, {
    headers: { cookie: viewer },
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /电子族谱预览测试/);
  response = await fetch(h.base + `/api/family-documents/${document.id}/download`, {
    headers: { cookie: viewer },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-disposition"), /attachment/);

  const forbidden = new FormData();
  forbidden.append("file", new Blob([word]), "越权.docx");
  response = await fetch(h.base + "/api/family-documents", {
    method: "POST",
    headers: { origin: ORIGIN, cookie: viewer },
    body: forbidden,
  });
  assert.equal(response.status, 403);
});

test("一键备份只保留最近三次，并能恢复数据库内容", async (t) => {
  const h = await harness();
  t.after(h.close);
  let r = await h.request("/setup", {
    method: "POST",
    body: {
      setupToken: "setup-secret",
      username: "admin",
      name: "管理员",
      password: "123456",
    },
  });
  const admin = r.cookie;
  const original = await h.request("/family", { cookie: admin });
  for (let index = 0; index < 4; index += 1) {
    r = await h.request("/backups", { method: "POST", cookie: admin, body: {} });
    assert.equal(r.status, 201);
  }
  r = await h.request("/backups", { cookie: admin });
  assert.equal(r.status, 200);
  assert.equal(r.data.length, 3);
  const selected = r.data[2];
  r = await h.request("/family", {
    method: "PUT",
    cookie: admin,
    body: {
      version: original.data.version,
      data: { ...original.data.data, description: "恢复前临时内容" },
    },
  });
  assert.equal(r.status, 200);
  r = await h.request(`/backups/${selected.id}/restore`, {
    method: "POST",
    cookie: admin,
    body: {},
  });
  assert.equal(r.status, 200);
  r = await h.request("/login", {
    method: "POST",
    body: { identifier: "admin", password: "123456" },
  });
  const restored = await h.request("/family", { cookie: r.cookie });
  assert.equal(restored.data.data.description, original.data.data.description);
});

test("回收站人物超过七天后自动永久清理", async (t) => {
  const h = await harness();
  t.after(h.close);
  let r = await h.request("/setup", {
    method: "POST",
    body: {
      setupToken: "setup-secret",
      username: "admin",
      name: "管理员",
      password: "123456",
    },
  });
  const admin = r.cookie;
  r = await h.request("/people", {
    method: "POST",
    cookie: admin,
    body: person("过期回收人物"),
  });
  const id = r.data.id;
  const created = (await h.db.query("SELECT version FROM people WHERE id=$1", [id])).rows[0];
  await h.request(`/people/${id}`, {
    method: "DELETE",
    cookie: admin,
    body: { version: created.version },
  });
  await h.db.query("UPDATE people SET deleted_at=datetime('now','-8 days') WHERE id=$1", [id]);
  r = await h.request("/trash", { cookie: admin });
  assert.equal(r.status, 200);
  assert.equal(r.data.some((value) => value.id === id), false);
  assert.equal((await h.db.query("SELECT 1 FROM people WHERE id=$1", [id])).rowCount, 0);
});
