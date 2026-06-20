> **Команда:** `python -m rag_eval.run_ragas` (не `eval` — это зарезервированное имя в Python).

Gold-датасет: `rag_eval/dataset.json` — 45 кейсов из миссий, чата и КоАП.

## Что измеряется

### Детерминированные метрики (без LLM)
- **paragraph_recall_at_k** — доля эталонных пунктов ПДД/КоАП, найденных в top-k
- **paragraph_precision_at_k** — доля retrieved chunks с нужным пунктом
- **paragraph_hit_rate** — доля кейсов, где найден хотя бы один эталонный пункт

### RAGAS (LLM-as-judge, нужен API key)
- **context_recall** — эталонный ответ покрыт retrieved context
- **faithfulness** — ответ не галлюцинирует относительно контекста
- **factual_correctness** — соответствие эталонному ответу

## Установка

```bash
cd pdd-rag
pip install -e ".[eval]"
```

## Подготовка

1. Запустите Qdrant и проиндексируйте ПДД:
   ```bash
   docker compose up -d qdrant rag-api
   ```
   или локально:
   ```bash
   python -m ingestion.pipeline
   ```

2. Проверьте, что эталонные пункты есть в Qdrant:
   ```bash
   python -m rag_eval.validate_dataset
   ```

3. RAGAS judge по умолчанию использует **Mistral** (`MISTRAL_API_KEY` из `web/.env`).
   Для Gemini: `RAGAS_LLM_PROVIDER=gemini` + `pip install langchain-google-genai` (может конфликтовать с google-genai в образе).

## Запуск

Только retrieval (быстро, без LLM):
```bash
python -m rag_eval.run_ragas --skip-ragas
```

Retrieval + RAGAS judge:
```bash
python -m rag_eval.run_ragas
```

С генерацией ответов пайплайна (faithfulness по реальным ответам):
```bash
python -m rag_eval.run_ragas --with-generation
```

Фильтры:
```bash
python -m rag_eval.run_ragas --category analyze --top-k 5 --limit 10 --skip-ragas
```

Отчёт сохраняется в `rag_eval/results/rag_eval_<timestamp>.json`.

## Docker (рекомендуется)

**Шаг 1.** Установить RAGAS в контейнер (один раз):

```bash
docker compose exec rag-api bash /app/scripts/install_eval.sh
```

Если `scripts/` не смонтирован — скопируйте и запустите:

```bash
docker cp pdd-rag/scripts/install_eval.sh pddv2-rag-api-1:/tmp/install_eval.sh
docker compose exec rag-api bash /tmp/install_eval.sh
```

**Шаг 2.** Запуск:

```bash
docker compose exec rag-api python -m rag_eval.validate_dataset
docker compose exec rag-api python -m rag_eval.run_ragas --skip-ragas
docker compose exec rag-api python -m rag_eval.run_ragas
```

RAGAS judge по умолчанию берёт **Mistral** (`MISTRAL_API_KEY` из `web/.env`).
Генерация ответов — **Gemini** (`LLM_PROVIDER=gemini`).

Если Groq/Gemini quota исчерпан для judge, явно задайте провайдера:
`RAGAS_LLM_PROVIDER=mistral` или `RAGAS_LLM_PROVIDER=gemini`.

Полный прогон: retrieval + генерация (Gemini) + RAGAS judge (Gemini). Локальный fallback (`pdd-rules.ts`) **не используется** — только Python `RagPipeline`.

```bash
# из корня репозитория (Git Bash / WSL)
bash pdd-rag/scripts/run_full_ab_eval.sh

# smoke (2 кейса на режим)
SMOKE_ONLY=1 bash pdd-rag/scripts/run_full_ab_eval.sh
```

Или вручную:

```bash
docker compose exec -e LLM_PROVIDER=gemini -e RAGAS_LLM_PROVIDER=gemini -e RAG_EVAL_OUTPUT=/tmp/rag_eval_results rag-api \
  python -m rag_eval.run_ragas --with-generation --reranker off

docker compose exec -e LLM_PROVIDER=gemini -e RAGAS_LLM_PROVIDER=gemini -e RAG_EVAL_OUTPUT=/tmp/rag_eval_results rag-api \
  python -m rag_eval.run_ragas --with-generation --reranker on
```

Отчёты: `/tmp/rag_eval_results/` в контейнере → `pdd-rag/rag_eval/results/` на хосте.

Сравнение:

```bash
python pdd-rag/scripts/compare_eval_results.py pdd-rag/rag_eval/results
```

## Baseline (e5-base, SKIP_RERANKER=1, top_k=5)

На gold-датасете из 45 кейсов (май 2026):

| Метрика | Значение |
|---------|----------|
| paragraph_recall_at_k | ~0.62 |
| paragraph_precision_at_k | ~0.18 |
| paragraph_hit_rate | ~0.67 |

Используйте отчёт `rag_eval/results/*.json` для A/B: reranker, top_k, модель эмбеддингов.

## Структура кейса

```json
{
  "id": "m2-2.2-special-signals-priority",
  "category": "analyze",
  "question": "...",
  "error_context": "...",
  "reference_paragraphs": ["3.2"],
  "ground_truth": "..."
}
```

- **analyze** — сценарий анализа ошибок (query + error_context, как в production)
- **chat** — вопрос пользователя без контекста ошибки
- **koap** — штрафы и статьи КоАП

## Переменные окружения

| Переменная | Назначение |
|------------|------------|
| `QDRANT_URL` | Адрес Qdrant (default `http://127.0.0.1:6333`) |
| `EMBEDDING_MODEL` | Модель эмбеддингов (default e5-base) |
| `SKIP_RERANKER` | `1` — без reranker (как в Docker) |
| `RAG_EVAL_TOP_K` | top_k для eval (default 5) |
| `RAGAS_LLM_PROVIDER` | LLM для judge-метрик (default mistral) |
| `RAGAS_PROMPT_LANG` | `ru` — русские промпты судьи (default), `en` — stock RAGAS |
| `RAG_EVAL_MAX_TOKENS` | Лимит генерации в eval (800 prod-parity, 1536 — без обрезки) |
| `RAG_EVAL_TEMPERATURE` | Температура генерации (default 0.1) |
| `RERANKER_THRESHOLD` | Порог reranker (0 для eval A/B) |
| `GEMINI_API_KEY` / `GROQ_API_KEY` / … | Ключ провайдера |

Полный прогон 4×45 кейсов (reranker × t800/t1536):

```powershell
powershell -File pdd-rag/scripts/run_full_ab_eval.ps1
```
