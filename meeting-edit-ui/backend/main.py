#!/usr/bin/env python3
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

import aiofiles
import anthropic
from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

app = FastAPI(title="Meeting Edit UI")

# Load .env from backend directory if present
_ENV_FILE = Path(__file__).parent / ".env"

def _load_env():
    if _ENV_FILE.exists():
        for line in _ENV_FILE.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                os.environ.setdefault(k.strip(), v.strip())

_load_env()

def get_api_key() -> str:
    _load_env()
    key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not key:
        raise RuntimeError("ANTHROPIC_API_KEY가 설정되지 않았습니다. 설정 화면에서 API 키를 입력해주세요.")
    return key

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:4173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory job store
jobs: dict[str, dict] = {}

SKILL_DIR = Path.home() / ".claude/skills/video-use/helpers"
PACK_SCRIPT = SKILL_DIR / "pack_transcripts.py"
RENDER_SCRIPT = SKILL_DIR / "render.py"

PUNCT_BREAK = set(".!?…。！？")
SUB_WORDS_PER_CUE = 6    # target words per subtitle cue
SUB_MIN_DURATION = 1.2   # minimum seconds a cue stays on screen


def _words_in_range(transcript: dict, t_start: float, t_end: float) -> list[dict]:
    out = []
    for w in transcript.get("words", []):
        if w.get("type") != "word":
            continue
        ws, we = w.get("start"), w.get("end")
        if ws is None or we is None:
            continue
        if we <= t_start or ws >= t_end:
            continue
        out.append(w)
    return out


def build_subtitle_cues(edl: dict, edit_dir: Path) -> list[dict]:
    """Return list of {index, start, end, text} dicts from transcript+EDL."""
    transcripts_dir = edit_dir / "transcripts"
    entries: list[tuple[float, float, str]] = []
    seg_offset = 0.0

    for r in edl.get("ranges", []):
        src_name = r["source"]
        seg_start = float(r["start"])
        seg_end = float(r["end"])
        seg_duration = seg_end - seg_start

        tr_path = transcripts_dir / f"{src_name}.json"
        if not tr_path.exists():
            seg_offset += seg_duration
            continue

        transcript = json.loads(tr_path.read_text())
        words_in_seg = _words_in_range(transcript, seg_start, seg_end)

        chunks: list[list[dict]] = []
        current: list[dict] = []
        for w in words_in_seg:
            text = (w.get("text") or "").strip()
            if not text:
                continue
            current.append(w)
            ends_in_punct = bool(text) and text[-1] in PUNCT_BREAK
            if len(current) >= SUB_WORDS_PER_CUE or ends_in_punct:
                chunks.append(current)
                current = []
        if current:
            chunks.append(current)

        for chunk in chunks:
            local_start = max(seg_start, chunk[0].get("start", seg_start))
            local_end = min(seg_end, chunk[-1].get("end", seg_end))
            out_start = max(0.0, local_start - seg_start) + seg_offset
            out_end = max(0.0, local_end - seg_start) + seg_offset
            # enforce minimum display duration
            if out_end - out_start < SUB_MIN_DURATION:
                out_end = out_start + SUB_MIN_DURATION
            text = re.sub(r"\s+", " ", " ".join(
                (w.get("text") or "").strip() for w in chunk
            )).strip().rstrip(",;:")
            entries.append((out_start, out_end, text))

        seg_offset += seg_duration

    entries.sort(key=lambda e: e[0])
    return [{"index": i + 1, "start": a, "end": b, "text": t}
            for i, (a, b, t) in enumerate(entries)]


def _srt_timestamp(seconds: float) -> str:
    total_ms = int(round(seconds * 1000))
    h, rem = divmod(total_ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def write_srt(cues: list[dict], out_path: Path) -> None:
    lines = []
    for c in cues:
        lines.append(str(c["index"]))
        lines.append(f"{_srt_timestamp(c['start'])} --> {_srt_timestamp(c['end'])}")
        lines.append(c["text"])
        lines.append("")
    out_path.write_text("\n".join(lines), encoding="utf-8")


# ── Models ────────────────────────────────────────────────────────────────────

class VideoInfoRequest(BaseModel):
    path: str

class TranscribeRequest(BaseModel):
    video_path: str
    edit_dir: str  # absolute path to edit_MMDD dir

class EDLSaveRequest(BaseModel):
    edit_dir: str
    edl: dict

class RenderRequest(BaseModel):
    edit_dir: str
    video_path: str  # for edit_report
    subtitles: bool = False

class ReportRequest(BaseModel):
    edit_dir: str
    edl: dict
    video_path: str
    duration_original: float
    duration_result: float

class AnalyzeRequest(BaseModel):
    edit_dir: str
    video_path: str
    transcript_path: str
    mode: str = "full"  # "full" | "shorts"


# ── Helpers ───────────────────────────────────────────────────────────────────

def run_ffprobe(path: str) -> dict:
    result = subprocess.run(
        ["ffprobe", "-v", "quiet", "-print_format", "json",
         "-show_streams", "-show_format", path],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr)
    return json.loads(result.stdout)


def format_duration(seconds: float) -> str:
    m, s = divmod(int(seconds), 60)
    h, m = divmod(m, 60)
    if h:
        return f"{h}시간 {m}분 {s}초"
    return f"{m}분 {s}초"


def make_transcribe_script(video_path: str, out_json: str) -> str:
    return f'''#!/usr/bin/env python3
import json, subprocess, os, tempfile

VIDEO = {json.dumps(video_path)}
OUT_JSON = {json.dumps(out_json)}
MODEL = "mlx-community/whisper-large-v3-turbo"

def extract_audio(video_path, wav_path):
    subprocess.run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-i", video_path, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
        wav_path
    ], check=True)

def transcribe(wav_path):
    import mlx_whisper
    return mlx_whisper.transcribe(
        wav_path, path_or_hf_repo=MODEL,
        language="ko", word_timestamps=True, verbose=False,
    )

def to_scribe_format(result):
    words = []
    for seg in result.get("segments", []):
        for w in seg.get("words", []):
            text = w.get("word", "").strip()
            if not text: continue
            words.append({{"text": text, "start": round(w["start"], 3),
                          "end": round(w["end"], 3), "type": "word", "speaker_id": "S0"}})
    return {{"language_code": "ko",
            "audio_duration": result["segments"][-1]["end"] if result.get("segments") else 0,
            "words": words}}

def main():
    os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)
    if os.path.exists(OUT_JSON):
        print(f"cached: {{OUT_JSON}}"); return
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        wav_path = f.name
    try:
        extract_audio(VIDEO, wav_path)
        result = transcribe(wav_path)
        scribe = to_scribe_format(result)
        with open(OUT_JSON, "w", encoding="utf-8") as f:
            json.dump(scribe, f, ensure_ascii=False, indent=2)
        print(f"done: {{len(scribe['words'])}} words")
    finally:
        if os.path.exists(wav_path): os.unlink(wav_path)

if __name__ == "__main__": main()
'''


def write_edit_report(edit_dir: str, video_path: str, edl: dict,
                      duration_original: float, duration_result: float):
    video_name = Path(video_path).name
    date_str = datetime.now().strftime("%Y-%m-%d")
    ranges = edl.get("ranges", [])
    clip_count = len(ranges)

    # Group by presenter
    presenters: dict[str, list] = {}
    for r in ranges:
        beat = r.get("beat", "Unknown")
        presenters.setdefault(beat, []).append(r)

    presenter_lines = []
    for name, clips in presenters.items():
        starts = [c["start"] for c in clips]
        ends = [c["end"] for c in clips]
        total_s = sum(c["end"] - c["start"] for c in clips)
        presenter_lines.append(
            f"  {name:<10} {min(starts):.0f} ~ {max(ends):.0f}초   "
            f"약 {total_s/60:.1f}분   {clips[0].get('reason', '')[:40]}"
        )

    reduction = (1 - duration_result / duration_original) * 100
    orig_min = duration_original / 60
    result_min = duration_result / 60

    report = f"""============================================================
  편집 보고서 — {video_name}
  작성일: {date_str}
============================================================

■ 원본 정보
  - 파일: {video_name}
  - 원본 길이: {orig_min:.1f}분 ({int(duration_original)}초)

■ 결과물 정보
  - 파일: edit_MMDD/preview.mp4 (1080p 프리뷰)
  - 편집 후 길이: {result_min:.1f}분 ({int(duration_result)}초)
  - 단축 비율: {reduction:.0f}% 감소 ({orig_min:.0f}분 → {result_min:.1f}분)
  - 사용 구간 수: {clip_count}개 클립

■ 편집 기준 (무엇을 남겼나)
  1. 발표자가 화면공유를 켜고 직접 설명하는 구간만 유지
  2. 발표 내용 이해에 직결되는 Q&A 일부 유지
  3. 발표자 직접 발화 위주 — 사회자 코멘트/방향제시는 제거

■ 편집 기준 (무엇을 제거했나)
  1. 사회자 구간 전체 (오프닝/소개/전환/마무리)
  2. 각 발표 내 Q&A 대부분 (비용/운영/기술 세부)
  3. 음향 설정 및 화면 공유 준비 구간
  4. 필러워드 단독 발화 및 반복 호응

■ 발표자별 유지 구간
  발표자     원본 시간대          편집 후 길이   내용 요약
  ─────────────────────────────────────────────────────────────
{chr(10).join(presenter_lines)}

■ 트랜스크립션
  - 도구: mlx-whisper (Apple Silicon MLX, 무료)
  - 모델: mlx-community/whisper-large-v3-turbo
  - 제한사항: 화자분리 없음 (전체 S0) — 내용 기반으로 발표자 구간 구분

■ 기술 사항
  - 컷 경계: 단어 경계 기준, 앞뒤 30~200ms 여유
  - 오디오: -14 LUFS / -1 dBTP 라우드니스 정규화
  - 색보정: 없음 (원본 그대로)
  - 자막: 없음
  - preview.mp4: 1080p, H.264, CRF 22

============================================================
"""
    report_path = Path(edit_dir) / "edit_report.txt"
    report_path.write_text(report, encoding="utf-8")
    return str(report_path)


# ── Background workers ────────────────────────────────────────────────────────

def _transcribe_worker(job_id: str, video_path: str, edit_dir: str):
    jobs[job_id]["status"] = "running"
    jobs[job_id]["message"] = "오디오 추출 중..."
    try:
        video_name = Path(video_path).stem
        transcripts_dir = Path(edit_dir) / "transcripts"
        transcripts_dir.mkdir(parents=True, exist_ok=True)
        out_json = str(transcripts_dir / f"{video_name}.json")

        if Path(out_json).exists():
            with open(out_json, encoding="utf-8") as f:
                data = json.load(f)
            jobs[job_id]["status"] = "done"
            jobs[job_id]["message"] = f"캐시 사용: {len(data.get('words', []))} 단어"
            jobs[job_id]["result"] = out_json
            return

        script_path = Path(edit_dir) / "transcribe_mlx.py"
        script_path.write_text(make_transcribe_script(video_path, out_json))

        jobs[job_id]["message"] = "트랜스크립션 실행 중 (30~40분 소요)..."
        result = subprocess.run(
            [sys.executable, str(script_path)],
            capture_output=True, text=True
        )
        script_path.unlink(missing_ok=True)

        if result.returncode != 0:
            raise RuntimeError(result.stderr or result.stdout)

        with open(out_json, encoding="utf-8") as f:
            data = json.load(f)

        jobs[job_id]["status"] = "done"
        jobs[job_id]["message"] = f"완료: {len(data.get('words', []))} 단어"
        jobs[job_id]["result"] = out_json
    except Exception as e:
        jobs[job_id]["status"] = "error"
        jobs[job_id]["message"] = str(e)


def _render_worker(job_id: str, edit_dir: str, video_path: str, subtitles: bool = False):  # subtitles param kept for compat
    jobs[job_id]["status"] = "running"
    jobs[job_id]["message"] = "렌더 준비 중..."
    try:
        edl_path = Path(edit_dir) / "edl.json"
        out_path = Path(edit_dir) / "preview.mp4"

        if not edl_path.exists():
            raise RuntimeError("edl.json이 없습니다. EDL을 먼저 저장하세요.")

        cmd = [sys.executable, str(RENDER_SCRIPT),
               str(edl_path), "-o", str(out_path), "--preview"]
        edl_data = json.loads(edl_path.read_text(encoding="utf-8"))
        has_subs = bool(edl_data.get("subtitles"))
        jobs[job_id]["message"] = "렌더 중... (자막 포함)" if has_subs else "렌더 중... (시간이 걸릴 수 있습니다)"
        result = subprocess.run(
            cmd,
            capture_output=True, text=True, cwd=str(edit_dir)
        )

        if result.returncode != 0:
            raise RuntimeError(result.stderr[-2000:] or result.stdout[-2000:])

        # Probe result duration
        probe = run_ffprobe(str(out_path))
        duration_result = float(probe["format"]["duration"])

        # Probe original duration
        probe_orig = run_ffprobe(video_path)
        duration_original = float(probe_orig["format"]["duration"])

        # Write report
        with open(edl_path, encoding="utf-8") as f:
            edl = json.load(f)
        write_edit_report(edit_dir, video_path, edl, duration_original, duration_result)

        # Cleanup intermediates
        for name in ["clips_preview", "clips_final"]:
            d = Path(edit_dir) / name
            if d.exists():
                subprocess.run(["rm", "-rf", str(d)])
        for name in ["base_preview.mp4", "takes_packed.md", "render.log",
                     "transcribe.log", "transcribe_mlx.py"]:
            f = Path(edit_dir) / name
            f.unlink(missing_ok=True)

        jobs[job_id]["status"] = "done"
        jobs[job_id]["message"] = f"완료: {duration_result/60:.1f}분"
        jobs[job_id]["result"] = {
            "preview": str(out_path),
            "report": str(Path(edit_dir) / "edit_report.txt"),
            "duration": duration_result,
        }
    except Exception as e:
        jobs[job_id]["status"] = "error"
        jobs[job_id]["message"] = str(e)


def _pack_transcript(edit_dir: str) -> str:
    """Run pack_transcripts.py and return content of takes_packed.md."""
    result = subprocess.run(
        [sys.executable, str(PACK_SCRIPT), "--edit-dir", edit_dir],
        capture_output=True, text=True
    )
    packed_path = Path(edit_dir) / "takes_packed.md"
    if not packed_path.exists():
        raise RuntimeError(f"pack_transcripts.py 실패: {result.stderr[:500]}")
    return packed_path.read_text(encoding="utf-8")


_PROMPT_COMMON_FORMAT = """
## 출력 형식

JSON 배열만 출력하세요. 다른 텍스트 없이.

[
  {"start": 0.0, "end": 0.0, "beat": "발표자명", "quote": "대표발언 한 문장", "reason": "포함 이유"},
  ...
]

- start/end: 초 단위 float (트랜스크립트 타임스탬프 기준)
- beat: 발표자 이름 (사회자 발화는 포함하지 말 것)
- 각 발표자의 연속 발화는 하나의 range로 묶되, 30초 이상 침묵/전환이 있으면 분리

## 트랜스크립트

"""

PROMPT_FULL = """\
당신은 회의/세미나 녹화 영상 편집 전문가입니다.
아래 트랜스크립트를 분석해서 EDL(편집 결정 목록)을 JSON으로 출력하세요.

## 편집 기준 (전체 편집 모드)

**유지:**
- 발표자가 화면공유를 켜고 직접 설명하는 구간 전체
- 발표 내용 이해에 필수적인 Q&A (도구 형태 명확화, 핵심 기능)

**제거:**
- 사회자 오프닝 / 발표자 간 전환 / 마무리
- 발표 후 사회자 방향 제시, POC 권장 발언
- Q&A 중 비용/운영/기술 세부 논의
- 음향 설정, 화면 공유 준비 지연 구간
- 필러워드 단독 발화 ("어", "음", "네네네" 반복)
""" + _PROMPT_COMMON_FORMAT

PROMPT_SHORTS = """\
당신은 회의/세미나 녹화 영상 편집 전문가입니다.
아래 트랜스크립트를 분석해서 하이라이트 쇼츠용 EDL을 JSON으로 출력하세요.

## 편집 기준 (쇼츠 하이라이트 모드 — 목표: 총 10~15분)

**핵심 원칙: 발표자당 핵심 데모 장면과 결과만 선별. 배경 설명 과감하게 제거.**

**유지 (이것만):**
- 실제 화면/도구 데모 구간 (결과가 화면에 보이는 순간)
- 발표자가 핵심 성과/결과를 말하는 1~2분
- "이렇게 되면..." "결과적으로..." 등 임팩트 있는 결론 발화

**모두 제거:**
- 사회자 구간 전체
- 배경 설명, 개발 동기, 도구 소개 (데모 전 설명)
- Q&A 전체
- 트러블슈팅 과정 설명 (결과만 유지)
- 음향/화면 준비 구간
- 필러워드

**총 길이 제약:** 모든 range의 (end - start) 합계가 반드시 600~900초(10~15분) 이내여야 합니다.
발표자가 여럿이면 각자 1~3분씩 핵심만 선별하세요.
""" + _PROMPT_COMMON_FORMAT


def _analyze_worker(job_id: str, edit_dir: str, video_path: str, transcript_path: str, mode: str = "full"):
    jobs[job_id]["status"] = "running"
    jobs[job_id]["message"] = "트랜스크립트 패킹 중..."
    try:
        packed = _pack_transcript(edit_dir)
        label = "쇼츠 하이라이트" if mode == "shorts" else "전체 편집"
        jobs[job_id]["message"] = f"Claude AI 분석 중... ({label}, 1~2분 소요)"

        header = PROMPT_SHORTS if mode == "shorts" else PROMPT_FULL
        prompt = header + packed[:120000]
        # Pass env without ANTHROPIC_API_KEY so claude CLI uses its own auth
        env = {k: v for k, v in os.environ.items() if k != "ANTHROPIC_API_KEY"}
        result = subprocess.run(
            ["claude", "--output-format", "text", "--model", "claude-sonnet-4-6"],
            input=prompt, capture_output=True, text=True, timeout=600, env=env
        )
        if result.returncode != 0:
            raise RuntimeError(f"claude CLI 실패 (code {result.returncode}): {(result.stderr or result.stdout)[:500]}")
        raw = result.stdout.strip()

        # Extract JSON array from response
        m = re.search(r'\[\s*\{.*\}\s*\]', raw, re.DOTALL)
        if not m:
            raise RuntimeError(f"JSON 파싱 실패. 응답:\n{raw[:500]}")
        ranges = json.loads(m.group())

        # Add source field
        stem = Path(video_path).stem
        for r in ranges:
            r["source"] = stem

        jobs[job_id]["status"] = "done"
        jobs[job_id]["message"] = f"완료: {len(ranges)}개 구간 제안"
        jobs[job_id]["result"] = ranges

        # Cleanup packed file
        (Path(edit_dir) / "takes_packed.md").unlink(missing_ok=True)

    except Exception as e:
        jobs[job_id]["status"] = "error"
        jobs[job_id]["message"] = str(e)


# ── Routes ────────────────────────────────────────────────────────────────────

@app.post("/api/video/info")
def video_info(req: VideoInfoRequest):
    path = req.path.strip()
    if not Path(path).exists():
        raise HTTPException(404, "파일을 찾을 수 없습니다")
    try:
        info = run_ffprobe(path)
    except Exception as e:
        raise HTTPException(400, str(e))

    fmt = info.get("format", {})
    streams = info.get("streams", [])
    video_stream = next((s for s in streams if s.get("codec_type") == "video"), {})

    duration = float(fmt.get("duration", 0))
    size_mb = int(fmt.get("size", 0)) / 1024 / 1024
    width = video_stream.get("width", 0)
    height = video_stream.get("height", 0)
    fps_raw = video_stream.get("r_frame_rate", "0/1")
    try:
        a, b = fps_raw.split("/")
        fps = round(int(a) / int(b), 2)
    except Exception:
        fps = 0

    stem = Path(path).stem
    date_tag = datetime.now().strftime("%m%d")
    edit_dir = str(Path(path).parent / f"edit_{date_tag}")

    return {
        "path": path,
        "stem": stem,
        "duration": duration,
        "duration_fmt": format_duration(duration),
        "size_mb": round(size_mb, 1),
        "width": width,
        "height": height,
        "fps": fps,
        "edit_dir": edit_dir,
    }


class SubtitleCue(BaseModel):
    index: int
    start: float
    end: float
    text: str

class SubtitleSaveRequest(BaseModel):
    edit_dir: str
    cues: list[SubtitleCue]

class ApiKeyRequest(BaseModel):
    api_key: str

@app.post("/api/subtitles/generate")
def subtitles_generate(req: EDLSaveRequest):
    edl_path = Path(req.edit_dir) / "edl.json"
    if not edl_path.exists():
        raise HTTPException(400, "edl.json이 없습니다. EDL을 먼저 저장하세요.")
    edl = json.loads(edl_path.read_text(encoding="utf-8"))
    cues = build_subtitle_cues(edl, Path(req.edit_dir))
    if not cues:
        raise HTTPException(400, "트랜스크립트를 찾을 수 없습니다. 트랜스크립션을 먼저 실행하세요.")
    return {"cues": cues}


@app.post("/api/subtitles/save")
def subtitles_save(req: SubtitleSaveRequest):
    edit_dir = Path(req.edit_dir)
    edit_dir.mkdir(parents=True, exist_ok=True)
    srt_path = edit_dir / "subtitles.srt"
    cues_data = [c.model_dump() for c in req.cues]
    write_srt(cues_data, srt_path)
    # Update EDL subtitles field
    edl_path = edit_dir / "edl.json"
    if edl_path.exists():
        edl = json.loads(edl_path.read_text(encoding="utf-8"))
        edl["subtitles"] = str(srt_path)
        edl_path.write_text(json.dumps(edl, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"saved": str(srt_path), "count": len(cues_data)}


@app.delete("/api/subtitles")
def subtitles_delete(edit_dir: str):
    srt_path = Path(edit_dir) / "subtitles.srt"
    srt_path.unlink(missing_ok=True)
    edl_path = Path(edit_dir) / "edl.json"
    if edl_path.exists():
        edl = json.loads(edl_path.read_text(encoding="utf-8"))
        edl["subtitles"] = None
        edl_path.write_text(json.dumps(edl, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"ok": True}


@app.get("/api/settings/apikey")
def get_apikey_status():
    _load_env()
    key = os.environ.get("ANTHROPIC_API_KEY", "")
    return {"set": bool(key), "preview": (key[:8] + "...") if key else ""}

@app.post("/api/settings/apikey")
def save_apikey(req: ApiKeyRequest):
    key = req.api_key.strip()
    if not key:
        raise HTTPException(400, "API 키가 비어있습니다")
    os.environ["ANTHROPIC_API_KEY"] = key
    lines = []
    if _ENV_FILE.exists():
        lines = [l for l in _ENV_FILE.read_text().splitlines()
                 if not l.startswith("ANTHROPIC_API_KEY")]
    lines.append(f"ANTHROPIC_API_KEY={key}")
    _ENV_FILE.write_text("\n".join(lines) + "\n")
    return {"ok": True}


@app.post("/api/analyze/start")
def analyze_start(req: AnalyzeRequest):
    job_id = str(uuid.uuid4())
    jobs[job_id] = {"status": "pending", "message": "대기 중..."}
    t = threading.Thread(
        target=_analyze_worker,
        args=(job_id, req.edit_dir, req.video_path, req.transcript_path, req.mode),
        daemon=True
    )
    t.start()
    return {"job_id": job_id}


@app.post("/api/transcribe/start")
def transcribe_start(req: TranscribeRequest):
    Path(req.edit_dir).mkdir(parents=True, exist_ok=True)
    job_id = str(uuid.uuid4())
    jobs[job_id] = {"status": "pending", "message": "대기 중..."}
    t = threading.Thread(
        target=_transcribe_worker,
        args=(job_id, req.video_path, req.edit_dir),
        daemon=True
    )
    t.start()
    return {"job_id": job_id}


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str):
    if job_id not in jobs:
        raise HTTPException(404, "Job not found")
    return jobs[job_id]


@app.get("/api/transcript")
def get_transcript(path: str):
    p = Path(path)
    if not p.exists():
        raise HTTPException(404, "트랜스크립트 없음")
    with open(p, encoding="utf-8") as f:
        return json.load(f)


@app.post("/api/edl/save")
def edl_save(req: EDLSaveRequest):
    edit_dir = Path(req.edit_dir)
    edit_dir.mkdir(parents=True, exist_ok=True)
    edl_path = edit_dir / "edl.json"
    with open(edl_path, "w", encoding="utf-8") as f:
        json.dump(req.edl, f, ensure_ascii=False, indent=2)
    return {"saved": str(edl_path)}


@app.post("/api/render/start")
def render_start(req: RenderRequest):
    edl_path = Path(req.edit_dir) / "edl.json"
    if not edl_path.exists():
        raise HTTPException(400, "EDL이 없습니다. 먼저 저장하세요.")
    job_id = str(uuid.uuid4())
    jobs[job_id] = {"status": "pending", "message": "대기 중..."}
    t = threading.Thread(
        target=_render_worker,
        args=(job_id, req.edit_dir, req.video_path, req.subtitles),
        daemon=True
    )
    t.start()
    return {"job_id": job_id}


@app.get("/api/video/stream")
async def video_stream(path: str, range: Optional[str] = None):
    p = Path(path)
    if not p.exists():
        raise HTTPException(404, "파일 없음")

    file_size = p.stat().st_size
    start = 0
    end = file_size - 1

    if range:
        m = re.match(r"bytes=(\d+)-(\d*)", range)
        if m:
            start = int(m.group(1))
            if m.group(2):
                end = int(m.group(2))

    chunk_size = end - start + 1

    async def iter_file():
        async with aiofiles.open(p, "rb") as f:
            await f.seek(start)
            remaining = chunk_size
            while remaining > 0:
                read_size = min(65536, remaining)
                data = await f.read(read_size)
                if not data:
                    break
                remaining -= len(data)
                yield data

    headers = {
        "Content-Range": f"bytes {start}-{end}/{file_size}",
        "Accept-Ranges": "bytes",
        "Content-Length": str(chunk_size),
        "Content-Type": "video/mp4",
    }
    status = 206 if range else 200
    return StreamingResponse(iter_file(), status_code=status, headers=headers)


@app.get("/api/report")
def get_report(path: str):
    p = Path(path)
    if not p.exists():
        raise HTTPException(404, "리포트 없음")
    return {"content": p.read_text(encoding="utf-8")}


@app.get("/api/files/list")
def list_files(dir: str):
    d = Path(dir)
    if not d.exists():
        return {"files": []}
    files = []
    for f in sorted(d.iterdir()):
        if f.is_file():
            files.append({"name": f.name, "path": str(f), "size": f.stat().st_size})
    return {"files": files}
