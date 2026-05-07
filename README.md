# Meeting Edit

회의/세미나 녹화 영상을 AI가 자동 분석해서 편집해주는 도구.
사회자 구간을 제거하고 발표자 화면공유 구간만 추출합니다.

---

## 주요 기능

- **자동 트랜스크립션** — mlx-whisper로 무료 음성 인식 (Apple Silicon)
- **AI 자동 편집** — Claude가 트랜스크립트를 읽고 발표 구간을 자동으로 감지
- **두 가지 편집 모드** — 전체 편집 / 쇼츠 (10~15분 하이라이트)
- **웹 UI** — 영상 플레이어 + 타임라인 + EDL 편집 화면
- **CLI 동일 결과물** — `preview.mp4` + `edit_report.txt` + `edl.json`

---

## 시스템 요구사항

| 항목 | 요구사항 |
|------|----------|
| OS | macOS (Apple Silicon 필수 — M1/M2/M3/M4) |
| Python | 3.10 이상 |
| Node.js | 18 이상 |
| ffmpeg | brew로 설치 |
| Claude Code | CLI 인증 필요 |

---

## 로컬 실행 방법

### 1. 레포 클론

```bash
git clone https://github.com/Mukjin/MeetingEdit2.git
cd MeetingEdit2
```

### 2. 의존성 설치

```bash
# ffmpeg (없다면)
brew install ffmpeg

# Python 패키지
pip3 install uv
uv sync
# 또는: pip3 install -e .

# mlx-whisper (트랜스크립션)
pip3 install mlx-whisper --break-system-packages
```

### 3. Claude Code 로그인

```bash
# 미설치 시
npm install -g @anthropic-ai/claude-code

# 로그인
claude login
```

### 4. 웹 UI 실행

```bash
cd meeting-edit-ui
./run.sh
```

브라우저에서 **http://localhost:5173** 열기

---

## 사용 방법

```
1. 영상 선택   →  mp4 절대경로 입력
2. 트랜스크립션 →  시작 버튼 클릭 (30~40분 소요)
3. AI 자동 분석 →  모드 선택 후 ✦ AI 분석 클릭 (1~2분)
4. EDL 검토    →  자동 생성된 구간 확인/수정
5. 렌더        →  렌더 시작 → preview.mp4 생성
```

결과물은 원본 영상과 같은 폴더의 `edit_MMDD/` 안에 저장됩니다.

---

## 디렉토리 구조

```
MeetingEdit2/
├── helpers/              ← 핵심 스크립트 (render.py, pack_transcripts.py 등)
├── meeting-edit-ui/
│   ├── backend/          ← FastAPI 서버
│   │   └── main.py
│   ├── frontend/         ← React + Tailwind
│   │   └── src/App.jsx
│   └── run.sh            ← 서버 시작 스크립트
├── skills/               ← Claude Code 스킬
└── SKILL.md              ← 편집 가이드
```

---

## 제한 사항

- Apple Silicon(M-series Mac) 전용 — mlx-whisper가 Intel Mac / Linux에서 동작하지 않습니다
- 영상 파일은 로컬 디스크에 있어야 합니다
- 트랜스크립션은 한국어 최적화 기준입니다
