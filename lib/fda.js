// openFDA (https://open.fda.gov) — 키 없이 일 1,000건, 키 있으면 일 120,000건(분당 240건)
import { httpJson, qs, SourceError, clip, stripTags } from "./util.js";

const FDA = "https://api.fda.gov";
const env = (k) => (process.env[k] || "").trim();

const q = (s) => String(s ?? "").replace(/["\\]/g, " ").replace(/\s+/g, " ").trim();
const isMulti = (s) => /\s/.test(q(s));
const term = (field, v) => (isMulti(v) ? `${field}:"${q(v)}"` : `${field}:${q(v)}`);

/** 공통 호출. 결과 없음(404 NOT_FOUND)은 빈 결과로 돌려준다. */
export async function fdaFetch(endpoint, { search, limit = 10, skip = 0, count, sort } = {}) {
  const p = { search, limit, skip: skip || undefined, count, sort, api_key: env("OPENFDA_API_KEY") || undefined };
  try {
    const j = await httpJson(`${FDA}/${endpoint}.json?` + qs(p), { timeoutMs: 30000, retries: 2 });
    return { results: j.results || [], total: j.meta?.results?.total ?? null, lastUpdated: j.meta?.last_updated };
  } catch (e) {
    if (e instanceof SourceError && e.status === 404) return { results: [], total: 0, 없음: true };
    throw e;
  }
}

const D = (s) => (s && /^\d{8}$/.test(String(s)) ? `${String(s).slice(0, 4)}-${String(s).slice(4, 6)}-${String(s).slice(6)}` : s || null);
export const ymd = (s) => String(s || "").replace(/-/g, "");

// ───────────────────────── Drugs@FDA (승인 이력) ─────────────────────────
export function approvalSearchClauses(a) {
  const c = [];
  if (a.brand) c.push(`(${term("products.brand_name", a.brand)} OR ${term("openfda.brand_name", a.brand)})`);
  if (a.ingredient) c.push(`(${term("products.active_ingredients.name", a.ingredient)} OR ${term("openfda.generic_name", a.ingredient)})`);
  if (a.application) c.push(`application_number:"${q(a.application).toUpperCase()}"`);
  if (a.sponsor) {
    // sponsor_name은 대문자 전체 문자열 필드라 부분 일치가 안 된다 → 첫 단어 접두 와일드카드로 후보를 받고 나머지 단어는 클라이언트에서 거른다
    const first = q(a.sponsor).toUpperCase().split(" ")[0];
    c.push(`sponsor_name:${first}*`);
  }
  if (a.date_from || a.date_to) c.push(`submissions.submission_status_date:[${ymd(a.date_from) || "19000101"} TO ${ymd(a.date_to) || "30000101"}]`);
  return c;
}

function parseApproval(r) {
  const subs = (r.submissions || []).slice().sort((x, y) => String(y.submission_status_date).localeCompare(String(x.submission_status_date)));
  const orig = subs.filter((s) => s.submission_type === "ORIG" && s.submission_status === "AP").sort((x, y) => String(x.submission_status_date).localeCompare(String(y.submission_status_date)))[0];
  const ofda = r.openfda || {};
  return {
    신청번호: r.application_number,
    스폰서: r.sponsor_name,
    최초승인일: orig ? D(orig.submission_status_date) : null,
    최초승인_심사구분: orig?.review_priority || null,
    제품: (r.products || []).slice(0, 8).map((p) => ({
      브랜드: p.brand_name,
      성분: (p.active_ingredients || []).map((i) => `${i.name} ${i.strength || ""}`.trim()),
      제형: p.dosage_form,
      경로: p.route,
      판매상태: p.marketing_status,
      TE코드: p.te_code || undefined,
    })),
    약리분류: ofda.pharm_class_epc || undefined,
    제출건수: subs.length,
    _subs: subs,
    제출이력: subs.slice(0, 8).map((s) => ({ 유형: s.submission_type, 번호: s.submission_number, 상태: s.submission_status, 일자: D(s.submission_status_date), 심사구분: s.review_priority || undefined, 분류: s.submission_class_code_description || undefined })),
  };
}

/** 승인 이력 검색. 날짜 구간은 서버가 '신청서 중 어느 제출이든' 일치하면 돌려주므로, 제출 단위로 다시 거른다. */
export async function fdaApprovals(a, { limit = 10, maxScan = 500 } = {}) {
  const clauses = approvalSearchClauses(a);
  if (!clauses.length) throw new SourceError("brand·ingredient·sponsor·application·date_from/date_to 중 하나 이상이 필요합니다");
  const search = clauses.join(" AND ");
  const needFilter = !!(a.date_from || a.date_to || a.submission_type || a.status_code);
  const from = ymd(a.date_from) || "00000000";
  const to = ymd(a.date_to) || "99999999";
  const wantSub = (s) => {
    const d = String(s.submission_status_date || "");
    return d >= from && d <= to && (!a.submission_type || s.submission_type === a.submission_type) && (!a.status_code || s.submission_status === a.status_code);
  };
  const sponsorWords = a.sponsor ? q(a.sponsor).toUpperCase().split(" ").slice(1) : [];
  const out = [];
  let skip = 0;
  let scanned = 0;
  let total = null;
  const pageSize = needFilter || sponsorWords.length ? 100 : Math.min(limit, 100);
  while (out.length < limit && scanned < maxScan) {
    const r = await fdaFetch("drug/drugsfda", { search, limit: pageSize, skip });
    total = r.total ?? total;
    if (!r.results.length) break;
    for (const raw of r.results) {
      scanned++;
      if (sponsorWords.length && !sponsorWords.every((w) => String(raw.sponsor_name).toUpperCase().includes(w))) continue;
      const rec = parseApproval(raw);
      if (needFilter) {
        const hit = rec._subs.filter(wantSub);
        if (!hit.length) continue;
        rec.조건일치_제출 = hit.slice(0, 6).map((s) => ({ 유형: s.submission_type, 번호: s.submission_number, 상태: s.submission_status, 일자: D(s.submission_status_date), 심사구분: s.review_priority || undefined, 분류: s.submission_class_code_description || undefined }));
        rec.조건일치_제출수 = hit.length;
      }
      delete rec._subs;
      out.push(rec);
      if (out.length >= limit) break;
    }
    skip += r.results.length;
    if (r.results.length < pageSize || skip >= (total ?? 0)) break;
  }
  const 잘림 = total !== null && skip < total && (out.length >= limit || scanned >= maxScan);
  return { records: out, 서버일치건수: total, 스캔건수: scanned, 잘림, 날짜재필터: needFilter };
}

// ───────────────────────── 허가사항(라벨) ─────────────────────────
export const LABEL_SECTIONS = {
  indications: "indications_and_usage",
  boxed_warning: "boxed_warning",
  dosage: "dosage_and_administration",
  contraindications: "contraindications",
  warnings: "warnings_and_cautions",
  adverse_reactions: "adverse_reactions",
  mechanism: "mechanism_of_action",
  clinical_studies: "clinical_studies",
  description: "description",
  pregnancy: "pregnancy",
  pediatric: "pediatric_use",
  pharmacokinetics: "pharmacokinetics",
  how_supplied: "how_supplied",
  drug_interactions: "drug_interactions",
};

export async function fdaLabels(a, { limit = 3, sections = ["indications", "boxed_warning"], maxChars = 1500 } = {}) {
  const c = [];
  if (a.set_id) c.push(`set_id:"${q(a.set_id)}"`);
  if (a.brand) c.push(term("openfda.brand_name", a.brand));
  if (a.generic) c.push(`(${term("openfda.generic_name", a.generic)} OR ${term("openfda.substance_name", a.generic)})`);
  if (!c.length) throw new SourceError("brand·generic·set_id 중 하나가 필요합니다");
  const r = await fdaFetch("drug/label", { search: c.join(" AND "), limit });
  const recs = r.results.map((x) => {
    const o = x.openfda || {};
    const rec = {
      브랜드: o.brand_name,
      성분: o.generic_name,
      제조사: o.manufacturer_name,
      제품유형: o.product_type,
      투여경로: o.route,
      허가번호: o.application_number,
      set_id: x.set_id,
      라벨개정일: D(x.effective_time),
      버전: x.version,
    };
    const secs = {};
    for (const s of sections) {
      const f = LABEL_SECTIONS[s];
      const v = x[f];
      secs[s] = v ? clip(stripTags([].concat(v).join(" ")), maxChars) : null;
    }
    rec.섹션 = secs;
    return rec;
  });
  return { records: recs, 일치건수: r.total, 마지막갱신: r.lastUpdated };
}

// ───────────────────────── 이상사례(FAERS) ─────────────────────────
const COUNT_FIELDS = {
  reaction: "patient.reaction.reactionmeddrapt.exact",
  country: "occurcountry.exact",
  sex: "patient.patientsex",
  serious: "serious",
  indication: "patient.drug.drugindication.exact",
  year: "receivedate",
  reporter: "primarysource.qualification",
};
const SEX = { 0: "미상", 1: "남", 2: "여" };
const SERIOUS = { 1: "중대", 2: "비중대" };
const REPORTER = { 1: "의사", 2: "약사", 3: "기타 의료인", 4: "변호사", 5: "소비자/비의료인" };

export async function fdaEvents(a, { groupBy = "reaction", top = 20 } = {}) {
  if (!COUNT_FIELDS[groupBy]) throw new SourceError(`group_by는 ${Object.keys(COUNT_FIELDS).join("|")} 중 하나`);
  const c = [`(${term("patient.drug.openfda.generic_name", a.drug)} OR ${term("patient.drug.openfda.brand_name", a.drug)})`];
  if (a.date_from || a.date_to) c.push(`receivedate:[${ymd(a.date_from) || "19000101"} TO ${ymd(a.date_to) || "30000101"}]`);
  if (a.serious === true) c.push("serious:1");
  if (a.reaction) c.push(`patient.reaction.reactionmeddrapt:"${q(a.reaction)}"`);
  const search = c.join(" AND ");
  const totalR = await fdaFetch("drug/event", { search, limit: 1 });
  if (totalR.없음) return { 총보고건수: 0, 집계: [], 집계기준: groupBy };
  const r = await fdaFetch("drug/event", { search, count: COUNT_FIELDS[groupBy], limit: groupBy === "year" ? 1000 : Math.min(top, 1000) });
  let rows = r.results.map((x) => ({ 키: x.term ?? x.time, 건수: x.count }));
  if (groupBy === "year" && r.results.length >= 1000) {
    // 일자 집계가 1000일 상한에 닿으면(오래 쓰인 약) 앞쪽 날짜만 와서 틀린다 → 연도별로 따로 총건수를 센다
    const y0 = Number(String(rows[0].키).slice(0, 4));
    const y1 = new Date().getFullYear();
    const years = [];
    for (let y = y0; y <= y1; y++) years.push(y);
    const base = c.filter((x) => !x.startsWith("receivedate:"));
    const lo = ymd(a.date_from) || "19000101";
    const hi = ymd(a.date_to) || "30000101";
    rows = [];
    for (let i = 0; i < years.length; i += 6) {
      const part = await Promise.all(years.slice(i, i + 6).map(async (y) => {
        const from = Math.max(Number(lo), Number(`${y}0101`));
        const to = Math.min(Number(hi), Number(`${y}1231`));
        if (from > to) return { 키: String(y), 건수: 0 };
        const t = await fdaFetch("drug/event", { search: [...base, `receivedate:[${from} TO ${to}]`].join(" AND "), limit: 1 });
        return { 키: String(y), 건수: t.total || 0 };
      }));
      rows.push(...part);
    }
  } else if (groupBy === "year") {
    const m = new Map();
    for (const x of rows) {
      const y = String(x.키).slice(0, 4);
      m.set(y, (m.get(y) || 0) + x.건수);
    }
    rows = [...m.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([키, 건수]) => ({ 키, 건수 }));
  } else if (groupBy === "sex") rows = rows.map((x) => ({ ...x, 키: SEX[x.키] ?? x.키 }));
  else if (groupBy === "serious") rows = rows.map((x) => ({ ...x, 키: SERIOUS[x.키] ?? x.키 }));
  else if (groupBy === "reporter") rows = rows.map((x) => ({ ...x, 키: REPORTER[x.키] ?? x.키 }));
  return { 총보고건수: totalR.total, 집계기준: groupBy, 집계: rows, 마지막갱신: totalR.lastUpdated };
}

// ───────────────────────── 회수·시장조치(enforcement) ─────────────────────────
export async function fdaRecalls(a, { limit = 10 } = {}) {
  const ep = { drug: "drug/enforcement", device: "device/enforcement", food: "food/enforcement" }[a.kind || "drug"];
  const c = [];
  if (a.firm) c.push(term("recalling_firm", a.firm));
  if (a.product) c.push(term("product_description", a.product));
  if (a.classification) c.push(`classification:"${q(a.classification)}"`);
  if (a.status) c.push(`status:"${q(a.status)}"`);
  if (a.date_from || a.date_to) c.push(`report_date:[${ymd(a.date_from) || "19000101"} TO ${ymd(a.date_to) || "30000101"}]`);
  if (!c.length) throw new SourceError("firm·product·classification·status·date_from/date_to 중 하나 이상이 필요합니다");
  const r = await fdaFetch(ep, { search: c.join(" AND "), limit, sort: "report_date:desc" });
  return {
    records: r.results.map((x) => ({
      회수번호: x.recall_number,
      회수업체: x.recalling_firm,
      등급: x.classification,
      상태: x.status,
      제품: clip(x.product_description, 240),
      사유: clip(x.reason_for_recall, 300),
      개시일: D(x.recall_initiation_date),
      보고일: D(x.report_date),
      종료일: D(x.termination_date),
      국가: x.country,
      자발여부: x.voluntary_mandated,
    })),
    일치건수: r.total,
  };
}
