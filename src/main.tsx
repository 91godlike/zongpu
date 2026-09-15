import React, { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  GitBranch,
  Users,
  BookOpen,
  History,
  Database,
  UserPlus,
  Search,
  Plus,
  X,
  ChevronRight,
  Menu,
  LogOut,
  Edit3,
  Download,
  Upload,
  Trash2,
  Link,
  ArrowLeft,
  Shield,
  FileText,
  Image as ImageIcon,
  Check,
  Settings,
  RefreshCw,
  Printer,
  Copy,
  Lock,
  Share2,
  PanelLeftClose,
  PanelLeftOpen,
  UserRound,
  Eye,
  ArchiveRestore,
  FileArchive,
  Crop,
  Info,
} from "lucide-react";
import { api, apiUrl, demoMode, download, shareToken } from "./api";
import { Graph, pathBetween } from "./Graph";
import { generationLevels } from "./family-layout";
import {
  Person,
  Relation,
  User,
  GraphData,
  canEdit,
  emptyPerson,
  fieldLabels,
  genderLabels,
  statusLabels,
  solarBirth,
  lunarBirth,
  displayedBirth,
} from "./types";
import "./style.css";
const pages = [
  ["tree", "家谱图", GitBranch],
  ["people", "人物名录", Users],
  ["family", "家族资料", BookOpen],
  ["audit", "修改记录", History],
  ["users", "成员管理", Users],
  ["data", "数据管理", Database],
] as const;
const instant = (t: string) =>
  new Date(/(?:Z|[+-]\d{2}:\d{2})$/.test(t) ? t : t.replace(" ", "T") + "Z");
const time = (t: string) =>
  instant(t).toLocaleString("zh-CN", { hour12: false });
const fileSize = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const chineseGeneration = (value: number) => {
  const digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
  if (value <= 10) return digits[value];
  if (value < 20) return `十${value % 10 ? digits[value % 10] : ""}`;
  if (value < 100)
    return `${digits[Math.floor(value / 10)]}十${value % 10 ? digits[value % 10] : ""}`;
  return String(value);
};
function parentSlots(ids: string[], data: GraphData): [string, string] {
  let father = "",
    mother = "";
  for (const id of ids) {
    const gender = data.people.find((p) => p.id === id)?.gender;
    if (gender === "male" && !father) father = id;
    else if (gender === "female" && !mother) mother = id;
    else if (!father) father = id;
    else if (!mother) mother = id;
  }
  return [father, mother];
}
function initialParentSlots(
  data: GraphData,
  person?: Person,
  link?: { id: string; direction: string },
): [string, string] {
  if (person) {
    return parentSlots(
      data.relations
        .filter((r) => r.type !== "partner" && r.target === person.id)
        .map((r) => r.source),
      data,
    );
  }
  if (link?.direction !== "child") return ["", ""];
  const base = data.people.find((p) => p.id === link.id);
  const partners = data.relations
    .filter(
      (r) =>
        r.type === "partner" && (r.source === link.id || r.target === link.id),
    )
    .map((r) =>
      data.people.find((p) => p.id === (r.source === link.id ? r.target : r.source)),
    )
    .filter((p): p is Person => Boolean(p));
  const opposite = partners.find(
    (p) =>
      (base?.gender === "male" && p.gender === "female") ||
      (base?.gender === "female" && p.gender === "male"),
  );
  return parentSlots(
    [link.id, opposite?.id || partners[0]?.id].filter(Boolean) as string[],
    data,
  );
}
function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", fn);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", fn);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className={"modal " + (wide ? "wide" : "")}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header>
          <h2>{title}</h2>
          <button className="icon-button" aria-label="关闭" onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
function Field({
  label,
  children,
  full = false,
}: {
  label: string;
  children: React.ReactNode;
  full?: boolean;
}) {
  return (
    <label className={full ? "field full" : "field"}>
      <span>{label}</span>
      {children}
    </label>
  );
}
function ErrorText({ error }: { error: string }) {
  return error ? (
    <p className="error" role="alert">
      {error}
    </p>
  ) : null;
}
function Brand() {
  return (
    <div className="brand">
      <span className="brand-cn"><span>宗</span><span>谱</span></span>
      <small aria-label="FAMILY ARCHIVE">
        {Array.from("FAMILY ARCHIVE").map((letter, index) => (
          <span aria-hidden="true" key={index}>{letter === " " ? "\u00a0" : letter}</span>
        ))}
      </small>
    </div>
  );
}
function Auth({
  needsSetup,
  onSuccess,
}: {
  needsSetup: boolean;
  onSuccess: () => void;
}) {
  const invite = new URLSearchParams(location.search).get("invite"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const body = Object.fromEntries(new FormData(e.currentTarget));
    try {
      await api(
        needsSetup ? "/setup" : invite ? "/register" : "/login",
        "POST",
        { ...body, token: invite },
      );
      history.replaceState(null, "", location.pathname);
      onSuccess();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-page">
      <div className="auth-story">
        <Brand />
        <div className="auth-story-content">
          <div className="auth-motto">
            <h1>
              一脉相承，
              <br />
              世代有迹。
            </h1>
            <GitBranch size={118} strokeWidth={0.7} />
          </div>
          <p>
            记录每一位家人，
            <br />
            让相连的名字，有故事可循。
          </p>
        </div>
      </div>
      <main className="auth-panel">
        <h2>
          {needsSetup
            ? "建立你的家族档案"
            : invite
              ? "加入家族，共续家谱"
              : "欢迎回家"}
        </h2>
        <p className="muted">
          {needsSetup
            ? "首次使用，请设置家族管理员。"
            : invite
              ? "填写姓名和手机号，登记后即可查看家谱。"
              : "登录后查看家谱，与家人共同维护。"}
        </p>
        <form onSubmit={submit}>
          {needsSetup && (
            <Field label="初始化密钥">
              <input
                name="setupToken"
                type="password"
                required
                autoComplete="off"
              />
            </Field>
          )}
          {needsSetup ? (
            <>
              <Field label="管理员账号">
                <input
                  name="username"
                  required
                  minLength={3}
                  maxLength={60}
                  pattern="[a-zA-Z0-9_.@\-]+"
                  autoComplete="username"
                  placeholder="字母、数字或下划线"
                />
              </Field>
              <Field label="管理员姓名">
                <input name="name" required maxLength={80} autoComplete="name" />
              </Field>
              <Field label="管理员密码">
                <input
                  name="password"
                  type="password"
                  required
                  minLength={6}
                  maxLength={128}
                  autoComplete="new-password"
                  placeholder="至少 6 位"
                />
              </Field>
            </>
          ) : invite ? (
            <>
              <Field label="姓名">
                <input
                  name="name"
                  required
                  maxLength={60}
                  autoComplete="name"
                  placeholder="填写中文姓名"
                />
              </Field>
              <Field label="手机号码">
                <input
                  name="phone"
                  type="tel"
                  required
                  inputMode="tel"
                  maxLength={24}
                  autoComplete="tel"
                  placeholder="用于登录和首次登录密码"
                />
              </Field>
              <p className="form-help">
                登记后可用姓名或手机号登录，首次登录密码就是手机号。
              </p>
            </>
          ) : (
            <>
              <Field label="姓名或手机号码">
                <input
                  name="identifier"
                  required
                  maxLength={80}
                  autoComplete="username"
                  placeholder="输入中文姓名或手机号"
                />
              </Field>
              <Field label="密码">
                <input
                  name="password"
                  type="password"
                  required
                  maxLength={128}
                  autoComplete="current-password"
                  placeholder="请输入密码"
                />
              </Field>
            </>
          )}
          <ErrorText error={error} />
          <button className="primary full-button" disabled={busy}>
            {busy
              ? "正在处理…"
              : needsSetup
                ? "创建管理员"
                : invite
                  ? "登记并加入"
                  : "登录家谱"}
            <ChevronRight size={18} />
          </button>
        </form>
        <p className="auth-note">
          <Lock size={14} /> 邀请加入 · 家族私有 · 修改留痕
        </p>
      </main>
    </div>
  );
}
function PersonForm({
  person,
  user,
  data,
  link,
  onClose,
  onSaved,
}: {
  person?: Person;
  user: User;
  data: GraphData;
  link?: { id: string; direction: string };
  onClose: () => void;
  onSaved: (id?: string) => void;
}) {
  const [value, setValue] = useState<any>(
      person
        ? {
            ...person,
            birth: solarBirth(person),
            birthLunar: lunarBirth(person),
          }
        : {
            ...emptyPerson,
            branch:
              user.branches?.[0] ||
              data.people.find((p) => p.id === link?.id)?.branch ||
              "",
          },
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [[fatherId, motherId], setParents] = useState<[string, string]>(() =>
      initialParentSlots(data, person, link),
    );
  const biographyRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const textarea = biographyRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [value.biography]);
  const options: Record<string, Record<string, string>> = {
    gender: genderLabels,
    status: statusLabels,
  };
  const formFields = [
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
  ].filter((field) => field !== "death" || value.status === "deceased");
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const personData = {
        ...value,
        death: value.status === "deceased" ? value.death || "" : "",
      };
      const r = await api(
        person ? "/people/" + person.id : "/people",
        person ? "PUT" : "POST",
        person
          ? {
              data: personData,
              version: person.version,
              parentIds: [fatherId, motherId].filter(Boolean),
            }
          : {
              ...personData,
              link,
              parentIds: [fatherId, motherId].filter(Boolean),
            },
      );
      onSaved(person?.id || r.id);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={
        person
          ? "编辑人物资料"
          : link
            ? "添加" +
              ({ parent: "父母", child: "子女", partner: "配偶" } as any)[
                link.direction
              ]
            : "添加家族人物"
      }
      onClose={onClose}
      wide
    >
      <form onSubmit={save}>
        <div className="form-grid">
          {formFields.map((f) => (
            <Field
              key={f}
              label={fieldLabels[f] + (f === "name" ? " *" : "")}
              full={f === "biography"}
            >
              {options[f] ? (
                <select
                  value={value[f]}
                  onChange={(e) =>
                    setValue({
                      ...value,
                      [f]: e.target.value,
                      ...(f === "status" && e.target.value !== "deceased"
                        ? { death: "" }
                        : {}),
                    })
                  }
                >
                  {Object.entries(options[f]).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              ) : f === "biography" ? (
                <textarea
                  ref={biographyRef}
                  className="auto-grow-textarea"
                  rows={3}
                  value={value[f]}
                  maxLength={10000}
                  onChange={(e) => setValue({ ...value, [f]: e.target.value })}
                />
              ) : (
                <input
                  type={f === "phone" ? "tel" : "text"}
                  value={value[f] || ""}
                  required={f === "name"}
                  maxLength={f === "name" ? 80 : 200}
                  placeholder={
                    ["birth", "birthLunar", "death"].includes(f)
                      ? "如 1962、约1930年、日期不详"
                      : ""
                  }
                  onChange={(e) =>
                    setValue({ ...value, [f]: e.target.value })
                  }
                />
              )}
            </Field>
          ))}
        </div>
        <div className="parent-picker">
            <div className="parent-picker-heading">
              <strong>父母关系</strong>
              <small>
                {person
                  ? "按已保存的父母关系显示，可以修改。"
                  : link?.direction === "child"
                    ? "已按当前人物及其配偶自动填写，保存前可以修改。"
                    : "可直接选择父亲和母亲，也可以暂不关联。"}
              </small>
            </div>
            <div className="form-grid">
              <Field label="父亲（可修改）">
                <select
                  value={fatherId}
                  onChange={(e) =>
                    setParents([
                      e.target.value,
                      e.target.value === motherId ? "" : motherId,
                    ])
                  }
                >
                  <option value="">暂不关联</option>
                  {data.people
                    .filter((p) => p.id !== person?.id)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} · {genderLabels[p.gender] || "不详"} ·{" "}
                        {displayedBirth(p) || "生年不详"}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="母亲（可修改）">
                <select
                  value={motherId}
                  onChange={(e) =>
                    setParents([
                      e.target.value === fatherId ? "" : fatherId,
                      e.target.value,
                    ])
                  }
                >
                  <option value="">暂不关联</option>
                  {data.people
                    .filter((p) => p.id !== person?.id)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} · {genderLabels[p.gender] || "不详"} ·{" "}
                        {displayedBirth(p) || "生年不详"}
                      </option>
                    ))}
                </select>
              </Field>
            </div>
          </div>
        {data.people.some(
          (p) => p.id !== person?.id && p.name === value.name,
        ) && (
          <p className="notice">
            已有同名人物，请核对。保存会建立独立档案，不会自动合并。
          </p>
        )}
        {link && (
          <p className="notice">
            父母／子女快捷添加会建立父母子女关系；配偶会建立婚姻关系。
          </p>
        )}
        <ErrorText error={error} />
        <footer>
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "保存中…" : "保存资料"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
function RelationForm({
  person,
  data,
  onClose,
  onSaved,
}: {
  person: Person;
  data: GraphData;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [direction, setDirection] = useState("parent");
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const f = Object.fromEntries(new FormData(e.currentTarget));
    try {
      await api("/relations", "POST", {
        source: direction === "parent" ? f.other : person.id,
        target: direction === "parent" ? person.id : f.other,
        type: direction === "partner" ? "partner" : "parent",
        data: { start: f.start, end: f.end, note: f.note },
      });
      onSaved();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={"连接亲属 · " + person.name} onClose={onClose}>
      <form onSubmit={save}>
        <Field label="选择已有人物">
          <select name="other" required defaultValue="">
            <option value="" disabled>
              选择人物
            </option>
            {data.people
              .filter((p) => p.id !== person.id)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {displayedBirth(p) || "生年不详"}
                </option>
              ))}
          </select>
        </Field>
        <Field label="对方与此人的方向">
          <select
            value={direction}
            onChange={(e) => setDirection(e.target.value)}
          >
            <option value="parent">对方是此人的父母</option>
            <option value="child">对方是此人的子女</option>
            <option value="partner">对方是此人的配偶</option>
          </select>
        </Field>
        <div className="form-grid">
          <Field label="开始记载">
            <input name="start" maxLength={80} />
          </Field>
          <Field label="结束记载">
            <input name="end" maxLength={80} />
          </Field>
        </div>
        <Field label="说明／资料来源">
          <textarea name="note" maxLength={2000} />
        </Field>
        <ErrorText error={error} />
        <footer>
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy}>
            保存关系
          </button>
        </footer>
      </form>
    </Modal>
  );
}
function AvatarCrop({
  file,
  onClose,
  onConfirm,
}: {
  file: File;
  onClose: () => void;
  onConfirm: (crop: Blob) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    image = useRef<HTMLImageElement | null>(null),
    drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null),
    [dimensions, setDimensions] = useState({ width: 0, height: 0 }),
    [zoom, setZoom] = useState(1),
    [offset, setOffset] = useState({ x: 0, y: 0 }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const previewSize = 320;
  const clampOffset = (next: { x: number; y: number }, nextZoom = zoom) => {
    if (!dimensions.width || !dimensions.height) return next;
    const scale = Math.max(previewSize / dimensions.width, previewSize / dimensions.height) * nextZoom;
    const limitX = Math.max(0, (dimensions.width * scale - previewSize) / 2);
    const limitY = Math.max(0, (dimensions.height * scale - previewSize) / 2);
    return {
      x: Math.max(-limitX, Math.min(limitX, next.x)),
      y: Math.max(-limitY, Math.min(limitY, next.y)),
    };
  };
  useEffect(() => {
    const url = URL.createObjectURL(file);
    const next = new Image();
    next.onload = () => {
      image.current = next;
      setDimensions({ width: next.naturalWidth, height: next.naturalHeight });
      setZoom(1);
      setOffset({ x: 0, y: 0 });
    };
    next.onerror = () => setError("照片无法读取，请换一张图片");
    next.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);
  useEffect(() => {
    const target = canvas.current;
    const source = image.current;
    if (!target || !source || !dimensions.width) return;
    const size = target.width;
    const ratio = size / previewSize;
    const scale =
      Math.max(previewSize / dimensions.width, previewSize / dimensions.height) *
      zoom *
      ratio;
    const width = dimensions.width * scale;
    const height = dimensions.height * scale;
    const context = target.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, size, size);
    context.drawImage(
      source,
      (size - width) / 2 + offset.x * ratio,
      (size - height) / 2 + offset.y * ratio,
      width,
      height,
    );
  }, [dimensions, zoom, offset]);
  const move = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drag.current) return;
    setOffset(
      clampOffset({
        x: drag.current.left + event.clientX - drag.current.x,
        y: drag.current.top + event.clientY - drag.current.y,
      }),
    );
  };
  return (
    <Modal title="调整头像显示范围" onClose={onClose}>
      <div className="avatar-crop">
        <p className="muted small">拖动照片选择显示区域，使用滑块调整大小。</p>
        <div className="avatar-crop-frame">
          <canvas
            ref={canvas}
            width={720}
            height={720}
            onPointerDown={(event) => {
              drag.current = {
                x: event.clientX,
                y: event.clientY,
                left: offset.x,
                top: offset.y,
              };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={move}
            onPointerUp={(event) => {
              drag.current = null;
              event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onPointerCancel={() => (drag.current = null)}
          />
          <span aria-hidden="true" />
        </div>
        <label className="crop-zoom">
          <Crop size={17} />
          <span>缩放</span>
          <input
            type="range"
            min="1"
            max="3"
            step="0.01"
            value={zoom}
            onChange={(event) => {
              const next = Number(event.target.value);
              setZoom(next);
              setOffset((value) => clampOffset(value, next));
            }}
          />
        </label>
        <ErrorText error={error} />
        <footer>
          <button type="button" onClick={onClose}>取消</button>
          <button
            type="button"
            className="primary"
            disabled={busy || !dimensions.width}
            onClick={() => {
              setBusy(true);
              canvas.current?.toBlob(
                (blob) => {
                  setBusy(false);
                  if (blob) onConfirm(blob);
                  else setError("无法生成裁剪后的头像");
                },
                "image/webp",
                0.9,
              );
            }}
          >
            {busy ? "处理中…" : "确认并上传"}
          </button>
        </footer>
      </div>
    </Modal>
  );
}
function Detail({
  p,
  user,
  data,
  onSelect,
  onEdit,
  onAdd,
  onLink,
  onDelete,
  onRefresh,
  onClose,
  onFocus,
}: {
  p: Person;
  user: User;
  data: GraphData;
  onSelect: (id: string) => void;
  onEdit: () => void;
  onAdd: (direction: string) => void;
  onLink: () => void;
  onDelete: () => void;
  onRefresh: () => void;
  onClose: () => void;
  onFocus: () => void;
}) {
  const editable = canEdit(user, p),
    [tab, setTab] = useState("details"),
    [files, setFiles] = useState<any[]>([]),
    [error, setError] = useState(""),
    [uploading, setUploading] = useState(false),
    [cropFile, setCropFile] = useState<File | null>(null),
    [target, setTarget] = useState("");
  const refresh = useCallback(
    () =>
      api("/people/" + p.id + "/attachments")
        .then(setFiles)
        .catch((e) => setError(e.message)),
    [p.id],
  );
  useEffect(() => {
    refresh();
    setTab("details");
    setTarget("");
  }, [refresh]);
  async function upload(file: File, crop?: Blob) {
    setUploading(true);
    const f = new FormData();
    f.append("file", file);
    if (crop) f.append("crop", crop, "avatar.webp");
    try {
      await api("/people/" + p.id + "/attachments", "POST", f);
      setCropFile(null);
      refresh();
      onRefresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setUploading(false);
    }
  }
  const rels = data.relations.filter(
      (r) => r.source === p.id || r.target === p.id,
    ),
    route = target ? pathBetween(data, p.id, target) : [];
  return (
    <>
    <aside className="inspector">
      <div className="inspector-label">选中成员</div>
      <button
        className="detail-close icon-button"
        aria-label="关闭人物详情"
        onClick={onClose}
      >
        <X size={18} />
      </button>
      <div className="person-heading">
        {p.avatarId ? (
          <img
            className="person-avatar"
            src={apiUrl("/api/attachments/" + p.avatarId + "?thumb=1")}
            alt={p.name + "的头像"}
          />
        ) : (
          <div className={"monogram " + (p.gender === "female" ? "female" : "")}>
            {p.name.slice(0, 1)}
          </div>
        )}
        <h2>{p.name}</h2>
      </div>
      <div className="detail-tabs">
        <button
          className={tab === "details" ? "active" : ""}
          onClick={() => setTab("details")}
        >
          人物资料
        </button>
        <button
          className={tab === "files" ? "active" : ""}
          onClick={() => setTab("files")}
        >
          照片与文献
        </button>
      </div>
      <div className="detail-scroll">
        {tab === "details" ? (
          <>
            <h3>基本信息</h3>
            <dl>
              {[
                ["出生日期（公历）", solarBirth(p) || "未记录"],
                ["出生日期（农历）", lunarBirth(p) || "未记录"],
                ...(p.status === "deceased"
                  ? [["去世记载", p.death || "未记录"]]
                  : []),
                ["性别", genderLabels[p.gender]],
                ["籍贯", p.origin || "未记录"],
                ["现居地", p.residence || "未记录"],
                ["电话号码", p.phone || "未记录"],
                ["生存状态", statusLabels[p.status]],
              ].map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
            {p.alias && <p className="detail-prose">曾用名：{p.alias}</p>}
            {p.biography && (
              <>
                <h3>人物简介</h3>
                <p className="detail-prose">{p.biography}</p>
              </>
            )}
            <h3>
              家庭关系 <small>{rels.length}</small>
            </h3>
            {!rels.length && <p className="muted small">尚未连接亲属关系。</p>}
            {rels.map((r) => {
              const other = data.people.find(
                (o) => o.id === (r.source === p.id ? r.target : r.source),
              )!;
              return (
                <div className="relative-row" key={r.id}>
                  <button onClick={() => onSelect(other.id)}>
                    <span className="mini-monogram">
                      {other.name.slice(0, 1)}
                    </span>
                    <span>
                      <strong>{other.name}</strong>
                      <small>
                        {r.type === "partner"
                          ? "配偶"
                          : r.source === p.id
                            ? "子女"
                            : "父母"}
                        {r.data.start ? " · " + r.data.start : ""}
                        {r.data.end ? " — " + r.data.end : ""}
                        {r.data.note ? " · " + r.data.note : ""}
                      </small>
                    </span>
                    <ChevronRight size={15} />
                  </button>
                  {user.role === "admin" && (
                    <button
                      className="icon-button muted"
                      aria-label={"删除与" + other.name + "的关系"}
                      onClick={async () => {
                        if (
                          confirm(
                            "删除这条关系？人物档案仍会保留，操作会记入日志。",
                          )
                        )
                          try {
                            await api("/relations/" + r.id, "DELETE");
                            onRefresh();
                          } catch (e: any) {
                            setError(e.message);
                          }
                      }}
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>
              );
            })}
            {editable && (
              <button className="text-button" onClick={onLink}>
                <Link size={14} />
                连接已有亲属
              </button>
            )}
            <h3>查看两人的关系</h3>
            <select
              aria-label="另一位家人"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              <option value="">选择另一位家人</option>
              {data.people
                .filter((q) => q.id !== p.id)
                .map((q) => (
                  <option key={q.id} value={q.id}>
                    {q.name}
                  </option>
                ))}
            </select>
            {target && (
              <p className="route">
                {route.length
                  ? route
                      .map((id) => data.people.find((q) => q.id === id)?.name)
                      .join(" → ")
                  : "当前可见资料中尚无连接路径"}
              </p>
            )}
          </>
        ) : (
          <>
            <p className="muted small">
              照片、文献和扫描件。单个文件不超过 12MB。
            </p>
            {files.length === 0 && (
              <div className="files-empty">
                <ImageIcon size={30} />
                <p>暂无可查看的资料</p>
              </div>
            )}
            <div className="files-grid">
              {files.map((f) => (
                <article key={f.id}>
                  {f.mime.startsWith("image/") ? (
                    <a
                      href={apiUrl("/api/attachments/" + f.id)}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="查看照片"
                    >
                      <img
                        src={apiUrl("/api/attachments/" + f.id + "?thumb=1")}
                        alt=""
                      />
                    </a>
                  ) : (
                    <a
                      href={apiUrl("/api/attachments/" + f.id)}
                      aria-label="查看文献"
                    >
                      <FileText size={28} />
                    </a>
                  )}
                  {editable && (
                    <button
                      className="text-button danger"
                      onClick={async () => {
                        if (confirm("删除此资料？"))
                          try {
                            await api("/attachments/" + f.id, "DELETE");
                            refresh();
                            onRefresh();
                          } catch (e: any) {
                            setError(e.message);
                          }
                      }}
                    >
                      删除
                    </button>
                  )}
                </article>
              ))}
            </div>
            {editable && (
              <label className="upload-button">
                <Upload size={16} />
                {uploading ? "上传中…" : "上传照片／PDF"}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp,application/pdf"
                  disabled={uploading}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file?.type.startsWith("image/")) setCropFile(file);
                    else if (file) upload(file);
                    e.target.value = "";
                  }}
                />
              </label>
            )}
          </>
        )}
        <ErrorText error={error} />
      </div>
      <div className="detail-actions">
        <button onClick={onFocus}>
          <GitBranch size={16} />
          以此人为中心
        </button>
        {editable && (
          <>
            <button className="primary" onClick={onEdit}>
              <Edit3 size={16} />
              编辑资料
            </button>
            <div className="quick-add">
              {[
                ["parent", "父母"],
                ["partner", "配偶"],
                ["child", "子女"],
              ].map(([k, v]) => (
                <button key={k} onClick={() => onAdd(k)}>
                  <Plus size={13} />
                  {v}
                </button>
              ))}
            </div>
          </>
        )}
        {user.role === "admin" && (
          <button className="text-button danger" onClick={onDelete}>
            <Trash2 size={13} />
            移入回收站
          </button>
        )}
      </div>
    </aside>
    {cropFile && (
      <AvatarCrop
        file={cropFile}
        onClose={() => setCropFile(null)}
        onConfirm={(crop) => upload(cropFile, crop)}
      />
    )}
    </>
  );
}
function Family({
  family,
  user,
  onSaved,
}: {
  family: any;
  user: User;
  onSaved: () => void;
}) {
  const [value, setValue] = useState(family.data),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const familyDescriptionRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setValue(family.data), [family]);
  return (
    <div className="content-page family-page">
      <div className="family-details-column">
          <div className="section-heading">
            <BookOpen size={25} />
            <div>
              <h2>家族的来处</h2>
              <p>保存族源和家族共同的记忆。</p>
            </div>
          </div>
          <form
            className="family-details-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await api("/family", "PUT", {
                  data: value,
                  version: family.version,
                });
                onSaved();
              } catch (e: any) {
                setError(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
          {[
            ["name", "家谱名称"],
            ["origin", "家族发源地"],
            ["description", "家族介绍"],
          ].map(([k, v]) => (
            <Field key={k} label={v}>
              {k === "description" ? (
                <textarea
                  className="family-description"
                  rows={4}
                  ref={(element) => {
                    familyDescriptionRef.current = element;
                    if (!element) return;
                    element.style.height = "auto";
                    element.style.height = `${Math.max(128, element.scrollHeight + 2)}px`;
                  }}
                  value={value[k] || ""}
                  maxLength={5000}
                  readOnly={user.role !== "admin"}
                  onChange={(e) => setValue({ ...value, [k]: e.target.value })}
                />
              ) : (
                <input
                  value={value[k] || ""}
                  required={k === "name"}
                  maxLength={k === "name" ? 100 : 200}
                  readOnly={user.role !== "admin"}
                  onChange={(e) => setValue({ ...value, [k]: e.target.value })}
                />
              )}
            </Field>
          ))}
            <ErrorText error={error} />
            {user.role === "admin" && (
              <button className="primary" disabled={busy}>
                保存家族资料
              </button>
            )}
          </form>
      </div>
    </div>
  );
}
function AuditPage({
  data,
  onRefresh,
  user,
}: {
  data: GraphData;
  onRefresh: () => void;
  user: User;
}) {
  const [logs, setLogs] = useState<any[]>([]),
    [page, setPage] = useState(0),
    [error, setError] = useState(""),
    [selected, setSelected] = useState<any>(null);
  useEffect(() => {
    api("/audit?page=" + page)
      .then(setLogs)
      .catch((e) => setError(e.message));
  }, [page, data]);
  return (
    <div className="content-page">
      <div className="section-heading">
        <History size={24} />
        <div>
          <h2>每一次补充，都有迹可循</h2>
          <p>记录谁在何时修改了哪些资料。</p>
        </div>
      </div>
      <ErrorText error={error} />
      <div className="mobile-record-list audit-mobile-list">
        {logs.map((l) => (
          <article key={l.id}>
            <div className="mobile-record-main">
              <strong>{l.action}</strong>
              <time>{time(l.created_at)}</time>
              <span>
                {l.actor_name || "系统"} · {data.people.find((p) => p.id === l.entity_id)?.name || l.before_data?.name || "无相关人物"}
              </span>
            </div>
            <button className="text-button" onClick={() => setSelected(l)}>
              查看变更
            </button>
          </article>
        ))}
        {!logs.length && <p className="empty-row">暂无可查看的修改记录</p>}
      </div>
      <div className="table-wrap audit-table-wrap">
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>操作人</th>
              <th>操作</th>
              <th>相关人物</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {logs.map((l) => (
              <tr key={l.id}>
                <td>{time(l.created_at)}</td>
                <td>{l.actor_name || "系统"}</td>
                <td>{l.action}</td>
                <td>
                  {data.people.find((p) => p.id === l.entity_id)?.name ||
                    l.before_data?.name ||
                    "—"}
                </td>
                <td>
                  <button
                    className="text-button"
                    onClick={() => setSelected(l)}
                  >
                    查看变更
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!logs.length && <p className="empty-row">暂无可查看的修改记录</p>}
      </div>
      <div className="pagination">
        <button disabled={!page} onClick={() => setPage((p) => p - 1)}>
          上一页
        </button>
        <span>第 {page + 1} 页</span>
        <button
          disabled={logs.length < 100}
          onClick={() => setPage((p) => p + 1)}
        >
          下一页
        </button>
      </div>
      {selected && (
        <Modal title={selected.action} onClose={() => setSelected(null)} wide>
          <p className="muted">
            {selected.actor_name} · {time(selected.created_at)}
          </p>
          {selected.entity === "person" ? (
            <table className="change-table">
              <thead>
                <tr>
                  <th>字段</th>
                  <th>修改前</th>
                  <th>修改后</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(fieldLabels)
                  .filter(
                    ([k]) =>
                      selected.before_data?.[k] !== selected.after_data?.[k],
                  )
                  .map(([k, v]) => (
                    <tr key={k}>
                      <td>{v}</td>
                      <td>{String(selected.before_data?.[k] ?? "—")}</td>
                      <td>{String(selected.after_data?.[k] ?? "—")}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          ) : (
            <div className="audit-summary">
              <p>
                {selected.entity === "import"
                  ? `导入 ${selected.after_data?.people?.length || 0} 位人物、${selected.after_data?.relations?.length || 0} 条关系。`
                  : selected.entity === "merge"
                    ? "合并记录保留了操作前的人物与关系快照，完整数据可通过管理员备份保管。"
                    : "此操作已记录。"}
              </p>
              <pre>
                {JSON.stringify(
                  { 修改前: selected.before_data, 修改后: selected.after_data },
                  null,
                  2,
                )}
              </pre>
            </div>
          )}
          {user.role === "admin" &&
            selected.entity === "person" &&
            selected.before_data &&
            data.people.some((p) => p.id === selected.entity_id) && (
              <footer>
                <button
                  onClick={async () => {
                    if (
                      !confirm(
                        "将人物资料恢复到这次修改之前？当前资料也会记录到日志。",
                      )
                    )
                      return;
                    try {
                      await api(
                        "/people/" + selected.entity_id + "/revert",
                        "POST",
                        {
                          auditId: selected.id,
                          version: data.people.find(
                            (p) => p.id === selected.entity_id,
                          )!.version,
                        },
                      );
                      setSelected(null);
                      onRefresh();
                    } catch (e: any) {
                      setError(e.message);
                    }
                  }}
                >
                  恢复修改前资料
                </button>
              </footer>
            )}
        </Modal>
      )}
    </div>
  );
}
function Members() {
  const [users, setUsers] = useState<any[]>([]),
    [invites, setInvites] = useState<any[]>([]),
    [shares, setShares] = useState<any[]>([]),
    [error, setError] = useState(""),
    [url, setUrl] = useState(""),
    [modal, setModal] = useState<"invite" | "share" | null>(null),
    [creating, setCreating] = useState(false),
    [edit, setEdit] = useState<any>(null);
  const refresh = () =>
    Promise.all([api("/users"), api("/invites"), api("/shares")])
      .then(([u, i, s]) => {
        setUsers(u);
        setInvites(i);
        setShares(s);
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    refresh();
  }, []);
  return (
    <div className="content-page">
      <div className="section-heading">
        <Users size={24} />
        <div>
          <h2>一家人，共同续谱</h2>
          <p>受邀成员登记后默认仅可查看，由管理员单独授予编辑权限。</p>
        </div>
        <div className="section-actions">
          <button
            className="primary"
            onClick={() => {
              setError("");
              setCreating(true);
            }}
          >
            <Plus size={16} />
            新建账号
          </button>
          <button
            onClick={() => {
              setUrl("");
              setModal("invite");
            }}
          >
            <UserPlus size={16} />
            邀请成员
          </button>
        </div>
      </div>
      <ErrorText error={error} />
      <div className="mobile-record-list members-mobile-list">
        {users.map((u) => (
          <article key={u.id}>
            <div className="mobile-record-main">
              <strong>{u.name}</strong>
              <span>
                {{ admin: "管理员", editor: "编辑成员", viewer: "查看成员" }[u.role as string]}
                {u.disabled ? " · 已停用" : " · 正常"}
              </span>
              <small>{u.phone || (u.username === "admin" ? "管理员账号" : "未登记手机号码")}</small>
            </div>
            <button className="text-button" onClick={() => setEdit(u)}>
              管理
            </button>
          </article>
        ))}
      </div>
      <div className="table-wrap members-table-wrap">
        <table>
          <thead>
            <tr>
              <th>成员</th>
              <th>手机号码</th>
              <th>权限</th>
              <th>状态</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>
                  <strong>{u.name}</strong>
                </td>
                <td>{u.phone || (u.username === "admin" ? "管理员账号" : "未登记")}</td>
                <td>
                  {
                    { admin: "管理员", editor: "编辑成员", viewer: "查看成员" }[
                      u.role as string
                    ]
                  }
                </td>
                <td>{u.disabled ? "已停用" : "正常"}</td>
                <td>
                  <button className="text-button" onClick={() => setEdit(u)}>
                    管理
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3 className="subsection">邀请记录</h3>
      <div className="simple-list">
        {invites.map((i) => (
          <div key={i.id}>
            <span>
              查看成员邀请 ·{" "}
              {i.used_at ? "已使用" : "有效至 " + time(i.expires_at)}
            </span>
            {!i.used_at && instant(i.expires_at) > new Date() && (
              <button
                onClick={async () => {
                  try {
                    await api("/invites/" + i.id, "DELETE");
                    refresh();
                  } catch (e: any) {
                    setError(e.message);
                  }
                }}
              >
                撤销
              </button>
            )}
          </div>
        ))}
        {!invites.length && <p className="muted">尚未创建邀请。</p>}
      </div>
      <div className="section-heading subsection">
        <div>
          <h3>只读分享</h3>
          <p>持有链接的人可查看全谱资料及附件，但不能编辑。</p>
        </div>
        <button
          onClick={() => {
            setUrl("");
            setModal("share");
          }}
        >
          <Share2 size={15} />
          创建分享
        </button>
      </div>
      <div className="simple-list">
        {shares.map((s) => (
          <div key={s.id}>
            <span>
              {s.revoked ? "已撤销" : "有效至 " + time(s.expires_at)}
            </span>
            {!s.revoked && (
              <button
                onClick={async () => {
                  try {
                    await api("/shares/" + s.id, "DELETE");
                    refresh();
                  } catch (e: any) {
                    setError(e.message);
                  }
                }}
              >
                撤销
              </button>
            )}
          </div>
        ))}
      </div>
      {creating && (
        <Modal title="新建账号" onClose={() => setCreating(false)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setError("");
              const body = Object.fromEntries(new FormData(e.currentTarget));
              try {
                await api("/users", "POST", body);
                setCreating(false);
                refresh();
              } catch (e: any) {
                setError(e.message);
              }
            }}
          >
            <Field label="姓名">
              <input
                name="name"
                required
                maxLength={60}
                autoComplete="off"
                placeholder="填写中文姓名"
              />
            </Field>
            <Field label="手机号码">
              <input
                name="phone"
                type="tel"
                required
                inputMode="tel"
                maxLength={24}
                autoComplete="off"
              />
            </Field>
            <p className="form-help">
              新账号默认仅可查看，可使用姓名或手机号登录，初始密码为手机号。
            </p>
            <ErrorText error={error} />
            <footer>
              <button className="primary">创建账号</button>
            </footer>
          </form>
        </Modal>
      )}
      {modal && (
        <Modal
          title={modal === "invite" ? "邀请家族成员" : "创建只读分享"}
          onClose={() => setModal(null)}
        >
          {url ? (
            <>
              <p className="notice">
                链接仅在本次创建后显示，请复制保管。
                {modal === "invite"
                  ? "邀请使用一次后即失效；新成员登记后默认仅可查看。"
                  : "请只发送给你信任的人。"}
              </p>
              <textarea readOnly value={url} rows={3} />
              <button
                className="primary"
                onClick={() =>
                  navigator.clipboard
                    .writeText(url)
                    .then(() => setError(""))
                    .catch(() => setError("请手动选中并复制链接"))
                }
              >
                <Copy size={15} />
                复制链接
              </button>
            </>
          ) : (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const f = Object.fromEntries(new FormData(e.currentTarget));
                try {
                  const r = await api(
                    modal === "invite" ? "/invites" : "/shares",
                    "POST",
                    modal === "invite"
                      ? { days: Number(f.days) }
                      : { days: Number(f.days) },
                  );
                  setUrl(r.url);
                  refresh();
                } catch (e: any) {
                  setError(e.message);
                }
              }}
            >
              {modal === "share" && (
                <p className="notice">
                  分享内容为全谱资料及附件；持有链接的人只能查看，不能编辑。
                </p>
              )}
              <Field label="有效期">
                <select name="days">
                  <option value="1">1 天</option>
                  <option value="7">7 天</option>
                  <option value="30">30 天</option>
                </select>
              </Field>
              <ErrorText error={error} />
              <footer>
                <button className="primary">创建链接</button>
              </footer>
            </form>
          )}
        </Modal>
      )}
      {edit && (
        <Modal title={"管理成员 · " + edit.name} onClose={() => setEdit(null)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api("/users/" + edit.id, "PATCH", {
                  role: edit.role,
                  disabled: edit.disabled,
                });
                setEdit(null);
                refresh();
              } catch (e: any) {
                setError(e.message);
              }
            }}
          >
            <Field label="角色">
              <select
                value={edit.role}
                onChange={(e) => setEdit({ ...edit, role: e.target.value })}
              >
                <option value="admin">管理员</option>
                <option value="editor">编辑成员</option>
                <option value="viewer">查看成员</option>
              </select>
            </Field>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={edit.disabled}
                onChange={(e) =>
                  setEdit({ ...edit, disabled: e.target.checked })
                }
              />
              停用账号
            </label>
            <ErrorText error={error} />
            <footer>
              <button className="primary">保存权限</button>
            </footer>
          </form>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api("/users/" + edit.id + "/reset-password", "POST", {});
                setEdit(null);
                refresh();
              } catch (e: any) {
                setError(e.message);
              }
            }}
          >
            {edit.role !== "admin" && (
              <>
                <p className="form-help">
                  重置后，密码恢复为该成员登记的手机号码，并使其已登录会话失效。
                </p>
                <button>重置为手机号码</button>
              </>
            )}
          </form>
        </Modal>
      )}
    </div>
  );
}
function DataPage({
  data,
  user,
  onRefresh,
}: {
  data: GraphData;
  user: User;
  onRefresh: () => void;
}) {
  const [error, setError] = useState(""),
    [preview, setPreview] = useState<any>(null),
    [trash, setTrash] = useState<any[]>([]),
    [backups, setBackups] = useState<any[]>([]),
    [documents, setDocuments] = useState<any[]>([]),
    [busy, setBusy] = useState(false),
    [maintenanceBusy, setMaintenanceBusy] = useState(false),
    [documentBusy, setDocumentBusy] = useState(false),
    [message, setMessage] = useState(""),
    [merge, setMerge] = useState<any>(null),
    [mergePreview, setMergePreview] = useState<any>(null);
  const refresh = () => {
    const requests: Promise<any>[] = [
      api("/family-documents").then(setDocuments),
    ];
    if (user.role === "admin") {
      requests.push(api("/trash").then(setTrash));
      requests.push(api("/backups").then(setBackups));
    }
    Promise.all(requests).catch((e) => setError(e.message));
  };
  useEffect(() => {
    refresh();
  }, [data]);
  async function previewImport(file: File) {
    setBusy(true);
    setError("");
    const f = new FormData();
    f.append("file", file);
    try {
      setPreview(await api("/import/preview", "POST", f));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function uploadFamilyDocument(file: File) {
    setDocumentBusy(true);
    setError("");
    const form = new FormData();
    form.append("file", file);
    try {
      await api("/family-documents", "POST", form);
      setMessage("电子族谱已上传");
      refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setDocumentBusy(false);
    }
  }
  async function createBackup() {
    setMaintenanceBusy(true);
    setError("");
    try {
      await api("/backups", "POST", {});
      setMessage("完整备份已创建，系统仅保留最近三次");
      refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setMaintenanceBusy(false);
    }
  }
  async function restoreBackup(id: string, createdAt: string) {
    if (!confirm(`确定恢复 ${time(createdAt)} 的完整备份？恢复前会自动保存当前数据，完成后需要重新登录。`))
      return;
    setMaintenanceBusy(true);
    setError("");
    try {
      await api(`/backups/${id}/restore`, "POST", {});
      alert("恢复完成，请重新登录。");
      location.reload();
    } catch (e: any) {
      setError(e.message);
      setMaintenanceBusy(false);
    }
  }
  return (
    <div className="content-page">
      <div className="section-heading">
        <Database size={24} />
        <div>
          <h2>让家谱长久保存</h2>
          <p>批量整理、导出留存，以及误删后的恢复。</p>
        </div>
      </div>
      <ErrorText error={error} />
      {message && <p className="notice">{message}</p>}
      <div className="data-block document-library-block">
        <div>
          <h3>电子版族谱资料</h3>
          <p>支持 DOC、DOCX 和 PDF，单个不超过 50MB。可在新标签页在线预览，也可下载原文件。</p>
        </div>
        {canEdit(user) && (
          <label className="upload-button">
            <Upload size={16} />
            {documentBusy ? "上传中…" : "上传文档"}
            <input
              type="file"
              accept=".doc,.docx,.pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/pdf"
              disabled={documentBusy}
              onChange={(event) => {
                if (event.target.files?.[0]) uploadFamilyDocument(event.target.files[0]);
                event.target.value = "";
              }}
            />
          </label>
        )}
      </div>
      <div className="document-list">
        {documents.map((document) => (
          <article key={document.id}>
            <span className="document-type">
              <FileText size={21} />
            </span>
            <div>
              <strong>{document.name}</strong>
              <small>
                {fileSize(document.size)} · {time(document.created_at)}
                {document.created_by_name ? ` · ${document.created_by_name}上传` : ""}
              </small>
            </div>
            <div className="button-row document-actions">
              <button
                onClick={() =>
                  window.open(
                    apiUrl(`/api/family-documents/${document.id}/preview`),
                    "_blank",
                    "noopener,noreferrer",
                  )
                }
              >
                <Eye size={15} />
                在线预览
              </button>
              <button onClick={() => download(`/family-documents/${document.id}/download`)}>
                <Download size={15} />
                下载
              </button>
              {canEdit(user) && (
                <button
                  className="danger"
                  onClick={async () => {
                    if (!confirm(`删除“${document.name}”？`)) return;
                    try {
                      await api(`/family-documents/${document.id}`, "DELETE");
                      setMessage("电子族谱已删除");
                      refresh();
                    } catch (e: any) {
                      setError(e.message);
                    }
                  }}
                >
                  <Trash2 size={15} />
                  删除
                </button>
              )}
            </div>
          </article>
        ))}
        {!documents.length && <p className="muted">尚未上传电子版族谱资料。</p>}
      </div>
      <div className="data-block">
        <div>
          <h3>导出家谱资料</h3>
          <p>
            导出当前账号可见的人物及关系。完整备份还需包含照片、账号和修改历史。
          </p>
        </div>
        <div className="button-row">
          <button onClick={() => download("/export.xlsx")}>
            <Download size={16} />
            Excel
          </button>
          <button onClick={() => download("/export.json")}>
            <Download size={16} />
            结构化数据
          </button>
        </div>
      </div>
      {user.role === "admin" && (
        <>
          <div className="data-block">
            <div>
              <h3>从 Excel 导入</h3>
              <p>
                使用模板填写人物与关系，先预览再确认。每批最多 500
                人，只新增、不覆盖。
              </p>
            </div>
            <div className="button-row">
              <button onClick={() => download("/import/template")}>
                下载模板
              </button>
              <label className="upload-button">
                <Upload size={16} />
                {busy ? "正在检查…" : "上传并预览"}
                <input
                  type="file"
                  accept=".xlsx"
                  disabled={busy}
                  onChange={(e) => {
                    if (e.target.files?.[0]) previewImport(e.target.files[0]);
                    e.target.value = "";
                  }}
                />
              </label>
            </div>
          </div>
          <div className="data-block">
            <div>
              <h3>合并重复人物</h3>
              <p>明确选择保留的人物档案，预览关系和附件的转移影响。</p>
            </div>
            <button
              onClick={() => {
                setMerge({ source: "", target: "" });
                setMergePreview(null);
              }}
            >
              选择人物
            </button>
          </div>
          <div className="data-block">
            <div>
              <h3>完整备份与恢复</h3>
              <p>
                一键保存数据库、人物照片和电子族谱文档。系统自动校验文件，并只保留最近三次备份。
              </p>
              <p className="muted small">
                恢复前会自动备份当前数据；恢复完成后所有账号需要重新登录。
              </p>
            </div>
            <button className="primary" disabled={maintenanceBusy} onClick={createBackup}>
              <FileArchive size={16} />
              {maintenanceBusy ? "处理中…" : "一键备份"}
            </button>
          </div>
          <div className="backup-list">
            {backups.map((backup) => (
              <div key={backup.id}>
                <span>
                  <strong>{time(backup.createdAt)}</strong>
                  <small>{fileSize(backup.size)} · {backup.reason}</small>
                </span>
                <button
                  disabled={maintenanceBusy}
                  onClick={() => restoreBackup(backup.id, backup.createdAt)}
                >
                  <ArchiveRestore size={15} />
                  恢复
                </button>
              </div>
            ))}
            {!backups.length && <p className="muted">还没有系统内备份。</p>}
          </div>
          <h3 className="subsection">
            回收站 <small>{trash.length}</small>
          </h3>
          <p className="muted small">移入回收站的人物最多保留 7 天，之后自动永久清理。</p>
          <div className="simple-list">
            {trash.map((p) => (
              <div key={p.id}>
                <span>
                  <strong>{p.data.name}</strong> · {time(p.deleted_at)}
                </span>
                <button
                  onClick={async () => {
                    try {
                      await api("/people/" + p.id + "/restore", "POST");
                      onRefresh();
                    } catch (e: any) {
                      setError(e.message);
                    }
                  }}
                >
                  恢复人物
                </button>
              </div>
            ))}
            {!trash.length && <p className="muted">回收站是空的。</p>}
          </div>
        </>
      )}
      {preview && (
        <Modal title="核对导入资料" onClose={() => setPreview(null)} wide>
          <p>
            将新增 <strong>{preview.people.length}</strong> 人和{" "}
            <strong>{preview.relations.length}</strong> 条关系。
          </p>
          {preview.issues.map((s: string, i: number) => (
            <p className="notice" key={i}>
              {s}
            </p>
          ))}
          <div className="table-wrap import-table">
            <table>
              <thead>
                <tr>
                  <th>姓名</th>
                  <th>出生日期（公历）</th>
                  <th>出生日期（农历）</th>
                  <th>生存状态</th>
                </tr>
              </thead>
              <tbody>
                {preview.people.map((p: any) => (
                  <tr key={p.id}>
                    <td>{p.data.name}</td>
                    <td>{solarBirth(p.data) || "—"}</td>
                    <td>{lunarBirth(p.data) || "—"}</td>
                    <td>{statusLabels[p.data.status]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ErrorText error={error} />
          <footer>
            <button onClick={() => setPreview(null)}>取消</button>
            <button
              className="primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api("/import/commit", "POST", { id: preview.id });
                  setPreview(null);
                  onRefresh();
                } catch (e: any) {
                  setError(e.message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              已核对，确认导入
            </button>
          </footer>
        </Modal>
      )}
      {merge && (
        <Modal title="合并重复人物" onClose={() => setMerge(null)}>
          {!mergePreview ? (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  setMergePreview(await api("/merge/preview", "POST", merge));
                } catch (e: any) {
                  setError(e.message);
                }
              }}
            >
              {[
                ["source", "待合并人物（移入回收站）"],
                ["target", "保留人物（保留此人的资料）"],
              ].map(([k, v]) => (
                <Field key={k} label={v}>
                  <select
                    required
                    value={merge[k]}
                    onChange={(e) =>
                      setMerge({ ...merge, [k]: e.target.value })
                    }
                  >
                    <option value="">请选择</option>
                    {data.people.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} · {displayedBirth(p) || "生年不详"}
                      </option>
                    ))}
                  </select>
                </Field>
              ))}
              <ErrorText error={error} />
              <footer>
                <button className="primary">预览影响</button>
              </footer>
            </form>
          ) : (
            <>
              <p className="notice">
                将「{mergePreview.source.data.name}」合并到「
                {mergePreview.target.data.name}
                」。保留目标人物的资料；原人物进入回收站。
              </p>
              <p>
                涉及 {mergePreview.relations.length} 条关系、
                {mergePreview.attachmentCount} 份附件。关系冲突时会阻止合并。
              </p>
              <ErrorText error={error} />
              <footer>
                <button onClick={() => setMergePreview(null)}>返回选择</button>
                <button
                  className="primary"
                  onClick={async () => {
                    try {
                      await api("/merge", "POST", {
                        source: mergePreview.source.id,
                        target: mergePreview.target.id,
                        sourceVersion: mergePreview.source.version,
                        targetVersion: mergePreview.target.version,
                      });
                      setMerge(null);
                      onRefresh();
                    } catch (e: any) {
                      setError(e.message);
                    }
                  }}
                >
                  确认合并
                </button>
              </footer>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
function AboutPage() {
  return (
    <div className="content-page about-page">
      <section className="about-card">
        <span className="about-mark" aria-hidden="true">
          <GitBranch size={34} />
        </span>
        <h2>关于宗谱</h2>
        <p>
          宗谱是一款用于记录、整理、展示和共同维护家族资料的数字化族谱系统。它以清晰的家谱图呈现家人之间的关系，并保存人物生平、照片、文献和家族资料，让分散各地的家人能够共同查阅和补充家族记忆。愿每一个名字都有来处，每一段故事都能被看见，让家族的根脉在一代代人之间长久延续。
        </p>
        <div className="about-motto" aria-label="一脉相承，世代有迹">
          <span />
          一脉相承，世代有迹
          <span />
        </div>
        <footer className="about-builder">
          <strong>项目构建人：Wei Xi</strong>
          <span>Copyright © Wei Xi</span>
          <a href="mailto:weixi1004@gmail.com">
            Contact me: weixi1004@gmail.com
          </a>
        </footer>
      </section>
    </div>
  );
}
function App() {
  const [session, setSession] = useState<{
      user: User | null;
      needsSetup: boolean;
    } | null>(null),
    [data, setData] = useState<GraphData>({ people: [], relations: [] }),
    [family, setFamily] = useState<any>(null),
    [page, setPage] = useState("tree"),
    [selected, setSelected] = useState(""),
    [root, setRoot] = useState(""),
    [search, setSearch] = useState(""),
    [mode, setMode] = useState("tree"),
    [depth, setDepth] = useState(0),
    [startGeneration, setStartGeneration] = useState(1),
    [sidebar, setSidebar] = useState(false),
    [compactNav, setCompactNav] = useState(true),
    [form, setForm] = useState<{
      person?: Person;
      link?: { id: string; direction: string };
    } | null>(null),
    [relation, setRelation] = useState(false),
    [error, setError] = useState(""),
    [toast, setToast] = useState(""),
    [password, setPassword] = useState(false);
  const user = session?.user || null;
  useEffect(() => {
    if (!user) return;
    setPage("tree");
    setMode("tree");
    setRoot("");
    setSelected("");
    setDepth(0);
    setStartGeneration(1);
  }, [user?.id, user?.name, user?.role]);
  const loadSession = () =>
    api("/session")
      .then((s) => {
        if (shareToken)
          s.user = { role: "guest", name: "分享访客", branches: null };
        setSession(s);
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    loadSession();
  }, []);
  const refresh = useCallback(async () => {
    try {
      const [g, f] = await Promise.all([
        api<GraphData>("/graph"),
        api("/family"),
      ]);
      setData(g);
      setFamily(f);
      setError("");
    } catch (e: any) {
      setError(e.message);
    }
  }, []);
  useEffect(() => {
    if (user) {
      refresh();
      const id = setInterval(refresh, 30000);
      return () => clearInterval(id);
    }
  }, [user, refresh]);
  useEffect(() => {
    if (toast) {
      const id = setTimeout(() => setToast(""), 3500);
      return () => clearTimeout(id);
    }
  }, [toast]);
  const graphLevels = useMemo(() => generationLevels(data), [data]);
  const generationCount = Math.max(
    1,
    ...[...graphLevels.values()].map((value) => value + 1),
  );
  const p = data.people.find((p) => p.id === selected);
  const select = (id: string) => {
    setSelected(id);
    setSearch("");
  };
  const openFamily = (id: string) => {
    setSelected(id);
    setRoot(id);
    setMode("kin");
    setSearch("");
  };
  const saved = (id?: string) => {
    setForm(null);
    setRelation(false);
    if (id) setSelected(id);
    refresh();
    setToast("已保存，修改已记录");
  };
  const searchResults = search
    ? data.people
        .filter((p) =>
          [p.name, p.alias].some((v) => v?.includes(search)),
        )
        .slice(0, 30)
    : [];
  if (!session)
    return (
      <div className="loading">
        <p>{error || "正在打开家族档案…"}</p>
        {error && <button onClick={loadSession}>重试</button>}
      </div>
    );
  if (!user)
    return <Auth needsSetup={session.needsSetup} onSuccess={loadSession} />;
  return (
    <div className="app-shell">
      <aside
        className={
          "sidebar " + (sidebar ? "open " : "") + (compactNav ? "compact" : "")
        }
      >
        <Brand />
        <button
          className="family-switch"
          aria-label={family?.data.name || "我的家谱"}
          title={family?.data.name || "我的家谱"}
          onClick={() => {
            setPage("family");
            setSidebar(false);
          }}
        >
          <span className="family-mark">
            <img
              src={`${import.meta.env.BASE_URL}assets/home-sweet-home.png`}
              alt=""
            />
          </span>
          <span className="family-name">{family?.data.name || "我的家谱"}</span>
        </button>
        <nav>
          {pages
            .filter(
              ([id]) =>
                !(["users"].includes(id) && user.role !== "admin") &&
                !(
                  ["audit"].includes(id) &&
                  !["admin", "editor"].includes(user.role)
                ) &&
                !(user.role === "guest" && ["family", "data"].includes(id)),
            )
            .map(([id, label, Icon]) => (
              <button
                key={id}
                aria-label={label}
                title={label}
                className={page === id ? "active" : ""}
                onClick={() => {
                  setPage(id);
                  setSidebar(false);
                }}
              >
                <Icon size={20} />
                <span>{label}</span>
              </button>
            ))}
        </nav>
        <div className="sidebar-bottom">
          <button
            className={"about-nav " + (page === "about" ? "active" : "")}
            aria-label="关于宗谱"
            title="关于宗谱"
            onClick={() => {
              setPage("about");
              setSidebar(false);
            }}
          >
            <Info size={17} />
            <span>关于宗谱</span>
          </button>
          <button
            className="nav-collapse"
            aria-label={compactNav ? "展开导航" : "收起导航"}
            onClick={() => setCompactNav((value) => !value)}
          >
            {compactNav ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
            <span>{compactNav ? "展开" : "收起"}</span>
          </button>
          <div className="user-info">
            <span>{user.name.slice(0, 1)}</span>
            <div>
              {user.name}
              <small>
                {
                  {
                    admin: "家族管理员",
                    editor: "编辑成员",
                    viewer: "查看成员",
                    guest: "只读分享",
                  }[user.role]
                }
              </small>
            </div>
          </div>
          {!demoMode && user.role !== "guest" && (
            <div className="account-actions">
              <button onClick={() => setPassword(true)}>
                <Settings size={15} />
                密码
              </button>
              <button
                onClick={async () => {
                  await api("/logout", "POST");
                  setData({ people: [], relations: [] });
                  setFamily(null);
                  setSelected("");
                  setPage("tree");
                  loadSession();
                }}
              >
                <LogOut size={15} />
                退出
              </button>
            </div>
          )}
        </div>
      </aside>
      {sidebar && (
        <button
          className="sidebar-scrim"
          aria-label="关闭导航"
          onClick={() => setSidebar(false)}
        />
      )}
      <main className="main">
        <header className="main-header">
          <button
            className="mobile-menu icon-button"
            aria-label="打开导航"
            onClick={() => setSidebar(true)}
          >
            <Menu size={23} />
          </button>
          <div className={`page-title${page === "tree" ? " tree-page-title" : ""}`}>
            <h1>{page === "about" ? "关于宗谱" : pages.find((x) => x[0] === page)?.[1]}</h1>
            {page === "tree" ? (
              <p className="tree-title-motto" aria-label="一脉相承，世代有迹">
                {[..."一脉相承，世代有迹"].map((character, index) => (
                  <span key={`${character}-${index}`} aria-hidden="true">
                    {character}
                  </span>
                ))}
              </p>
            ) : (
              <p>{family?.data.name || "家族档案"}</p>
            )}
            {demoMode && (
              <small className="demo-badge">虚构数据 · 只读演示</small>
            )}
          </div>
          <div className="search-box">
            <Search size={18} />
            <input
              aria-label="搜索家族人物"
              placeholder="搜索姓名、谱名…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <div className="search-results">
                {searchResults.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => {
                      select(p.id);
                      setRoot(p.id);
                      setMode("kin");
                      setPage("tree");
                    }}
                  >
                    <span>{p.name}</span>
                    <small>
                      {p.alias || "无曾用名"} · {displayedBirth(p) || "生年不详"}
                    </small>
                  </button>
                ))}
                {!searchResults.length && <p>没有找到匹配人物</p>}
              </div>
            )}
          </div>
          {["admin", "editor"].includes(user.role) && (
            <button className="primary add-person" aria-label="添加成员" onClick={() => setForm({})}>
              <UserPlus className="add-person-icon" size={18} aria-hidden="true" />
              <span>添加成员</span>
            </button>
          )}
        </header>
        {error && (
          <div className="global-error" role="alert">
            {error}
            <button
              onClick={() => {
                refresh();
                loadSession();
              }}
            >
              <RefreshCw size={14} />
              重新加载
            </button>
          </div>
        )}
        {toast && (
          <div className="toast" role="status">
            <Check size={17} />
            {toast}
          </div>
        )}
        {page === "tree" ? (
          <div className={"workspace " + (p ? "with-detail" : "")}>
            <section className="tree-panel">
              <div className="tree-toolbar">
                <div className="view-tabs">
                  <button
                    className={mode === "tree" ? "active" : ""}
                    onClick={() => {
                      setMode("tree");
                      setRoot("");
                      setDepth(0);
                      setStartGeneration(1);
                    }}
                  >
                    全部家人（{data.people.length}人）
                  </button>
                  <button
                    className={mode === "kin" ? "active" : ""}
                    onClick={() => {
                      const center = selected || root || data.people[0]?.id || "";
                      setMode("kin");
                      setRoot(center);
                    }}
                  >
                    查看家庭
                  </button>
                </div>
                <div className="tree-options">
                  {mode === "tree" && (
                    <span className="toolbar-label">展示</span>
                  )}
                  {mode === "tree" && (
                    <select
                      aria-label="展示代数"
                      value={depth}
                      onChange={(e) => setDepth(Number(e.target.value))}
                    >
                      {[2, 3, 4, 5, 8, 10, 0].map((d) => (
                        <option key={d} value={d}>
                          {d ? `${d} 代` : "全部"}
                        </option>
                      ))}
                    </select>
                  )}
                  {mode === "tree" && (
                    <select
                      className="root-select"
                      aria-label="起始代数"
                      value={startGeneration}
                      onChange={(e) => setStartGeneration(Number(e.target.value))}
                    >
                      {Array.from({ length: generationCount }, (_, index) => index + 1).map(
                        (value) => (
                          <option key={value} value={value}>
                            第{chineseGeneration(value)}代
                          </option>
                        ),
                      )}
                    </select>
                  )}
                  <button
                    className="export-button"
                    aria-label="打印 / PDF"
                    onClick={() => window.print()}
                  >
                    <Printer size={16} />
                    <span>打印 / PDF</span>
                  </button>
                  <button
                    className="export-button"
                    aria-label="导出 PNG"
                    onClick={() => window.dispatchEvent(new Event("zongpu:export-png"))}
                  >
                    <Download size={16} />
                    <span>导出 PNG</span>
                  </button>
                </div>
              </div>
              <Graph
                data={data}
                root={root}
                depth={depth}
                mode={mode}
                startGeneration={startGeneration}
                selected={selected}
                onSelect={select}
                onOpenFamily={openFamily}
              />
            </section>
            {p && (
              <Detail
                key={p.id}
                p={p}
                user={user}
                data={data}
                onSelect={select}
                onEdit={() => setForm({ person: p })}
                onAdd={(direction) =>
                  setForm({ link: { id: p.id, direction } })
                }
                onLink={() => setRelation(true)}
                onClose={() => setSelected("")}
                onFocus={() => {
                  setRoot(p.id);
                  setMode("kin");
                }}
                onDelete={async () => {
                  if (
                    confirm(
                      `将 ${p.name} 移入回收站？关联关系暂时隐藏，恢复人物后重新显示。`,
                    )
                  )
                    try {
                      await api("/people/" + p.id, "DELETE", {
                        version: p.version,
                      });
                      setSelected("");
                      refresh();
                    } catch (e: any) {
                      setError(e.message);
                    }
                }}
                onRefresh={refresh}
              />
            )}
          </div>
        ) : page === "people" ? (
          <div className="content-page">
            <div className="section-heading">
              <Users size={24} />
              <div>
                <h2>家族人物名录</h2>
                <p>
                  共 {data.people.length} 位可见人物，点击姓名查看详细资料。
                </p>
              </div>
            </div>
            <div className="people-mobile-list">
              {data.people.map((p) => {
                const facts = [
                  solarBirth(p) && ["公历出生", solarBirth(p)],
                  lunarBirth(p) && ["农历出生", lunarBirth(p)],
                  p.origin && ["籍贯", p.origin],
                  p.residence && ["现居地", p.residence],
                  p.phone && ["电话", p.phone],
                  p.status === "deceased" && p.death && ["去世记载", p.death],
                ].filter(Boolean) as string[][];
                return (
                  <article key={p.id}>
                    <button
                      className="mobile-person-heading"
                      onClick={() => {
                        select(p.id);
                        setPage("tree");
                      }}
                    >
                      <span className={"directory-avatar " + (p.gender === "female" ? "female" : "")}>
                        {p.avatarId ? (
                          <img src={apiUrl(`/api/attachments/${p.avatarId}?thumb=1`)} alt="" />
                        ) : (
                          <UserRound size={19} aria-hidden="true" />
                        )}
                      </span>
                      <span>
                        <strong>{p.name}</strong>
                        <small>
                          {p.alias ? `曾用名：${p.alias} · ` : ""}
                          {genderLabels[p.gender]} · {statusLabels[p.status]}
                        </small>
                      </span>
                      <ChevronRight size={18} aria-hidden="true" />
                    </button>
                    {!!facts.length && (
                      <dl>
                        {facts.map(([label, value]) => (
                          <div key={label}>
                            <dt>{label}</dt>
                            <dd>{value}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </article>
                );
              })}
            </div>
            <div className="table-wrap people-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>姓名</th>
                    <th>曾用名</th>
                    <th>性别</th>
                    <th>出生日期（公历）</th>
                    <th>出生日期（农历）</th>
                    <th>籍贯</th>
                    <th>现居地</th>
                    <th>电话号码</th>
                    <th>生存状态</th>
                    <th>去世记载</th>
                  </tr>
                </thead>
                <tbody>
                  {data.people.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <button
                            className="person-link"
                            onClick={() => {
                              select(p.id);
                              setPage("tree");
                            }}
                          >
                            <span className={"directory-avatar " + (p.gender === "female" ? "female" : "")}>
                              {p.avatarId ? (
                                <img src={apiUrl(`/api/attachments/${p.avatarId}?thumb=1`)} alt="" />
                              ) : (
                                <UserRound size={19} aria-hidden="true" />
                              )}
                            </span>
                            {p.name}
                          </button>
                        </td>
                        <td>{p.alias || "—"}</td>
                        <td>{genderLabels[p.gender]}</td>
                        <td>{solarBirth(p) || "—"}</td>
                        <td>{lunarBirth(p) || "—"}</td>
                        <td>{p.origin || "—"}</td>
                        <td>{p.residence || "—"}</td>
                        <td>{p.phone || "—"}</td>
                        <td>{statusLabels[p.status]}</td>
                        <td>{p.status === "deceased" ? p.death || "—" : "—"}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
              {!data.people.length && (
                <div className="empty-row">
                  <h3>家谱从第一位家人开始</h3>
                  <p>点击右上角“添加成员”，或由管理员导入 Excel。</p>
                </div>
              )}
            </div>
          </div>
        ) : page === "family" && family ? (
          <Family
            family={family}
            user={user}
            onSaved={() => {
              refresh();
              setToast("家族资料已保存");
            }}
          />
        ) : page === "audit" ? (
          <AuditPage data={data} user={user} onRefresh={refresh} />
        ) : page === "users" ? (
          <Members />
        ) : page === "data" ? (
          <DataPage data={data} user={user} onRefresh={refresh} />
        ) : page === "about" ? (
          <AboutPage />
        ) : null}
      </main>
      {form && (
        <PersonForm
          person={form.person}
          link={form.link}
          user={user}
          data={data}
          onClose={() => setForm(null)}
          onSaved={saved}
        />
      )}{" "}
      {relation && p && (
        <RelationForm
          person={p}
          data={data}
          onClose={() => setRelation(false)}
          onSaved={() => saved()}
        />
      )}{" "}
      {password && (
        <Modal title="修改登录密码" onClose={() => setPassword(false)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api(
                  "/password",
                  "POST",
                  Object.fromEntries(new FormData(e.currentTarget)),
                );
                setPassword(false);
                loadSession();
              } catch (e: any) {
                setError(e.message);
              }
            }}
          >
            <Field label="当前密码">
              <input
                name="current"
                type="password"
                required
                autoComplete="current-password"
              />
            </Field>
            <Field label="新密码（至少 6 位）">
              <input
                name="password"
                type="password"
                minLength={6}
                maxLength={128}
                required
                autoComplete="new-password"
              />
            </Field>
            <ErrorText error={error} />
            <footer>
              <button className="primary">保存并重新登录</button>
            </footer>
          </form>
        </Modal>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
if ("serviceWorker" in navigator)
  navigator.serviceWorker
    .register(`${import.meta.env.BASE_URL}sw.js`)
    .catch(() => {});
