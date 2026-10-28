// 실제 API로 모든 도구를 MCP 프로토콜 그대로(인메모리 전송) 호출하는 스모크 테스트.
//   OPENFDA_API_KEY=... DATA_PORTAL_KEY=... node smoke.mjs [도구명 ...]
// 키는 환경변수로만 받는다(저장소에 넣지 말 것).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "./lib/server.js";

const server = buildServer();
const client = new Client({ name: "smoke", version: "0" });
const [ct, st] = InMemoryTransport.createLinkedPair();
await server.connect(st);
await client.connect(ct);

const only = new Set(process.argv.slice(2));
let pass = 0, failN = 0;

async function call(name, args, check, label = "") {
  if (only.size && !only.has(name)) return null;
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text || "";
  let body = null;
  try { body = JSON.parse(text); } catch { /* 오류 문구 */ }
  let verdict = false;
  try { verdict = !!(check ? check(body, text, r) : !r.isError); } catch (e) { verdict = false; }
  verdict ? pass++ : failN++;
  console.log(`${verdict ? "✅" : "❌"} ${name}${label ? " [" + label + "]" : ""} ${JSON.stringify(args).slice(0, 110)} (${Date.now() - t0}ms)`);
  if (!verdict) console.log("   ", text.slice(0, 700).replace(/\n/g, " "));
  return body;
}
const isErr = (b, t, r) => r.isError === true;

const tools = await client.listTools();
console.log("도구:", tools.tools.map((t) => t.name).join(", "));

// ── 상태 ──
await call("pharma_api_status", { live_check: "true" },
  (b) => b?.실호출?.clinicaltrials?.정상 && b.실호출.openfda.정상 && b.실호출.ema.정상 && b.실호출.mfds.정상, "4소스 실호출");

// ── ClinicalTrials.gov ──
const t1 = await call("ct_search_trials", { condition: "Alzheimer", phase: "PHASE3", status: "RECRUITING", max_results: "5" },
  (b) => b?.시험?.length === 5 && b.요약.전체건수 > 5 && b.시험.every((s) => /3/.test(String(s.단계)) && s.상태 === "RECRUITING"), "문자열 숫자·쉼표목록 + 단계/상태 실효");
if (t1) console.log("    전체건수:", t1.요약.전체건수, "다음토큰:", !!t1.요약.다음페이지토큰);
await call("ct_search_trials", { condition: "Alzheimer", max_results: 3, page_token: t1?.요약?.다음페이지토큰 }, (b) => b?.시험?.length > 0, "페이지 토큰");
await call("ct_search_trials", { condition: "Alzheimer", start_from: "2026-01-01", max_results: 20, sort: "start" },
  (b) => b.시험.length > 0 && b.시험.every((s) => String(s.시작일) >= "2026-01"), "start_from 실효");
await call("ct_search_trials", { condition: "Alzheimer", start_from: "2010-01-01", start_to: "2010-12-31", max_results: 20 },
  (b) => b.시험.length > 0 && b.시험.every((s) => String(s.시작일).startsWith("2010")), "시작일 구간 실효");
await call("ct_search_trials", { condition: "Alzheimer", phase: "PHASE3", status: "COMPLETED", has_results: "true", max_results: 5 },
  (b) => b.요약.전체건수 > 0 && b.요약.전체건수 < 200, "has_results 조합(82건 근처)");
await call("ct_search_trials", { sponsor: "Gemvax", max_results: 10 }, (b) => b.시험.length > 0, "스폰서 검색");
await call("ct_search_trials", { condition: "zzzxqnonexistentcondition" }, (b) => b.요약.전체건수 === 0 && b.시험.length === 0, "0건 정상 처리");
await call("ct_search_trials", {}, isErr, "조건 없음 → 오류");
await call("ct_search_trials", { condition: "cancer", max_results: 1000 }, (b, t, r) => r.isError === true || b?.시험?.length <= 100, "범위 밖 max_results는 거부(또는 상한)");

await call("ct_get_trial", { nct_ids: "NCT01579188, NCT00000000" }, (b) => b?.시험?.length === 2 && b.시험[0].NCT && b.시험[1].오류, "상세 + 없는 번호 개별 오류");

const l1 = await call("ct_landscape", { condition: "Alzheimer", max_scan: 200, top: "8" },
  (b) => b?.요약?.집계대상 === 200 && b.요약.잘림 === true && b.상위스폰서?.length === 8 && b.단계별?.length > 0, "max_scan=200 → 잘림 표시");
if (l1) console.log("    일치전체:", l1.요약.일치전체건수, "상위중재:", l1.상위중재?.slice(0, 3).map((x) => x.키).join(" / "));
await call("ct_landscape", { sponsor: "Gemvax", max_scan: 500 }, (b) => b.요약.잘림 === false && b.요약.집계대상 === b.요약.일치전체건수, "소량 → 잘림 false");

const p1 = await call("ct_company_pipeline", { companies: "Gemvax, Kael-GemVax, GemVax & Kael", max_drugs: 10 },
  (b) => b?.약물?.length > 0 && b.요약.주관시험수 > 0 && b.스폰서표기?.length > 0, "별칭 3개 → 파이프라인");
if (p1) console.log("    약물:", p1.약물.slice(0, 4).map((d) => `${d.약물}(${d.최고단계},${d.시험수})`).join(" | "), "| 스폰서표기:", p1.스폰서표기.map((x) => x.키).join(", "));
await call("ct_company_pipeline", { companies: "Eisai", status: "RECRUITING", max_scan: 200, max_drugs: 5 },
  (b) => b.약물.length <= 5 && b.약물.every((d) => Object.keys(d.상태별).every((k) => k === "RECRUITING")), "status 한정 실효");

// ── openFDA ──
const f1 = await call("fda_approvals", { brand: "LEQEMBI" }, (b) => b?.승인이력?.length > 0 && b.승인이력[0].신청번호 && b.승인이력[0].최초승인일, "브랜드");
if (f1) console.log("    ", f1.승인이력[0].신청번호, f1.승인이력[0].스폰서, f1.승인이력[0].최초승인일);
await call("fda_approvals", { date_from: "2025-01-01", date_to: "2025-03-31", submission_type: "ORIG", status_code: "AP", max_results: 20 },
  (b) => b.승인이력.length > 0 && b.승인이력.every((r) => r.조건일치_제출?.some((s) => s.유형 === "ORIG" && s.일자 >= "2025-01-01" && s.일자 <= "2025-03-31")), "날짜+ORIG 제출 단위 재필터");
await call("fda_approvals", { sponsor: "Eisai", max_results: 5 }, (b) => b.승인이력.length > 0 && b.승인이력.every((r) => /EISAI/i.test(r.스폰서)), "스폰서 첫 단어");
await call("fda_approvals", { brand: "LEQEMBI", max_results: 1, max_scan: 100 }, (b) => b.승인이력.length === 1, "max_results=1");
await call("fda_approvals", { brand: "ZZZNOSUCHDRUG" }, (b) => b.승인이력.length === 0 && b.요약.서버일치건수 === 0, "0건(404) 정상 처리");
await call("fda_approvals", {}, isErr, "조건 없음 → 오류");

await call("fda_label", { brand: "LEQEMBI", sections: "indications,boxed_warning", max_chars: 400 },
  (b) => b?.라벨?.length > 0 && b.라벨[0].섹션.indications && b.라벨[0].섹션.indications.length <= 401, "라벨 섹션·글자 상한 실효");
await call("fda_label", { generic: "lecanemab", sections: ["mechanism"], max_chars: 200 }, (b) => b.라벨.length > 0 && b.라벨[0].섹션.mechanism !== undefined, "섹션 선택");

const ev = await call("fda_adverse_events", { drug: "lecanemab", group_by: "reaction", top: 5 },
  (b) => b?.요약?.총보고건수 > 0 && b.집계.length === 5, "반응 상위 5");
if (ev) console.log("    총보고:", ev.요약.총보고건수, "상위:", ev.집계.slice(0, 3).map((x) => x.키).join(", "));
await call("fda_adverse_events", { drug: "lecanemab", group_by: "year" }, (b) => b.집계.length > 0 && /^\d{4}$/.test(b.집계[0].키) && b.집계.reduce((s, x) => s + x.건수, 0) === b.요약.총보고건수, "연도별 합계=총건수");
await call("fda_adverse_events", { drug: "aspirin", group_by: "year" }, (b) => b.집계.length >= 15 && b.집계.every((x) => /^\d{4}$/.test(x.키)) && b.집계.reduce((s, x) => s + x.건수, 0) === b.요약.총보고건수, "연도별(1000일 초과 약물 → 연도별 재집계, 합계=총건수)");
await call("fda_adverse_events", { drug: "lecanemab", group_by: "sex" }, (b) => b.집계.every((x) => ["남", "여", "미상"].includes(x.키)), "성별 라벨");
await call("fda_adverse_events", { drug: "lecanemab", serious: "true" }, (b, t) => b.요약.총보고건수 > 0, "중대만");
await call("fda_adverse_events", { drug: "lecanemab", date_from: "2099-01-01" }, (b) => b.요약.총보고건수 === 0, "미래 날짜 → 0건");
await call("fda_adverse_events", { drug: "zzznosuchdrug" }, (b) => b.요약.총보고건수 === 0, "없는 약 → 0건");

await call("fda_recalls", { kind: "drug", classification: "Class I", max_results: 5 }, (b) => b?.회수?.length > 0 && b.회수.every((r) => r.등급 === "Class I"), "등급 실효");
await call("fda_recalls", { firm: "Pfizer", date_from: "2024-01-01", max_results: 3 }, (b) => b.회수.length >= 0, "업체+기간");
await call("fda_recalls", {}, isErr, "조건 없음 → 오류");

// ── EMA ──
await call("ema_search", { dataset: "medicines", query: "alzheimer", filters: { medicine_status: "Authorised" }, max_results: 5 },
  (b) => b?.결과?.length > 0 && b.결과.every((r) => r.medicine_status === "Authorised") && b.요약.데이터기준시각, "상태 필터 실효");
await call("ema_search", { dataset: "medicines", date_from: "2025-01-01", date_to: "2025-12-31", filters: { medicine_status: "Authorised" }, max_results: 50 },
  (b) => b.결과.length > 0 && b.결과.every((r) => String(r[b.요약.정렬기준일]).split("/").reverse().join("-").startsWith("2025")), "허가일 2025 구간 실효");
await call("ema_search", { dataset: "medicines", query: "alzheimer", max_results: 3, offset: 3 }, (b) => b.결과.length > 0, "offset");
await call("ema_search", { dataset: "orphan", query: "alzheimer", max_results: 3 }, (b) => b.요약.일치건수 >= 0 && b.결과, "orphan");
await call("ema_search", { dataset: "shortages", max_results: 3 }, (b) => b.결과.length > 0, "shortages");
await call("ema_search", { dataset: "dhpc", max_results: 3 }, (b) => b.결과.length > 0, "dhpc");
await call("ema_search", { dataset: "medicines", filters: { nosuchfield: "x" } }, isErr, "잘못된 필터 키 → 오류");
await call("ema_search", { dataset: "medicines", query: "zzzzqqq" }, (b) => b.요약.일치건수 === 0, "0건");

// ── 식약처 ──
const m1 = await call("mfds_clinical_trials", { sponsor: "젬백스", summarize: "true", max_results: 5 },
  (b) => b?.요약?.전체일치건수 > 0 && b.집계?.시험약별?.length > 0 && b.시험.length > 0, "의뢰자 부분일치 + 집계");
if (m1) console.log("    전체:", m1.요약.전체일치건수, "시험약:", m1.집계.시험약별.slice(0, 4).map((x) => x.키).join(", "));
await call("mfds_clinical_trials", { date_from: "2026-09-01", date_to: "2026-10-27", max_results: 20, newest_first: "true" },
  (b) => b.시험.length > 0 && b.시험.every((t) => t.승인일 >= "2026-09-01" && t.승인일 <= "2026-10-27") && b.시험[0].승인일 >= b.시험[b.시험.length - 1].승인일, "승인일 구간 + 내림차순");
await call("mfds_clinical_trials", { date_from: "2026-09-01", max_results: 5, newest_first: "false", max_scan: 100 },
  (b) => b.시험.length > 0 && b.시험[0].승인일 <= b.시험[b.시험.length - 1].승인일, "오름차순 전환 실효");
await call("mfds_clinical_trials", { product: "GV1001", include_detail: "true", max_results: 3 },
  (b) => b.시험.length > 0 && ("시험기간" in b.시험[0] || "대조약" in b.시험[0] || "일차평가변수" in b.시험[0]), "상세 필드");
await call("mfds_clinical_trials", { sponsor: "한미약품", max_results: 3, max_scan: 100 }, (b) => b.시험.length > 0 && b.시험.every((t) => !("일차평가변수" in t)), "기본은 상세 제외");
await call("mfds_clinical_trials", { sponsor: "존재하지않는회사xyz" }, (b) => b.요약.전체일치건수 === 0 && b.시험.length === 0, "0건");
await call("mfds_clinical_trials", { date_from: "2020-01-01", max_scan: 100, max_results: 100, summarize: "true" },
  (b) => b.요약.잘림 === true && b.요약.훑은건수 <= 100, "max_scan 상한·잘림 표시");

// ── 경쟁사 종합 ──
const cp = await call("pharma_competitor_profile", { names: "Gemvax, Kael-GemVax, 젬백스, 카엘젬백스", top: 5 },
  (b) => b?.ct?.약물수 > 0 && b.mfds?.시험수_중복제거 > 0 && b.fda && b.ema, "4시스템 병렬");
if (cp) console.log("    ct 약물:", cp.ct?.약물수, "mfds 시험:", cp.mfds?.시험수_중복제거, "fda:", JSON.stringify(cp.fda).slice(0, 80), "ema:", cp.ema?.일치건수);
await call("pharma_competitor_profile", { names: "Eisai", systems: "fda, ema", top: 3 }, (b) => b.fda?.신청건수 > 0 && b.ema?.일치건수 > 0 && !b.ct && !b.mfds, "systems 선택 실효");
await call("pharma_competitor_profile", { names: "한미약품", systems: ["mfds", "fda"] }, (b) => b.mfds?.시험수_중복제거 > 0 && b.fda?.건너뜀, "한글만 → FDA 건너뜀");
await call("pharma_competitor_profile", { names: "" }, isErr, "빈 입력 → 오류");

console.log(`\n결과: 통과 ${pass} / 실패 ${failN}`);
process.exit(failN ? 1 : 0);
