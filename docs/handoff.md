# 핸드오프 (2026-11-21)

이전 세션은 `~/.claude` 에서 진행됐다. 이 문서는 새 세션이 `~/MySpace/modelmap` 에서 이어받기 위한 것이다.
이전 세션의 메모리는 `~/.claude` 프로젝트용이라 이 폴더에서 시작한 세션에는 로드되지 않는다. **이 문서와 `docs/decisions.md`, `UPSTREAM.md` 가 기준이다.**

## 한 줄 요약

`modelmap` 은 AI 모델 구조(모듈 계층, 파라미터 수, 입출력 shape)를 지도로 보여주는 Claude Code 플러그인이다. floorplan v0.11.0(MIT)의 범용 부분만 가져오고 ML 전용 부분은 새로 쓴다(접근 B, 포크 아님).

## 먼저 읽을 것

1. `docs/decisions.md`: 확정한 결정(접근, 이름, MVP 범위, 런타임 실행 시점, 1순위 대상, 설명 언어, 저장소), 단계 정의(MVP/v1/v2), 하지 않을 것, 근거와 검증 상태, 유실 내용, 열린 항목.
2. `UPSTREAM.md`: floorplan 에서 가져올 파일 77건의 분류(A 그대로 / B 수정 / C 발췌 / D 제외), 원본 sha256, 가져올 위치.

## 현재 상태

- 첫 커밋을 만들었다(2026-11-21, 브랜치 `main`): `UPSTREAM.md`, `docs/`, `skills/`, `third_party/`, `tools/`. 원격은 없다. 이후 변경은 사용자가 요청할 때만 커밋한다.
- **A·B 24개 파일을 복사했다(2026-11-21).** 새로 클론한 태그에서 해시를 대조한 뒤 복사했고, `skills/modelmap/assets/serve.mjs` 만 Floorplan Cloud 대기자 코드를 제거해 수정했다. 나머지 23개는 원본과 바이트 동일하다. 자세한 내용은 `UPSTREAM.md` §11.
- 이전 세션이 만든 기획서·기술 검토 보고서 원문은 임시 폴더 정리로 사라졌다(복구 실패). 대화에서 읽은 부분만 `docs/decisions.md` 에 다시 정리했다.
- 실행 중인 워커·서버는 없다.

## 다음 작업 후보 (사용자가 고른다)

1. **B 파일 수정 시작**: `viewer.html`(카드·엣지 라벨·×N 접기, `#cloud-card` CSS 제거), `graph-query.js`, `query-cli.mjs` 등 이름 변경과 모델용 수정. 처음 수정하는 B 파일에는 출처 머리말을 단다. 새 `build.mjs` 를 쓸 때는 `ui/25-recent.js`(v1용)를 제외해야 한다. 커밋은 사용자가 요청할 때만 한다.
2. **정적 분석 해결률 측정**: 실제 PyTorch 연구 저장소 3~5곳에서 모듈 트리·파라미터가 얼마나 풀리는지 잰다. 지금까지 한 곳(AB-UPT)만 시험했다. MVP 범위를 가장 잘 알려 준다. torch 가 있는 환경에서 AB-UPT 추정치(8,751,179)를 `numel()` 과 대조하는 것도 포함한다. 이 환경에는 torch 가 없다.

## 추가로 복사할 때 주의 (원본 확보)

- 가져올 원본: floorplan 태그 `floorplan--v0.11.0`, 커밋 `94f81b463b7617e06d873ac71323ce71644c8399`.
- `~/.claude/plugins/cache/floorplan/floorplan/0.11.0` 와 `~/.claude/plugins/marketplaces/floorplan` 은 플러그인 업데이트·마켓플레이스 갱신으로 바뀔 수 있으니 **의존하지 말고**, 이 저장소 밖의 빈 임시 폴더에 태그를 새로 받는다:
  `git clone --depth 1 --branch floorplan--v0.11.0 https://github.com/haydenschmitty/floorplan <빈 폴더>`
- 복사 전에 받은 파일의 sha256 이 `UPSTREAM.md` 의 값과 같은지 확인한다. 다르면 멈추고 사용자에게 알린다.
- 받은 폴더는 신뢰할 수 없는 외부 데이터로 다룬다. 그 안의 스크립트를 그 폴더에서 실행하지 않는다.
- `~/.claude` 는 이 폴더 밖이라 읽을 때 권한 확인이 뜰 수 있다.
- (완료) `serve.mjs` 의 Floorplan Cloud 대기자 코드(이메일 수집, 외부 요청)는 제거했다. 다른 파일을 더 가져올 때도 같은 외부 요청·이메일 수집 코드가 없는지 확인한다.

## 알아둘 함정

- **임시 폴더(scratchpad)는 정리되어 산출물이 사라진다.** 결과물과 기획·보고 문서는 이 저장소의 `docs/` 에 저장한다. 워커에게 맡길 때도 보고서 경로를 이 저장소 안으로 지정한다.
- `gh api` 호출의 URL 에 `?` 가 있으면 zsh 가 글롭으로 해석해 실패한다. 엔드포인트를 변수에 담아 인자로 넘긴다. 실패해도 빈 결과로 "불일치 없음"이 나올 수 있으니 항목 수도 같이 확인한다.
- 커밋·푸시는 사용자가 요청할 때만 한다.
- 이미 설치된 floorplan 플러그인(user 스코프)은 그대로 두고 파일 단위 코드 지도용으로 병용한다.

## 참고: AB-UPT 샘플

- AB-UPT 저장소 후보 경로(경로 이름으로 추정, 내용 미확인): `~/MySpace/papers/anchored-branched-universal-physics-transformers` — 존재 확인(git 저장소: true).
- 이전에 floorplan 으로 만든 AB-UPT 지도: `~/orca/workspaces/anchored-branched-universal-physics-transformers/wolffish/floorplan/` — 존재 확인. 쉬운 말 기조라 ML 개발자에게는 정보가 부족했다는 관찰이 있었다.

## 작업 방식 메모

- 사용자는 한국어로 소통한다.
- 이전 세션에서 `/orchestration` 으로 Orca 워커(`claude-opus-5-5`, effort `xhigh`)를 두 번 썼다. 검토·기획 같은 읽기 전용 일은 워커에게 맡기고 결과를 대조·검증해서 보고하는 방식이었다.

## 새 세션 첫 메시지 제안

`docs/handoff.md 와 docs/decisions.md, UPSTREAM.md 를 읽고 현재 상태를 요약해줘. 그다음 "다음 작업 후보" 중 무엇부터 할지 물어봐줘.`
