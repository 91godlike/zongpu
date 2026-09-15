import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { rateLimit } from "express-rate-limit";
import multer from "multer";
import sharp from "sharp";
import ExcelJS from "exceljs";
import WordExtractor from "word-extractor";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { transaction, audit } from "./db.mjs";
import { BackupManager, purgeExpiredTrash } from "./maintenance.mjs";
import {
  personSchema,
  familySchema,
  accountSchema,
  registrationSchema,
  normalizePhone,
  relationSchema,
  canRead,
  canEdit,
  sanitizePerson,
  checkGraph,
  warnings,
  fail,
} from "./domain.mjs";
import {
  token,
  digest,
  hashPassword,
  verifyPassword,
  equalSecret,
} from "./auth.mjs";

const familyDocumentTypes = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
const escapeHtml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
const originalName = (value) => {
  const name = String(value || "");
  if (/[^\x00-\xff]/.test(name)) return name;
  const decoded = Buffer.from(name, "latin1").toString("utf8");
  return decoded.includes("�") ? name : decoded;
};
function documentType(file) {
  const extension = path.extname(file.originalname || "").toLowerCase();
  const mime = familyDocumentTypes[extension];
  if (!mime) fail(415, "只支持 DOC、DOCX 和 PDF 文档");
  const buffer = file.buffer;
  const valid =
    (extension === ".pdf" && buffer.subarray(0, 5).toString() === "%PDF-") ||
    (extension === ".docx" && buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) ||
    (extension === ".doc" && buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])));
  if (!valid) fail(415, "文件内容与扩展名不一致");
  return mime;
}
function wordPreviewHtml(name, id, text) {
  const paragraphs = String(text || "")
    .slice(0, 1_000_000)
    .split(/\r?\n/)
    .map((line) => `<p>${escapeHtml(line) || "&nbsp;"}</p>`)
    .join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(name)}</title><style>body{margin:0;background:#f3f0e8;color:#263d36;font:16px/1.85 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}.bar{position:sticky;top:0;display:flex;justify-content:space-between;align-items:center;gap:20px;padding:14px 24px;background:#174f43;color:#fff}.bar strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bar a{flex:none;color:#fff4d4;text-decoration:none;border:1px solid #dfc78b;border-radius:7px;padding:7px 13px}.paper{box-sizing:border-box;width:min(900px,calc(100% - 28px));min-height:calc(100vh - 100px);margin:22px auto;padding:42px 54px;background:#fff;box-shadow:0 8px 30px #243d3420}.paper p{margin:.35em 0;white-space:pre-wrap;overflow-wrap:anywhere}.note{color:#7c715e;font-size:13px;margin-bottom:24px}@media(max-width:600px){.bar{padding:12px 14px}.paper{padding:24px 20px}}</style></head><body><div class="bar"><strong>${escapeHtml(name)}</strong><a href="/api/family-documents/${id}/download">下载原文件</a></div><main class="paper"><div class="note">Word 文档在线只读预览</div>${paragraphs || "<p>文档中没有可提取的文字内容，请下载原文件查看。</p>"}</main></body></html>`;
}

export function createApp(db, config) {
  const app = express(),
    configuredOrigin = config.origin ? new URL(config.origin).origin : "",
    configuredSecure = configuredOrigin.startsWith("https:");
  const documentDir = config.documentDir || path.join(path.dirname(config.uploadDir), "family-documents");
  const backupDir = config.backupDir || path.join(path.dirname(config.uploadDir), "managed-backups");
  const backups = new BackupManager(db, {
    backupDir,
    uploadDir: config.uploadDir,
    documentDir,
  });
  const wordExtractor = new WordExtractor();
  const publicOrigin = (req) =>
    configuredOrigin || `${req.protocol}://${req.get("host")}`;
  app.set("trust proxy", 1);
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 12 * 1024 * 1024, files: 2, fields: 4 },
  });
  const documentUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024, files: 1, fields: 2 },
  });
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:", "blob:"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: config.allowFrames ? ["'self'"] : ["'none'"],
          upgradeInsecureRequests: configuredSecure ? [] : null,
        },
      },
      strictTransportSecurity: configuredSecure ? undefined : false,
    }),
  );
  app.use(express.json({ limit: "3mb" }), cookieParser());
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      let requestOrigin = "";
      try {
        requestOrigin = new URL(req.headers.origin || "").origin;
      } catch {
        // Invalid or missing origins are rejected below.
      }
      if (requestOrigin !== publicOrigin(req))
        return res
          .status(403)
          .json({ error: "请求来源无效，请通过配置的应用网址访问" });
    }
    next();
  });
  const limited = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 40,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "尝试次数过多，请稍后重试" },
  });
  app.use(["/api/login", "/api/setup", "/api/register"], limited);
  const one = async (c, id, deleted = false) => {
    z.uuid().parse(id);
    const { rows } = await c.query(
      "SELECT * FROM people WHERE id=$1" +
        (deleted ? "" : " AND deleted_at IS NULL"),
      [id],
    );
    if (!rows[0]) fail(404, "人物不存在或已移入回收站");
    return rows[0];
  };
  const getUser = async (req) => {
    if (!req.cookies.zongpu_session) return null;
    const { rows } = await db.query(
      "SELECT u.id,u.username,u.name,u.role,u.branches FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=$1 AND s.expires_at>now() AND NOT u.disabled",
      [digest(req.cookies.zongpu_session)],
    );
    return rows[0] || null;
  };
  async function session(req, res, user) {
    const t = token();
    await db.query("DELETE FROM sessions WHERE expires_at<now()");
    await db.query(
      "INSERT INTO sessions(token,user_id,expires_at) VALUES($1,$2,now()+interval '7 days')",
      [digest(t), user.id],
    );
    res.cookie("zongpu_session", t, {
      httpOnly: true,
      secure: configuredOrigin ? configuredSecure : req.secure,
      sameSite: "strict",
      path: "/",
      maxAge: 7 * 86400000,
    });
  }
  app.get("/api/health", async (req, res) => {
    await db.query("SELECT 1");
    res.json({ status: "ok", version: "1.0" });
  });
  app.get("/api/session", async (req, res) => {
    const user = await getUser(req);
    const { rows } = await db.query(
      "SELECT EXISTS(SELECT 1 FROM users) AS ready",
    );
    res.json({ user, needsSetup: !rows[0].ready });
  });
  app.post("/api/setup", async (req, res) => {
    if (
      !config.setupToken ||
      !equalSecret(req.body.setupToken, config.setupToken)
    )
      fail(403, "初始化密钥不正确");
    const a = accountSchema.parse(req.body),
      password = await hashPassword(a.password);
    const u = await transaction(db, async (c) => {
      if ((await c.query("SELECT 1 FROM users LIMIT 1")).rowCount)
        fail(409, "系统已初始化");
      const u = {
        id: randomUUID(),
        username: a.username,
        name: a.name,
        role: "admin",
        branches: null,
      };
      await c.query(
        "INSERT INTO users(id,username,name,password,role) VALUES($1,$2,$3,$4,$5)",
        [u.id, u.username, u.name, password, u.role],
      );
      await audit(c, u, "初始化管理员", "user", u.id, null, { name: u.name });
      return u;
    });
    await session(req, res, u);
    res.status(201).json(u);
  });
  app.post("/api/login", async (req, res) => {
    const { identifier, password } = z
      .object({
        identifier: z.string().trim().min(1).max(80).optional(),
        username: z.string().trim().min(1).max(80).optional(),
        password: z.string().max(128),
      })
      .transform((value) => ({
        identifier: value.identifier || value.username || "",
        password: value.password,
      }))
      .refine((value) => value.identifier, { message: "请输入姓名或手机号" })
      .parse(req.body);
    const phone = normalizePhone(identifier);
    const looksLikePhone = /^\+?\d{6,20}$/.test(phone);
    const { rows } = await db.query(
      looksLikePhone
        ? "SELECT * FROM users WHERE NOT disabled AND (phone=$1 OR username=$2) LIMIT 20"
        : "SELECT * FROM users WHERE NOT disabled AND (username=$1 OR name=$1) LIMIT 20",
      looksLikePhone ? [phone, identifier] : [identifier],
    );
    const dummy = "00000000000000000000000000000000:" + "00".repeat(64);
    let matched = null;
    for (const candidate of rows)
      if (await verifyPassword(password, candidate.password)) {
        matched = candidate;
        break;
      }
    if (!rows.length) await verifyPassword(password, dummy);
    if (!matched) fail(401, "姓名、手机号或密码不正确");
    const { password: _, phone: __, disabled: ___, ...u } = matched;
    await session(req, res, u);
    res.json(u);
  });
  app.post("/api/register", async (req, res) => {
    const a = registrationSchema.parse(req.body),
      t = z.string().length(64).parse(req.body.token),
      hashed = await hashPassword(a.phone);
    const u = await transaction(db, async (c) => {
      const { rows } = await c.query(
        "SELECT * FROM invites WHERE token=$1 AND used_at IS NULL AND expires_at>now() FOR UPDATE",
        [digest(t)],
      );
      if (!rows[0]) fail(400, "邀请链接已失效或已使用");
      const i = rows[0];
      if ((await c.query("SELECT 1 FROM users WHERE phone=$1", [a.phone])).rowCount)
        fail(409, "该手机号已经登记，请直接登录或联系管理员");
      let username = a.name;
      if ((await c.query("SELECT 1 FROM users WHERE username=$1", [username])).rowCount)
        username = `${a.name}-${a.phone.slice(-4)}-${randomUUID().slice(0,4)}`;
      const u = {
          id: randomUUID(),
          username,
          name: a.name,
          phone: a.phone,
          role: "viewer",
          branches: null,
        };
      await c.query(
        "INSERT INTO users(id,username,name,phone,password,role,branches) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [u.id, u.username, u.name, u.phone, hashed, u.role, JSON.stringify(u.branches)],
      );
      await c.query("UPDATE invites SET used_at=now() WHERE id=$1", [i.id]);
      await audit(c, u, "接受邀请", "user", u.id, null, {
        name: u.name,
        role: u.role,
      });
      const { phone: _, ...safeUser } = u;
      return safeUser;
    });
    await session(req, res, u);
    res.status(201).json(u);
  });
  app.use("/api", async (req, res, next) => {
    if (req.query.share) {
      const { rows } = await db.query(
        "SELECT * FROM shares WHERE token=$1 AND NOT revoked AND expires_at>now()",
        [digest(String(req.query.share))],
      );
      if (rows[0])
        req.user = { role: "guest", branch: rows[0].branch, name: "分享访客" };
    } else req.user = await getUser(req);
    if (!req.user) fail(401, "请先登录");
    next();
  });
  const admin = (req, res, next) => {
    if (req.user.role !== "admin") fail(403, "需要管理员权限");
    next();
  };
  const editor = (req, res, next) => {
    if (!["admin", "editor"].includes(req.user.role))
      fail(403, "当前账号仅可查看");
    next();
  };
  const member = (req, res, next) => {
    if (!["admin", "editor", "viewer"].includes(req.user.role))
      fail(403, "需要家族成员账号");
    next();
  };
  app.post("/api/logout", async (req, res) => {
    await db.query("DELETE FROM sessions WHERE token=$1", [
      digest(req.cookies.zongpu_session || ""),
    ]);
    res.clearCookie("zongpu_session", { path: "/" }).json({ ok: true });
  });
  app.post("/api/password", async (req, res) => {
    if (!req.user.id) fail(403, "请先登录");
    const v = z
      .object({
        current: z.string().max(128),
        password: z.string().min(6, "密码至少 6 位").max(128),
      })
      .parse(req.body);
    const { rows } = await db.query("SELECT password FROM users WHERE id=$1", [
      req.user.id,
    ]);
    if (!(await verifyPassword(v.current, rows[0].password)))
      fail(403, "当前密码不正确");
    await transaction(db, async (c) => {
      await c.query("UPDATE users SET password=$1 WHERE id=$2", [
        await hashPassword(v.password),
        req.user.id,
      ]);
      await c.query("DELETE FROM sessions WHERE user_id=$1", [req.user.id]);
      await audit(c, req.user, "修改密码", "user", req.user.id, null, null);
    });
    res.clearCookie("zongpu_session", { path: "/" }).json({ ok: true });
  });
  async function graph(user, c = db) {
    const { rows } = await c.query(
      "SELECT * FROM people WHERE deleted_at IS NULL ORDER BY updated_at,id",
    );
    const people = rows
        .filter((r) => canRead(user, r.data))
        .map((r) => sanitizePerson(user, r)),
      ids = new Set(people.map((p) => p.id));
    const avatarByPerson = new Map();
    for (const attachment of (
      await c.query(
        "SELECT id,person_id FROM attachments WHERE deleted_at IS NULL AND mime LIKE 'image/%' ORDER BY created_at DESC,id DESC",
      )
    ).rows)
      if (ids.has(attachment.person_id) && !avatarByPerson.has(attachment.person_id))
        avatarByPerson.set(attachment.person_id, attachment.id);
    for (const person of people) {
      const avatarId = avatarByPerson.get(person.id);
      if (avatarId) person.avatarId = avatarId;
    }
    let rels = (
      await c.query("SELECT * FROM relations WHERE deleted_at IS NULL")
    ).rows.filter((r) => ids.has(r.source) && ids.has(r.target));
    return { people, relations: rels };
  }
  app.get("/api/graph", async (req, res) => res.json(await graph(req.user)));
  app.get("/api/family", async (req, res) => {
    const r = (await db.query("SELECT * FROM family WHERE id=1")).rows[0];
    res.json(r);
  });
  app.put("/api/family", admin, async (req, res) => {
    const data = familySchema.parse(req.body.data),
      v = z.number().int().positive().parse(req.body.version);
    await transaction(db, async (c) => {
      const before = (await c.query("SELECT * FROM family WHERE id=1")).rows[0];
      if (before.version !== v) fail(409, "家族资料已被其他人修改，请刷新");
      await c.query("UPDATE family SET data=$1,version=version+1 WHERE id=1", [
        data,
      ]);
      await audit(
        c,
        req.user,
        "编辑家族资料",
        "family",
        "1",
        before.data,
        data,
      );
    });
    res.json({ ok: true });
  });
  app.post("/api/people", editor, async (req, res) => {
    const data = personSchema.parse(req.body);
    const parentIds = z
      .array(z.uuid())
      .max(2, "一位人物最多选择两位父母")
      .optional()
      .parse(req.body.parentIds);
    const link = z
      .object({
        id: z.uuid(),
        direction: z.enum(["parent", "child", "partner"]),
      })
      .optional()
      .parse(req.body.link);
    if (!canEdit(req.user, data)) fail(403, "无权编辑该人物所属的范围");
    const id = randomUUID();
    await transaction(db, async (c) => {
      await c.query("INSERT INTO people(id,data) VALUES($1,$2)", [id, data]);
      await audit(c, req.user, "新增人物", "person", id, null, data);
      const links = [];
      if (parentIds && link?.direction !== "child") {
        for (const parentId of [...new Set(parentIds)]) {
          const parent = await one(c, parentId);
          if (!canEdit(req.user, parent.data))
            fail(403, "所选父母均需编辑权限");
          links.push({ source: parentId, target: id, type: "parent" });
        }
      }
      if (link) {
        const base = await one(c, link.id);
        if (!canEdit(req.user, base.data)) fail(403, "不能编辑关联人物");
        if (link.direction === "child") {
          const chosen = [...new Set(parentIds ?? [link.id])];
          for (const parentId of chosen) {
            const parent = await one(c, parentId);
            if (!canEdit(req.user, parent.data))
              fail(403, "所选父母均需编辑权限");
            links.push({ source: parentId, target: id, type: "parent" });
          }
        } else {
          let source = link.direction === "parent" ? id : link.id,
            target = link.direction === "parent" ? link.id : id;
          const type = link.direction === "partner" ? "partner" : "parent";
          if (type === "partner" && source > target)
            [source, target] = [target, source];
          links.push({ source, target, type });
        }
      }
      if (links.length) {
        const edges = (
          await c.query("SELECT * FROM relations WHERE deleted_at IS NULL")
        ).rows;
        checkGraph([...edges, ...links]);
        for (const relation of links) {
          const rid = randomUUID();
          await c.query(
            "INSERT INTO relations(id,source,target,type) VALUES($1,$2,$3,$4)",
            [rid, relation.source, relation.target, relation.type],
          );
          await audit(c, req.user, "新增关系", "relation", rid, null, relation);
        }
      }
    });
    res.status(201).json({ id });
  });
  app.put("/api/people/:id", editor, async (req, res) => {
    const data = personSchema.parse(req.body.data),
      v = z.number().int().positive().parse(req.body.version);
    const parentIds = z
      .array(z.uuid())
      .max(2, "一位人物最多选择两位父母")
      .optional()
      .parse(req.body.parentIds);
    await transaction(db, async (c) => {
      const before = await one(c, req.params.id);
      if (!canEdit(req.user, before.data) || !canEdit(req.user, data))
        fail(403, "无权编辑该人物所属的范围");
      if (before.version !== v)
        fail(
          409,
          "此人物已被其他人修改。你的输入已保留，请关闭表单刷新后核对。",
        );
      await c.query(
        "UPDATE people SET data=$1,version=version+1,updated_at=now() WHERE id=$2",
        [data, before.id],
      );
      await audit(
        c,
        req.user,
        "编辑人物",
        "person",
        before.id,
        before.data,
        data,
      );
      if (parentIds) {
        const selected = [...new Set(parentIds)];
        if (selected.includes(before.id)) fail(422, "不能把自己设为父母");
        for (const parentId of selected) {
          const parent = await one(c, parentId);
          if (!canEdit(req.user, parent.data))
            fail(403, "所选父母均需编辑权限");
        }
        const edges = (
          await c.query("SELECT * FROM relations WHERE deleted_at IS NULL")
        ).rows;
        const current = edges.filter(
          (r) => r.type === "parent" && r.target === before.id,
        );
        const finalEdges = [
          ...edges.filter((r) => !current.some((old) => old.id === r.id)),
          ...selected.map((source) => ({
            source,
            target: before.id,
            type: "parent",
          })),
        ];
        checkGraph(finalEdges);
        const selectedSet = new Set(selected);
        for (const old of current.filter((r) => !selectedSet.has(r.source))) {
          await c.query(
            "UPDATE relations SET deleted_at=now(),version=version+1 WHERE id=$1",
            [old.id],
          );
          await audit(c, req.user, "删除关系", "relation", old.id, old, null);
        }
        const currentSources = new Set(current.map((r) => r.source));
        for (const source of selected.filter((id) => !currentSources.has(id))) {
          const relation = { source, target: before.id, type: "parent" };
          const relationId = randomUUID();
          await c.query(
            "INSERT INTO relations(id,source,target,type) VALUES($1,$2,$3,$4)",
            [relationId, relation.source, relation.target, relation.type],
          );
          await audit(
            c,
            req.user,
            "新增关系",
            "relation",
            relationId,
            null,
            relation,
          );
        }
      }
    });
    res.json({ ok: true });
  });
  app.delete("/api/people/:id", admin, async (req, res) => {
    await transaction(db, async (c) => {
      const p = await one(c, req.params.id);
      if (p.version !== req.body.version) fail(409, "人物已更新，请刷新后重试");
      await c.query(
        "UPDATE people SET deleted_at=now(),version=version+1 WHERE id=$1",
        [p.id],
      );
      await audit(c, req.user, "移入回收站", "person", p.id, p.data, null);
    });
    res.json({ ok: true });
  });
  app.get("/api/trash", admin, async (req, res) => {
    await purgeExpiredTrash(db, config.uploadDir);
    res.json(
      (
        await db.query(
          "SELECT * FROM people WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC",
        )
      ).rows,
    );
  });
  app.post("/api/people/:id/restore", admin, async (req, res) => {
    await transaction(db, async (c) => {
      const p = await one(c, req.params.id, true);
      if (!p.deleted_at) fail(409, "人物已恢复");
      const edges = (
        await c.query("SELECT * FROM relations WHERE deleted_at IS NULL")
      ).rows;
      checkGraph(edges);
      await c.query(
        "UPDATE people SET deleted_at=NULL,version=version+1 WHERE id=$1",
        [p.id],
      );
      await audit(c, req.user, "恢复人物", "person", p.id, null, p.data);
    });
    res.json({ ok: true });
  });
  app.post("/api/relations", editor, async (req, res) => {
    const r = relationSchema.parse(req.body);
    if (r.type === "partner" && r.source > r.target)
      [r.source, r.target] = [r.target, r.source];
    const id = randomUUID();
    await transaction(db, async (c) => {
      const a = await one(c, r.source),
        b = await one(c, r.target);
      if (!canEdit(req.user, a.data) || !canEdit(req.user, b.data))
        fail(403, "关系两端的人物均需编辑权限");
      const edges = (
        await c.query("SELECT * FROM relations WHERE deleted_at IS NULL")
      ).rows;
      checkGraph([...edges, r]);
      await c.query(
        "INSERT INTO relations(id,source,target,type,data) VALUES($1,$2,$3,$4,$5)",
        [id, r.source, r.target, r.type, r.data],
      );
      await audit(c, req.user, "新增关系", "relation", id, null, r);
    });
    res.status(201).json({ id });
  });
  app.delete("/api/relations/:id", admin, async (req, res) => {
    z.uuid().parse(req.params.id);
    await transaction(db, async (c) => {
      const r = (
        await c.query(
          "SELECT * FROM relations WHERE id=$1 AND deleted_at IS NULL",
          [req.params.id],
        )
      ).rows[0];
      if (!r) fail(404, "关系不存在");
      await c.query(
        "UPDATE relations SET deleted_at=now(),version=version+1 WHERE id=$1",
        [r.id],
      );
      await audit(c, req.user, "删除关系", "relation", r.id, r, null);
    });
    res.json({ ok: true });
  });
  app.post("/api/merge/preview", admin, async (req, res) => {
    const { source, target } = z
      .object({ source: z.uuid(), target: z.uuid() })
      .parse(req.body);
    if (source === target) fail(422, "请选择两个不同人物");
    const a = await one(db, source),
      b = await one(db, target),
      edges = (
        await db.query(
          "SELECT * FROM relations WHERE deleted_at IS NULL AND (source=$1 OR target=$1)",
          [source],
        )
      ).rows;
    res.json({
      source: a,
      target: b,
      relations: edges,
      attachmentCount: (
        await db.query(
          "SELECT count(*)::int AS n FROM attachments WHERE person_id=$1",
          [source],
        )
      ).rows[0].n,
    });
  });
  app.post("/api/merge", admin, async (req, res) => {
    const v = z
      .object({
        source: z.uuid(),
        target: z.uuid(),
        sourceVersion: z.number().int(),
        targetVersion: z.number().int(),
      })
      .parse(req.body);
    if (v.source === v.target) fail(422, "请选择两个不同人物");
    await transaction(db, async (c) => {
      const a = await one(c, v.source),
        b = await one(c, v.target);
      if (a.version !== v.sourceVersion || b.version !== v.targetVersion)
        fail(409, "人物已修改，请重新预览");
      const before = (
        await c.query("SELECT * FROM relations WHERE deleted_at IS NULL")
      ).rows;
      const seen = new Set(),
        changed = [];
      for (const edge of before) {
        const r = {
          ...edge,
          source: edge.source === a.id ? b.id : edge.source,
          target: edge.target === a.id ? b.id : edge.target,
        };
        if (r.source === r.target)
          fail(422, "合并会产生自身关系，请先核对并删除错误关系");
        if (r.type === "partner" && r.source > r.target)
          [r.source, r.target] = [r.target, r.source];
        const key = `${r.source}|${r.target}|${r.type}`;
        if (seen.has(key))
          fail(422, "合并会产生重复关系，请先核对重复关系，避免丢失来源说明");
        seen.add(key);
        changed.push(r);
      }
      checkGraph(changed);
      for (const r of changed)
        await c.query(
          "UPDATE relations SET source=$1,target=$2,version=version+1 WHERE id=$3",
          [r.source, r.target, r.id],
        );
      await c.query("UPDATE attachments SET person_id=$1 WHERE person_id=$2", [
        b.id,
        a.id,
      ]);
      await c.query(
        "UPDATE people SET deleted_at=now(),version=version+1 WHERE id=$1",
        [a.id],
      );
      await c.query("UPDATE people SET version=version+1 WHERE id=$1", [b.id]);
      await audit(
        c,
        req.user,
        "合并人物（保留目标资料）",
        "merge",
        b.id,
        { source: a, target: b, relations: before },
        { source: a.id, target: b.id },
      );
    });
    res.json({ ok: true });
  });
  app.get("/api/audit", async (req, res) => {
    if (req.user.role === "guest" || req.user.role === "viewer")
      fail(403, "需要编辑权限");
    const page = Math.max(0, Math.min(100000, Number(req.query.page) || 0));
    const rows = (
      await db.query(
        "SELECT a.*,u.name AS actor_name FROM audit a LEFT JOIN users u ON u.id=a.actor ORDER BY a.id DESC LIMIT 100 OFFSET $1",
        [page * 100],
      )
    ).rows;
    const allowed =
      req.user.role === "admin"
        ? rows
        : rows.filter(
            (r) =>
              r.entity === "person" &&
              (!r.before_data || canEdit(req.user, r.before_data)) &&
              (!r.after_data || canEdit(req.user, r.after_data)),
          );
    res.json(allowed);
  });
  app.get("/api/users", admin, async (req, res) =>
    res.json(
      (
        await db.query(
          "SELECT id,username,name,phone,role,branches,disabled,created_at FROM users ORDER BY created_at",
        )
      ).rows,
    ),
  );
  app.post("/api/users", admin, async (req, res) => {
    const account = registrationSchema.parse(req.body),
      hashed = await hashPassword(account.phone);
    const user = await transaction(db, async (c) => {
      if (
        (await c.query("SELECT 1 FROM users WHERE phone=$1", [account.phone]))
          .rowCount
      )
        fail(409, "该手机号已经登记");
      let username = account.name;
      if (
        (await c.query("SELECT 1 FROM users WHERE username=$1", [username]))
          .rowCount
      )
        username = `${account.name}-${account.phone.slice(-4)}-${randomUUID().slice(0, 4)}`;
      const created = {
        id: randomUUID(),
        username,
        name: account.name,
        phone: account.phone,
        role: "viewer",
        branches: null,
        disabled: false,
      };
      await c.query(
        "INSERT INTO users(id,username,name,phone,password,role,branches) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          created.id,
          created.username,
          created.name,
          created.phone,
          hashed,
          created.role,
          JSON.stringify(created.branches),
        ],
      );
      await audit(c, req.user, "新建成员账号", "user", created.id, null, {
        name: created.name,
        role: created.role,
      });
      return created;
    });
    res.status(201).json(user);
  });
  app.patch("/api/users/:id", admin, async (req, res) => {
    const data = z
      .object({
        role: z.enum(["admin", "editor", "viewer"]),
        disabled: z.boolean(),
      })
      .parse(req.body);
    z.uuid().parse(req.params.id);
    await transaction(db, async (c) => {
      const b = (
        await c.query(
          "SELECT id,name,role,branches,disabled FROM users WHERE id=$1",
          [req.params.id],
        )
      ).rows[0];
      if (!b) fail(404, "账号不存在");
      if (b.id === req.user.id && (data.disabled || data.role !== "admin"))
        fail(422, "不能停用自己或移除自己的管理员权限");
      await c.query(
        "UPDATE users SET role=$1,branches=NULL,disabled=$2 WHERE id=$3",
        [data.role, data.disabled, b.id],
      );
      await c.query("DELETE FROM sessions WHERE user_id=$1", [b.id]);
      await audit(c, req.user, "修改成员权限", "user", b.id, b, data);
    });
    res.json({ ok: true });
  });
  app.post("/api/users/:id/reset-password", admin, async (req, res) => {
    z.uuid().parse(req.params.id);
    await transaction(db, async (c) => {
      const member = (
        await c.query("SELECT id,phone,role FROM users WHERE id=$1", [
          req.params.id,
        ])
      ).rows[0];
      if (!member) fail(404, "账号不存在");
      if (member.role === "admin") fail(422, "管理员密码请由本人修改");
      if (!member.phone) fail(422, "该成员没有登记手机号码，无法重置");
      await c.query(
        "UPDATE users SET password=$1 WHERE id=$2 RETURNING id",
        [await hashPassword(member.phone), req.params.id],
      );
      await c.query("DELETE FROM sessions WHERE user_id=$1", [req.params.id]);
      await audit(
        c,
        req.user,
        "重置成员密码",
        "user",
        req.params.id,
        null,
        null,
      );
    });
    res.json({ ok: true });
  });
  app.get("/api/invites", admin, async (req, res) =>
    res.json(
      (
        await db.query(
          "SELECT id,role,branches,expires_at,used_at FROM invites WHERE expires_at>now() ORDER BY expires_at DESC LIMIT 100",
        )
      ).rows,
    ),
  );
  app.post("/api/invites", admin, async (req, res) => {
    const v = z
        .object({
          days: z.number().int().min(1).max(30).default(7),
        })
        .parse(req.body),
      t = token(),
      id = randomUUID(),
      expiresAt = new Date(Date.now() + v.days * 86400000);
    await transaction(db, async (c) => {
      await c.query(
        "INSERT INTO invites(id,token,role,branches,expires_at,created_by) VALUES($1,$2,$3,$4,$5,$6)",
        [
          id,
          digest(t),
          "viewer",
          JSON.stringify(null),
          expiresAt,
          req.user.id,
        ],
      );
      await audit(c, req.user, "创建邀请", "invite", id, null, {
        role: "viewer",
        branches: null,
        days: v.days,
      });
    });
    res.status(201).json({ url: `${publicOrigin(req)}/?invite=${t}` });
  });
  app.delete("/api/invites/:id", admin, async (req, res) => {
    z.uuid().parse(req.params.id);
    await db.query("UPDATE invites SET expires_at=now() WHERE id=$1", [
      req.params.id,
    ]);
    res.json({ ok: true });
  });
  app.get("/api/shares", admin, async (req, res) =>
    res.json(
      (
        await db.query(
          "SELECT id,branch,expires_at,revoked FROM shares ORDER BY expires_at DESC",
        )
      ).rows,
    ),
  );
  app.post("/api/shares", admin, async (req, res) => {
    const v = z
        .object({
          days: z.union([z.literal(1), z.literal(7), z.literal(30)]),
        })
        .parse(req.body),
      t = token(),
      id = randomUUID(),
      expiresAt = new Date(Date.now() + v.days * 86400000);
    await transaction(db, async (c) => {
      await c.query(
        "INSERT INTO shares(id,token,branch,expires_at) VALUES($1,$2,$3,$4)",
        [id, digest(t), "*", expiresAt],
      );
      await audit(c, req.user, "创建只读分享", "share", id, null, v);
    });
    res.status(201).json({ url: `${publicOrigin(req)}/?share=${t}` });
  });
  app.delete("/api/shares/:id", admin, async (req, res) => {
    z.uuid().parse(req.params.id);
    await transaction(db, async (c) => {
      await c.query("UPDATE shares SET revoked=true WHERE id=$1", [
        req.params.id,
      ]);
      await audit(c, req.user, "撤销分享", "share", req.params.id, null, null);
    });
    res.json({ ok: true });
  });
  app.get("/api/backups", admin, async (req, res) =>
    res.json(await backups.list()),
  );
  app.post("/api/backups", admin, async (req, res) => {
    const created = await backups.create("手动备份");
    await transaction(db, (client) =>
      audit(client, req.user, "创建完整备份", "backup", created.id, null, {
        size: created.size,
        createdAt: created.createdAt,
      }),
    );
    const { files, ...summary } = created;
    res.status(201).json({ ...summary, fileCount: files.length });
  });
  app.post("/api/backups/:id/restore", admin, async (req, res) => {
    const id = z.string().regex(/^managed-\d{14}-[0-9a-f]{8}$/).parse(req.params.id);
    const result = await backups.restore(id);
    res.clearCookie("zongpu_session", { path: "/" }).json({
      ok: true,
      restoredAt: result.restored.createdAt,
      safetyBackup: result.safety.id,
    });
  });
  app.get("/api/family-documents", member, async (req, res) =>
    res.json(
      (
        await db.query(
          "SELECT d.id,d.name,d.mime,d.size,d.created_at,u.name AS created_by_name FROM family_documents d LEFT JOIN users u ON u.id=d.created_by ORDER BY d.created_at DESC,d.id DESC",
        )
      ).rows,
    ),
  );
  app.post(
    "/api/family-documents",
    editor,
    documentUpload.single("file"),
    async (req, res) => {
      if (!req.file) fail(400, "请选择文档");
      const mime = documentType(req.file);
      if (mime !== "application/pdf") {
        try {
          await wordExtractor.extract(req.file.buffer);
        } catch {
          fail(415, "Word 文档损坏或无法读取");
        }
      }
      const id = randomUUID();
      const name = path.basename(originalName(req.file.originalname)).slice(0, 200);
      await mkdir(documentDir, { recursive: true });
      await writeFile(path.join(documentDir, id), req.file.buffer, { flag: "wx" });
      try {
        await transaction(db, async (client) => {
          await client.query(
            "INSERT INTO family_documents(id,name,mime,size,created_by) VALUES($1,$2,$3,$4,$5)",
            [id, name, mime, req.file.buffer.length, req.user.id],
          );
          await audit(client, req.user, "上传电子族谱", "family_document", id, null, {
            name,
            mime,
            size: req.file.buffer.length,
          });
        });
      } catch (error) {
        await unlink(path.join(documentDir, id)).catch(() => {});
        throw error;
      }
      res.status(201).json({ id, name, mime, size: req.file.buffer.length });
    },
  );
  const familyDocument = async (id) => {
    z.uuid().parse(id);
    const row = (
      await db.query("SELECT * FROM family_documents WHERE id=$1", [id])
    ).rows[0];
    if (!row) fail(404, "电子族谱不存在");
    return row;
  };
  app.get("/api/family-documents/:id/download", member, async (req, res) => {
    const document = await familyDocument(req.params.id);
    res.set({
      "Content-Type": document.mime,
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(document.name)}`,
      "X-Content-Type-Options": "nosniff",
    });
    res.send(await readFile(path.join(documentDir, document.id)));
  });
  app.get("/api/family-documents/:id/preview", member, async (req, res) => {
    const document = await familyDocument(req.params.id);
    const content = await readFile(path.join(documentDir, document.id));
    if (document.mime === "application/pdf") {
      res.set({
        "Content-Type": document.mime,
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(document.name)}`,
        "X-Content-Type-Options": "nosniff",
      });
      return res.send(content);
    }
    let extracted;
    try {
      extracted = await wordExtractor.extract(content);
    } catch {
      fail(422, "Word 文档暂时无法预览，请下载原文件查看");
    }
    res.set({
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
    });
    res.send(wordPreviewHtml(document.name, document.id, extracted.getBody()));
  });
  app.delete("/api/family-documents/:id", editor, async (req, res) => {
    const document = await familyDocument(req.params.id);
    await transaction(db, async (client) => {
      await client.query("DELETE FROM family_documents WHERE id=$1", [document.id]);
      await audit(client, req.user, "删除电子族谱", "family_document", document.id, document, null);
    });
    await unlink(path.join(documentDir, document.id)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    res.json({ ok: true });
  });
  app.get("/api/people/:id/attachments", async (req, res) => {
    const p = await one(db, req.params.id);
    if (!canRead(req.user, p.data)) fail(404, "人物不存在");
    res.json(
      (
        await db.query(
          "SELECT id,person_id,name,mime,size,created_at FROM attachments WHERE person_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC",
          [p.id],
        )
      ).rows,
    );
  });
  app.post(
    "/api/people/:id/attachments",
    editor,
    upload.fields([
      { name: "file", maxCount: 1 },
      { name: "crop", maxCount: 1 },
    ]),
    async (req, res) => {
      const p = await one(db, req.params.id);
      if (!canEdit(req.user, p.data)) fail(403, "无权上传此人物资料");
      const uploaded = req.files?.file?.[0];
      const crop = req.files?.crop?.[0];
      if (!uploaded) fail(400, "请选择文件");
      const id = randomUUID(),
        buf = uploaded.buffer;
      let mime, content, thumb;
      if (buf.subarray(0, 5).toString() === "%PDF-") {
        mime = "application/pdf";
        content = buf;
      } else {
        try {
          const meta = await sharp(buf, {
            limitInputPixels: 40000000,
          }).metadata();
          if (!["jpeg", "png", "webp"].includes(meta.format))
            fail(415, "只支持 JPG、PNG、WebP 和 PDF");
          content = await sharp(buf, { limitInputPixels: 40000000 })
            .rotate()
            .webp({ quality: 88 })
            .toBuffer();
          if (crop) {
            const cropMeta = await sharp(crop.buffer, {
              limitInputPixels: 4000000,
            }).metadata();
            if (
              !["jpeg", "png", "webp"].includes(cropMeta.format) ||
              !cropMeta.width ||
              !cropMeta.height ||
              Math.abs(cropMeta.width - cropMeta.height) > 2
            )
              fail(415, "头像裁剪结果无效");
            thumb = await sharp(crop.buffer)
              .resize(300, 300, { fit: "cover" })
              .webp({ quality: 82 })
              .toBuffer();
          } else {
            thumb = await sharp(content)
              .resize(300, 300, { fit: "inside", withoutEnlargement: true })
              .webp({ quality: 75 })
              .toBuffer();
          }
          mime = "image/webp";
        } catch (e) {
          if (e.status) throw e;
          fail(415, "图片无效或分辨率过大");
        }
      }
      await mkdir(config.uploadDir, { recursive: true });
      await writeFile(path.join(config.uploadDir, id), content, { flag: "wx" });
      if (thumb)
        await writeFile(path.join(config.uploadDir, id + ".thumb"), thumb, {
          flag: "wx",
        });
      await transaction(db, async (c) => {
        const current = await one(c, p.id);
        if (!canEdit(req.user, current.data)) fail(403, "无权上传");
        await c.query(
          "INSERT INTO attachments(id,person_id,name,mime,size,created_by) VALUES($1,$2,$3,$4,$5,$6)",
          [
            id,
            p.id,
            originalName(uploaded.originalname).slice(0, 200),
            mime,
            content.length,
            req.user.id,
          ],
        );
        await audit(c, req.user, "上传资料", "attachment", id, null, {
          person: p.id,
          name: originalName(uploaded.originalname),
        });
      });
      res.status(201).json({ id });
    },
  );
  app.get("/api/attachments/:id", async (req, res) => {
    z.uuid().parse(req.params.id);
    const a = (
      await db.query(
        "SELECT * FROM attachments WHERE id=$1 AND deleted_at IS NULL",
        [req.params.id],
      )
    ).rows[0];
    if (!a) fail(404, "资料不存在");
    const p = await one(db, a.person_id);
    if (!canRead(req.user, p.data))
      fail(404, "资料不存在");
    res.set("Content-Type", a.mime);
    if (a.mime === "application/pdf")
      res.set(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(a.name)}`,
      );
    res.send(
      await readFile(
        path.join(
          config.uploadDir,
          a.id +
            (req.query.thumb && a.mime.startsWith("image/") ? ".thumb" : ""),
        ),
      ),
    );
  });
  app.delete("/api/attachments/:id", editor, async (req, res) => {
    z.uuid().parse(req.params.id);
    await transaction(db, async (c) => {
      const a = (
        await c.query(
          "SELECT * FROM attachments WHERE id=$1 AND deleted_at IS NULL",
          [req.params.id],
        )
      ).rows[0];
      if (!a) fail(404, "资料不存在");
      const p = await one(c, a.person_id);
      if (!canEdit(req.user, p.data)) fail(403, "无权删除");
      await c.query("UPDATE attachments SET deleted_at=now() WHERE id=$1", [
        a.id,
      ]);
      await audit(c, req.user, "删除资料", "attachment", a.id, a, null);
    });
    res.json({ ok: true });
  });
  const columns = [
    "编号",
    "姓名",
    "曾用名",
    "性别",
    "出生日期（公历）",
    "出生日期（农历）",
    "籍贯",
    "现居地",
    "电话号码",
    "生存状态",
    "去世记载",
    "人物简介",
  ];
  const fields = [
    "key",
    "name",
    "alias",
    "gender",
    "birth",
    "birthLunar",
    "origin",
    "residence",
    "phone",
    "status",
    "death",
    "biography",
  ];
  const legacyColumns = ["编号","姓名","曾用名","性别","家庭分组","资料记载代数","出生记载","去世记载","历法","状态","籍贯","居住地","联系方式","生平简介","资料来源","核实状态"];
  const legacyFields = ["key","name","alias","gender","branch","generation","birth","death","calendar","status","origin","residence","phone","biography","source","certainty"];
  const labels = {
    gender: { male: "男", female: "女", unknown: "不详" },
    calendar: { solar: "公历", lunar: "农历", unknown: "不详" },
    status: { living: "在世", deceased: "已故", unknown: "不详" },
    certainty: { verified: "已核实", pending: "待核实", disputed: "有争议" },
  };
  async function workbookExport(req, res, template) {
    const wb = new ExcelJS.Workbook(),
      ws = wb.addWorksheet("人物"),
      rs = wb.addWorksheet("关系"),
      guide = wb.addWorksheet("填写说明");
    ws.addRow(columns);
    rs.addRow([
      "起点编号",
      "终点编号",
      "关系类型",
      "开始记载",
      "结束记载",
      "说明",
    ]);
    guide.addRow([
      "人物编号必须唯一，关系通过编号连接，不能用姓名代替编号。仅导入可见的“人物”和“关系”工作表。",
    ]);
    guide.addRow([
      "性别：男/女/不详；生存状态：在世/已故/不详。只有已故人物填写去世记载。",
    ]);
    guide.addRow([
      "关系类型：父母子女/配偶。父母子女关系方向为父母 → 子女。",
    ]);
    guide.addRow([
      "导入只新增，不覆盖已有档案；同名会提示核对。每批最多 500 人、1000 条关系。",
    ]);
    if (!template) {
      const g = await graph(req.user);
      for (const original of g.people) {
        const legacyLunar = original.calendar === "lunar" && !original.birthLunar;
        const p = { ...original, birth: legacyLunar ? "" : original.birth || "", birthLunar: original.birthLunar || (legacyLunar ? original.birth || "" : ""), death: original.status === "deceased" ? original.death || "" : "" };
        ws.addRow(
          fields.map((f) =>
            f === "key" ? p.id : (labels[f]?.[p[f]] ?? p[f] ?? ""),
          ),
        );
      }
      for (const r of g.relations)
        rs.addRow([
          r.source,
          r.target,
          {
            parent: "父母子女",
            partner: "配偶",
          }[r.type],
          r.data.start || "",
          r.data.end || "",
          r.data.note || "",
        ]);
    }
    for (const sheet of [ws, rs]) {
      sheet.views = [{ state: "frozen", ySplit: 1 }];
      sheet.columns.forEach((c) => (c.width = 20));
      sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
      sheet.getRow(1).fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF284B40" },
      };
    }
    res.set(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.set(
      "Content-Disposition",
      `attachment; filename="zongpu-${template ? "template" : "export"}.xlsx"`,
    );
    res.send(Buffer.from(await wb.xlsx.writeBuffer()));
  }
  app.get("/api/import/template", editor, (req, res) =>
    workbookExport(req, res, true),
  );
  app.get("/api/export.xlsx", async (req, res) =>
    workbookExport(req, res, false),
  );
  app.get("/api/export.json", async (req, res) => {
    const g = await graph(req.user),
      f = (await db.query("SELECT data FROM family WHERE id=1")).rows[0].data;
    res.set("Content-Disposition", 'attachment; filename="zongpu-data.json"');
    res.json({
      schema: 1,
      exportedAt: new Date().toISOString(),
      family: f,
      ...g,
    });
  });
  app.post(
    "/api/import/preview",
    admin,
    upload.single("file"),
    async (req, res) => {
      if (!req.file) fail(400, "请选择 xlsx 文件");
      const buf = req.file.buffer;
      let total = 0,
        entries = 0;
      for (let i = 0; i + 46 < buf.length; i++) {
        if (buf.readUInt32LE(i) === 0x02014b50) {
          total += buf.readUInt32LE(i + 24);
          entries++;
        }
      }
      if (!entries || total > 30 * 1024 * 1024 || entries > 500)
        fail(422, "文件过大或不是有效的 xlsx，请每批最多导入 500 人");
      const wb = new ExcelJS.Workbook();
      try {
        await wb.xlsx.load(buf);
      } catch {
        fail(422, "无法读取 xlsx 文件");
      }
      const ws = wb.getWorksheet("人物"),
        rs = wb.getWorksheet("关系");
      if (!ws || ws.state !== "visible") fail(422, "缺少可见的“人物”工作表");
      if (ws.rowCount > 501 || (rs?.rowCount || 0) > 1001)
        fail(422, "每批最多 500 人、1000 条关系");
      const val = (row, i) => {
        const v = row.getCell(i).value;
        if (v === null || v === undefined) return "";
        if (typeof v === "object")
          fail(422, "请使用纯文本或数字，不能包含公式、富文本或日期格式");
        return String(v).trim();
      };
      const headerMatches = (expected, legacy = false) => expected.every((h, i) => {
        const actual = val(ws.getRow(1), i + 1);
        return actual === h || (legacy && i === 4 && actual === "支系") || (legacy && i === 5 && actual === "谱载世次");
      });
      const importFields = headerMatches(columns) ? fields : headerMatches(legacyColumns, true) ? legacyFields : null;
      if (!importFields)
        fail(422, "列名不匹配，请下载并使用模板");
      const people = [],
        relations = [],
        issues = [],
        keys = new Map(),
        existing = (await graph(req.user)).people;
      for (let row = 2; row <= ws.rowCount; row++) {
        const vals = importFields.map((_, i) => val(ws.getRow(row), i + 1));
        if (vals.every((x) => !x)) continue;
        const raw = Object.fromEntries(importFields.map((f, i) => [f, vals[i]]));
        if (!raw.key || keys.has(raw.key))
          fail(422, `第 ${row} 行编号为空或重复`);
        for (const [f, m] of Object.entries(labels)) {
          if (!(f in raw)) continue;
          raw[f] =
            Object.entries(m).find(
              ([k, v]) => v === raw[f] || k === raw[f],
            )?.[0] ||
            (f === "certainty" ? "pending" : f === "status" ? "living" : "unknown");
        }
        const data = personSchema.parse(raw),
          id = randomUUID();
        keys.set(raw.key, id);
        people.push({ id, data });
        for (const w of warnings(data, [
          ...existing,
          ...people.slice(0, -1).map((p) => p.data),
        ]))
          issues.push(`第 ${row} 行 ${data.name}：${w}`);
      }
      if (rs?.state === "visible")
        for (let row = 2; row <= rs.rowCount; row++) {
          const vals = Array.from({ length: 6 }, (_, i) =>
            val(rs.getRow(row), i + 1),
          );
          if (vals.every((x) => !x)) continue;
          let [a, b, t, start, end, note] = vals;
          const source = keys.get(a),
            target = keys.get(b);
          if (!source || !target)
            fail(422, `关系第 ${row} 行引用了本次人物表中不存在的编号`);
          const type = { 父母子女: "parent", 配偶: "partner" }[t];
          const r = relationSchema.parse({
            source,
            target,
            type,
            data: { start, end, note },
          });
          if (r.type === "partner" && r.source > r.target)
            [r.source, r.target] = [r.target, r.source];
          relations.push({ ...r, id: randomUUID() });
        }
      if (!people.length) fail(422, "没有可导入的人物");
      checkGraph(relations);
      const seen = new Set();
      for (const r of relations) {
        const k = [r.source, r.target, r.type].join(":");
        if (seen.has(k)) fail(422, "关系表存在重复关系");
        seen.add(k);
      }
      const id = randomUUID(),
        data = { people, relations, issues };
      await db.query("DELETE FROM import_previews WHERE expires_at<now()");
      await db.query(
        "INSERT INTO import_previews(id,user_id,data,expires_at) VALUES($1,$2,$3,now()+interval '30 minutes')",
        [id, req.user.id, data],
      );
      res.json({ id, ...data });
    },
  );
  app.post("/api/import/commit", admin, async (req, res) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.body);
    await transaction(db, async (c) => {
      const p = (
        await c.query(
          "SELECT * FROM import_previews WHERE id=$1 AND user_id=$2 AND expires_at>now() FOR UPDATE",
          [id, req.user.id],
        )
      ).rows[0];
      if (!p) fail(400, "预览已失效，请重新上传");
      for (const item of p.data.people)
        await c.query("INSERT INTO people(id,data) VALUES($1,$2)", [
          item.id,
          item.data,
        ]);
      for (const r of p.data.relations)
        await c.query(
          "INSERT INTO relations(id,source,target,type,data) VALUES($1,$2,$3,$4,$5)",
          [r.id, r.source, r.target, r.type, r.data],
        );
      await audit(c, req.user, "批量导入", "import", id, null, p.data);
      await c.query("DELETE FROM import_previews WHERE id=$1", [id]);
    });
    res.json({ ok: true });
  });
  app.post("/api/people/:id/revert", admin, async (req, res) => {
    const v = z
      .object({ auditId: z.string().regex(/^\d+$/), version: z.number().int() })
      .parse(req.body);
    await transaction(db, async (c) => {
      const p = await one(c, req.params.id);
      if (p.version !== v.version) fail(409, "人物已更新，请刷新");
      const log = (
        await c.query(
          "SELECT * FROM audit WHERE id=$1 AND entity='person' AND entity_id=$2",
          [v.auditId, p.id],
        )
      ).rows[0];
      if (!log?.before_data) fail(422, "该记录没有可恢复的历史资料");
      const data = personSchema.parse(log.before_data);
      await c.query(
        "UPDATE people SET data=$1,version=version+1,updated_at=now() WHERE id=$2",
        [data, p.id],
      );
      await audit(c, req.user, "恢复历史资料", "person", p.id, p.data, data);
    });
    res.json({ ok: true });
  });
  app.use("/api", (req, res) => res.status(404).json({ error: "接口不存在" }));
  app.use(express.static(config.distDir, { index: false, maxAge: "1h" }));
  app.get("/{*path}", (req, res) => {
    res
      .set("Cache-Control", "no-cache")
      .sendFile(path.join(config.distDir, "index.html"));
  });
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof z.ZodError)
      return res.status(422).json({
        error: err.issues
          .map((i) => `${i.path.join(".")}：${i.message}`)
          .join("；"),
      });
    if (err.code === "23505")
      return res
        .status(409)
        .json({ error: "账号或关系已存在，请检查重复记录" });
    if (err.code === "LIMIT_FILE_SIZE")
      return res.status(413).json({ error: "文件大小超过允许上限" });
    if (err.code === "22P02")
      return res.status(422).json({ error: "数据格式不正确" });
    const status = err.status || 500;
    if (status === 500)
      console.error(
        "request failed",
        req.method,
        req.path,
        err.code || err.message,
      );
    res.status(status).json({
      error: status === 500 ? "服务暂时无法处理请求，请稍后重试" : err.message,
    });
  });
  return app;
}
