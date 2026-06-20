# Игра по правилам — веб-версия + RAG-ассистент по ПДД

Браузерный порт обучающей игры по ПДД («Игра по правилам 2»: 9 миссий, 108 дорожных
ситуаций) и сопутствующий RAG-ассистент, который отвечает на вопросы по Правилам
дорожного движения и штрафам и озвучивает ответы (TTS).

Репозиторий содержит **только то, что нужно для запуска**. Оригинальная настольная игра
(`Game.exe`, `*.pak`, текстуры, звук) в него осознанно не входит — источником игрового
контента служит сгенерированный `game_logic_dump.json` и карта `map/`.

## Архитектура

| Компонент | Технологии | Порт | Назначение |
|-----------|-----------|------|------------|
| `web/` (фронтенд) | React 18 + Vite + TS, Canvas2D, zustand | `5173` | UI игры, рендер миссий |
| `web/server/` (бэкенд) | Express 5, TS | `3001` | прокси к LLM/RAG/TTS, авторизация, профили |
| `pdd-rag/` (RAG API) | Python 3.11, FastAPI, sentence-transformers, Silero TTS | `8000` | поиск по ПДД/штрафам, генерация, озвучка |
| Qdrant | Docker-образ | `6333` | векторное хранилище |
| PostgreSQL 16 | Docker-образ | `5433` | пользователи, профили, логи |

Фронтенд и Express-сервер запускаются через `npm` (Node), а связка
Qdrant + PostgreSQL + RAG API поднимается через `docker-compose`.

## Требования

- **Docker** + **Docker Compose** (для RAG API, Qdrant, PostgreSQL).
- **Node.js 20+** и **npm** (для веб-части).
- API-ключ хотя бы одного LLM-провайдера: Gemini, Groq или Mistral.
- При первом `docker compose build` скачиваются ML-модели (эмбеддинги, реранкер, TTS) —
  это может занять время и трафик.

## Быстрый старт

### 1. Настройте окружение

```bash
cp web/.env.example web/.env
```

Откройте `web/.env` и заполните как минимум один ключ (`GEMINI_API_KEY`,
`GROQ_API_KEY` или `MISTRAL_API_KEY`). Значения `DATABASE_URL` и `RAG_API_URL`
уже указывают на сервисы из `docker-compose` (порты `5433` и `8000`).
Файл `web/.env` нужен и `docker-compose` (через `env_file`), и веб-серверу.

### 2. Поднимите бэкенд-сервисы

```bash
docker compose up -d --build
```

Поднимутся `qdrant`, `postgres` и `rag-api`. RAG API проиндексирует данные из
`полные_pdd.rtf` и `штрафы_ПДД.csv` (примонтированы в контейнер). Готовность:

```bash
curl http://localhost:8000/health
```

### 3. Запустите игру

**Из корня репозитория** (рекомендуется):

```bash
npm run dev
```

Или двойной клик по `start.bat` (Windows).

Первый раз (если ещё не ставили зависимости):

```bash
npm install          # установит web/node_modules
npm run build:data   # game_logic_dump.json -> web/src/data/missions.json
npm run dev
```

Альтернатива — вручную из `web/`:

```bash
cd web
npm install
npm run build:data
npm run dev
```

Откройте **http://127.0.0.1:5173**.

### Прод-сборка фронтенда

```bash
cd web
npm run build
npm run preview
```

## Структура репозитория

```
.
├─ docker-compose.yml        # qdrant + postgres + rag-api
├─ game_logic_dump.json      # источник игрового контента (9 миссий, 108 узлов)
├─ полные_pdd.rtf            # текст ПДД для RAG (монтируется в rag-api)
├─ штрафы_ПДД.csv            # таблица штрафов для RAG (монтируется в rag-api)
├─ map/                      # десктопная карта города (city.map и пр.) для build:map
├─ docs/                     # техническая документация по контенту ПДД
├─ web/                      # фронтенд (React/Vite) + Express-сервер
│  ├─ src/                   # движок игры, компоненты, состояние
│  ├─ server/                # API-прокси, авторизация, БД-схема
│  ├─ public/                # сгенерированные ассеты (city/, maps/, scenes/)
│  ├─ scripts/               # build-data, extract-city-map и пр.
│  └─ .env.example           # шаблон переменных окружения
└─ pdd-rag/                  # Python RAG API (FastAPI), Dockerfile, оценка качества
   ├─ api/ ingestion/ retrieval/ generation/ tts/
   ├─ rag_eval/              # данные и результаты оценки RAG
   └─ pyproject.toml
```

## Переменные окружения

Все настройки — в `web/.env` (см. подробные комментарии в `web/.env.example`):

- `GEMINI_API_KEY` / `GROQ_API_KEY` / `MISTRAL_API_KEY` — ключи LLM-провайдеров.
- `LLM_PROVIDER` — какой провайдер использовать по умолчанию.
- `DATABASE_URL` — строка подключения к PostgreSQL (по умолчанию порт `5433`).
- `RAG_API_URL` — адрес RAG API (по умолчанию `http://127.0.0.1:8000`).
- `JWT_SECRET` — секрет для токенов авторизации (**смените в проде**).
- `ADMIN_LOGINS` — логины с доступом к встроенным редакторам.

Файлы с реальными секретами (`web/.env`) в репозиторий не коммитятся (см. `.gitignore`).

## Что не входит в репозиторий

- Оригинальные файлы игры «Новый Диск» (`Game.exe`, `*.dll`, `*.pak`, исходные
  спрайты/текстуры/звук) — проприетарны и для запуска порта не нужны.
- `node_modules/`, сборки (`web/dist/`), Python-venv (`pdd-rag/.eval-venv/`),
  кэши моделей — устанавливаются/генерируются при сборке.
- Промежуточные артефакты пайплайна построения карт — оставлены только финальные
  атласы, composite-сцены и спрайты, реально используемые рантаймом.
