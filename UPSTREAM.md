# UPSTREAM: floorplan 에서 가져오는 파일

modelmap 은 floorplan(MIT)의 일부를 가져와 쓰고 나머지는 새로 만든다(접근 B, 포크 아님). 이 문서는 무엇을, 어디서, 어떤 모양으로 가져오는지와 그 원본이 정확히 무엇이었는지를 고정한다.

- 작성: 2026-11-21. A·B 24개 파일을 같은 날 복사했다(§11). 복사할 때마다 아래 표의 "상태" 열을 갱신한다.
- **수정한** 파일의 머리에는 한 줄을 단다: `// Derived from floorplan v0.11.0 (MIT): <원본 경로>`. 바이트 동일 파일(A, 그리고 복사만 한 B)은 머리말을 달지 않고 이 문서로만 출처를 남긴다. B 파일은 첫 수정 때 머리말을 단다. 이렇게 하면 원본과의 diff 가 수정분만 보인다.

## 1. 원본 고정

| 항목 | 값 |
|---|---|
| 저장소 | https://github.com/haydenschmitty/floorplan (MIT, Copyright (c) 2026 Hayden Smith) |
| 버전 | 0.11.0 (2026-11-16) |
| 태그 | `floorplan--v0.11.0` |
| 태그 객체 | `9578130cc7ae5d0f7887c07f4ce1a014dae77fa7` |
| 커밋 | `94f81b463b7617e06d873ac71323ce71644c8399` |
| 해시를 계산한 사본 | `~/.claude/plugins/cache/floorplan/floorplan/0.11.0` (플러그인 설치본) |

## 2. 검증 내역 (2026-11-21)

- 설치본 297개 파일(플러그인 캐시의 `.in_use` 표식 제외)은 마켓플레이스 클론(`~/.claude/plugins/marketplaces/floorplan`, HEAD `94f81b4`, 작업 트리 깨끗함)의 297개 파일과 해시가 모두 같다.
- 원격 `git ls-remote` 에서 태그 `floorplan--v0.11.0` 이 가리키는 커밋이 `94f81b4…` 이고, 클론 HEAD 와 같다.
- GitHub 에서 태그 시점의 `CHECKSUMS.txt` 를 받아 대조했다. 61개 항목이 설치본 해시와 모두 일치한다. (첫 시도는 쉘 글로빙 오류로 0건이 대조되어 무의미했고, 재실행해서 61/61 을 확인했다.)
- `CHECKSUMS.txt` 범위 밖 236개 파일(tests, docs, LICENSE 등)은 위 클론과의 일치로만 확인했다. 별도의 외부 출처와는 대조하지 않았고 git 객체 무결성에 의존한다.

## 3. 분류

| 기호 | 뜻 | 다루는 방법 |
|---|---|---|
| **A** | 그대로 복사 | 바이트 동일. 아래 해시와 같아야 하고, 테스트로 강제한다. 업스트림의 수정(특히 보안)을 해시 차이로 추적한다. |
| **B** | 복사 후 수정 | 원본 해시를 기준점으로 남긴다. 수정은 가능한 한 이름 변경과 제거로 작게 유지해 업스트림과 diff 가 되게 한다. |
| **C** | 발췌·참고 재작성 | 파일을 복사하지 않는다. 함수 일부를 발췌하거나 구조만 참고해 새로 쓴다. |
| **D** | 가져오지 않음 | 이유를 적는다. |

"단계"는 MVP 에 필요한가(MVP), 선택인가(MVP 선택), 다음 단계인가(v1)를 뜻한다.
가져올 위치는 제안이다. 새 저장소 구조는 `.claude-plugin/`, `skills/modelmap/{scripts,assets,references}`, `tests/`, `tools/`, `docs/`, `third_party/` 를 기본으로 한다.

## 4. A: 그대로 복사 (11개)

| 단계 | 원본 경로 | 크기 | 원본 sha256 | 가져올 위치 | 수정·발췌 내용 | 상태 |
|---|---|---|---|---|---|---|
| MVP | `skills/floorplan/assets/page-safety.mjs` | 158줄 | `0c005d140da6182e3dd61034ffef726f2437fd634a010231947926d0622d4750` | `skills/modelmap/assets/page-safety.mjs` | Node 전용, 의존성 없음. CSP 해시·`scriptJson` 이스케이프·에디터 링크 허용목록. floorplan 언급은 주석과 내부 속성명 `data-floorplan-policy`(84행)뿐이라 바이트 동일로 둔다. 업스트림 보안 수정을 해시로 추적하기 위함. | 복사됨 (해시 일치) |
| MVP | `skills/floorplan/assets/vendor/elk.bundled.js` | 1,606,238 B | `b0745abd7f23cd91690a1587e377edbe19fd7233c783300290936720546216d4` | `skills/modelmap/assets/vendor/elk.bundled.js` | elkjs 0.9.3 (EPL-2.0). 업스트림 테스트가 npm 패키지와 바이트 동일함을 검사한다고 문서에 적혀 있으나 우리는 직접 대조하지 않았다(§10). | 복사됨 (해시 일치) |
| MVP | `skills/floorplan/assets/vendor/elkjs-LICENSE.md` | 265줄 | `89591d4578fb1ebd91501312a3d25f021bd865a2e436641c1cf7b1bc7e3c1617` | `skills/modelmap/assets/vendor/elkjs-LICENSE.md` | elkjs 라이선스. ELK와 반드시 함께 둔다. | 복사됨 (해시 일치) |
| MVP | `skills/floorplan/assets/vendor/fonts/inter-latin-ext-wght-normal.woff2` | 85,068 B | `34b9c504cab7a73e37b746343a449132e56cf7b5481af2cb81dc74dcff25c956` | `skills/modelmap/assets/vendor/fonts/inter-latin-ext-wght-normal.woff2` | 지도 한 파일에 인라인되는 글꼴. | 복사됨 (해시 일치) |
| MVP | `skills/floorplan/assets/vendor/fonts/inter-latin-wght-normal.woff2` | 48,256 B | `3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62` | `skills/modelmap/assets/vendor/fonts/inter-latin-wght-normal.woff2` | 지도 한 파일에 인라인되는 글꼴. | 복사됨 (해시 일치) |
| MVP | `skills/floorplan/assets/vendor/fonts/inter-LICENSE.txt` | 94줄 | `3b0a5fca3d17942cde889069889dedbbbd075e9b599968c82a95f4d944e9b345` | `skills/modelmap/assets/vendor/fonts/inter-LICENSE.txt` | 글꼴 라이선스. 글꼴과 함께 둔다. | 복사됨 (해시 일치) |
| MVP | `skills/floorplan/assets/vendor/fonts/jetbrains-mono-latin-ext-wght-normal.woff2` | 15,196 B | `79bfdab9ba467e26eea4122e6f2567e188dd8a09a8c730d501fc487c4ab99c6e` | `skills/modelmap/assets/vendor/fonts/jetbrains-mono-latin-ext-wght-normal.woff2` | 지도 한 파일에 인라인되는 글꼴. | 복사됨 (해시 일치) |
| MVP | `skills/floorplan/assets/vendor/fonts/jetbrains-mono-latin-wght-normal.woff2` | 40,404 B | `18be452724bfdc236c074ca94a249a7f41a86752c7d04ab258ce9ed5651f6a7e` | `skills/modelmap/assets/vendor/fonts/jetbrains-mono-latin-wght-normal.woff2` | 지도 한 파일에 인라인되는 글꼴. | 복사됨 (해시 일치) |
| MVP | `skills/floorplan/assets/vendor/fonts/jetbrains-mono-LICENSE.txt` | 94줄 | `403581b69dac5cff4079205e01c6b467e56af449ecbd7247693ddb1baafa005b` | `skills/modelmap/assets/vendor/fonts/jetbrains-mono-LICENSE.txt` | 글꼴 라이선스. 글꼴과 함께 둔다. | 복사됨 (해시 일치) |
| MVP | `tools/checksums.mjs` | 62줄 | `51f90d24cbe1069b50070d258072636be4b5108e4e5bb5fce34e35e858732d5a` | `tools/checksums.mjs` | 파일 해시 목록 생성·대조. 검사 대상 폴더(`PARTS`)가 없으면 건너뛰므로 .codex-plugin·.agents 가 없어도 수정 없이 동작한다. | 복사됨 (해시 일치) |
| 필수 | `LICENSE` | 22줄 | `65a06a9dab105cd5a2b713a41a020a442bd431e6e19631182ed3889fd1672faf` | `third_party/floorplan/LICENSE` | MIT, Copyright (c) 2026 Hayden Smith. 가져온 파일을 배포할 때 이 고지를 유지한다. | 복사됨 (해시 일치) |

## 5. B: 복사 후 수정 (13개)

| 단계 | 원본 경로 | 크기 | 원본 sha256 | 가져올 위치 | 수정·발췌 내용 | 상태 |
|---|---|---|---|---|---|---|
| MVP | `skills/floorplan/assets/viewer.html` | 2517줄 | `c1af7b9605477f79c962babdb048a08e034809fb3e1ee2338d0cc1701dfe3db6` | `skills/modelmap/assets/viewer.html` | 지도 본체(드릴다운·엣지 집계·ELK 배치·패널·검색·Ask·내보내기). 수정: 모듈·레이어 카드에 파라미터/shape 표시, 텐서 흐름 엣지 라벨, ×N 접기. ELK 설정(1107-1114행: layered, RIGHT, ORTHOGONAL)은 유지. `#cloud-card` 스타일(555행) 제거. `window.FLOORPLAN_SERVER` 등 이름 정리. | 수정함(2026-11-21, 머리말 있음, +60/−10줄): 모델 노드 종류의 색·아이콘, 카드 꼬리(파라미터·출처 태그·×N·글자·가중치 체크), 모듈 개요, `#cloud-card` 제거. 남은 일: 투어·Ask 경고 문구(`floorplan/serve.mjs`), 엣지 라벨(흐름도) |
| MVP | `skills/floorplan/assets/serve.mjs` | 678줄 | `e8717685c341cf94be91dd4feeaddbccc8ee601ac62a4caa7e7be745df1c6696` | `skills/modelmap/assets/serve.mjs` | 유지: 127.0.0.1 전용, Host 허용목록, 실행마다 새 토큰, same-origin 검사, 정적 파일을 지도 폴더 안으로 제한, Ask(`claude -p` 읽기 전용). 제거: Floorplan Cloud 대기자 코드(246-280행: `WAITLIST_URL`, `claude auth status`로 계정 이메일 조회, `joinWaitlist`, `~/.floorplan/settings.json` 저장)와 `/api/cloud/*`(594-613행). 이름·환경변수(`FLOORPLAN_*`) 변경. | 복사됨 (대기자 코드 제거, §11) |
| MVP | `skills/floorplan/assets/graph-query.js` | 261줄 | `60c5ef78ab48cb60fed2a3d712dc8b48c017245042bf7139d242844790f77f3c` | `skills/modelmap/assets/graph-query.js` | 그래프 조회(`createGraphQuery`). 항목 id 체계(3행: n:/f:/r:/s:)와 routes 중심 조회를 모듈·텐서 흐름 중심으로 바꾼다. serve.mjs 가 `new Function` 으로 로드하므로 식별자 이름은 serve.mjs 와 함께 바꾼다. | 복사됨 (원본과 동일) |
| MVP | `skills/floorplan/assets/query-cli.mjs` | 31줄 | `b5d2deedec0ce45fd86e7618370d2a090780883cb63a98c9e08edc81b02937ed` | `skills/modelmap/assets/query-cli.mjs` | `query.mjs` 로 조립되는 CLI(overview/find/show/path). 모델 조회(파라미터·shape what-if)를 추가하고 경로 `floorplan/query.mjs` 를 새 이름으로. | 복사됨 (원본과 동일) |
| MVP | `skills/floorplan/assets/ui/05-theme.js` | 55줄 | `9fb61d68fec54c44ff185c3ba4af4a85c1e54dd90d77ef7bc54c82f0a3c47215` | `skills/modelmap/assets/ui/05-theme.js` | 밝기 테마. 이름만 변경(`window.Floorplan`, `floorplanTheme`). | 복사됨 (원본과 동일) |
| MVP | `skills/floorplan/assets/ui/40-tour.js` | 175줄 | `236b7fd46869d0fa5e2dc7d9ce133849fdd715d25515f17e04edb8faf3993cb0` | `skills/modelmap/assets/ui/40-tour.js` | Start here 투어. Screens 연결 문구(98행 `window.FloorplanScreens`) 제거, 이름 변경. | 복사됨 (원본과 동일) |
| MVP | `skills/floorplan/assets/ui/60-export.js` | 84줄 | `0ac649030dd593656829af33a2f42e0a603aba35128ea7c133abab8d2a6aa7af` | `skills/modelmap/assets/ui/60-export.js` | 공유용 내보내기. 옵션을 flows·notes 중심으로 두고 health 는 모델 점검(v1)으로 교체. | 복사됨 (원본과 동일) |
| MVP | `skills/floorplan/assets/ui/10-glossary.js` | 195줄 | `c41b2ce2e0038cab208579eaeb541223d8175fade09ed360ba53a4c49956a9c3` | `skills/modelmap/assets/ui/10-glossary.js` | 용어 툴팁 장치는 유지하고 용어표를 ML 용어(head_dim, GQA, RoPE, pre-norm 등)로 교체. 비개발자 대상 문구도 개발자용으로. | 복사됨 (원본과 동일) |
| v1 | `skills/floorplan/assets/ui/25-recent.js` | 90줄 | `eaee06a3f1b1eaf72f451bcffb97b04752c0eb5009a9ca1e93c39a70dad9d912` | `skills/modelmap/assets/ui/25-recent.js` | Recent work 의 모델판(구조 diff·파라미터 Δ). v1 용이다. 사용자 요청으로 미리 복사했고 MVP 빌드에는 연결하지 않는다(§11). | 복사됨 (원본과 동일, v1용, §11) |
| MVP | `skills/floorplan/scripts/lib/agent.mjs` | 36줄 | `f5143f79a352c648780178bfbeb7a18f892cede2881ac33bc1860dd5b713a8c1` | `skills/modelmap/scripts/lib/agent.mjs` | 실행 중인 에이전트 판별. `FLOORPLAN_AGENT` 환경변수명 변경. | 수정함(2026-11-21, 머리말 있음): `FLOORPLAN_AGENT` 를 `MODELMAP_AGENT` 로 |
| MVP 선택 | `skills/floorplan/scripts/lib/claudemd.mjs` | 94줄 | `2db69e2bc682c69ea2e1e760bb35badeb7fc035d3d788ee174d183e3128a2056` | `skills/modelmap/scripts/lib/claudemd.mjs` | CLAUDE.local.md 안내 블록. 마커(`<!-- floorplan:start -->`)와 문구 변경. `.git/info/exclude` 수정과 옛 CLAUDE.md 블록 제거 동작은 사용자 동의가 있을 때만 하도록 다시 점검. | 수정함(2026-11-21, 머리말 있음): 마커를 modelmap 으로. `.git/info/exclude` 수정과 옛 블록 제거는 옵션을 줄 때만 하고 기본은 아무것도 쓰지 않음. build.mjs 는 아직 호출하지 않음 |
| MVP | `skills/floorplan/scripts/open.mjs` | 104줄 | `919721514ed688650039caf4515207650123d823a784555c3d4d2a417f44bb01` | `skills/modelmap/scripts/open.mjs` | 서버를 백그라운드로 띄우고 브라우저를 연다. 이름 변경. | 수정함(2026-11-21, 머리말 있음): 지도 폴더·환경변수·출력 이름을 modelmap 으로. 서버에 보내는 헤더 `x-floorplan-token` 은 그대로(viewer·serve 와 맞춤) |
| MVP | `skills/floorplan/scripts/status.mjs` | 58줄 | `0a217eb84510fb02894fbb452390fa2d906acd47f65e4791a16c62e0aa860fdb` | `skills/modelmap/scripts/status.mjs` | 기존 지도 상태 출력(SKILL.md 가 시작 시 호출). 이름 변경. | 수정함(2026-11-21, 머리말 있음): 상태는 none · unbuilt · map 셋. blueprint·옛 폴더 제거. git 비교는 `meta.repos` 를 읽음 |

## 6. C: 발췌·참고 재작성 (29개)

| 단계 | 원본 경로 | 크기 | 원본 sha256 | 가져올 위치 | 수정·발췌 내용 | 상태 |
|---|---|---|---|---|---|---|
| MVP | `skills/floorplan/scripts/lib/common.mjs` | 540줄 | `0d107723f66b079414f04735fc27d8df8d2b190a191d6d0967f938c59ae0addc` | `(발췌)` | 발췌할 함수: `toPosix, rel, HARD_IGNORE_DIRS, WALK_IGNORE_DIRS, keepOutOfGit, mapDir(MAP_DIR 를 새 이름으로, LEGACY_MAP_DIR 제거), discover(259-312행, 저장소·워크트리 탐색: classify·테마 함수를 쓰지 않음), gitRun, git, explainGitError, gitInfo, gitFiles, listGitFiles, readJsonFile, readJsonLoose, stripJsonComments, parseArgs, isUnattended, unattendedMode, printJson, fmtNum`. 가져오지 않음: `classify, themeRoots`(웹 파일 종류·Shopify), `importStatements, callArgs, blockComments` 등 JS 소스 파싱 보조. | 최소판을 새로 쓰고(2026-11-21) 발췌를 더함: parseArgs, mapDir, readJsonFile, listPythonFiles, fmtNum + floorplan 발췌(gitRun, git, isMapDir, keepOutOfGit, isUnattended, unattendedMode, printJson; 이름 변경, 머리말 있음) |
| MVP | `skills/floorplan/scripts/build.mjs` | 723줄 | `8ccce14886a370b4aa3be475a5235059eef53760a3f9413acab7e070d7ace7a4` | `(재작성)` | 구조만 참고: 입력 검증·정규화, 그래프 조립, UI 스크립트 이어붙이기와 `withPolicy` 적용(640-648행), `query.mjs` 조립(655행), serve/page-safety 를 지우고 새로 쓰기(658-664행, 읽기 전용 설치 대응). 가져오지 않음: health·blueprint import(15,17행), `NODE_KINDS/EDGE_KINDS`(48-49행: ui/service/worker 등 웹 앱용)는 모듈·레이어·텐서용으로 교체. | 새로 씀(2026-11-21, 구조만 참고, 머리말 있음): `scripts/build.mjs` + `lib/graph.mjs`. 그래프 조립, ×N 접기(멤버 전체의 가중치 체크 합산), 설명 합치기, 인라인. health·blueprint·screens 없음 |
| MVP | `skills/floorplan/scripts/describe.mjs` | 323줄 | `90e60818f6dc85ad3a497f91ecb88d9ea1c969f861d77d33aac183f2bf3d8b63` | `(재작성)` | 모듈별 워크시트와 설명 골격 생성 방식을 참고. 파일·라우트 대신 모듈·forward 코드를 다룬다. | 새로 씀(2026-11-21): 클래스별 워크시트(`.cache/worksheet.md`)와 `--check`. 저장소 텍스트는 펜스 블록 안에만 넣고 크기를 제한함 |
| MVP | `skills/floorplan/scripts/lib/names.mjs` | 120줄 | `d3ed5a3c797d24c264c58181da7fd32c363ccbb515c4e8b90beaaa9782ed36cc` | `(발췌)` | `humanize` 류 이름 정리만 발췌. `JARGON, FRAMEWORKS` 는 웹 프레임워크 용어라 ML 용어로 교체. | 미작성 |
| MVP | `skills/floorplan/scripts/scan.mjs` | 443줄 | `d7fe9192933ab65ffb8fd62932bfd88fc22ebdd0b09f5f0cdcb7ab2e8ac0d055` | `(재작성)` | CLI 형태·캐시(`.cache/scan.json`)·요약 출력을 참고. 스캐너 본체(PyTorch AST, config, safetensors 헤더)는 새로 쓴다. | 새로 씀(2026-11-21): `scripts/scan.mjs` + `scripts/pyscan.py`. 캐시·요약 출력 형태만 참고했고 코드는 복사하지 않음. 측정은 `docs/scan-measurements.md` |
| v1 | `skills/floorplan/scripts/refresh.mjs` | 245줄 | `c66ba674064e16a0f9ec344cdb92a68094f318c73c70b9cdb4a08b9504a28d28` | `(재작성)` | 증분 갱신(지문 비교, 설명 이월). MVP 는 전체 재생성이라 보류. | 미작성 |
| v1 | `skills/floorplan/scripts/recent.mjs` | 113줄 | `6355c172b92dcfc2114ff6802c0151d4c601d7922bb826eebbdf96cc5e62f54f` | `(재작성)` | Recent work 대상 계산. 구조 diff(F13)와 함께. | 미작성 |
| v1 | `skills/floorplan/assets/ui/20-health.js` | 300줄 | `67d8c505ff59222ae1ce410e4d4f265c078b46d1c6ae1b4e250d5850e806fabf` | `(재작성)` | Health 패널을 모델 점검(F14)으로 개작. | 미작성 |
| MVP | `skills/floorplan/references/schema.md` | 175줄 | `c5dfb273c36421b87037d9d04c7ec58dfae73619ff7feacc5fcf769c54c206dc` | `(개작)` | architecture.json 형식 설명 틀. 새 스키마(모듈 트리, params, shape, 출처 태그)로 다시 쓴다. | 새로 씀(2026-11-21): `skills/modelmap/references/schema.md` (scan.json, descriptions, graph.json) |
| MVP | `skills/floorplan/references/writing-descriptions.md` | 184줄 | `c44a381dacf1ed0ce011b00c23e6c0001bf8e6437e22dd8fa2d0becc112fb9a0` | `(개작)` | 설명 작성 지침. "쉬운 말" 기조를 개발자용(한국어+영문 병기)으로 바꾸되 "코드가 오늘 하는 일을 말한다" 원칙은 유지. | 새로 씀(2026-11-21, 한국어): `skills/modelmap/references/writing-descriptions.md` |
| MVP | `skills/floorplan/references/choosing-boundaries.md` | 43줄 | `66d6387588ea44f7506a0354a8354911fba48d6156a903aa3099175f5fda8dff` | `(개작)` | 경계를 나누는 지침. 모듈 계층 기준으로. | 만들지 않음: 모듈 트리가 경계를 정하므로 필요 없음 |
| MVP | `skills/floorplan/SKILL.md` | 184줄 | `772f06b06b6c34fec3cb4d328687fb12de92958566f81d3af6a73a19d9c2b144` | `(재작성)` | 워크플로 틀과 `allowed-tools` 로 자기 스크립트만 미리 허용하는 방식을 참고. 이름·절차는 새로 쓴다. | 새로 씀(2026-11-21): `skills/modelmap/SKILL.md`. 워크플로 틀과 `allowed-tools` 방식만 참고함 |
| MVP | `.claude-plugin/plugin.json` | 25줄 | `e6e1e0aa1504bc0717126faa366c576295a75b52811d44dc7822b997007f796e` | `(재작성)` | 플러그인 매니페스트 형식 참고. | 새로 씀(2026-11-21): version 0.1.0. `license` 필드 없음(라이선스 미정). 훅·MCP 없음 |
| MVP | `.claude-plugin/marketplace.json` | 19줄 | `98cd297588a52fc7715d29ad10636f3224ee7a99bfbb94230315493dabc7147c` | `(재작성)` | 로컬 폴더 설치용 마켓플레이스 형식 참고. | 새로 씀(2026-11-21): 로컬 폴더 설치용 |
| MVP | `tests/supply-chain.test.mjs` | 184줄 | `eeb945b67d0f0183d9a0a83d76e102a8c48d7646544582c4193c70b2315d58b3` | `(개작)` | 훅·MCP·의존성·설치 스크립트 없음, 외부 요청 지점, 실행 프로그램 목록, 동적 코드 금지, 벤더 파일 해시를 강제. 이름·허용 목록을 새 프로젝트에 맞춰 개작(대기자 요청은 제거). | 새로 씀(2026-11-21): 훅·MCP·의존성 없음, 실행 프로그램 허용목록, 네트워크·eval 금지, pyscan.py 표준 라이브러리만, A 파일 11개의 해시를 이 문서 표에서 읽어 대조 |
| MVP | `tests/hostile-content.test.mjs` | 674줄 | `090be1d436d6b71d757654255c82a096036adc9c97aa2157788d75354e973ebe` | `(개작)` | 저장소 텍스트가 페이지를 깨거나 비밀을 새게 하지 못함. 모델 코드의 docstring·주석 주입 시나리오로 개작. | 일부(2026-11-21): `build.test.mjs`(적대적 클래스명·인자가 페이지를 깨지 못함)와 `describe.test.mjs`(적대적 forward 본문은 펜스 안에만). 전체 개작은 아직 |
| MVP | `tests/sandboxed.test.mjs` | 315줄 | `3199bca6075a16e6bb3cb28cd8abfa8afcddd17bd48e4423e953f6e6e708da9c` | `(개작)` | 샌드박스된 브라우저(저장소·클립보드·새 창 거부)에서 페이지 코드 동작. | 미작성 |
| MVP | `tests/read-only-install.test.mjs` | 73줄 | `93091b8eed32799b912e7d8835c4ca4a3ee940f7d14bf4e3972c7cb5da890f2c` | `(개작)` | 읽기 전용 설치에서 두 번째 빌드도 성공. | 일부(2026-11-21): `build.test.mjs` 가 읽기 전용 serve.mjs 위에 두 번째 빌드를 시험함 |
| MVP | `tests/serve.test.mjs` | 91줄 | `da8e8ca27ad6eaba480b252d8800e4758f3efb82b05e69e3263e06d1b1bed340` | `(개작)` | 로컬 서버가 이 컴퓨터에서만 열리고 API 는 토큰·same-origin 만 허용. | 미작성 |
| MVP | `tests/ask.test.mjs` | 164줄 | `b84a8c2176ed048bd096a5e0f57daf6106494a4d5069b5918aaeff1932b55724` | `(개작)` | Ask 가 읽기 전용 CLI 로 동작(가짜 CLI 사용). | 미작성 |
| MVP | `tests/fixtures/fake-cli/fake-claude.mjs` | 40줄 | `7ebaf537834528bef7e0e752a3efa1d2a74f08772ed9a86efa8d9b223c693cd0` | `(개작)` | ask 테스트용 가짜 claude CLI. Codex 용(fake-codex.mjs)은 MVP 범위 밖. | 미작성 |
| MVP | `tests/export.test.mjs` | 135줄 | `39596332d88eb671f943bf50491a7bfd5740a6e9ac4a200cdbad42d4f28cc64f` | `(개작)` | 내보내기에 이 컴퓨터 정보·토큰이 들어가지 않음. | 미작성 |
| MVP | `tests/theme.test.mjs` | 111줄 | `d93397ef03a1cb956c3e12a3a2c9ea33fb51265fa8362687782da50421482007` | `(개작)` | 밝기 테마 선택 로직. | 미작성 |
| MVP | `tests/editor-links.test.mjs` | 204줄 | `0cd277f8f9c33d069a40108568d13c0d0ec0a73f3fd77c2f04cb9df1d9700ce2` | `(개작)` | "Open in editor" 링크가 에디터 고유 스킴만 허용. | 미작성 |
| MVP | `tests/touch.test.mjs` | 46줄 | `d88ddf5a8f0abefdd99b27fdaf4b6fcdfb156baaf0a7a5a6f4efe36374eb06c8` | `(개작)` | 터치 제스처. | 미작성 |
| MVP | `tests/release.test.mjs` | 57줄 | `f242e6e9aeffe25c90698dea009ff21b435f5c70bdc13861ed9e9b95946c51c2` | `(개작)` | 매니페스트·변경 기록의 버전 일치. | 새로 씀(2026-11-21): plugin.json 과 marketplace.json 의 버전 일치 |
| MVP | `tests/helpers.mjs` | 136줄 | `196b0c559a2691fb6b48f5a969f21a656e2315f5e38ff554f4c71fc2e45febab` | `(개작)` | 임시 프로젝트를 만들어 스크립트를 돌리는 공용 도우미. | 새로 씀(2026-11-21): `tests/helpers.mjs` 와 `helpers-build.mjs`, `helpers-plugin.mjs`, `helpers-scan.mjs` |
| MVP | `.github/workflows/test.yml` | 29줄 | `88aa44dcecb7cc7caca048abbab8d859e254661bc8b64bb53d8116c7bec6b14f` | `(재작성)` | Linux·Windows × Node 18/20/22 에서 `node --test` 실행하는 CI 형식 참고. | 미작성 |
| MVP | `.github/workflows/macos.yml` | 25줄 | `9436d9074e1a9f0cccef591bdcae1c51aad6e66725d8f05f35243a48df9a5c48` | `(재작성)` | 주 1회·수동 macOS 테스트 형식 참고. | 미작성 |

## 7. D: 가져오지 않음

skills/ 아래 파일 54개는 A·B·C·D 중 어디에도 빠짐없이 들어 있다(점검함).

| 단계 | 원본 경로 | 크기 | 원본 sha256 | 가져오지 않는 이유 |
|---|---|---|---|---|
| - | `skills/floorplan/scripts/lib/extract.mjs` | 2414줄 | `c499cb0aa661b8289e701c0c55ca3675be38c3ef31dbba1731e9800f799dedc3` | 웹 앱의 import·라우트·HTTP 호출 추출. Python 은 최상위 def/class 이름과 줄 번호만 기록(750-752행)해 모델 분석에 쓸 수 없다. |
| - | `skills/floorplan/scripts/lib/health.mjs` | 2339줄 | `2e47dbf734daaf4e613523a75369d6d14029101785495e300f18adfc5b512cc6` | 웹 보안 점검(하드코딩 키, 인증 없는 엔드포인트, Supabase·Firebase·Stripe 등). |
| - | `skills/floorplan/scripts/lib/health-csharp.mjs` | 257줄 | `836b2d635d10aaeff9700e547b3b1f660280970fc1a6afdd6657064e585e39be` | C# 웹 점검. |
| - | `skills/floorplan/scripts/lib/resolve.mjs` | 638줄 | `3728cf1bcfd2d12528fe44373a8a76e9d2263dd63dabc63436dc1122d2584bff` | HTTP 호출과 라우트 매칭. |
| - | `skills/floorplan/scripts/lib/routes.mjs` | 592줄 | `246bca462268afa948a078093c2f1b3195335066263c837be82b23186977752c` | 웹 라우트 해석. |
| - | `skills/floorplan/scripts/lib/route-tables.mjs` | 315줄 | `1a97644419b9168b494201dcccc178da706caf6c4963a467f076d9b817af6c5a` | 라우트 테이블. |
| - | `skills/floorplan/scripts/lib/screens.mjs` | 705줄 | `9e971ae17950ba513292a2187fe50e3b483e61b10cb6b909323b46dc91123f6a` | 화면(Screens) 탐지. |
| - | `skills/floorplan/scripts/lib/serverless.mjs` | 408줄 | `0394a9076827398f983eaa656cc70b03516327db6dd9c172b6423109aab5b44c` | Serverless Framework 엔드포인트. |
| - | `skills/floorplan/scripts/lib/supabase-functions.mjs` | 51줄 | `e3f166ed4ef74948dd05f39327a4c5fdeb763712706cac26870d17eb0e835017` | Supabase Edge Functions. |
| - | `skills/floorplan/scripts/lib/nuxt.mjs` | 205줄 | `98e97fb363d9072ae7b577c9b25d24c1c676a8e8dd50ec9649a2273aa1991171` | Nuxt 라우팅. |
| - | `skills/floorplan/scripts/lib/blueprint.mjs` | 229줄 | `0cd705247440591764a3387cd9ec0ddb80fe72887728dd4e4b92b6ef6077dc7e` | 블루프린트(문서→설계) 모드. 논문→구현 청사진(F28)은 v2 이후. |
| - | `skills/floorplan/scripts/plan.mjs` | 56줄 | `c0f9f5f0fff0241a79c8c56d38523a7553e606efd53a23eb4eccf90da826d452` | 블루프린트 모드 보조. |
| - | `skills/floorplan/assets/ui/06-blueprint.js` | 103줄 | `f8cce314344a2661c6ef19a1c029b77ec8afbdefb13e32466440457ee705665a` | 블루프린트 모드 UI. |
| - | `skills/floorplan/references/blueprint.md` | 87줄 | `b4151d2af2c658447fc0c30689f361c62a331b7c6370584b216f0dfe4b56c205` | 블루프린트 모드 지침. |
| - | `skills/floorplan/assets/ui/30-screens.js` | 142줄 | `2929df952f6b63d24428545cf53ca6adab2c350d7eadf0505d9b93012caff58a` | Screens UI. |
| - | `skills/floorplan/assets/ui/50-cloud.js` | 131줄 | `9cd14f892119ec2d448e1c647c9c539772a52319d304c9b637ef5188a3fe661c` | Floorplan Cloud 대기자 카드 UI. 이메일 수집·외부 요청이라 가져오지 않는다. |
| - | `skills/floorplan/assets/logo.png` | 4,473 B | `308b79d1680314b80350eaae04b8ad0c655bfb7a1fa2a2ef64b79e286469cc9b` | floorplan 브랜딩. 새 로고 필요. |
| - | `skills/floorplan/assets/favicon.png` | 2,071 B | `91485d6e067e25f742939ee7903d97096e560bfebdb32b71b428294ef2c781d9` | floorplan 브랜딩. |
| - | `skills/floorplan/workflow.json` | 493줄 | `cecf46ff286f543bf072035519c8f9c237b1caa7a91f175bcba0a1f0290ab64c` | SKILL.md 단계의 데이터판(무인·CI 실행용). MVP 범위 밖, v1 의 CI 요약 때 재검토. |
| - | `skills/floorplan/agents/openai.yaml` | 5줄 | `4dde86cace299094c246604badb73b605a10f47e01a72cc6746680788a7e20f9` | Codex 연동. MVP 는 Claude Code 만. |
| - | `.claude-plugin/icon.png` | 1,353,958 B | `fdce61be9c420fd16b8cbbff629baa37e8d1096094b3e90bc5ecc0fe1ffc3a78` | floorplan 아이콘. |
| - | `.codex-plugin/ , .agents/` | — | `—` | Codex 플러그인·마켓플레이스 매니페스트(MVP 범위 밖). |
| - | `docs/, README.md, CHANGELOG.md, CONTRIBUTING.md, SECURITY.md, .github/ISSUE_TEMPLATE, .github/PULL_REQUEST_TEMPLATE.md` | — | `—` | 참고용 문서. 새 SECURITY.md 와 "설치해도 안전한가" 문서의 모델로 읽을 뿐 복사하지 않는다. |
| - | `tests/ 의 나머지 및 tests/fixtures/ 의 나머지` | — | `—` | 웹 프레임워크(Express·FastAPI·Laravel·Nest·Firebase 등) 라우트·Health 테스트와 그 픽스처. |

## 8. 라이선스와 고지

- floorplan: MIT. `third_party/floorplan/LICENSE` 로 원문을 둔다(위 A 표, 해시 포함). B·C 로 만든 파일은 머리말로 출처를 밝힌다.
- elkjs 0.9.3: EPL-2.0. `elkjs-LICENSE.md` 를 ELK 와 함께 둔다.
- Inter, JetBrains Mono: 각 글꼴 라이선스 파일을 글꼴과 함께 둔다.
- modelmap 자체의 라이선스는 **아직 정하지 않았다**(§10).

## 9. 업스트림을 따라가는 방법

1. 업스트림에 새 태그가 나오면 이 문서의 "원본 고정"과 아래 해시를 기준으로 **가져온 원본 파일만** 비교한다. 업스트림은 CHANGELOG 기준 20일(2026-10-27~11-16) 동안 30번 릴리스했고 최근 변화 대부분이 웹 프레임워크 기능이라, 전체 머지는 하지 않는다.
2. 가장 먼저 볼 파일은 보안 관련이다: `page-safety.mjs`(A), `serve.mjs` 의 Host·토큰·CSP 부분(B).
3. A 파일은 `tests/` 에 "해시가 이 문서와 같다"는 테스트를 둔다(업스트림의 ELK 해시 테스트 방식). 이 테스트와 `tools/upstream-diff.mjs` 는 아직 만들지 않았다.

## 10. 미정·미검증

- ELK 번들을 npm 의 `elkjs@0.9.3` 과 직접 대조하지 않았다(업스트림 문서와 테스트의 주장에 의존).
- 분류 근거: `floorplan` 언급 수, import, export 목록은 직접 측정했고 build.mjs·serve.mjs·common.mjs·claudemd.mjs·open.mjs·agent.mjs 는 일부 또는 전부 읽었다. `viewer.html`, `graph-query.js` 같은 큰 파일은 일부만 읽었다. **테스트는 머리말 주석만 읽었고 본문은 검토하지 않았다.**
- 업스트림이 확장 API 이름(`window.Floorplan`)을 그대로 두면 `05-theme.js`, `40-tour.js` 등을 A 로 바꿀 수 있다. 이름을 바꿀지는 정하지 않았다.
- modelmap 자체의 라이선스, 코드 서명이나 체크섬 배포 방식은 정하지 않았다.

## 11. 복사 기록 (2026-11-21)

- **원본**: 이 저장소 밖 빈 폴더에 태그를 새로 클론했다(`git clone --depth 1 --branch floorplan--v0.11.0`, 임시 폴더). HEAD `94f81b463b7617e06d873ac71323ce71644c8399` 가 태그가 가리키는 커밋과 같고, 태그 객체 `9578130cc7ae5d0f7887c07f4ce1a014dae77fa7` 은 원격 `git ls-remote` 값과 같다. 클론의 작업 트리는 깨끗했다.
- **대조**: §4·§5 의 해시 24개가 클론 파일과 모두 일치한 뒤에 복사했다. 복사본의 해시도 다시 확인해 24/24 가 같았다.
- **복사**: A 11개, B 13개를 §4·§5 의 "가져올 위치"로 복사했다. 대상 경로가 이미 있으면 덮어쓰지 않도록 했고 모두 비어 있었다.
- **수정은 `skills/modelmap/assets/serve.mjs` 하나뿐이다.** 나머지 B 12개는 원본과 바이트 동일하다.

### serve.mjs: Floorplan Cloud 대기자 코드 제거

| 항목 | 내용 |
|---|---|
| 원본 sha256 | `e8717685c341cf94be91dd4feeaddbccc8ee601ac62a4caa7e7be745df1c6696` |
| 수정본 sha256 | `6642cda209152651c57cce3f708387ec47e0c37146a3a491b8e75e0129630bca` |
| 제거 | 원본 239-281행: 대기자 블록 전체(`WAITLIST_URL`, `~/.floorplan/settings.json` 읽기·쓰기, `claude auth status` 로 계정 이메일 조회, `joinWaitlist` 의 외부 POST, 이메일 정규식). 원본 594-613행: `/api/cloud/*` 라우트. 이제 `/api/cloud/*` 는 일반 404 로 떨어진다. |
| 추가 | 2행에 출처 머리말 1줄. 합계 63줄 삭제, 1줄 추가. |
| 검증함 | `node --check` 통과. 제거한 식별자(`readSettings, saveCloud, cloudPrompt, claudeEmail, joinWaitlist, EMAIL, WAITLIST_URL, settingsFile` 등)의 잔존 참조 없음. 외부 요청 API(`fetch`, `node:https`, `node:net` 등) 없음. |
| 남은 프로세스 실행 지점 | 5곳: `which/where`(CLI 찾기), `--version` 확인, `claude/codex` 실행(Ask), 자체 스크립트를 `node` 로 실행(`skillScript`), 브라우저 열기. 모두 셸을 거치지 않는다. |
| 검증하지 않음 | 서버를 실제로 띄워 보지 않았다(지도를 만드는 `build.mjs` 가 아직 없다). 정적 검사만 했다. |

### 남은 일

- `viewer.html` 555행의 `body #cloud-card` CSS 선택자가 남아 있다. 해당 요소가 없어져 무해하지만 §5 의 계획대로 viewer 를 수정할 때 제거한다.
- `ui/25-recent.js` 는 v1 용이다. 원본 `build.mjs` 는 `assets/ui/*.js` 를 모두 이어붙이므로(원본 644행), 새 `build.mjs` 를 쓸 때 이 파일을 제외하거나 다른 곳으로 옮겨야 한다.
- 나머지 B 파일 12개는 아직 원본 그대로다(이름 변경, 모델용 수정은 이후).

## 12. 작업 기록 (2026-11-21, 둘째 라운드)

- Orca 워커 3명이 같은 폴더에서 파일을 나눠 맡아 구현했다: A(build·graph·viewer·패널), B(설정·YAML·safetensors), C(플러그인 뼈대·describe·supply-chain). 내가 통합 점검을 했고 A 에게 후속 수정을 한 번 더 시켰다(접힌 카드의 가중치 체크 누락, `meta.repos`).
- 처음 수정한 B 파일(viewer.html, open.mjs, status.mjs, agent.mjs, claudemd.mjs)에는 첫 줄에 출처 머리말을 달았다. A 파일 11개는 그대로이고, 해시는 `tests/supply-chain.test.mjs` 가 이 문서 §4 표에서 읽어 대조한다.
- 아직 원본 그대로인 B 파일: serve.mjs(대기자 코드만 제거), graph-query.js, query-cli.mjs, ui/05-theme.js, 10-glossary.js, 40-tour.js, 60-export.js, 25-recent.js. Ask·투어·용어집 개작은 다음 라운드다.
- §10 의 "확장 API 이름" 은 유지하기로 했다(계획 결정 2): `window.Floorplan`, `FLOORPLAN_SERVER`, `x-floorplan-token` 은 그대로 둔다.
- 검증: `node --test tests/*.test.mjs` 119개 통과. 이 환경에서 Python 3.9 와 Windows 는 확인하지 못했다.
