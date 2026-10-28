# pharma-intel-mcp

신약 개발사 경쟁·규제 정보를 무료 공개 데이터로 조회하는 MCP 서버입니다(포니링크 기반기술사업부문). 임상(ClinicalTrials.gov), 미국 FDA(openFDA), 유럽 EMA, 한국 식약처 임상시험계획 승인 현황을 한 곳에서 부릅니다. 논문 검색은 짝 서버인 [scholar-mcp](https://github.com/Sejin-Koo/scholar-mcp)가 맡습니다.

## 도구

| 도구 | 소스 | 용도 |
|---|---|---|
| ct_search_trials | ClinicalTrials.gov v2 | 적응증·약물·스폰서·단계·상태·시작일·국가 조합 검색, 전체 건수 |
| ct_get_trial | 〃 | NCT 번호별 상세(설계·투여군·평가변수·선정기준·참여국가) |
| ct_landscape | 〃 | 적응증·약물 단위 경쟁 현황 집계(단계·상태·상위 스폰서·중재·연도) |
| ct_company_pipeline | 〃 | 회사 표기 여러 개로 모은 파이프라인(약물별 최고 단계) |
| fda_approvals | openFDA Drugs@FDA | 승인 이력, 기간 내 신규 승인(제출 단위 재필터) |
| fda_label | openFDA label | 허가사항 섹션별 발췌 |
| fda_adverse_events | openFDA FAERS | 이상사례 보고 집계(자발보고, 인과 아님) |
| fda_recalls | openFDA enforcement | 의약품·기기·식품 회수 |
| ema_search | EMA JSON 데이터 | 허가·심사 현황, 희귀의약품, PIP, 공급 부족, 재평가, 안전성 서한 |
| mfds_clinical_trials | 공공데이터포털(식약처) | 국내 임상시험계획 승인 현황 조회·집계 |
| pharma_competitor_profile | 위 4개 | 회사 하나의 종합 프로필(표기 여러 개 입력) |
| pharma_api_status | — | 키 설정 여부와 소스별 실호출 확인 |

## 환경변수 (값은 저장소에 넣지 않고 Vercel에만 둡니다)

| 이름 | 필수 | 설명 |
|---|---|---|
| DATA_PORTAL_KEY | 식약처 도구에 필수 | 공공데이터포털 인증키 |
| OPENFDA_API_KEY | 권장 | 없으면 일 1,000건, 있으면 일 120,000건 |
| MCP_GATE_KEYS | 권장 | 접근 허용 키(쉼표 구분). 호출 주소에 `?k=키`로 붙임 |
| MCP_GATE_MODE | 선택 | `enforce`이면 키 없는 호출 거부, 기본은 관찰만 |

ClinicalTrials.gov와 EMA는 키가 필요 없습니다.

## 알려진 함정 (실측)

- openFDA 날짜·상태 조건은 신청서 안의 어느 제출이든 일치하면 신청서를 돌려줍니다. 이 서버가 제출 단위로 다시 걸러 `조건일치_제출`에 담습니다.
- openFDA 스폰서명은 대문자 정확 문자열이라 첫 단어로 찾은 뒤 서버에서 걸러냅니다. 결과가 없으면 404가 오는데 이는 0건으로 처리합니다.
- FAERS 일자 집계는 1,000일 상한이 있어 오래 쓰인 약은 연도별로 따로 셉니다.
- 식약처 API는 일련번호 순으로 돌려주며 승인일과 정확히 일치하지 않습니다(변경 승인 건이 앞쪽에 섞임). 한 번에 최대 500건이고, 이 서버는 뒤쪽 페이지부터 읽고 읽은 범위 안에서 승인일로 정렬합니다. 범위를 다 읽지 못하면 `잘림`으로 표시합니다.
- ClinicalTrials.gov 스폰서는 등록된 영문 표기 그대로여야 하며 같은 회사가 여러 표기로 등록돼 있습니다. 표기를 모두 넣으세요.
- 회사별 건수는 시스템마다 정의가 달라 서로 더하거나 비교하지 마세요.

## 로컬 실행·테스트

```bash
npm install
OPENFDA_API_KEY=... DATA_PORTAL_KEY=... node smoke.mjs
```

배포는 Vercel(`api/mcp.js`, 상태 비저장 Streamable HTTP)이며 main에 푸시하면 자동 배포됩니다.
