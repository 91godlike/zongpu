import type { GraphData, Person, Relation, User } from "./types";

export const shareToken = new URLSearchParams(location.search).get("share");
export const demoMode = import.meta.env.VITE_DEMO_MODE === "true";

const person = (
  id: string,
  name: string,
  gender: string,
  generation: string,
  birth: string,
  status = "living",
): Person => ({
  id,
  name,
  alias: "",
  gender,
  branch: "",
  generation,
  birth,
  birthLunar: "",
  death: status === "deceased" ? "2018" : "",
  calendar: "solar",
  status,
  origin: "示例地区",
  residence: "",
  phone: "",
  biography: "这是公开演示使用的虚构人物资料。",
  source: "",
  certainty: "pending",
  version: 1,
});

const demoPeople: Person[] = [
  person("demo-1", "示例祖父", "male", "1", "1940", "deceased"),
  person("demo-2", "示例祖母", "female", "1", "1943", "deceased"),
  person("demo-3", "示例父亲", "male", "2", "1968"),
  person("demo-4", "示例母亲", "female", "2", "1970"),
  person("demo-5", "示例长子", "male", "3", "1994"),
  person("demo-6", "示例长女", "female", "3", "1997"),
  person("demo-7", "示例孙女", "female", "4", "2022"),
];

const relation = (
  id: string,
  source: string,
  target: string,
  type: "parent" | "partner",
): Relation => ({ id, source, target, type, data: {}, version: 1 });

const demoGraph: GraphData = {
  people: demoPeople,
  relations: [
    relation("demo-r1", "demo-1", "demo-2", "partner"),
    relation("demo-r2", "demo-1", "demo-3", "parent"),
    relation("demo-r3", "demo-2", "demo-3", "parent"),
    relation("demo-r4", "demo-3", "demo-4", "partner"),
    relation("demo-r5", "demo-3", "demo-5", "parent"),
    relation("demo-r6", "demo-4", "demo-5", "parent"),
    relation("demo-r7", "demo-3", "demo-6", "parent"),
    relation("demo-r8", "demo-4", "demo-6", "parent"),
    relation("demo-r9", "demo-5", "demo-7", "parent"),
  ],
};

const demoUser: User = {
  id: "demo-viewer",
  username: "demo",
  name: "演示访客",
  role: "viewer",
  branches: null,
};

const clone = <T>(value: T): T => structuredClone(value);

async function demoApi<T>(url: string, method: string): Promise<T> {
  if (method !== "GET" && !(url === "/logout" && method === "POST"))
    throw new Error("公开演示使用虚构只读数据；完整编辑功能请自行部署 Docker 版。");
  if (url === "/session")
    return clone({ user: demoUser, needsSetup: false }) as T;
  if (url === "/graph") return clone(demoGraph) as T;
  if (url === "/family")
    return clone({
      data: {
        name: "示例家谱",
        origin: "此处填写家族发源地",
        description:
          "这里可以记录家族的来处、迁徙过程和共同记忆。公开演示中的内容均为虚构资料。",
      },
      version: 1,
    }) as T;
  if (
    url.startsWith("/audit") ||
    url === "/family-documents" ||
    /\/people\/[^/]+\/attachments$/.test(url)
  )
    return [] as T;
  if (url === "/logout") return { ok: true } as T;
  throw new Error("此功能在公开只读演示中不可用。");
}

export const apiUrl = (url: string) =>
  url +
  (shareToken
    ? (url.includes("?") ? "&" : "?") +
      "share=" +
      encodeURIComponent(shareToken)
    : "");

export async function api<T = any>(
  url: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  if (demoMode) return demoApi<T>(url, method);
  const response = await fetch(apiUrl("/api" + url), {
    method,
    headers:
      body instanceof FormData
        ? undefined
        : body !== undefined
          ? { "Content-Type": "application/json" }
          : undefined,
    body:
      body instanceof FormData
        ? body
        : body !== undefined
          ? JSON.stringify(body)
          : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

export function download(url: string) {
  if (demoMode) {
    alert("公开演示不提供真实数据下载。");
    return;
  }
  const a = document.createElement("a");
  a.href = apiUrl("/api" + url);
  a.download = "";
  a.click();
}

export function saveBlob(blob: Blob, name: string) {
  const a = document.createElement("a"),
    u = URL.createObjectURL(blob);
  a.href = u;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(u), 3000);
}
