# Servim

**Self-hosted сервер транскрибации речи на базе [WhisperX](https://github.com/m-bain/whisperX):**
OpenAI-совместимый API, диаризацияспикеров, таймкоды слов, очередь задач и веб-интерфейс.
Один процесс, один GPU (или CPU), никаких внешних сервисов.

> TL;DR (EN): self-hosted WhisperX server — OpenAI-compatible `POST /v1/audio/transcriptions`,
> word-level timestamps, speaker diarization, a task queue and a small web UI. MIT.

```bash
git clone https://github.com/BotoVed/Servim.git && cd Servim
pip install -e .                       # зависимости: fastapi, uvicorn, whisperx
servim                                 # http://localhost:8090
```

```bash
curl -s -F file=@interview.mp3 -F model=whisper-1 -F diarize=true \
     http://localhost:8090/v1/audio/transcriptions | jq '.segments[:1]'
```

## Зачем ещё один Whisper-сервер

WhisperX сам по себе — CLI и библиотека: нет очереди, нет Rest API, нет нормального прогресса,
а каждая транскрибация заново поднимает модели в память. Servim оборачивает движок в сервис,
который держит модели загруженными, складывает задачи в очередь и отдаёт результат в десяти форматах.

| | WhisperX (CLI) | **Servim** |
|---|---|---|
| REST API, совместимый с OpenAI Audio | нет | `POST /v1/audio/transcriptions` |
| Очередь задач, прогресс, перезапуск | нет | есть, с переживанием рестарта |
| Веб-интерфейс | нет | есть (vanilla JS, без сборки) |
| Форматы на выходе | json/tsv/srt | 10 форматов + слова |
| Модель в памяти между запросами | нет | да |

## Возможности

* **Транскрибация** — faster-whisper (CT2): `large-v3` по умолчанию, `large-v3-turbo`, `distil-large-v3`,
  `medium`, `small`, `base`, `tiny`; автоопределение языка или явный `language`.
* **Таймкоды слов** — выравнивание wav2vec2/papka для ~80 языков, включая русский.
* **Диаризацияспикеров** — `pyannote/speaker-diarization-3.1` (нужен бесплатный токен Hugging Face).
  Границыспикеров склеиваются по интервалам, имяспикера можно переименовать — текст не меняется.
* **Веб-UI** — таблица задач с живым прогрессом, фильтры, выделение пакетных операций,
  скачивание результата, поиск и замена по расшифровке, переименованиеспикеров.
* **OpenAI-совместимость** — тот же контракт, что у `client.audio.transcriptions.create(...)`.
* **Метрики Prometheus** — `GET /metrics`.
* **Хранение на диске** — задачи и результаты лежат в `$SERVIM_DATA` и переживают перезапуск сервиса.

## Установка

Требования: Python ≥ 3.10. Для GPU — драйвер CUDA и `libpython3.x` для binary-сборки
[`faster-whisper`](https://github.com/SYSTRAN/faster-whisper) (ставится автоматически как зависимость WhisperX).

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -e .                      # fastapi + uvicorn + whisperx (тянет torch)
pip install "pyannote.audio>=3.1"    # только если нужна диаризация
```

`whisperx` — единственная тяжёлая зависимость (torch, ctranslate2); сама обёртка — один модуль
и три статических файла.

Запуск:

```bash
export HF_TOKEN=hf_...             # только для диаризации
servim --port 8090                 # или: python -m servim
```

Первый запрос скачает веса моделей в кэш Hugging Face (`large-v3` ≈ 3 ГБ).

### systemd

```ini
# /etc/systemd/system/servim.service
[Unit]
Description=Servim transcription server
After=network-online.target

[Service]
User=media
ExecStart=/opt/servim/.venv/bin/servim
Environment=SERVIM_DATA=/var/lib/servim
Environment=HF_TOKEN=hf_...
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## Конфигурация (переменные окружения)

| Переменная | По умолчанию | Значение |
|---|---|---|
| `SERVIM_DATA` | `./servim-data` | каталог задач, результатов и временных файлов |
| `SERVIM_MODEL` | `large-v3` | модель по умолчанию |
| `SERVIM_DEVICE` | `cuda` | `cuda` или `cpu` |
| `SERVIM_COMPUTE_TYPE` | `float16` | `float16`, `int8_float16`, `int8` (для CPU) |
| `SERVIM_HOST` / `SERVIM_PORT` | `0.0.0.0` / `8090` | адрес сервиса |
| `SERVIM_MAX_UPLOAD_MB` | `2048` | лимит размера загружаемого файла |
| `SERVIM_KEEP_JOBS` | `200` | сколько старых задач хранить |
| `HF_TOKEN` | — | токен Hugging Face для диаризации |
| `HUGGINGFACE_HUB_CACHE` | `~/.cache/huggingface/hub` | кэш весов (для списка моделей) |

## API

| Метод | Назначение |
|---|---|
| `POST /v1/audio/transcriptions` | OpenAI-совместимая транскрибация загруженного файла |
| `GET  /v1/models`, `GET /v1/audio/models` | список моделей (вторая — с признаком «весы в кэше») |
| `POST /jobs` | поставить файл в очередь (`start=false` — только зарегистрировать) |
| `GET  /jobs`, `GET /jobs/{id}` | список задач /детали одной задачи |
| `GET  /jobs/{id}/result?format=` | результат в выбранном формате |
| `PUT  /jobs/{id}/speakers` | переименоватьспикеров (`{"A":"Иван"}`) |
| `POST /queue/start`, `POST /queue/pause`, `GET /queue` | управление очередью |
| `GET  /health`, `GET /metrics` | состояние сервиса, метрики Prometheus |

Полная схема — `GET /openapi.json`, интерфейс — `http://<host>:8090/docs`.

### Форматы ответа

`json` · `verbose_json` (со словами) · `diarized_json` · `text` · `txt` · `srt` · `vtt` · `tsv` · `md`.

Отдельно `stxt` — наш собственном диалект «одна строка на сегмент» (`Start:/End:/Line:`); это **не**
распространённый формат, ни один внешний плеер его не читает.

В субтитрные форматы (`srt`, `vtt`) и в `md` именаспикеров попадают в виде префикса строки —
`[Иван] текст`. В `tsv` появилась колонка `speaker`. В `json`/`verbose_json`спикер остаётся меткой
`A`/`B` — это поле контракта OpenAI, имена дополнительно выносятся отдельно, чтобы не ломать разбор у клиентов.

## OpenAI-совместимость

Реализовано: `file`, `model` (`whisper-1` → модель по умолчанию), `language`, `prompt`, `temperature`,
`response_format` (`json`, `text`, `srt`, `vtt`, `verbose_json`), `timestamp_granularities` (`word`, `segment`).

Наши расширения, которые валидные OpenAI-клиенты проигнорируют: `diarize`, `vad_filter`, `beam_size`,
`min_speakers`, `max_speakers`, `num_speakers`, `word_timestamps`, `known_speaker_names`.

## Ограничения

* Один экземпляр сервиса = одна модель в памяти; конкурентность — очередь, а не параллельные прогоны.
* Диаризация требует токен Hugging Face и принятия условий модели `pyannote/speaker-diarization-3.1`.
* Сервис поднимает `0.0.0.0` — аутентификации нет, ставьте за реверс-прокси или в доверенную сеть.
* Загруженные файлы и результаты хранятся на диске в `$SERVIM_DATA` (исходное аудио удаляется после обработки).
* Whisper и модели диаризации распространяются под собственными лицензиями — проверьте их перед
  коммерческим использованием; этот репозиторий лицензирует только код обёртки и интерфейса.

## Лицензия

MIT — см. [LICENSE](LICENSE).
