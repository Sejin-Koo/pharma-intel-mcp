// 식품의약품안전처 의약품 임상시험계획 상세정보 (공공데이터포털 15 ClncExamPlanDtlService03)
// 하루 10,000건 호출. 1회 최대 500건(1000건 요청은 오류), 승인일 오름차순으로 돌아온다.
import { httpJson, qs, SourceError, clip, tally } from "./util.js";

const URL_ = "https://apis.data.go.kr/1471000/ClncExamPlanDtlService03/getClncExamPlanDtlInq03";
const key = () => (process.env.DATA_PORTAL_KEY || "").trim();
export const MFDS_PAGE = 500;

export function parseTrial(it) {
  const d = (s) => (s ? String(s).slice(0, 10) : null);
  return {
    일련번호: it.CLNC_TEST_SN,
    의뢰자: it.ORGN_DEV_BSSH_NM,
    시험약: it.PRDT_NM,
    일반명: it.GNRL_CD_NM,
    임상단계: it.CLINIC_STEP_NM,
    임상유형: it.CLINIC_TYPE_CD_NM,
    승인일: d(it.CLST_APRV_DT),
    시험제목: clip(it.CLNC_TEST_TITLE, 200),
    영문제목: clip(it.CLNC_TEST_ENG_TITLE, 200),
    시험목적구분: it.CLST_PRPOS_CD_NM,
    개발구분: it.DMINT_DIVS_CD_NM,
    시험구분: it.CLNC_TEST_DTL_CD_NM,
    대상질환분류: it.TRGT_DISS_CD_NM,
    대상질환: it.TRGT_DISS_NM,
    대조약: it.COMP_DRUG_NM,
    위약대조: it.PLCB_YN,
    무작위배정: it.RNDM_ASSG_CD_NM,
    눈가림: it.BLND_CD_NM,
    대상자수: it.TESTEE_CNT_INFO,
    시험기간: it.CLINICAL_PERIOD,
    시작일: d(it.CLST_BGNG_DT),
    종료일: d(it.CLST_END_DT),
    시험완료일: d(it.TEST_COMPLETION_DT),
    결과보고제출일: d(it.RESULT_REPORT_SUBMIT_DT),
    상태: it.STATUS,
    일차평가변수: clip(it.PRIM_EVL_VAR, 200),
    개발국가: it.ORGN_DEV_NATN_CD_NM,
    소재지: it.ADDR,
  };
}

export async function mfdsPage({ page = 1, rows = MFDS_PAGE, sponsor, product, generic, from, to }) {
  if (!key()) throw new SourceError("DATA_PORTAL_KEY가 설정되지 않았습니다");
  const p = {
    serviceKey: key(), pageNo: page, numOfRows: Math.min(rows, MFDS_PAGE), type: "json",
    orgn_dev_bssh_nm: sponsor, prdt_nm: product, gnrl_cd_nm: generic,
    clst_aprv_start_dt: from, clst_aprv_end_dt: to,
  };
  const j = await httpJson(`${URL_}?` + qs(p), { timeoutMs: 40000, retries: 2 });
  if (j.OpenAPI_ServiceResponse) throw new SourceError(`식약처 API 오류: ${j.OpenAPI_ServiceResponse.cmmMsgHeader?.returnAuthMsg || j.OpenAPI_ServiceResponse.cmmMsgHeader?.errMsg}`);
  const h = j.header || {};
  if (h.resultCode && h.resultCode !== "00") throw new SourceError(`식약처 API 오류 ${h.resultCode}: ${h.resultMsg}`);
  const b = j.body || {};
  return { items: (b.items || []).map((x) => (x.item ? x.item : x)), total: Number(b.totalCount) || 0 };
}

/**
 * 조건에 맞는 시험을 모은다. newestFirst면 마지막 페이지부터 거꾸로 읽어 최신 승인분을 우선 확보한다.
 */
export async function mfdsScan(f, { maxScan = 1000, newestFirst = true } = {}) {
  const first = await mfdsPage({ ...f, page: 1, rows: MFDS_PAGE });
  const total = first.total;
  if (!total) return { items: [], total: 0, 스캔건수: 0, 잘림: false };
  const pages = Math.ceil(total / MFDS_PAGE);
  const need = Math.min(Math.ceil(maxScan / MFDS_PAGE), pages);
  const order = [];
  if (newestFirst) for (let i = 0; i < need; i++) order.push(pages - i);
  else for (let i = 1; i <= need; i++) order.push(i);
  const got = new Map();
  if (order.includes(1)) got.set(1, first.items);
  const todo = order.filter((p) => p !== 1);
  for (let i = 0; i < todo.length; i += 3) {
    const batch = await Promise.all(todo.slice(i, i + 3).map((p) => mfdsPage({ ...f, page: p, rows: MFDS_PAGE }).then((r) => [p, r.items])));
    for (const [p, it] of batch) got.set(p, it);
  }
  let items = order.flatMap((p) => got.get(p) || []);
  // API 순서는 일련번호 기준이라 승인일과 정확히 일치하지 않는다(변경 승인 건이 앞쪽에 섞임) → 모은 범위 안에서 승인일로 정렬
  items = items.sort((a, b) => (newestFirst ? -1 : 1) * String(a.CLST_APRV_DT).localeCompare(String(b.CLST_APRV_DT)));
  return { items: items.slice(0, Math.max(maxScan, 0)), total, 스캔건수: Math.min(items.length, maxScan), 잘림: total > Math.min(items.length, maxScan) };
}

export function summarize(items, top = 15) {
  const year = (x) => (x.CLST_APRV_DT ? String(x.CLST_APRV_DT).slice(0, 4) : "미기재");
  return {
    의뢰자별: tally(items.map((x) => x.ORGN_DEV_BSSH_NM), top),
    임상단계별: tally(items.map((x) => x.CLINIC_STEP_NM), 10),
    대상질환분류별: tally(items.map((x) => x.TRGT_DISS_CD_NM), top),
    시험약별: tally(items.map((x) => x.PRDT_NM), top),
    승인연도별: tally(items.map(year), 40).sort((a, b) => String(a.키).localeCompare(String(b.키))),
    상태별: tally(items.map((x) => x.STATUS), 10),
  };
}
