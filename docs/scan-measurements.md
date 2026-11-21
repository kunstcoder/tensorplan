# 스캐너 측정 (2026-11-21)

`skills/modelmap/scripts/scan.mjs` 를 네 저장소에 돌린 결과다. 계획 문서(`docs/plan-mvp.html`)의 위험 항목("시험한 저장소가 AB-UPT 한 곳뿐")을 줄이려고 했다. 스캐너는 코드를 텍스트로만 읽고 실행하지 않는다.

## 결과

| 저장소 (커밋) | 루트와 인자 | 스캐너 결과 | 기준값 | 일치 |
|---|---|---|---|---|
| AB-UPT (`2211068`, 로컬) | `AnchoredBranchedUPT`, 기본 인자 | 8,751,179 (모든 부분을 앎) | 이전 프로토타입 8,751,179. 모듈별 합을 손으로 다시 더해도 같음 | 일치 |
| nanoGPT (`3adf61e`) | `GPT`, `--arg config={…GPT-2 small, vocab 50304…}` | 124,475,904 (모든 부분을 앎) | 손계산 124,475,904 (wte 와 lm_head 가중치 공유를 한 번만 셈) | 일치 |
| vit-pytorch (`42298e1`) | `vit_pytorch/vit.py:ViT`, ViT-B/16 인자 7개 | 86,543,080 (모든 부분을 앎) | 손계산 86,543,080 | 일치 |
| DiT (`ed81ce2`) | `DiT`, 기본 인자 | ≥ 228,617,888, 알 수 없는 부분 57곳 | 없음 (timm 의 `Attention`, `Mlp`, `PatchEmbed` 가 저장소 밖에 있음) | 하한만 |

## 이 측정으로 알게 된 것

- 모듈 트리와 파라미터 수는 이 네 곳에서 맞았다. 모르는 부분은 추측하지 않고 `≥` 와 이유로 남았다.
- 루트 클래스를 자동으로 고르는 규칙은 "저장소의 다른 클래스를 가장 많이 만드는 모듈"이다. AB-UPT, nanoGPT, DiT 에서는 맞았다. vit-pytorch 는 모델이 수십 개라 자동 선택이 의미가 없고, 같은 이름(`ViT`)이 16개라 `--root-class 파일:이름` 이 필요했다.
- 루트의 필수 인자(예: `config`, `dim`)는 코드에 값이 없다. 지금은 `--arg` 로 준다. 계획 2.5 의 설정 파일 읽기(JSON·YAML)가 이 자리를 채울 예정이고, 아직 없다.
- 처음 돌렸을 때 틀렸던 것: DiT 에서 루트를 `DiTBlock` 으로 고름, `a, *b = x`, `isinstance(x, tuple)`, 설정 객체의 속성 읽기, 가중치 공유. 모두 고쳤고 테스트가 있다.

## 한계 (결과를 그대로 믿으면 안 되는 이유)

- **torch 로 실측하지 못했다.** 기준값은 이전 프로토타입과 손계산이다. torch 가 있는 환경에서 `numel()` 합과 대조하는 일은 아직 열려 있다.
- 시험한 저장소는 잘 정리된 공개 저장소 셋과 AB-UPT 다. 1순위 대상인 지저분한 커스텀 연구 저장소(동적 구성, Hydra, 문자열로 클래스를 고르는 레지스트리)는 아직 시험하지 못했다. MVP 범위를 정하기에는 부족한 표본이다.
- 외부 패키지 클래스(timm, HF, torch_geometric)는 아는 표가 없어 전부 미지수가 된다. 파라미터가 없다고 알려진 einops 의 `Rearrange`, `Reduce`, `Repeat` 만 0 으로 센다.
- 레이어 표(`lib/layers.mjs`)는 Linear, LayerNorm, RMSNorm, GroupNorm, BatchNorm, InstanceNorm, Embedding, Conv, ConvTranspose, MultiheadAttention, PReLU 와 파라미터 없는 레이어들만 안다. LSTM, GRU, Transformer 계열은 `≥` 로 남는다.

## 구현하면서 정한 것 (되돌리고 싶으면 알려 주세요)

- ×N 접기는 `ModuleList`, `Sequential` 안의 형제에만 적용한다. `q`, `k`, `v` 처럼 이름이 있는 형제는 클래스와 인자가 같아도 접지 않는다. 계획의 "형제 모듈은 같을 때만 접는다"를 이렇게 좁혔다.
- 접히지 않는 컨테이너의 패턴 글자는 처음 나온 순서대로 A, B, C 다 (`blocks` 는 `A B C B C B`).
- Python 은 `python3 -I` (격리 모드)로 부르고, 파일 경로가 저장소 밖을 가리키면 읽지 않는다. 2 MB 넘는 파일은 건너뛴다.
