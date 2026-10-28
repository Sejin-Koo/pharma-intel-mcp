// EMA 공개 JSON 데이터 파일(검색 API가 아니라 통째 파일 다운로드). 갱신: 매일 06:00·18:00 CET.
// 원본: https://www.ema.europa.eu/en/about-us/about-website/download-website-data-json-data-format
import { httpJson, SourceError, clip, stripTags } from "./util.js";

const BASE = "https://www.ema.europa.eu/en/documents/report/";
const TTL_MS = 3 * 3600 * 1000;
const cache = new Map(); // dataset → {at, meta, data}

export const EMA_DATASETS = {
  medicines: {
    label: "의약품(EPAR 허가·심사 현황)",
    file: "medicines-output-medicines_json-report_en.json",
    text: ["name_of_medicine", "active_substance", "international_non_proprietary_name_common_name", "marketing_authorisation_developer_applicant_holder", "therapeutic_area_mesh", "therapeutic_indication", "atc_code_human", "ema_product_number"],
    dates: ["european_commission_decision_date", "marketing_authorisation_date", "opinion_adopted_date", "start_of_evaluation_date", "first_published_date", "last_updated_date", "refusal_of_marketing_authorisation_date", "withdrawal_of_application_date"],
    defaultDate: "marketing_authorisation_date",
    filters: ["category", "medicine_status", "opinion_status", "orphan_medicine", "conditional_approval", "accelerated_assessment", "advanced_therapy", "biosimilar", "generic", "prime_priority_medicine", "exceptional_circumstances", "additional_monitoring"],
    show: ["name_of_medicine", "active_substance", "marketing_authorisation_developer_applicant_holder", "medicine_status", "opinion_status", "therapeutic_area_mesh", "atc_code_human", "therapeutic_indication", "orphan_medicine", "conditional_approval", "accelerated_assessment", "prime_priority_medicine", "advanced_therapy", "biosimilar", "generic", "opinion_adopted_date", "marketing_authorisation_date", "european_commission_decision_date", "start_of_evaluation_date", "refusal_of_marketing_authorisation_date", "withdrawal_of_application_date", "ema_product_number", "medicine_url"],
  },
  orphan: {
    label: "희귀의약품 지정",
    file: "medicines-output-orphan_designations-json-report_en.json",
    text: ["medicine_name", "active_substance", "intended_use", "eu_designation_number"],
    dates: ["date_of_designation_or_refusal", "first_published_date", "last_updated_date"],
    defaultDate: "date_of_designation_or_refusal",
    filters: ["status"],
    show: ["medicine_name", "active_substance", "intended_use", "status", "date_of_designation_or_refusal", "eu_designation_number", "related_ema_product_number", "orphan_designation_url"],
  },
  pip: {
    label: "소아임상시험계획(PIP)",
    file: "medicines-output-paediatric_investigation_plans-output-json-report_en.json",
    text: ["active_substance", "invented_name", "therapeutic_area", "condition_indication", "pip_number"],
    dates: ["decision_date", "compliance_opinion_date", "first_published_date", "last_updated_date"],
    defaultDate: "decision_date",
    filters: ["decision_type", "compliance_outcome"],
    show: ["active_substance", "invented_name", "therapeutic_area", "condition_indication", "decision_type", "decision_date", "compliance_outcome", "pip_number", "pip_url"],
  },
  shortages: {
    label: "공급 부족",
    file: "shortages-output-json-report_en.json",
    text: ["medicine_affected", "international_non_proprietary_name_inn_or_common_name", "therapeutic_area_mesh"],
    dates: ["start_of_shortage_date", "last_updated_date", "first_published_date"],
    defaultDate: "last_updated_date",
    filters: ["category", "supply_shortage_status"],
    show: ["medicine_affected", "supply_shortage_status", "therapeutic_area_mesh", "availability_of_alternatives", "start_of_shortage_date", "expected_resolution", "last_updated_date", "shortage_url"],
  },
  referrals: {
    label: "중재절차(Referral·안전성 재평가)",
    file: "referrals-output-json-report_en.json",
    text: ["referral_name", "international_non_proprietary_name_inn_common_name", "associated_names_centrally_authorised_medicines", "associated_names_non_centrally_authorised_medicines"],
    dates: ["procedure_start_date", "prac_recommendation_date", "chmp_cvmp_opinion_date", "european_commission_decision_date", "last_updated_date"],
    defaultDate: "procedure_start_date",
    filters: ["category", "current_status", "safety_referral", "referral_type"],
    show: ["referral_name", "international_non_proprietary_name_inn_common_name", "current_status", "referral_type", "safety_referral", "procedure_start_date", "prac_recommendation", "chmp_cvmp_opinion_date", "european_commission_decision_date", "referral_url"],
  },
  dhpc: {
    label: "의료인 안전성 서한(DHPC)",
    file: "dhpc-output-json-report_en.json",
    text: ["name_of_medicine", "active_substances", "therapeutic_area_mesh", "dhpc_type"],
    dates: ["dissemination_date", "first_published_date", "last_updated_date"],
    defaultDate: "dissemination_date",
    filters: ["category", "dhpc_type"],
    show: ["name_of_medicine", "active_substances", "therapeutic_area_mesh", "dhpc_type", "regulatory_outcome", "dissemination_date", "dhpc_url"],
  },
};

const toIso = (s) => {
  const m = String(s || "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};

export async function emaLoad(dataset) {
  const cfg = EMA_DATASETS[dataset];
  if (!cfg) throw new SourceError(`dataset은 ${Object.keys(EMA_DATASETS).join("|")} 중 하나`);
  const hit = cache.get(dataset);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;
  const j = await httpJson(BASE + cfg.file, { timeoutMs: 45000, retries: 1 });
  const entry = { at: Date.now(), meta: j.meta || {}, data: j.data || [] };
  cache.set(dataset, entry);
  return entry;
}

function tokens(query) {
  const out = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(query || "")))) out.push((m[1] || m[2]).toLowerCase());
  return out;
}

export async function emaSearch({ dataset = "medicines", query, filters = {}, dateField, dateFrom, dateTo, limit = 20, offset = 0, sort = "date_desc" }) {
  const cfg = EMA_DATASETS[dataset];
  const { data, meta, at } = await emaLoad(dataset);
  const tk = tokens(query);
  const dField = dateField || cfg.defaultDate;
  if (dateField && !cfg.dates.includes(dateField)) throw new SourceError(`date_field는 ${cfg.dates.join("|")} 중 하나(데이터셋 ${dataset})`);
  const badFilter = Object.keys(filters).filter((k) => !cfg.filters.includes(k));
  if (badFilter.length) throw new SourceError(`${dataset}에서 쓸 수 있는 필터: ${cfg.filters.join(", ")} (잘못된 키: ${badFilter.join(", ")})`);
  const from = dateFrom || null;
  const to = dateTo || null;
  let rows = data.filter((r) => {
    if (tk.length) {
      const hay = cfg.text.map((f) => stripTags(r[f] ?? "")).join(" ").toLowerCase();
      if (!tk.every((t) => hay.includes(t))) return false;
    }
    for (const [k, v] of Object.entries(filters)) {
      if (v === undefined || v === null || v === "") continue;
      if (String(r[k] ?? "").toLowerCase() !== String(v).toLowerCase()) return false;
    }
    if (from || to) {
      const d = toIso(r[dField]);
      if (!d) return false;
      if (from && d < from) return false;
      if (to && d > to) return false;
    }
    return true;
  });
  const total = rows.length;
  if (sort !== "none") {
    const dir = sort === "date_asc" ? 1 : -1;
    rows = rows.slice().sort((a, b) => dir * String(toIso(a[dField]) || "").localeCompare(String(toIso(b[dField]) || "")));
  }
  const page = rows.slice(offset, offset + limit).map((r) => {
    const o = {};
    for (const f of cfg.show) {
      let v = r[f];
      if (v === "" || v === null || v === undefined) continue;
      if (typeof v === "string") v = clip(stripTags(v), f === "therapeutic_indication" ? 420 : 300);
      o[f] = v;
    }
    return o;
  });
  return { records: page, 일치건수: total, 데이터기준시각: meta.timestamp, 데이터전체건수: meta.total_records ?? data.length, 정렬기준일: dField, 캐시적재: new Date(at).toISOString() };
}
