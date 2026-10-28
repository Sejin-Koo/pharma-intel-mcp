// pharma-intel-mcp 도구 정의
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { zInt, zBool, zList, SourceError, clip, normCompany, today } from "./util.js";
import { ctSearch, ctScan, ctGet, summarizeLandscape, buildPipeline, PHASES, STATUSES } from "./ct.js";
import { fdaApprovals, fdaLabels, fdaEvents, fdaRecalls, fdaFetch, LABEL_SECTIONS } from "./fda.js";
import { emaSearch, EMA_DATASETS, emaLoad } from "./ema.js";
import { mfdsPage, mfdsScan, summarize as mfdsSummarize, parseTrial, MFDS_PAGE } from "./mfds.js";

const env = (k) => (process.env[k] || "").trim();
const ok = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj) }] });
const fail = (msg) => ({ isError: true, content: [{ type: "text", text: String(msg) }] });

function errInfo(e) {
  if (e instanceof SourceError) {
    if (e.status === 429) return `요청 한도 초과(429)${e.retryAfter ? `, ${e.retryAfter}초 후 재시도` : ""}`;
    return e.message;
  }
  return String(e?.message || e);
}

/** 내부(_로 시작) 필드·빈 값을 떼어 응답용으로 */
function clean(o) {
  if (Array.isArray(o)) return o.map(clean);
  if (o && typeof o === "object") {
    const r = {};
    for (const [k, v] of Object.entries(o)) {
      if (k.startsWith("_") || v === null || v === undefined || (Array.isArray(v) && !v.length)) continue;
      r[k] = clean(v);
    }
    return r;
  }
  return o;
}

const ctFilterShape = {
  query: z.string().optional().describe("자유 검색어(전체 필드). 예: GV1001"),
  condition: z.string().optional().describe("적응증·질환. 예: Alzheimer"),
  intervention: z.string().optional().describe("약물·중재. 예: GV1001, lecanemab"),
  sponsor: z.string().optional().describe("스폰서·협력기관 이름(영문 권장). 예: Gemvax, Kael-GemVax"),
  title: z.string().optional().describe("시험 제목 검색어"),
  location: z.string().optional().describe("국가·도시. 예: Korea, Republic of / Seoul"),
  status: zList(z.enum(STATUSES)).describe("모집 상태(쉼표 구분 가능): " + STATUSES.join(", ")),
  phase: zList(z.enum(PHASES)).describe("임상 단계(쉼표 구분 가능): " + PHASES.join(", ")),
  study_type: z.enum(["INTERVENTIONAL", "OBSERVATIONAL", "EXPANDED_ACCESS"]).optional().describe("시험 유형"),
  start_from: z.string().optional().describe("시험 시작일 하한 YYYY-MM-DD"),
  start_to: z.string().optional().describe("시험 시작일 상한 YYYY-MM-DD"),
  updated_from: z.string().optional().describe("최종 갱신일 하한 YYYY-MM-DD"),
  updated_to: z.string().optional().describe("최종 갱신일 상한 YYYY-MM-DD"),
  has_results: zBool(false).describe("true면 결과가 등록된 시험만"),
};

function ctFilters(a) {
  return {
    query: a.query, condition: a.condition, intervention: a.intervention, sponsor: a.sponsor, title: a.title, location: a.location,
    status: a.status, phase: a.phase, study_type: a.study_type, start_from: a.start_from, start_to: a.start_to,
    updated_from: a.updated_from, updated_to: a.updated_to, has_results: a.has_results === true ? true : undefined,
  };
}
const hasCtFilter = (f) => Object.values(f).some((v) => (Array.isArray(v) ? v.length : v !== undefined && v !== ""));

export function buildServer() {
  const server = new McpServer({ name: "pharma-intel-mcp", version: "1.0.0" });

  // ───────────────────────── ClinicalTrials.gov ─────────────────────────
  server.registerTool(
    "ct_search_trials",
    {
      title: "ClinicalTrials.gov 임상시험 검색",
      description:
        "ClinicalTrials.gov(미국 NIH, 전 세계 등록 시험)에서 임상시험을 검색합니다. 적응증·약물·스폰서·단계·상태·시작일·국가 등을 조합할 수 있고 전체 일치 건수를 함께 돌려줍니다. " +
        "한국 식약처 승인 시험은 mfds_clinical_trials, 회사 단위 종합은 ct_company_pipeline·pharma_competitor_profile을 쓰세요. " +
        "※ 스폰서 이름은 등록된 표기 그대로(영문)여야 잘 걸립니다(예: '(주)카엘젬백스'가 아니라 Kael-GemVax). 표기가 여러 가지면 ct_company_pipeline의 companies에 모두 넣으세요.",
      inputSchema: {
        ...ctFilterShape,
        sort: z.enum(["relevance", "updated", "start", "enrollment"]).optional().describe("relevance(기본)|updated(최근 갱신순)|start(시작일 최신순)|enrollment(등록 인원 많은 순)"),
        max_results: zInt(1, 100, 20).describe("반환 건수(1~100). 기본 20"),
        page_token: z.string().optional().describe("다음 페이지 토큰(이전 응답의 다음페이지토큰)"),
      },
    },
    async (a) => {
      const f = ctFilters(a);
      if (!hasCtFilter(f)) return fail("query·condition·intervention·sponsor 등 검색 조건이 하나 이상 필요합니다");
      const sort = { updated: "LastUpdatePostDate:desc", start: "StartDate:desc", enrollment: "EnrollmentCount:desc" }[a.sort];
      try {
        const r = await ctSearch(f, { pageSize: a.max_results, pageToken: a.page_token, sort });
        return ok({ 요약: { 전체건수: r.total, 반환: r.studies.length, 다음페이지토큰: r.next || undefined }, 시험: clean(r.studies) });
      } catch (e) {
        return fail(`ClinicalTrials.gov 오류: ${errInfo(e)}`);
      }
    }
  );

  server.registerTool(
    "ct_get_trial",
    {
      title: "임상시험 상세(NCT 번호)",
      description: "NCT 번호로 시험 상세(요약·설계·투여군·평가변수·선정기준·참여국가·시험기관)를 가져옵니다. 결과가 등록된 시험은 '결과'에 일차·이차 평가변수의 군별 값·통계 분석(p값·신뢰구간)과 군별 중대한 이상사례 수가 함께 옵니다 — 보도보다 이 등록 수치를 먼저 인용하세요. 최대 5건.",
      inputSchema: { nct_ids: zList(z.string()).describe("NCT 번호 목록(쉼표 구분 가능). 예: NCT01579188") },
    },
    async (a) => {
      const ids = (a.nct_ids || []).slice(0, 5);
      if (!ids.length) return fail("nct_ids가 비어 있습니다");
      const out = [];
      for (const id of ids) {
        try {
          const r = await ctGet(id);
          out.push(r ? clean(r) : { NCT: id, 오류: "찾을 수 없습니다" });
        } catch (e) {
          out.push({ NCT: id, 오류: errInfo(e) });
        }
      }
      return ok({ 시험: out });
    }
  );

  server.registerTool(
    "ct_landscape",
    {
      title: "임상 경쟁 현황 집계(적응증·약물 단위)",
      description:
        "적응증·약물·스폰서 조건에 맞는 시험을 모아 단계별·상태별·상위 스폰서·상위 중재(약물)·시작연도별로 집계합니다. '알츠하이머 임상 경쟁 구도', '이 타깃 파이프라인이 얼마나 붐비나' 같은 질문용입니다. " +
        "최대 max_scan건까지만 훑으며 전체 건수보다 적으면 '잘림'으로 표시하니 그 경우 집계는 일부 표본임을 밝히세요(조건을 좁히면 정확해집니다).",
      inputSchema: {
        ...ctFilterShape,
        max_scan: zInt(50, 5000, 1000).describe("훑을 최대 시험 수(50~5000). 기본 1000"),
        top: zInt(5, 40, 15).describe("상위 N개 표시. 기본 15"),
      },
    },
    async (a) => {
      const f = ctFilters(a);
      if (!hasCtFilter(f)) return fail("condition·intervention·sponsor·query 등 조건이 하나 이상 필요합니다");
      try {
        const r = await ctScan(f, { maxScan: a.max_scan });
        const sum = summarizeLandscape(r.studies, a.top);
        return ok({
          요약: { 일치전체건수: r.total, 집계대상: r.studies.length, 잘림: r.잘림, ...(r.잘림 ? { 잘림안내: "일치 건수가 max_scan보다 많아 일부만 집계했습니다. 조건을 좁히거나 max_scan을 올리세요." } : {}) },
          ...clean(sum),
        });
      } catch (e) {
        return fail(`ClinicalTrials.gov 오류: ${errInfo(e)}`);
      }
    }
  );

  server.registerTool(
    "ct_company_pipeline",
    {
      title: "회사 임상 파이프라인(ClinicalTrials.gov)",
      description:
        "회사(스폰서) 이름 표기 여러 개를 한꺼번에 넣어 그 회사가 주관(lead sponsor)하는 시험을 약물별로 묶어 최고 단계·적응증·상태·최신 시험을 돌려줍니다. " +
        "같은 회사가 'Kael-GemVax'·'GemVax & Kael' 등 여러 표기로 등록돼 있으므로 표기를 모두 넣으세요. 결과의 스폰서표기에서 실제로 잡힌 표기를 확인할 수 있습니다. " +
        "lead_only=false면 협력기관으로 참여한 시험도 포함합니다. 약물 중재만 보려면 drug_only(기본 true).",
      inputSchema: {
        companies: zList(z.string()).describe("회사 표기 목록(쉼표 구분 가능). 예: Gemvax, Kael-GemVax, GemVax & Kael"),
        status: zList(z.enum(STATUSES)).describe("상태 한정(선택)"),
        lead_only: zBool(true).describe("주관 스폰서인 시험만(기본 true)"),
        drug_only: zBool(true).describe("약물·생물학제제·유전자 중재만 약물로 집계(기본 true)"),
        max_scan: zInt(50, 3000, 1000).describe("표기당 훑을 최대 시험 수. 기본 1000"),
        max_drugs: zInt(1, 100, 30).describe("반환할 약물 수. 기본 30"),
      },
    },
    async (a) => {
      const names = (a.companies || []).slice(0, 8);
      if (!names.length) return fail("companies가 비어 있습니다");
      try {
        const byNct = new Map();
        const per = {};
        for (const n of names) {
          const r = await ctScan({ sponsor: n, status: a.status }, { maxScan: a.max_scan });
          per[n] = { 전체건수: r.total, 수집: r.studies.length, 잘림: r.잘림 };
          for (const s of r.studies) if (!byNct.has(s.NCT)) byNct.set(s.NCT, s);
        }
        const p = buildPipeline([...byNct.values()], names, { leadOnly: a.lead_only, drugOnly: a.drug_only });
        return ok({ 요약: { 조회표기: per, 합산시험수_중복제거: byNct.size, 주관시험수: p.시험수, 제외된시험수: p.제외된시험수, 약물수: p.약물수 }, 스폰서표기: p.스폰서표기, 약물: clean(p.약물.slice(0, a.max_drugs)) });
      } catch (e) {
        return fail(`ClinicalTrials.gov 오류: ${errInfo(e)}`);
      }
    }
  );

  // ───────────────────────── openFDA ─────────────────────────
  server.registerTool(
    "fda_approvals",
    {
      title: "FDA 승인 이력(Drugs@FDA)",
      description:
        "미국 FDA 승인 약물(NDA/BLA/ANDA)의 신청번호·스폰서·제품·최초 승인일·심사구분(우선/표준)·제출(변경) 이력을 조회합니다. 브랜드명·성분명·스폰서·신청번호로 검색하고, 날짜 구간을 주면 '그 기간에 승인 처리된 제출'만 남깁니다. " +
        "※ openFDA 날짜 검색은 신청서 안의 어느 제출이든 일치하면 돌려주기 때문에, 이 도구가 제출 단위로 다시 걸러 조건일치_제출에 보여 줍니다. " +
        "※ 스폰서명은 FDA 표기(대문자 'EISAI INC' 형태)이며 첫 단어 기준으로 찾습니다. FDA 승인(허가) 목록은 openFDA에 있는 범위(주로 1939년 이후 Drugs@FDA)입니다. 의료기기는 대상이 아닙니다.",
      inputSchema: {
        brand: z.string().optional().describe("브랜드명. 예: LEQEMBI"),
        ingredient: z.string().optional().describe("성분(일반명). 예: lecanemab"),
        sponsor: z.string().optional().describe("스폰서(신청 회사). 예: Eisai, Pfizer"),
        application: z.string().optional().describe("신청번호. 예: BLA761269, NDA019926"),
        date_from: z.string().optional().describe("제출 처리일 하한 YYYY-MM-DD"),
        date_to: z.string().optional().describe("제출 처리일 상한 YYYY-MM-DD"),
        submission_type: z.enum(["ORIG", "SUPPL"]).optional().describe("ORIG=최초(신약) 신청, SUPPL=변경·추가적응증 등. 날짜와 함께 쓰면 '그 기간 신규 승인'만 추려짐"),
        status_code: z.enum(["AP", "TA"]).optional().describe("AP=승인, TA=잠정승인(tentative)"),
        max_results: zInt(1, 100, 10).describe("반환 건수. 기본 10"),
        max_scan: zInt(100, 2000, 500).describe("날짜 재필터를 위해 훑을 최대 건수. 기본 500"),
      },
    },
    async (a) => {
      try {
        const r = await fdaApprovals(a, { limit: a.max_results, maxScan: a.max_scan });
        return ok({
          요약: { 서버일치건수: r.서버일치건수, 반환: r.records.length, 스캔건수: r.스캔건수, 잘림: r.잘림, 날짜재필터: r.날짜재필터, ...(r.잘림 ? { 잘림안내: "조건에 맞는 건이 더 있을 수 있습니다. max_results·max_scan을 늘리거나 조건을 좁히세요." } : {}) },
          승인이력: clean(r.records),
        });
      } catch (e) {
        return fail(`openFDA 오류: ${errInfo(e)}`);
      }
    }
  );

  server.registerTool(
    "fda_label",
    {
      title: "FDA 허가사항(라벨)",
      description:
        "미국 FDA 의약품 라벨(SPL)에서 적응증·박스경고·용법·금기·경고·이상반응·작용기전·임상시험 요약 등 선택한 섹션을 돌려줍니다. 브랜드명 또는 성분명으로 찾습니다. " +
        "섹션당 max_chars(기본 1500)까지만 반환하므로 전문이 필요하면 max_chars를 늘리세요. 최신 개정 버전만 openFDA에 있습니다.",
      inputSchema: {
        brand: z.string().optional().describe("브랜드명. 예: LEQEMBI"),
        generic: z.string().optional().describe("성분(일반명). 예: lecanemab"),
        set_id: z.string().optional().describe("SPL set_id"),
        sections: zList(z.enum(Object.keys(LABEL_SECTIONS))).describe("반환할 섹션(쉼표 구분). 기본: indications, boxed_warning. 선택지: " + Object.keys(LABEL_SECTIONS).join(", ")),
        max_chars: zInt(200, 20000, 1500).describe("섹션당 최대 글자 수. 기본 1500"),
        max_results: zInt(1, 10, 3).describe("라벨 건수. 기본 3"),
      },
    },
    async (a) => {
      try {
        const r = await fdaLabels(a, { limit: a.max_results, sections: a.sections?.length ? a.sections : ["indications", "boxed_warning"], maxChars: a.max_chars });
        return ok({ 요약: { 일치건수: r.일치건수, 반환: r.records.length, 마지막갱신: r.마지막갱신 }, 라벨: clean(r.records) });
      } catch (e) {
        return fail(`openFDA 오류: ${errInfo(e)}`);
      }
    }
  );

  server.registerTool(
    "fda_adverse_events",
    {
      title: "FDA 이상사례 보고 집계(FAERS)",
      description:
        "FDA 이상사례보고(FAERS)에서 약물 하나의 총 보고 건수와 반응·국가·성별·중대성·적응증·연도별 집계를 돌려줍니다. " +
        "★ 자발보고 자료라 인과관계·발생률을 뜻하지 않으며(과소·중복 보고 가능), 약 판매량이 많을수록 건수도 많아집니다. 결과를 안전성 결론으로 인용하지 말고 신호 탐색용으로만 쓰세요.",
      inputSchema: {
        drug: z.string().min(1).describe("성분명 또는 브랜드명. 예: lecanemab"),
        group_by: z.enum(["reaction", "country", "sex", "serious", "indication", "year", "reporter"]).optional().describe("집계 기준. 기본 reaction"),
        reaction: z.string().optional().describe("특정 반응(MedDRA PT)만 보고. 예: HEADACHE"),
        date_from: z.string().optional().describe("접수일 하한 YYYY-MM-DD"),
        date_to: z.string().optional().describe("접수일 상한 YYYY-MM-DD"),
        serious: zBool(false).describe("true면 중대 이상사례 보고만"),
        top: zInt(5, 100, 20).describe("상위 N개. 기본 20"),
      },
    },
    async (a) => {
      try {
        const r = await fdaEvents(a, { groupBy: a.group_by || "reaction", top: a.top });
        return ok({ 요약: { 약물: a.drug, 총보고건수: r.총보고건수, 집계기준: r.집계기준, 마지막갱신: r.마지막갱신, 주의: "자발보고 자료: 인과관계·발생률 아님" }, 집계: r.집계 });
      } catch (e) {
        return fail(`openFDA 오류: ${errInfo(e)}`);
      }
    }
  );

  server.registerTool(
    "fda_recalls",
    {
      title: "FDA 회수·시장조치(Enforcement)",
      description: "FDA 의약품(drug)·의료기기(device)·식품(food) 회수 보고를 회수업체·제품·등급(Class I~III)·기간으로 조회합니다. 보고일 최신순.",
      inputSchema: {
        kind: z.enum(["drug", "device", "food"]).optional().describe("기본 drug"),
        firm: z.string().optional().describe("회수업체. 예: Pfizer"),
        product: z.string().optional().describe("제품 설명 키워드"),
        classification: z.enum(["Class I", "Class II", "Class III"]).optional().describe("회수 등급(Class I이 가장 위험)"),
        status: z.enum(["Ongoing", "Completed", "Terminated"]).optional(),
        date_from: z.string().optional().describe("보고일 하한 YYYY-MM-DD"),
        date_to: z.string().optional().describe("보고일 상한 YYYY-MM-DD"),
        max_results: zInt(1, 100, 10).describe("반환 건수. 기본 10"),
      },
    },
    async (a) => {
      try {
        const r = await fdaRecalls(a, { limit: a.max_results });
        return ok({ 요약: { 일치건수: r.일치건수, 반환: r.records.length }, 회수: clean(r.records) });
      } catch (e) {
        return fail(`openFDA 오류: ${errInfo(e)}`);
      }
    }
  );

  // ───────────────────────── EMA ─────────────────────────
  server.registerTool(
    "ema_search",
    {
      title: "EMA(유럽의약품청) 공개 데이터 검색",
      description:
        "EMA가 공개한 JSON 데이터를 검색합니다(검색 API가 아니라 EMA가 하루 2회(06:00·18:00 CET) 갱신하는 통파일을 서버가 받아 필터링). " +
        "dataset: medicines(허가·심사 현황: 승인/거절/철회/CHMP 의견 단계, 희귀·조건부·신속심사·PRIME·첨단 플래그) | orphan(희귀의약품 지정) | pip(소아임상시험계획) | shortages(공급 부족) | referrals(재평가 절차) | dhpc(안전성 서한). " +
        "query는 공백 구분 AND(\"구문\" 가능)로 이름·성분·허가권자·적응증·치료영역에서 찾고, filters로 상태·플래그를 정확 일치 필터, 날짜 구간은 date_field 기준입니다. " +
        "응답에 데이터 기준시각이 있으니 '최신'을 말할 때 그 시각을 함께 밝히세요.",
      inputSchema: {
        dataset: z.enum(Object.keys(EMA_DATASETS)).optional().describe("기본 medicines. " + Object.entries(EMA_DATASETS).map(([k, v]) => `${k}=${v.label}`).join(", ")),
        query: z.string().optional().describe("검색어(공백=AND). 예: alzheimer / \"Eisai\" / lecanemab"),
        filters: z.record(z.string(), z.string()).optional().describe(
          "정확 일치 필터 {필드: 값}. medicines: " + EMA_DATASETS.medicines.filters.join("/") + "(값 Yes/No 등, medicine_status: Authorised·Withdrawn·Refused·Opinion·Lapsed…); orphan: status(Positive·Negative·Withdrawn·Expired); shortages: supply_shortage_status; referrals: current_status·referral_type"
        ),
        date_field: z.string().optional().describe("날짜 기준 필드(데이터셋별 기본값 있음). medicines: marketing_authorisation_date, opinion_adopted_date, european_commission_decision_date, start_of_evaluation_date, refusal_of_marketing_authorisation_date, withdrawal_of_application_date …"),
        date_from: z.string().optional().describe("YYYY-MM-DD"),
        date_to: z.string().optional().describe("YYYY-MM-DD"),
        sort: z.enum(["date_desc", "date_asc", "none"]).optional().describe("기본 date_desc"),
        max_results: zInt(1, 200, 20).describe("반환 건수. 기본 20"),
        offset: zInt(0, 10000, 0).describe("건너뛸 건수(페이징). 기본 0"),
      },
    },
    async (a) => {
      try {
        const r = await emaSearch({ dataset: a.dataset || "medicines", query: a.query, filters: a.filters || {}, dateField: a.date_field, dateFrom: a.date_from, dateTo: a.date_to, sort: a.sort || "date_desc", limit: a.max_results, offset: a.offset });
        return ok({ 요약: { 데이터셋: a.dataset || "medicines", 일치건수: r.일치건수, 반환: r.records.length, 데이터기준시각: r.데이터기준시각, 데이터전체건수: r.데이터전체건수, 정렬기준일: r.정렬기준일 }, 결과: r.records });
      } catch (e) {
        return fail(`EMA 오류: ${errInfo(e)}`);
      }
    }
  );

  // ───────────────────────── 식약처 ─────────────────────────
  server.registerTool(
    "mfds_clinical_trials",
    {
      title: "식약처 임상시험계획 승인 현황",
      description:
        "식품의약품안전처 '의약품 임상시험 계획 상세정보'(공공데이터포털)에서 국내 승인된 임상시험계획(IND)을 의뢰자·시험약·일반명·승인일로 조회합니다. " +
        "summarize=true면 조건에 맞는 시험을 의뢰자·임상단계·대상질환·시험약·승인연도별로 집계합니다. " +
        "※ API는 일련번호 순(대체로 승인일 오름차순이지만 변경 승인 건이 섞여 정확히 일치하지는 않음)으로 돌려주므로 이 도구는 기본으로 뒤쪽 페이지(최신)부터 읽고 읽은 범위 안에서 승인일로 정렬합니다(newest_first). 한 호출 최대 500건, 일 10,000건 한도. " +
        "※ 의뢰자·시험약 검색은 부분 일치(예: '젬백스'로 '(주)카엘젬백스'가 잡힘)이며 한글·영문 표기가 섞여 있으므로 표기를 바꿔 한 번 더 찾아 보세요.",
      inputSchema: {
        sponsor: z.string().optional().describe("임상시험 의뢰자(개발업체). 예: 젬백스, 한미약품, Pfizer"),
        product: z.string().optional().describe("시험약 명칭(코드명·제품명). 예: GV1001"),
        generic: z.string().optional().describe("일반명(성분). 예: 메트포르민"),
        date_from: z.string().optional().describe("승인일 하한 YYYY-MM-DD"),
        date_to: z.string().optional().describe("승인일 상한 YYYY-MM-DD"),
        summarize: zBool(false).describe("true면 집계 포함(최대 max_scan건 기준)"),
        newest_first: zBool(true).describe("최신 승인분부터(기본 true)"),
        max_results: zInt(1, 200, 20).describe("목록으로 반환할 건수. 기본 20"),
        max_scan: zInt(100, 8500, 1000).describe("집계·최신순 확보를 위해 훑을 최대 건수. 기본 1000(2페이지 호출)"),
        include_detail: zBool(false).describe("true면 평가변수·대조약·시험기간 등 상세 필드 포함"),
      },
    },
    async (a) => {
      const f = { sponsor: a.sponsor, product: a.product, generic: a.generic, from: a.date_from, to: a.date_to };
      try {
        const r = await mfdsScan(f, { maxScan: Math.max(a.max_scan, a.max_results), newestFirst: a.newest_first });
        const rows = r.items.slice(0, a.max_results).map(parseTrial).map((t) => {
          if (a.include_detail) return t;
          const { 영문제목, 일차평가변수, 시험기간, 대조약, 소재지, 결과보고제출일, 시험완료일, 시험구분, 개발국가, ...rest } = t;
          return rest;
        });
        return ok({
          요약: { 전체일치건수: r.total, 훑은건수: r.스캔건수, 잘림: r.잘림, 반환: rows.length, 정렬: a.newest_first ? "승인일 내림차순(훑은 범위 안에서)" : "승인일 오름차순", ...(r.잘림 ? { 잘림안내: "일치 건수가 훑은 범위보다 많습니다. 집계는 최신 승인분 표본이니 기간·의뢰자로 좁히거나 max_scan을 올리세요." } : {}) },
          ...(a.summarize ? { 집계: mfdsSummarize(r.items) } : {}),
          시험: clean(rows),
        });
      } catch (e) {
        return fail(`식약처 API 오류: ${errInfo(e)}`);
      }
    }
  );

  // ───────────────────────── 경쟁사 종합 ─────────────────────────
  server.registerTool(
    "pharma_competitor_profile",
    {
      title: "경쟁사 종합 프로필(임상·FDA·EMA·식약처)",
      description:
        "회사 하나에 대해 ClinicalTrials.gov 파이프라인, FDA 승인 이력, EMA 허가 현황, 식약처 임상시험계획을 한 번에 모아 요약합니다. " +
        "시스템마다 회사 표기가 달라서(영문 법인명·한글명·옛 이름) names에 알려진 표기를 모두 넣어야 누락이 줄어듭니다. 영문 표기는 CT·FDA·EMA에, 한글 포함 표기는 식약처에 주로 쓰입니다. " +
        "각 시스템은 독립적으로 실행되어 한 곳이 실패해도 나머지는 반환하며, 시스템별 '조회표기'로 어떤 표기가 무엇을 잡았는지 확인할 수 있습니다. 세부는 개별 도구(ct_company_pipeline, fda_approvals, ema_search, mfds_clinical_trials)로 파고드세요.",
      inputSchema: {
        names: zList(z.string()).describe("회사 표기 목록(쉼표 구분 가능). 예: Gemvax, Kael-GemVax, 젬백스, 카엘젬백스"),
        systems: zList(z.enum(["ct", "fda", "ema", "mfds"])).describe("조회할 시스템. 기본 전부"),
        top: zInt(3, 30, 10).describe("시스템별 상위 N건. 기본 10"),
      },
    },
    async (a) => {
      const names = (a.names || []).slice(0, 8);
      if (!names.length) return fail("names가 비어 있습니다");
      const systems = a.systems?.length ? a.systems : ["ct", "fda", "ema", "mfds"];
      const ascii = names.filter((n) => /^[\x20-\x7e]+$/.test(n));
      const top = a.top;
      const jobs = {
        ct: async () => {
          const byNct = new Map();
          const per = {};
          for (const n of ascii.length ? ascii : names) {
            const r = await ctScan({ sponsor: n }, { maxScan: 500 });
            per[n] = { 전체건수: r.total, 수집: r.studies.length, 잘림: r.잘림 };
            for (const s of r.studies) if (!byNct.has(s.NCT)) byNct.set(s.NCT, s);
          }
          const p = buildPipeline([...byNct.values()], names);
          return { 조회표기: per, 주관시험수: p.시험수, 약물수: p.약물수, 스폰서표기: p.스폰서표기, 상위약물: clean(p.약물.slice(0, top).map(({ 시험, ...r }) => ({ ...r, 최신시험: 시험.slice(0, 2) }))) };
        },
        fda: async () => {
          if (!ascii.length) return { 건너뜀: "영문 표기가 없어 FDA 스폰서 검색을 건너뜀" };
          const seen = new Map();
          const per = {};
          for (const n of ascii) {
            const r = await fdaApprovals({ sponsor: n }, { limit: 100, maxScan: 300 });
            per[n] = { 서버일치건수: r.서버일치건수, 반환: r.records.length };
            for (const rec of r.records) if (!seen.has(rec.신청번호)) seen.set(rec.신청번호, rec);
          }
          const recs = [...seen.values()].sort((x, y) => String(y.최초승인일).localeCompare(String(x.최초승인일)));
          return { 조회표기: per, 신청건수: recs.length, 최근승인: clean(recs.slice(0, top).map((r) => ({ 신청번호: r.신청번호, 스폰서: r.스폰서, 브랜드: r.제품.map((p) => p.브랜드).slice(0, 3), 성분: r.제품[0]?.성분, 최초승인일: r.최초승인일 }))) };
        },
        ema: async () => {
          if (!ascii.length) return { 건너뜀: "영문 표기가 없어 EMA 허가권자 검색을 건너뜀" };
          const { data, meta } = await emaLoad("medicines");
          const keys = ascii.map(normCompany).filter(Boolean);
          const hit = data.filter((r) => {
            const m = normCompany(r.marketing_authorisation_developer_applicant_holder);
            return m && keys.some((k) => m.includes(k) || k.includes(m));
          });
          const by = {};
          for (const r of hit) by[r.medicine_status] = (by[r.medicine_status] || 0) + 1;
          return {
            데이터기준시각: meta.timestamp,
            일치건수: hit.length,
            상태별: by,
            의약품: hit.sort((x, y) => String(y.marketing_authorisation_date).split("/").reverse().join("-").localeCompare(String(x.marketing_authorisation_date).split("/").reverse().join("-"))).slice(0, top).map((r) => ({ 이름: r.name_of_medicine, 성분: r.active_substance, 허가권자: r.marketing_authorisation_developer_applicant_holder, 상태: r.medicine_status, 허가일: r.marketing_authorisation_date || undefined, 의견: r.opinion_status || undefined })),
          };
        },
        mfds: async () => {
          const seen = new Map();
          const per = {};
          for (const n of names) {
            const r = await mfdsScan({ sponsor: n }, { maxScan: 1000, newestFirst: true });
            per[n] = { 전체일치건수: r.total, 훑은건수: r.스캔건수 };
            for (const it of r.items) if (!seen.has(it.CLNC_TEST_SN)) seen.set(it.CLNC_TEST_SN, it);
          }
          const items = [...seen.values()].sort((x, y) => String(y.CLST_APRV_DT).localeCompare(String(x.CLST_APRV_DT)));
          const s = mfdsSummarize(items, 8);
          return { 조회표기: per, 시험수_중복제거: items.length, 임상단계별: s.임상단계별, 대상질환분류별: s.대상질환분류별, 시험약별: s.시험약별, 최근승인: clean(items.slice(0, top).map((x) => { const t = parseTrial(x); return { 승인일: t.승인일, 의뢰자: t.의뢰자, 시험약: t.시험약, 임상단계: t.임상단계, 대상질환: t.대상질환 }; })) };
        },
      };
      const settled = await Promise.allSettled(systems.map((s) => jobs[s]()));
      const out = {};
      settled.forEach((r, i) => {
        out[systems[i]] = r.status === "fulfilled" ? r.value : { 오류: errInfo(r.reason) };
      });
      if (settled.every((r) => r.status === "rejected")) return fail(`모든 시스템이 실패했습니다: ${JSON.stringify(out)}`);
      return ok({ 요약: { 입력표기: names, 시스템: systems, 안내: "시스템마다 회사 표기가 달라 건수를 서로 더하거나 비교하지 마세요(범위·정의가 다름)." }, ...out });
    }
  );

  // ───────────────────────── 상태 ─────────────────────────
  server.registerTool(
    "pharma_api_status",
    {
      title: "서버·키 설정 상태",
      description: "각 소스의 API 키 설정 여부(값은 노출하지 않음)를 보여 주고, live_check=true면 소스마다 가벼운 호출로 실제 응답을 확인합니다.",
      inputSchema: { live_check: zBool(false).describe("소스별 실제 호출 확인. 기본 false") },
    },
    async (a) => {
      const out = {
        키설정: {
          OPENFDA_API_KEY: { 설정됨: !!env("OPENFDA_API_KEY"), 효과: "일 1,000→120,000건, 분당 240건" },
          DATA_PORTAL_KEY: { 설정됨: !!env("DATA_PORTAL_KEY"), 효과: "식약처 임상시험계획 API(필수)" },
          MCP_GATE_MODE: { 값: env("MCP_GATE_MODE") || "observe" },
        },
        키불필요: ["ClinicalTrials.gov v2", "EMA JSON 데이터"],
      };
      if (a.live_check) {
        const probe = async (label, fn) => {
          const t0 = Date.now();
          try {
            const r = await fn();
            return [label, { 정상: true, ms: Date.now() - t0, ...r }];
          } catch (e) {
            return [label, { 정상: false, ms: Date.now() - t0, 오류: errInfo(e) }];
          }
        };
        const res = await Promise.all([
          probe("clinicaltrials", async () => ({ 전체건수: (await ctSearch({ query: "aspirin" }, { pageSize: 1 })).total })),
          probe("openfda", async () => ({ 일치건수: (await fdaFetch("drug/label", { search: "openfda.generic_name:aspirin", limit: 1 })).total })),
          probe("ema", async () => ({ 데이터기준시각: (await emaLoad("shortages")).meta.timestamp })),
          probe("mfds", async () => ({ 전체건수: (await mfdsPage({ page: 1, rows: 1 })).total })),
        ]);
        out.실호출 = Object.fromEntries(res);
        out.실호출.확인일 = today();
      }
      return ok(out);
    }
  );

  return server;
}
