// 공통 유틸: HTTP 호출(재시도·타임아웃), 입력 정규화, 레코드 병합
import { z } from "zod";

const UA = "pharma-intel-mcp/1.0 (+https://github.com/Sejin-Koo/pharma-intel-mcp)";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 소스 호출 오류. status가 있으면 HTTP 상태, retryAfter(초)가 있으면 429 대기 안내 */
export class SourceError extends Error {
  constructor(msg, { status, retryAfter, url } = {}) {
    super(msg);
    this.status = status;
    this.retryAfter = retryAfter;
    this.url = url;
  }
}

/** 키가 들어간 URL을 로그·오류에 그대로 남기지 않도록 마스킹 */
export function redact(url) {
  return String(url).replace(/([?&](?:api_key|apikey|serviceKey|email)=)[^&]*/gi, "$1***");
}

/**
 * fetch + 타임아웃 + 429/5xx 재시도(최대 retries회). 본문 텍스트를 돌려준다.
 * 429는 Retry-After(초)를 존중하되 한 번 대기는 maxWaitMs로 제한한다.
 */
export async function httpText(url, { headers = {}, timeoutMs = 20000, retries = 2, maxWaitMs = 4000, method = "GET" } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method, headers: { "User-Agent": UA, ...headers }, signal: ctrl.signal, redirect: "follow" });
      clearTimeout(timer);
      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get("retry-after"));
        lastErr = new SourceError(`HTTP ${res.status}`, { status: res.status, retryAfter: Number.isFinite(ra) ? ra : undefined, url: redact(url) });
        if (attempt < retries) {
          const wait = Math.min(maxWaitMs, (Number.isFinite(ra) && ra > 0 ? ra * 1000 : 800 * 2 ** attempt));
          await sleep(wait);
          continue;
        }
        throw lastErr;
      }
      const text = await res.text();
      if (!res.ok) throw new SourceError(`HTTP ${res.status}: ${text.slice(0, 200).replace(/\s+/g, " ")}`, { status: res.status, url: redact(url) });
      return text;
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof SourceError) throw e;
      lastErr = new SourceError(e.name === "AbortError" ? `시간 초과(${timeoutMs}ms)` : `네트워크 오류: ${e.message}`, { url: redact(url) });
      if (attempt < retries) {
        await sleep(600 * 2 ** attempt);
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr;
}

export async function httpJson(url, opts) {
  const t = await httpText(url, { ...opts, headers: { Accept: "application/json", ...(opts?.headers || {}) } });
  try {
    return JSON.parse(t);
  } catch {
    throw new SourceError(`JSON 파싱 실패: ${t.slice(0, 120).replace(/\s+/g, " ")}`, { url: redact(url) });
  }
}

export function qs(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    sp.set(k, String(v));
  }
  return sp.toString();
}

// ── 입력 스키마 보조: MCP 클라이언트가 숫자·불리언·배열을 문자열로 보내는 경우를 흡수 ──
export const zInt = (min, max, def) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() !== "" ? Number(v) : v), z.number().int().min(min).max(max).optional()).describe(def !== undefined ? `기본 ${def}` : "").transform((v) => v ?? def);

export const zBool = (def = false) =>
  z.preprocess((v) => (typeof v === "string" ? ["true", "1", "yes", "y"].includes(v.trim().toLowerCase()) : v), z.boolean().optional()).transform((v) => v ?? def);

export const zList = (itemSchema) =>
  z.preprocess((v) => {
    if (typeof v === "string") {
      const s = v.trim();
      if (!s) return undefined;
      if (s.startsWith("[")) {
        try {
          return JSON.parse(s);
        } catch {
          /* 아래로 */
        }
      }
      return s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
    }
    return v;
  }, z.array(itemSchema).optional());


export function clip(s, n) {
  if (s == null) return s;
  const t = String(s);
  return n > 0 && t.length > n ? t.slice(0, n) + "…" : t;
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function stripTags(s) {
  return String(s ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** 빈도 집계 → 내림차순 [{키, 건수}] */
export function tally(items, top = 20) {
  const m = new Map();
  for (const it of items) {
    if (it === null || it === undefined || it === "") continue;
    m.set(it, (m.get(it) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([키, 건수]) => ({ 키, 건수 }));
}

/** 회사명 비교용 정규화(법인 표기·구두점·공백 제거, 소문자) */
export function normCompany(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\(주\)|\(유\)|주식회사|㈜/g, "")
    .replace(/\b(co\.?,?\s*ltd\.?|ltd\.?|inc\.?|corp\.?|corporation|company|gmbh|ag|s\.?a\.?|plc|llc|kk|limited|holdings?)\b/g, "")
    .replace(/[^a-z0-9가-힣]+/g, "");
}
