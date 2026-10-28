// ClinicalTrials.gov API v2 (키 불필요). 서버 부담을 줄이려고 호출은 보수적으로(동시 1~2개) 한다.
import { httpJson, qs, SourceError, clip, tally, normCompany } from "./util.js";

const CT = "https://clinicaltrials.gov/api/v2";

export const PHASES = ["EARLY_PHASE1", "PHASE1", "PHASE2", "PHASE3", "PHASE4", "NA"];
export const STATUSES = [
  "NOT_YET_RECRUITING", "RECRUITING", "ENROLLING_BY_INVITATION", "ACTIVE_NOT_RECRUITING", "COMPLETED",
  "SUSPENDED", "TERMINATED", "WITHDRAWN", "UNKNOWN",
];
const PHASE_RANK = { EARLY_PHASE1: 0.5, PHASE1: 1, PHASE2: 2, PHASE3: 3, PHASE4: 4, NA: 0 };
const PHASE_LABEL = { EARLY_PHASE1: "초기1상", PHASE1: "1상", PHASE2: "2상", PHASE3: "3상", PHASE4: "4상", NA: "해당없음" };
const LIST_FIELDS = [
  "NCTId", "BriefTitle", "OverallStatus", "Phase", "StudyType", "LeadSponsorName", "LeadSponsorClass", "Condition",
  "InterventionName", "InterventionType", "EnrollmentCount", "StartDate", "PrimaryCompletionDate", "CompletionDate",
  "StudyFirstPostDate", "LastUpdatePostDate", "HasResults", "WhyStopped", "LocationCountry",
].join("|");

export const phaseLabel = (p) => PHASE_LABEL[p] || p;
export const phaseRank = (p) => PHASE_RANK[p] ?? 0;

/** 검색 파라미터 → API 쿼리스트링 값 */
export function buildQuery(a) {
  const p = {};
  if (a.query) p["query.term"] = a.query;
  if (a.condition) p["query.cond"] = a.condition;
  if (a.intervention) p["query.intr"] = a.intervention;
  if (a.sponsor) p["query.spons"] = a.sponsor;
  if (a.title) p["query.titles"] = a.title;
  if (a.location) p["query.locn"] = a.location;
  if (a.status?.length) p["filter.overallStatus"] = a.status.join(",");
  const adv = [];
  if (a.phase?.length) adv.push(`AREA[Phase](${a.phase.join(" OR ")})`);
  if (a.study_type) adv.push(`AREA[StudyType]${a.study_type}`);
  if (a.start_from || a.start_to) adv.push(`AREA[StartDate]RANGE[${a.start_from || "MIN"},${a.start_to || "MAX"}]`);
  if (a.updated_from || a.updated_to) adv.push(`AREA[LastUpdatePostDate]RANGE[${a.updated_from || "MIN"},${a.updated_to || "MAX"}]`);
  if (a.has_results === true) adv.push("AREA[ResultsFirstPostDate]RANGE[MIN,MAX]");
  if (adv.length) p["filter.advanced"] = adv.join(" AND ");
  return p;
}

export function parseStudy(s) {
  const pm = s.protocolSection || {};
  const id = pm.identificationModule || {};
  const st = pm.statusModule || {};
  const sp = pm.sponsorCollaboratorsModule || {};
  const ds = pm.designModule || {};
  const ai = pm.armsInterventionsModule || {};
  const cl = pm.contactsLocationsModule || {};
  const countries = [...new Set((cl.locations || []).map((l) => l.country).filter(Boolean))];
  return {
    NCT: id.nctId,
    제목: id.briefTitle,
    상태: st.overallStatus,
    단계: (ds.phases || []).map(phaseLabel).join("/") || null,
    _phases: ds.phases || [],
    유형: ds.studyType,
    스폰서: sp.leadSponsor?.name,
    스폰서구분: sp.leadSponsor?.class,
    적응증: pm.conditionsModule?.conditions || [],
    중재: (ai.interventions || []).map((i) => i.name).filter(Boolean),
    _intervs: (ai.interventions || []).map((i) => ({ name: i.name, type: i.type })),
    등록인원: ds.enrollmentInfo?.count ?? null,
    시작일: st.startDateStruct?.date || null,
    일차종료예정: st.primaryCompletionDateStruct?.date || null,
    종료예정: st.completionDateStruct?.date || null,
    최초등록: st.studyFirstPostDateStruct?.date || null,
    최종갱신: st.lastUpdatePostDateStruct?.date || null,
    결과등록: s.hasResults ?? null,
    중단사유: st.whyStopped || undefined,
    참여국가: countries.length ? countries : undefined,
    링크: id.nctId ? `https://clinicaltrials.gov/study/${id.nctId}` : undefined,
  };
}

export async function ctSearch(a, { pageSize = 20, pageToken, sort, fields = LIST_FIELDS } = {}) {
  const p = { ...buildQuery(a), pageSize, countTotal: "true", fields };
  if (sort) p.sort = sort;
  if (pageToken) p.pageToken = pageToken;
  const j = await httpJson(`${CT}/studies?` + qs(p), { timeoutMs: 30000, retries: 2 });
  return { studies: (j.studies || []).map(parseStudy), total: j.totalCount ?? null, next: j.nextPageToken || null };
}

/** 여러 페이지를 훑어 최대 maxScan건까지 모은다. 총 건수와 잘림 여부를 함께 돌려준다. */
export async function ctScan(a, { maxScan = 1000, fields = LIST_FIELDS, sort } = {}) {
  const all = [];
  let token = null;
  let total = null;
  let pages = 0;
  do {
    const r = await ctSearch(a, { pageSize: Math.min(1000, maxScan - all.length), pageToken: token, fields, sort });
    pages++;
    total = r.total ?? total;
    all.push(...r.studies);
    token = r.next;
  } while (token && all.length < maxScan && pages < 10);
  return { studies: all, total, 잘림: total !== null ? all.length < total : !!token, 페이지수: pages };
}

export async function ctGet(nct) {
  const id = String(nct).trim().toUpperCase();
  if (!/^NCT\d{8}$/.test(id)) throw new SourceError(`NCT 번호 형식이 아닙니다: ${nct} (예: NCT01579188)`);
  let j;
  try {
    j = await httpJson(`${CT}/studies/${id}?format=json`, { timeoutMs: 30000 });
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
  const pm = j.protocolSection || {};
  const base = parseStudy(j);
  const d = pm.descriptionModule || {};
  const el = pm.eligibilityModule || {};
  const oc = pm.outcomesModule || {};
  const ai = pm.armsInterventionsModule || {};
  const cl = pm.contactsLocationsModule || {};
  const ds = pm.designModule || {};
  const spn = pm.sponsorCollaboratorsModule || {};
  const out = {
    ...base,
    공식제목: pm.identificationModule?.officialTitle,
    요약: clip(d.briefSummary, 1500),
    상세설명: clip(d.detailedDescription, 1500),
    설계: {
      배정: ds.designInfo?.allocation, 중재모델: ds.designInfo?.interventionModel, 목적: ds.designInfo?.primaryPurpose,
      눈가림: ds.designInfo?.maskingInfo?.masking, 인원구분: ds.enrollmentInfo?.type,
    },
    협력기관: (spn.collaborators || []).map((c) => c.name),
    군_중재: (ai.armGroups || []).map((g) => ({ 군: g.label, 유형: g.type, 설명: clip(g.description, 300), 중재: g.interventionNames })),
    일차평가변수: (oc.primaryOutcomes || []).slice(0, 8).map((o) => ({ 지표: o.measure, 시점: o.timeFrame })),
    이차평가변수: (oc.secondaryOutcomes || []).slice(0, 8).map((o) => ({ 지표: o.measure, 시점: o.timeFrame })),
    선정기준: { 성별: el.sex, 최소연령: el.minimumAge, 최대연령: el.maximumAge, 건강인포함: el.healthyVolunteers, 기준문: clip(el.eligibilityCriteria, 1500) },
    시험기관수: (cl.locations || []).length,
    시험기관: (cl.locations || []).slice(0, 8).map((l) => [l.facility, l.city, l.country].filter(Boolean).join(", ")),
    키워드: pm.conditionsModule?.keywords,
    참고문헌PMID: (pm.referencesModule?.references || []).map((r) => r.pmid).filter(Boolean),
    결과섹션있음: !!j.resultsSection,
    상태이력: undefined,
  };
  delete out._phases;
  delete out._intervs;
  return out;
}

const CORE_TYPES = new Set(["DRUG", "BIOLOGICAL", "GENETIC", "COMBINATION_PRODUCT", "DIETARY_SUPPLEMENT", "RADIATION", "PROCEDURE", "DEVICE", "BEHAVIORAL", "DIAGNOSTIC_TEST", "OTHER"]);
const NOISE = /^(placebo|saline|normal saline|standard of care|sham|control|usual care|best supportive care|vehicle)\b/i;

const normInterv = (n) => String(n || "").replace(/\s+/g, " ").trim();

/** 조건/중재/스폰서 등으로 모은 시험을 단계·상태·스폰서·중재·연도별로 집계 */
export function summarizeLandscape(studies, top = 15) {
  const sponsorOf = (s) => s.스폰서;
  const phaseCounts = tally(studies.map((s) => (s._phases.length ? s._phases.map(phaseLabel).join("/") : "미기재")), 12);
  const intervs = [];
  for (const s of studies) {
    const seen = new Set();
    for (const i of s._intervs) {
      if (!["DRUG", "BIOLOGICAL", "GENETIC", "COMBINATION_PRODUCT"].includes(i.type)) continue;
      const n = normInterv(i.name);
      if (!n || NOISE.test(n) || seen.has(n.toLowerCase())) continue;
      seen.add(n.toLowerCase());
      intervs.push(n);
    }
  }
  const years = studies.map((s) => (s.시작일 ? String(s.시작일).slice(0, 4) : "미기재"));
  return {
    단계별: phaseCounts,
    상태별: tally(studies.map((s) => s.상태), 12),
    상위스폰서: tally(studies.map(sponsorOf), top),
    스폰서구분: tally(studies.map((s) => s.스폰서구분), 8),
    상위중재: tally(intervs, top),
    시작연도별: tally(years, 40).sort((a, b) => String(a.키).localeCompare(String(b.키))),
  };
}

/**
 * 회사 파이프라인: 스폰서 별칭으로 모은 시험을 중재(약물)별로 묶어
 * 최고 단계·적응증·상태별 건수·최신 시험을 낸다. 리드 스폰서가 별칭과 일치하는 시험만 쓴다(기본).
 */
export function buildPipeline(studies, aliases, { leadOnly = true, drugOnly = true } = {}) {
  const keys = aliases.map(normCompany).filter(Boolean);
  const match = (name) => {
    const n = normCompany(name);
    return n && keys.some((k) => n.includes(k) || k.includes(n));
  };
  const mine = studies.filter((s) => (leadOnly ? match(s.스폰서) : true));
  const byDrug = new Map();
  for (const s of mine) {
    const names = new Set();
    for (const i of s._intervs) {
      const n = normInterv(i.name);
      if (!n || NOISE.test(n)) continue;
      if (drugOnly && !["DRUG", "BIOLOGICAL", "GENETIC", "COMBINATION_PRODUCT"].includes(i.type)) continue;
      names.add(n);
    }
    if (!names.size) names.add("(약물 중재 미기재)");
    for (const n of names) {
      const key = n.toLowerCase();
      if (!byDrug.has(key)) byDrug.set(key, { 약물: n, 시험수: 0, 적응증: new Set(), 단계: new Set(), 상태: {}, 최고단계순위: -1, 시험: [] });
      const e = byDrug.get(key);
      e.시험수++;
      s.적응증.forEach((c) => e.적응증.add(c));
      s._phases.forEach((p) => {
        e.단계.add(p);
        e.최고단계순위 = Math.max(e.최고단계순위, phaseRank(p));
      });
      e.상태[s.상태] = (e.상태[s.상태] || 0) + 1;
      e.시험.push({ NCT: s.NCT, 단계: s.단계, 상태: s.상태, 시작일: s.시작일, 적응증: s.적응증.slice(0, 3), 제목: clip(s.제목, 90) });
    }
  }
  const rows = [...byDrug.values()]
    .map((e) => ({
      약물: e.약물,
      최고단계: Object.entries(PHASE_RANK).find(([, v]) => v === e.최고단계순위)?.[0] ? phaseLabel(Object.entries(PHASE_RANK).find(([, v]) => v === e.최고단계순위)[0]) : "미기재",
      시험수: e.시험수,
      적응증: [...e.적응증].slice(0, 6),
      상태별: e.상태,
      _rank: e.최고단계순위,
      시험: e.시험.sort((a, b) => String(b.시작일).localeCompare(String(a.시작일))).slice(0, 6),
    }))
    .sort((a, b) => b._rank - a._rank || b.시험수 - a.시험수)
    .map(({ _rank, ...r }) => r);
  const sponsorsSeen = tally(mine.map((s) => s.스폰서), 10);
  return { 시험수: mine.length, 약물수: rows.length, 스폰서표기: sponsorsSeen, 약물: rows, 제외된시험수: studies.length - mine.length };
}
