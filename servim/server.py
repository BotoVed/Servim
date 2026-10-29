#!/usr/bin/env python3
"""Servim — сервер транскрибации на WhisperX: OpenAI-совместимый API, диаризация, очередь задач и веб-UI.

Совместимость (OpenAI Audio API, проверено по openai/openai-openapi, CreateTranscriptionRequest):
  POST /v1/audio/transcriptions
    file (обяз.)            flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm (у нас шире)
    model (обяз.)            "whisper-1" -> large-v3; либо our ids: large-v3, large-v3-turbo, ...
    language, prompt, temperature
    response_format          json | text | srt | vtt | verbose_json | diarized_json  (+наши: txt,tsv,stxt,md)
    timestamp_granularities  word | segment   (для verbose_json)
    include                  logprobs
    known_speaker_names      подписи спикеров по порядку появления
  GET  /v1/models            список моделей (OpenAI-форма)
  GET  /v1/audio/models      то же + признак "загружена ли модель в кэш"

Наши расширения (не часть OpenAI, игнорируются клиентами): diarize, vad_filter, beam_size,
  min_speakers, max_speakers, num_speakers, word_timestamps.

Задачи UI: POST /jobs, GET /jobs, GET /jobs/{id}, GET /jobs/{id}/result?format=...,
  PUT /jobs/{id}/speakers  {"A":"Пупкин Иван"} — переименование спикеров.
Хранение задач: $SERVIM_DATA/<id>.json (переживает рестарт).
"""
from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import threading
import time
import traceback
import uuid
from pathlib import Path
from typing import Any

from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

# --------------------------------------------------------------------------- конфиг
DATA_DIR = Path(os.environ.get("SERVIM_DATA", os.environ.get("WHISPERX_DATA", "./servim-data")))
STATIC_DIR = Path(__file__).with_name("static")
DEFAULT_MODEL = os.environ.get("SERVIM_MODEL", os.environ.get("WHISPERX_MODEL", "large-v3"))
DEVICE = os.environ.get("SERVIM_DEVICE", os.environ.get("WHISPERX_DEVICE", "cuda"))
COMPUTE = os.environ.get("SERVIM_COMPUTE_TYPE", os.environ.get("WHISPERX_COMPUTE_TYPE", "float16"))
HF_TOKEN = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
KEEP_JOBS = int(os.environ.get("SERVIM_KEEP_JOBS", os.environ.get("WHISPERX_KEEP_JOBS", "200")))
MAX_UPLOAD = int(os.environ.get("SERVIM_MAX_UPLOAD_MB", "2048")) * 1024 * 1024

# id модели OpenAI -> наша модель
MODEL_ALIASES = {"whisper-1": "large-v3", "whisper-1-turbo": "large-v3-turbo"}
SUPPORTED_MODELS = [
    ("large-v3", "Whisper large v3 (CT2)", 3_100_000_000),
    ("large-v3-turbo", "Whisper large v3 turbo (CT2)", 1_600_000_000),
    ("distil-large-v3", "Distil-Whisper large v3", 1_600_000_000),
    ("medium", "Whisper medium (CT2)", 1_500_000_000),
    ("small", "Whisper small (CT2)", 480_000_000),
    ("base", "Whisper base (CT2)", 140_000_000),
    ("tiny", "Whisper tiny (CT2)", 75_000_000),
]
CONTAINERS = {".wav", ".mp3", ".m4a", ".m4b", ".ogg", ".opus", ".flac", ".webm", ".mp4", ".mov",
              ".mkv", ".aac", ".wma", ".mpg", ".mpga", ".mpeg", ".mpeg", ".m4v", ".mka", ".aiff", ".ape"}

app = FastAPI(title="WhisperX ASR", version="1.1.2",
              description="Локальная замена OpenAI Audio Transcriptions: WhisperX + pyannote.")

# FastAPI не редиректит ДВОЙНОЙ ведущий слэш (//jobs → 405/404): страница, открытая
# по адресу с //, ломает все запросы. Нормализуем путь до роутинга.
@app.middleware("http")
async def collapse_double_slash(request, call_next):
    p = request.scope.get("path") or ""
    if "//" in p:
        request.scope["path"] = re.sub(r"/{2,}", "/", p)
    return await call_next(request)

# --------------------------------------------------------------------------- состояние
_state: dict[str, Any] = {"asr_name": None, "asr": None, "diar": None, "align_cache": {},
                          "loading": None, "error": None, "busy": None}
_lock = threading.Lock()
_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()
_tasks: "list[str]" = []
_paused = {"v": False}          # True — очередь стоит: новые задачи не начинаем


class JobCancelled(RuntimeError):
    """Задача прервана пользователем (кнопка «Стоп»). Не ошибка: в error не пишем."""

_task_evt = threading.Event()

# --------------------------------------------------------------------------- модели
def _ascii_name(stem: str, ext: str) -> str:
    """Имя для Content-Disposition: заголовки HTTP не юникодные — транслируем."""
    import unicodedata
    stem = unicodedata.normalize("NFKD", stem).encode("ascii", "ignore").decode()
    stem = re.sub(r"[^A-Za-z0-9._-]+", "_", stem).strip("._-") or "transcript"
    return f"{stem[:60]}.{ext}"


def resolve_model(name: str | None) -> str:
    if not name or name in ("default", "whisperx"):
        return DEFAULT_MODEL
    n = name.strip()
    if n in MODEL_ALIASES:
        return MODEL_ALIASES[n]
    n = re.sub(r"^@(?P<user>[^/]+)/(?P<m>whisper|faster-whisper|distil-whisper)-", "", n)
    for pat in (r"^faster-whisper-", r"^whisper-"):
        n = re.sub(pat, "", n) if n.startswith(pat) else n
    return n or DEFAULT_MODEL


_asr_cache: dict[tuple, Any] = {}


def _asr_key(name: str, o: dict) -> tuple:
    return (name, int(o.get("beam_size", 5)), bool(o.get("word_timestamps", True)),
            bool(o.get("vad_filter", True)), (o.get("initial_prompt") or "")[:180])


def get_asr(model_name: str, o: dict | None = None):
    """Загрузка ASR-модели под набор опций.

    В whisperx 3.8.6 beam_size / word_timestamps / initial_prompt / VAD задаются при загрузке
    (load_model(asr_options=..., vad_method=..., vad_options=...)), а НЕ в transcribe().
    Поэтому кэшируем по подписке опций и переключaем модели только реально меняя их.
    """
    o = o or {}
    key = _asr_key(model_name, o)
    with _lock:
        if key in _asr_cache:
            return _asr_cache[key]
        import whisperx

        _state["loading"] = model_name
        _state["error"] = None
        asr_options = {"beam_size": int(o.get("beam_size", 5)),
                       "best_of": int(o.get("beam_size", 5)),
                       "word_timestamps": bool(o.get("word_timestamps", True)),
                       "initial_prompt": o.get("initial_prompt") or None,
                       "suppress_numerals": bool(o.get("suppress_numerals", False)),
                       "condition_on_previous_text": True}
        vad_options = {"chunk_size": 30,
                       "vad_onset": float(o.get("vad_onset", 0.5)),
                       "vad_offset": float(o.get("vad_offset", 0.363))}
        try:
            asr = whisperx.load_model(model_name, DEVICE, compute_type=COMPUTE,
                                      asr_options=asr_options,
                                      vad_method="silero" if o.get("vad_filter", True) else None,
                                      vad_options=vad_options)
        except Exception as exc:  # noqa: BLE001
            _state["error"] = f"{type(exc).__name__}: {exc}"
            _state["loading"] = None
            raise HTTPException(400, detail={"error": {
                "message": f"модель {model_name!r} не загрузилась: {_state['error']}",
                "type": "invalid_request_error", "param": "model"}}) from exc
        _asr_cache[key] = asr
        _state["asr"], _state["asr_name"], _state["loading"] = asr, model_name, None
        return asr


def get_diar():
    with _lock:
        if _state["diar"] is None:
            from whisperx.diarize import DiarizationPipeline

            if not HF_TOKEN:
                raise RuntimeError("HF_TOKEN не задан — диаризация недоступна")
            _state["diar"] = DiarizationPipeline(token=HF_TOKEN, device=DEVICE)
        return _state["diar"]


def get_align(language: str):
    with _lock:
        if language not in _state["align_cache"]:
            import whisperx

            _state["align_cache"][language] = whisperx.load_align_model(language_code=language,
                                                                        device=DEVICE)
        return _state["align_cache"][language]


threading.Thread(target=lambda: get_asr(DEFAULT_MODEL, {}), daemon=True).start()

# --------------------------------------------------------------------------- утилиты

def speaker_letters(result: dict) -> dict:
    """Маппинг метки pyannote -> буква по OpenAI (A, B, C …) в порядке первого появления.
    Учитывает переименование: если задано имя, буква не меняется."""
    names = result.get("speaker_names") or {}
    order = result.get("speaker_order") or []
    if not order:
        for s in result.get("segments", []):
            lab = s.get("speaker")
            if lab and lab not in order:
                order.append(lab)
    out = {}
    for i, lab in enumerate(order):
        out[lab] = chr(ord("A") + i) if i < 26 else f"S{i}"
        if names.get(lab):
            out[lab] = names[lab]
    for lab, nm in names.items():
        if nm and lab not in out:
            out[lab] = nm
    return out


def spk_label(raw: str | None, names: dict[str, str]) -> str | None:
    """'SPEAKER_00'/'A' -> имя из маппинга, иначе как есть."""
    if not raw:
        return None
    return names.get(raw) or names.get(_letter(raw)) or raw


def _letter(raw: str) -> str:
    m = re.search(r"(\d+)$", raw)
    if m:
        return chr(ord("A") + int(m.group(1)))
    return raw[-1].upper() if raw else raw


def _ts_srt(t: float) -> str:
    ms = int(round(max(0.0, t) * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _ts_vtt(t: float) -> str:
    return _ts_srt(t).replace(",", ".")


def _ts_stxt(t: float) -> str:
    ms = int(round(max(0.0, t) * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h}:{m:02d}:{s:02d}.{ms:03d}"


def _line(text: str, speaker: str | None, prefix: bool) -> str:
    return f"[{speaker}] {text}" if (prefix and speaker) else text




def _join_words(words: list[dict], fallback: str = "") -> str:
    """Склеивает слова обратно. WhisperX для CJK возвращает слова без разделителей, а для
    алфавитных письменностей — слитно (без пробелов), поэтому для них вставляем пробелы."""
    if not words:
        return fallback
    parts = [str(w.get("word", "")) for w in words]
    text = "".join(parts)
    if len(parts) > 1 and " " not in text.strip():
        # слитно + есть буквы кириллицы/латиницы -> разделяем пробелами
        if re.search(r"[\w\u0400-\u04ff]", text) and not re.search(r"[\u4e00-\u9fff\u3040-\u30ff\uac00-\uacff]", text):
            text = " ".join(p.strip() for p in parts if p.strip())
    return text.strip() or fallback


def split_segments_by_speaker(result: dict) -> dict:
    """Разбивает сегменты ASR по сменам спикера (использует слова с метками от
    assign_word_speakers) — иначе OpenAI-подобный diarized_json показывает по одному
    «доминирующему» спикеру на 30-секундный чанк."""
    out = []
    for seg in result.get("segments", []):
        words = seg.get("words") or []
        if not words or not any(w.get("speaker") for w in words):
            out.append(seg)
            continue
        buf, wbuf = [], []
        cur = None
        start = float(seg.get("start", 0.0))

        def flush(end: float) -> None:
            if not buf:
                return
            piece = dict(seg)
            piece["text"] = _join_words(wbuf, seg.get("text", ""))
            piece["start"], piece["end"], piece["speaker"], piece["words"] = start, end, cur, wbuf
            out.append(piece)

        for w in words:
            spk = w.get("speaker") or cur
            if cur is None:
                cur = spk
            if spk != cur:
                flush(float(w.get("start", seg.get("end", 0.0))))
                start, cur, buf, wbuf = float(w.get("start", 0.0)), spk, [], []
            buf.append(str(w.get("word", "")))
            wbuf.append(w)
        flush(float(seg.get("end", 0.0)))
    if out:
        for i, s in enumerate(out):
            s["id"] = i
        result["segments"] = out
        order = []
        for s in out:
            lab = s.get("speaker")
            if lab and lab not in order:
                order.append(lab)
        result["speaker_order"] = order
        result["num_speakers"] = len(order)
    return result


def render(result: dict, fmt: str) -> tuple[str, str, str]:
    """(тело, mimetype, расширение). result — внутренний словарь WhisperX + speaker-маппинг."""
    names = speaker_letters(result)
    segs = result.get("segments", [])
    lab = lambda s: names.get(s.get("speaker")) if s.get("speaker") else None  # noqa: E731
    has_spk = any(lab(s) for s in segs)

    if fmt == "json":
        return json.dumps(openai_verbose(result), ensure_ascii=False), "application/json", "json"
    if fmt == "srt":
        body = "\n".join(
            f"{i}\n{_ts_srt(s['start'])} --> {_ts_srt(s['end'])}\n{_line(s['text'].strip(), lab(s), has_spk)}\n"
            for i, s in enumerate(segs, 1))
        return body, "application/x-subrip", "srt"
    if fmt == "vtt":
        lines = ["WEBVTT", ""]
        for s in segs:
            who = lab(s)
            lines.append(f"{_ts_vtt(s['start'])} --> {_ts_vtt(s['end'])}\n"
                         + (f"<v {who}>{s['text'].strip()}" if who else s["text"].strip()) + "\n")
        return "\n".join(lines), "text/vtt", "vtt"
    if fmt == "stxt":
        # формат субтитров Super (.stxt): заголовок Super-VTT + блоки Start/End/Line
        out = [f"Super-VTT:stxt:v1\nLanguage={result.get('language', 'ru').upper()}\n"]
        for s in segs:
            out.append(f"Start:{_ts_stxt(s['start'])}\nEnd:{_ts_stxt(s['end'])}\n"
                       f"Line:{_line(s['text'].strip(), lab(s), has_spk)}\n")
        return "\n".join(out), "text/plain", "stxt"
    if fmt == "tsv":
        rows = ["start\tend\tspeaker\ttext"] + [
            f"{s['start']:.3f}\t{s['end']:.3f}\t{lab(s) or ''}\t{s['text'].strip()}" for s in segs]
        return "\n".join(rows), "text/tab-separated-values", "tsv"
    if fmt == "md":
        rows = ["| время | спикер | текст |", "|---|---|---|"] + [
            f"| {_ts_vtt(s['start'])} | {lab(s) or '—'} | {s['text'].strip().replace('|', '\\|')} |" for s in segs]
        return "\n".join(rows), "text/markdown", "md"
    text = "\n".join(_line(s["text"].strip(), lab(s), has_spk and fmt == "txt" and False) for s in segs)
    return text, "text/plain", "txt"


def openai_verbose(result: dict) -> dict:
    """verbose_json по спецификации OpenAI."""
    names = speaker_letters(result)
    segs = [{"id": i, "seek": i, "start": s["start"], "end": s["end"], "text": s["text"],
             "tokens": s.get("tokens", []), "temperature": s.get("temperature", 0.0),
             "avg_logprob": s.get("avg_logprob", 0.0), "compression_ratio": s.get("compression_ratio", 1.0),
             "no_speech_prob": s.get("no_speech_prob", 0.0),
             **({"speaker": names.get(s.get("speaker"), s.get("speaker")),
                 "speaker_raw": s.get("speaker")} if s.get("speaker") else {}),
             **({"words": s.get("words", [])} if s.get("words") else {})}
            for i, s in enumerate(result.get("segments", []))]
    words = [w for s in result.get("segments", []) for w in s.get("words", [])]
    return {"task": "transcribe", "language": result.get("language"),
            "duration": result.get("audio_duration"), "text": result.get("text_full", ""),
            "segments": segs, "words": words,
            "model": result.get("model"), "usage": {"type": "duration", "seconds": result.get("audio_duration")}}


def openai_diarized(result: dict) -> dict:
    """diarized_json: segments[] {type,id,start,end,text,speaker}."""
    letters = speaker_letters(result)
    segs = [{"type": "transcript.text.segment", "id": f"seg_{i + 1}", "start": s["start"], "end": s["end"],
             "text": s["text"].strip(), "speaker": letters.get(s.get("speaker"), "A")}
            for i, s in enumerate(result.get("segments", []))]
    return {"task": "transcribe", "language": result.get("language"),
            "duration": result.get("audio_duration"), "text": result.get("text_full", ""),
            "segments": segs, "model": result.get("model"),
            "usage": {"type": "duration", "seconds": result.get("audio_duration")}}

# --------------------------------------------------------------------------- задачи
def _persist(job: dict) -> None:
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        slim = {k: v for k, v in job.items() if k not in ("audio", "dir")}
        (DATA_DIR / f"{job['id']}.json").write_text(json.dumps(slim, ensure_ascii=False))
    except OSError:
        pass


def _load_persisted() -> None:
    if not DATA_DIR.exists():
        return
    for f in sorted(DATA_DIR.glob("*.json"))[-KEEP_JOBS:]:
        try:
            j = json.loads(f.read_text())
            _jobs[j["id"]] = j
        except (OSError, ValueError):
            continue


_load_persisted()


def _update(jid: str, **kw) -> None:
    with _jobs_lock:
        job = _jobs.get(jid)
        if not job:
            return
        job.update(kw)
        _persist(job)


def _progress(jid: str, value: float, stage: str) -> None:
    """Отметить ход обработки. Только память: whisperx дёргает progress_callback на каждый
    VAD-чанк, писать JSON на диск на каждый вызов незачем."""
    with _jobs_lock:
        j = _jobs.get(jid)
        if j is None:
            return
        if j.get("cancel"):
            # единственный дешёвый способ прервать whisperx посередине: progress_callback
            # вызывается на каждом VAD-чанке/окне, исключение оттуда разворачивает транскрибцию
            raise JobCancelled("остановлено пользователем")
        j["progress"] = round(max(0.0, min(99.5, float(value))), 1)
        j["stage"] = stage


def _process(jid: str) -> None:
    import whisperx

    job = _jobs[jid]
    o = job["options"]
    t0 = time.time()
    _state["busy"] = jid
    try:
        _update(jid, status="running", started=t0, progress=0.0, stage="подготовка")

        # Веса этапов. Честные progress_callback у whisperx есть у распознавания (процент по
        # VAD-чанкам) и у диаризации (pyannote, два подэтапа); у выравнивания их нет, поэтому
        # выравнивание — фиксированный отрезок, а не измерение.
        diar_on = bool(o.get("diarize", True))
        w_asr, w_align, w_diar = (65.0, 13.0, 21.0) if diar_on else (86.0, 13.0, 0.0)

        def asr_cb(v: float) -> None:
            _progress(jid, v / 100 * w_asr, "распознавание")

        def align_cb(v: float) -> None:
            _progress(jid, w_asr + v / 100 * w_align, "выравнивание")

        def diar_cb(v: float) -> None:
            _progress(jid, w_asr + w_align + v / 100 * w_diar, "диаризация")

        # Задача могла пережить рестарт из старого дампа либо уже отработанный файл:
        # без этой проверки была непонятная ошибка KeyError: 'audio'.
        _src = job.get("audio")
        if not _src or not Path(_src).exists():
            raise FileNotFoundError("аудио недоступно (старая задача или файл уже удалён) — загрузите заново")
        audio = whisperx.load_audio(_src)
        _progress(jid, 0.0, "распознавание")

        asr = get_asr(resolve_model(o.get("model")), o)
        res = asr.transcribe(audio, batch_size=int(o.get("batch_size", 8)),
                            language=o.get("language") or None, task="transcribe",
                            chunk_size=30, verbose=False, progress_callback=asr_cb)
        # faster-whisper кладёт "language" только когда определял сам; при явном языке дописываем
        detected = res.get("language") or o.get("language")

        if o.get("word_timestamps", True) and res.get("segments"):
            _progress(jid, w_asr, "выравнивание")
            try:
                align_model, meta = get_align(detected or "ru")
                res = whisperx.align(res["segments"], align_model, meta, audio, device=DEVICE,
                                    return_char_alignments=False, progress_callback=align_cb)
            except Exception as exc:  # noqa: BLE001
                job.setdefault("warnings", []).append(f"align: {type(exc).__name__}: {exc}")
        _progress(jid, w_asr + w_align, "выравнивание")

        if o.get("diarize", True):
            try:
                from whisperx.diarize import assign_word_speakers

                diar = get_diar()
                kw: dict[str, Any] = {}
                if o.get("num_speakers"):
                    kw["num_speakers"] = int(o["num_speakers"])
                else:
                    kw["min_speakers"] = int(o.get("min_speakers", 1))
                    kw["max_speakers"] = int(o.get("max_speakers", 8))
                _progress(jid, w_asr + w_align, "диаризация")
                ann = diar(audio, progress_callback=diar_cb, **kw)
                res = assign_word_speakers(ann, res, fill_nearest=True)
                try:
                    res["num_speakers"] = int(ann["speaker"].nunique())
                except Exception:  # noqa: BLE001
                    res["num_speakers"] = len({s.get("speaker") for s in res["segments"] if s.get("speaker")})
            except Exception as exc:  # noqa: BLE001
                job.setdefault("warnings", []).append(f"diarization: {type(exc).__name__}: {exc}")

        if o.get("diarize", True) and o.get("word_timestamps", True):
            try:
                res = split_segments_by_speaker(res)
            except Exception as exc:  # noqa: BLE001
                job.setdefault("warnings", []).append(f"split: {type(exc).__name__}: {exc}")


        # имена спикеров из запроса (OpenAI known_speaker_names) — по порядку первого появления
        order, named = [], {}
        for s in res.get("segments", []):
            lab = s.get("speaker")
            if lab and lab not in named:
                named[lab] = None
                order.append(lab)
        given = o.get("known_speaker_names") or []
        names = {lab: (given[i] if i < len(given) else None) for i, lab in enumerate(order)}
        res["language"] = detected or res.get("language")
        res.update(audio_duration=round(len(audio) / 16000, 3),
                   elapsed=round(time.time() - t0, 2),
                   model=_state["asr_name"], speed=round((len(audio) / 16000) / max(time.time() - t0, 1e-6), 2),
                   speaker_names={k: v for k, v in names.items() if v},
                   speaker_order=order,
                   text_full=" ".join(s["text"].strip() for s in res.get("segments", [])))
        if not res.get("segments"):
            job.setdefault("warnings", []).append(
                "текста не найдено: в файле тишина ниже порога VAD или нераспознанная речь")
        _update(jid, status="done", result=res, finished=time.time(), progress=100.0,
                stage="готово", warnings=job.get("warnings", []))
    except JobCancelled:
        _update(jid, status="plan", progress=0.0, stage="остановлено", finished=None)
    except HTTPException as exc:
        _update(jid, status="error", error=str(exc.detail), finished=time.time())
    except Exception as exc:  # noqa: BLE001
        _update(jid, status="error", error=f"{type(exc).__name__}: {exc}",
                trace=traceback.format_exc()[-3000:], finished=time.time())
    finally:
        _state["busy"] = None
        if not job.get("cancel"):
            # после ручной остановки аудио оставляем: задачу можно снова запустить кнопкой
            shutil.rmtree(job.get("dir", "/nonexistent"), ignore_errors=True)
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:  # noqa: BLE001
            pass
        _task_evt.set()


def _worker() -> None:
    global _tasks
    while True:
        while not _tasks or _paused["v"]:
            _task_evt.wait(2)
            _task_evt.clear()
        jid = _tasks.pop(0)
        try:
            _process(jid)
        finally:
            _gc()


def _gc() -> None:
    with _jobs_lock:
        if len(_jobs) <= KEEP_JOBS:
            return
        old = sorted(_jobs.values(), key=lambda j: j.get("finished") or 0)[: len(_jobs) - KEEP_JOBS]
        for j in old:
            _jobs.pop(j["id"], None)
            (DATA_DIR / f"{j['id']}.json").unlink(missing_ok=True)
            shutil.rmtree(j.get("dir", "/nonexistent"), ignore_errors=True)


threading.Thread(target=_worker, daemon=True).start()


async def _stash(file: UploadFile) -> tuple[str, str]:
    suffix = (Path(file.filename or "audio.wav").suffix or ".wav").lower()
    if suffix not in CONTAINERS:
        raise HTTPException(415, detail={"error": {"message": f"контейнер {suffix} не поддерживается",
                                                   "type": "invalid_request_error", "code": "unsupported_file"}})
    tmp_root = os.environ.get("SERVIM_TMP") or str(DATA_DIR / "tmp")
    os.makedirs(tmp_root, exist_ok=True)
    d = tempfile.mkdtemp(prefix="wx_", dir=tmp_root)
    path = os.path.join(d, f"in{suffix}")
    size = 0
    with open(path, "wb") as fh:
        while chunk := await file.read(1 << 23):
            size += len(chunk)
            if size > MAX_UPLOAD:
                shutil.rmtree(d, ignore_errors=True)
                raise HTTPException(413, detail={"error": {"message": f"файл больше {MAX_UPLOAD // 2**20} МБ",
                                                           "type": "invalid_request_error"}})
            fh.write(chunk)
    if not size:
        shutil.rmtree(d, ignore_errors=True)
        raise HTTPException(400, detail={"error": {"message": "пустой файл", "type": "invalid_request_error"}})
    return path, d


def _probe_duration(path: str) -> float | None:
    """Длительность сразу при загрузке: после обработки аудио удаляется, а колонка «длит.»
    нужна и в очереди. Только заголовок файла, стоит доли секунды."""
    import subprocess
    for exe in ("/usr/bin/ffprobe", "ffprobe"):
        try:
            out = subprocess.run([exe, "-v", "error", "-show_entries", "format=duration",
                                  "-of", "default=nw=1:nk=1", path],
                                 capture_output=True, text=True, timeout=8)
            if out.returncode == 0 and out.stdout.strip():
                return round(float(out.stdout.strip().splitlines()[0]), 3)
        except Exception:  # noqa: BLE001
            continue
    try:                                     # wav/ogg без ffmpeg
        import soundfile as sf
        info = sf.info(path)
        return round(info.frames / float(info.samplerate), 3)
    except Exception:  # noqa: BLE001
        return None


def _new_job(name: str, path: str, d: str, opts: dict, start: bool = True) -> str:
    jid = str(uuid.uuid4())
    ext = (Path(name).suffix or "").lstrip(".").lower()[:5]
    with _jobs_lock:
        _jobs[jid] = {"id": jid, "name": name, "type": ext, "duration": _probe_duration(path),
                      "status": "queued" if start else "plan", "audio": path, "dir": d,
                      "options": opts, "created": time.time(), "warnings": []}
        _persist(_jobs[jid])
    if start:
        _tasks.append(jid)
        _task_evt.set()
    return jid


def _as_bool(v: Any, default: bool = True) -> bool:
    if isinstance(v, bool):
        return v
    if v is None or v == "":
        return default
    return str(v).strip().lower() in ("1", "true", "yes", "on", "да")


def _wait(jid: str, timeout: int) -> dict:
    end = time.time() + timeout
    while time.time() < end:
        st = _jobs.get(jid, {}).get("status")
        if st in ("done", "error"):
            break
        time.sleep(0.4)
    else:
        raise HTTPException(504, detail={"error": {"message": f"таймаут ожидания; опроси /jobs/{jid}",
                                                   "type": "timeout_error"}})
    job = _jobs[jid]
    if job["status"] == "error":
        raise HTTPException(500, detail={"error": {"message": job.get("error", "ошибка"),
                                                   "type": "server_error", "source": "whisperx"}})
    return job


# --------------------------------------------------------------------------- OpenAI API
@app.get("/v1/models")
def models() -> dict:
    have = set()
    hub = Path(os.environ.get("HUGGINGFACE_HUB_CACHE", str(Path.home() / ".cache" / "huggingface" / "hub")))
    if hub.exists():
        for d in hub.iterdir():
            for pref in ("models--Systran--", "models----"):
                if d.name.startswith(pref):
                    have.add(d.name[len(pref):].replace("__", "/"))
    data = [{"id": mid, "object": "model", "created": 0, "owned_by": "local-whisperx",
             "name": label, "params": params, "downloaded": any(mid in h or mid.replace("/", "-") in h for h in have)}
            for mid, label, params in SUPPORTED_MODELS]
    data.append({"id": "whisper-1", "object": "model", "created": 0, "owned_by": "local-whisperx",
                 "name": "псевдоним large-v3 (как в OpenAI)", "params": None, "downloaded": True})
    return {"object": "list", "data": data}


@app.post("/v1/audio/transcriptions")
async def transcriptions(request: Request, file: UploadFile = File(...), model: str = Form(...),
                        language: str | None = Form(None), prompt: str | None = Form(None),
                        response_format: str = Form("json"), temperature: float = Form(0.0),
                        timestamp_granularities: list[str] | None = Form(None),
                        include: list[str] | None = Form(None),
                        known_speaker_names: list[str] | None = Form(None),
                        known_speaker_references: list[str] | None = Form(None),
                        diarize: str | None = Form(None), vad_filter: str | None = Form(None),
                        beam_size: int = Form(5), min_speakers: int = Form(1), max_speakers: int = Form(8),
                        num_speakers: int = Form(0), word_timestamps: str | None = Form(None),
                        wait: int = Form(7200)):
    form = await request.form()
    g = lambda k, d=None: form.get(k, d)  # noqa: E731
    if known_speaker_references:
        raise HTTPException(400, detail={"error": {
            "message": "known_speaker_references не поддерживается локальным движком (нужна регистрация голосов); "
                       "используй known_speaker_names или переименуй спикеров через UI",
            "type": "invalid_request_error", "code": "unsupported_parameter"}})

    fmt = response_format or "json"
    want_diar = _as_bool(diarize, default=(fmt == "diarized_json"))
    path, d = await _stash(file)
    jid = _new_job(file.filename or "audio", path, d, {
        "model": model, "language": language or None, "initial_prompt": prompt or None,
        "beam_size": beam_size, "vad_filter": _as_bool(vad_filter, True),
        "word_timestamps": _as_bool(word_timestamps, "word" in (timestamp_granularities or []) or True),
        "diarize": want_diar, "min_speakers": min_speakers, "max_speakers": max_speakers,
        "num_speakers": num_speakers or None, "known_speaker_names": known_speaker_names or [],
        "prompt": prompt, "temperature": temperature})
    job = _wait(jid, wait)
    res = job["result"]

    if fmt == "text" or fmt == "plain_text":
        return PlainTextResponse(res["text_full"])
    if fmt in ("srt", "vtt", "stxt", "tsv", "txt", "md"):
        body, mime, ext = render(res, fmt)
        stem = re.sub(r"[^\w.-]+", "_", Path(job["name"]).stem)[:48] or "transcript"
        return PlainTextResponse(body, media_type=mime,
                                 headers={"Content-Disposition": f"attachment; filename=\"{_ascii_name(stem, ext)}\""})
    if fmt == "diarized_json":
        return JSONResponse(openai_diarized(res))
    if fmt == "verbose_json":
        v = openai_verbose(res)
        gran = _granularities(timestamp_granularities)
        if gran and "word" not in gran:
            v.pop("words", None)
        if gran and "segment" not in gran:
            v.pop("segments", None)
        return JSONResponse(v)
    return JSONResponse({"text": res["text_full"], "language": res.get("language"),
                         "duration": res.get("audio_duration"),
                         **({"languages": res.get("all_language_probs") and list(res["all_language_probs"][0])}
                            if res.get("all_language_probs") else {})})


@app.post("/v1/audio/translations")
async def translations(file: UploadFile = File(...), model: str = Form(...),
                      response_format: str = Form("json"), prompt: str | None = Form(None)):
    """Перевода нет — отдаём транскрипцию исходника (как это делает whisper-1 без перевода)."""
    path, d = await _stash(file)
    jid = _new_job(file.filename or "audio", path, d, {"model": model, "diarize": False,
                                                      "word_timestamps": False, "prompt": prompt})
    res = _wait(jid, 7200)["result"]
    if response_format in ("text", "plain_text"):
        return PlainTextResponse(res["text_full"])
    return JSONResponse({"text": res["text_full"]})

# --------------------------------------------------------------------------- UI API

def _ui_stamp() -> int:
    """Штамп версии интерфейса: самый свежий mtime среди статики. Фронт сравнивает его
    с тем, что загрузил, и сам перезагружает страницу после обновления сервера — иначе во
    вкладке остаётся старый JS/HTML и кнопки ведут себя по-старому. Смотрим по всем
    файлам: правка только index.html раньше штамп не двигала."""
    try:
        stamps = [int((STATIC_DIR / n).stat().st_mtime)
                  for n in ("app.js", "index.html", "app.css") if (STATIC_DIR / n).exists()]
        return max(stamps) if stamps else 0
    except OSError:
        return 0


@app.get("/health")
def health() -> dict:
    vram = {}
    try:
        import torch
        if torch.cuda.is_available():
            free, total = torch.cuda.mem_get_info()
            vram = {"free_gib": round(free / 2**30, 2), "total_gib": round(total / 2**30, 2)}
    except Exception:  # noqa: BLE001
        pass
    return {"version": app.version,
            "ui_stamp": _ui_stamp(),
            "status": "loading" if _state["loading"] else ("error" if _state["error"] else "ready"),
            "model": _state["asr_name"] or DEFAULT_MODEL, "device": DEVICE, "compute_type": COMPUTE,
            "asr_loaded": _state["asr"] is not None, "diar_loaded": _state["diar"] is not None,
            "diar_ready": bool(HF_TOKEN), "align_languages": sorted(_state["align_cache"]),
            "error": _state["error"], "queue": len(_tasks), "busy": _state["busy"],
            "paused": _paused["v"],
            "jobs": len(_jobs), "formats": ["json", "verbose_json", "diarized_json", "text", "srt",
                                           "vtt", "stxt", "txt", "tsv", "md"], **({"vram": vram} if vram else {})}


@app.post("/jobs")
async def create_job(file: UploadFile = File(...), model: str = Form(DEFAULT_MODEL),
                    language: str | None = Form(None), diarize: str | None = Form(None),
                    vad_filter: str | None = Form(None), word_timestamps: str | None = Form(None),
                    beam_size: int = Form(5), min_speakers: int = Form(1), max_speakers: int = Form(8),
                    num_speakers: int = Form(0), start: str | None = Form(None)):
    path, d = await _stash(file)
    jid = _new_job(file.filename or "audio", path, d, {
        "model": model, "language": language or None, "diarize": _as_bool(diarize, True),
        "vad_filter": _as_bool(vad_filter, True), "word_timestamps": _as_bool(word_timestamps, True),
        "beam_size": beam_size, "min_speakers": min_speakers, "max_speakers": max_speakers,
        "num_speakers": num_speakers or None}, start=_as_bool(start, True))
    return {"job_id": jid, "status": _jobs[jid]["status"], "status_url": f"/jobs/{jid}",
            "result_url": f"/jobs/{jid}/result"}


@app.get("/queue", response_model=None)
def queue_state(selected: str | None = None) -> dict:
    """Состояние очереди; `selected` (id через запятую) — отмеченные задачи, они идут первыми."""
    with _jobs_lock:
        planned = [j["id"] for j in sorted(_jobs.values(), key=lambda j: j.get("created") or 0)
                   if j.get("status") == "plan"]
    head = [i for i in (selected.split(",") if selected else []) if i in planned]
    if head:
        planned = head + [i for i in planned if i not in head]
    return {"paused": _paused["v"], "busy": _state["busy"], "planned": planned,
            "queued": list(_tasks)}


@app.post("/queue/start", response_model=None)
def queue_start(selected: str | None = None) -> dict:
    """Снять с паузы и поставить в очередь всё запланированное.
    `selected` (id через запятую) ставит отмеченные задачи первыми."""
    _paused["v"] = False
    order = [x.strip() for x in (selected or "").split(",") if x.strip()]
    with _jobs_lock:
        # Отмеченные в интерфейсе идут первыми, остальное — в порядке добавления.
        ids = order + [j["id"] for j in sorted(_jobs.values(), key=lambda j: j.get("created") or 0)
                       if j.get("status") == "plan" and j["id"] not in order]
        ids = [i for i in ids if _jobs.get(i) and _jobs[i]["status"] in ("plan", "queued")]
        for jid in ids:
            _jobs[jid]["status"] = "queued"
            _jobs[jid].pop("cancel", None)
    # Пересобираем очередь целиком: только что отмеченные — в начало, остальные — за ними.
    global _tasks
    with _jobs_lock:
        _tasks = ids + [i for i in _tasks if i not in ids]
    _task_evt.set()
    if not ids:  # диагностика для интерфейса: «Старт» на пустой очереди выглядит поломкой
        left = [{"id": j["id"], "status": j.get("status"), "error": (j.get("error") or "")[:80]}
                for j in _jobs.values() if j.get("status") in ("error", "queued", "running")]
        return {"paused": False, "started": 0, "nothing_to_start": True, "jobs": left}
    return {"paused": False, "started": len(ids)}


@app.post("/queue/pause")
def queue_pause(pause_current: bool = False) -> dict:
    """Пауза: текущая задача доходит до конца (или прерывается сразу, если pause_current=true)."""
    _paused["v"] = True
    stopped = None
    if pause_current and _state["busy"]:
        stopped = _stop_job(_state["busy"])
    return {"paused": True, "stopped": stopped}


def _stop_job(job_id: str) -> str:
    """Снять с очереди (если ждёт) или прервать на ближайшей границе чанка (если идёт)."""
    with _jobs_lock:
        j = _jobs.get(job_id)
        if not j:
            return "нет такой задачи"
        if j.get("status") in ("plan", "queued"):
            if job_id in _tasks:
                _tasks.remove(job_id)
            j["status"] = "plan"
            j["stage"] = "остановлено"
            return "снято из очереди"
        j["cancel"] = True
        j["stage"] = "останавливается…"
        return "прерывается"


@app.post("/jobs/{job_id}/stop")
def stop_job(job_id: str) -> dict:
    if job_id not in _jobs:
        raise HTTPException(404, detail={"error": {"message": "задачи нет",
                                                   "type": "invalid_request_error"}})
    return {"job_id": job_id, "action": _stop_job(job_id)}


@app.get("/jobs")
def list_jobs(limit: int = 50) -> dict:
    with _jobs_lock:
        items = sorted(_jobs.values(), key=lambda j: j.get("created") or 0, reverse=True)[:limit]
    return {"count": len(_jobs), "jobs": [{k: v for k, v in j.items()
                                          if k not in ("audio", "dir", "result", "trace")} | (
        {"summary": _summary(j)} if j.get("status") == "done" else {}) for j in items]}


def _summary(job: dict) -> dict:
    r = job.get("result") or {}
    return {"duration": r.get("audio_duration"), "elapsed": r.get("elapsed"), "speed": r.get("speed"),
            "segments": len(r.get("segments", [])), "speakers": r.get("num_speakers"),
            "language": r.get("language"), "model": r.get("model")}


@app.get("/jobs/{job_id}")
def job_status(job_id: str) -> dict:
    j = _jobs.get(job_id)
    if not j:
        raise HTTPException(404, detail={"error": {"message": "задачи нет", "type": "invalid_request_error"}})
    out = {k: v for k, v in j.items() if k not in ("audio", "dir")}
    if j["status"] == "done":
        out["summary"] = _summary(j)
        letters = speaker_letters(j["result"])
        raw_names = j["result"].get("speaker_names") or {}
        seen: dict[str, dict] = {}
        for s in j["result"].get("segments", []):
            raw = s.get("speaker")
            if raw and raw not in seen:
                letter = letters.get(raw, raw)
                seen[raw] = {"label": letter, "raw": raw, "name": raw_names.get(raw) or ""}
        out["speakers"] = list(seen.values())
    return out


@app.get("/download")
def download_all(fmt: str = "srt") -> Response:
    """Все готовые результаты одним zip-архивом (имена = имена исходных файлов)."""
    import io
    import zipfile
    buf = io.BytesIO()
    n = 0
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for j in _jobs.values():
            if j.get("status") != "done":
                continue
            try:
                body, _mime, ext = render(j["result"], fmt)
            except Exception:      # noqa: BLE001 - один битый результат не должен ломать архив
                continue
            stem = re.sub(r"[^\w.-]+", "_", Path(j["name"]).stem)[:48] or "transcript"
            z.writestr(f"{stem}.{n:03d}.{ext}", body)
            n += 1
    if not n:
        raise HTTPException(409, detail={"error": {"message": "готовых задач нет",
                                                   "type": "invalid_request_error"}})
    return Response(buf.getvalue(), media_type="application/zip",
                    headers={"Content-Disposition": 'attachment; filename="transcripts.zip"'})


@app.api_route("/jobs/{job_id}/download", methods=["GET", "HEAD"])
def job_download(job_id: str, fmt: str = "srt", format: str = ""):
    """Старое/прямое имя ссылки: ?fmt= вместо ?format=. Нужено, чтобы вкладки,
    открытые до переименования параметра, продолжали скачивать."""
    return job_result(job_id, format or fmt)


@app.api_route("/jobs/{job_id}/result", methods=["GET", "HEAD"])
def job_result(job_id: str, format: str = "json"):
    j = _jobs.get(job_id)
    if not j:
        raise HTTPException(404, detail={"error": {"message": "задачи нет", "type": "invalid_request_error"}})
    if j["status"] != "done":
        raise HTTPException(409, detail={"error": {"message": f"статус {j['status']}"
                                                           + (f": {j.get('error')}" if j.get("error") else ""),
                                                  "type": "invalid_request_error"}})
    if format == "verbose_json":
        return JSONResponse(openai_verbose(j["result"]))
    if format == "diarized_json":
        return JSONResponse(openai_diarized(j["result"]))
    if format == "raw":
        return JSONResponse(j["result"])
    body, mime, ext = render(j["result"], format)
    stem = re.sub(r"[^\w.-]+", "_", Path(j["name"]).stem)[:48] or "transcript"
    return PlainTextResponse(body, media_type=mime,
                            headers={"Content-Disposition": f"attachment; filename=\"{_ascii_name(stem, ext)}\""})


@app.put("/jobs/{job_id}/speakers")
async def rename_speakers(job_id: str, body: dict) -> dict:
    """{"SPEAKER_00": "Пупкин Иван", "B": "Друг"} — переименование спикеров (по исходной метке)."""
    j = _jobs.get(job_id)
    if not j or j["status"] != "done":
        raise HTTPException(404, detail={"error": {"message": "готовой задачи нет", "type": "invalid_request_error"}})
    names = j["result"].setdefault("speaker_names", {})
    order = j["result"].get("speaker_order") or []
    if not order:
        for s in j["result"].get("segments", []):
            raw = s.get("speaker")
            if raw and raw not in order:
                order.append(raw)
    by_letter = {chr(ord("A") + i): raw for i, raw in enumerate(order[:26])}
    for key, val in body.items():
        key = (key or "").strip()
        if not key:
            continue
        # ключ — буква (A, B, …) из UI/API либо сырая метка (SPEAKER_03)
        raw = by_letter.get(key.upper(), key) if len(key) == 1 else key
        val = (val or "").strip()
        if val:
            names[raw] = val
        else:
            names.pop(raw, None)
    _update(job_id, result=j["result"])
    return {"job_id": job_id, "speaker_names": names}


@app.delete("/jobs/{job_id}", status_code=204)
def delete_job(job_id: str):
    with _jobs_lock:
        j = _jobs.pop(job_id, None)
    if j:
        shutil.rmtree(j.get("dir", "/nonexistent"), ignore_errors=True)
        (DATA_DIR / f"{job_id}.json").unlink(missing_ok=True)


@app.delete("/jobs")
def delete_jobs(ids: str) -> Response:
    """Пакетное удаление: `DELETE /jobs?ids=<id1>,<id2>`. Отвечает списком фактически
    удалённых id, чтобы интерфейс мог убедиться, что запрос дошёл и обработан."""
    deleted = []
    for jid in [x.strip() for x in ids.split(",") if x.strip()]:
        with _jobs_lock:
            job = _jobs.pop(jid, None)
        if job is None:
            continue
        deleted.append(jid)
        if jid in _tasks:          # снять с очереди, если ещё не началась
            _tasks.remove(jid)
        shutil.rmtree(job.get("dir", "/nonexistent"), ignore_errors=True)
        (DATA_DIR / f"{jid}.json").unlink(missing_ok=True)
    return JSONResponse({"deleted": deleted, "count": len(deleted)}, status_code=200)


@app.middleware("http")
async def _no_store_static(request, call_next):
    """Страница маленькая, а устаревшую копию браузер держит долго — запрещаем кэш."""
    resp = await call_next(request)
    # StatFiles отдаёт "/" как index.html, но браузер реально грузит /index.html —
    # без этого заголовка он неделями держит старую страницу (лечилось только Ctrl+Shift+R).
    if request.url.path.endswith((".html", ".js", ".css")) or request.url.path in ("/", "", "/index.html"):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


if STATIC_DIR.exists():
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="ui")


def main(argv: list[str] | None = None) -> None:
    """Запуск: `servim` или `python -m servim` (--help покажет все опции)."""
    import argparse

    import uvicorn
    ap = argparse.ArgumentParser(prog="servim", description="Servim — сервер транскрибации на WhisperX")
    ap.add_argument("--host", default=os.environ.get("SERVIM_HOST", "0.0.0.0"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("SERVIM_PORT", "8090")))
    ap.add_argument("--data", default=os.environ.get("SERVIM_DATA"), help="каталог задач и результатов")
    ap.add_argument("--model", default=os.environ.get("SERVIM_MODEL"), help="модель по умолчанию")
    ap.add_argument("--device", default=os.environ.get("SERVIM_DEVICE"), help="cuda | cpu")
    ap.add_argument("--compute-type", default=os.environ.get("SERVIM_COMPUTE_TYPE"),
                    help="float16 | int8_float16 | int8")
    a = ap.parse_args(argv)
    for key, val in (("SERVIM_DATA", a.data), ("SERVIM_MODEL", a.model),
                     ("SERVIM_DEVICE", a.device), ("SERVIM_COMPUTE_TYPE", a.compute_type)):
        if val:
            os.environ[key] = val
    if a.data:
        globals()["DATA_DIR"] = Path(a.data)
    uvicorn.run(app, host=a.host, port=a.port)


if __name__ == "__main__":
    main()
