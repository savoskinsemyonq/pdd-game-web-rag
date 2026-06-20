FROM python:3.11-slim

WORKDIR /app

ENV TORCH_HOME=/root/.cache/torch
ENV HF_HOME=/root/.cache/huggingface

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential curl git \
    && rm -rf /var/lib/apt/lists/* \
    && python -m pip install --upgrade "pip==25.3" "packaging>=24.2" wheel setuptools

COPY pyproject.toml ./
RUN pip install --no-cache-dir .

COPY . .
RUN pip install --no-cache-dir --no-deps .

ENV SILERO_MODEL_DIR=/root/.cache/silero
RUN mkdir -p /root/.cache/silero && \
    curl -fsSL --retry 5 --retry-delay 3 \
      -o /root/.cache/silero/v4_ru.pt \
      https://models.silero.ai/models/tts/ru/v4_ru.pt

RUN python scripts/preload_tts.py

RUN pip install --upgrade "pip==24.3.1" "packaging==24.2"

COPY requirements-eval.txt ./
RUN pip install --no-cache-dir --no-deps ragas==0.2.14 && \
    pip install --no-cache-dir -r requirements-eval.txt

EXPOSE 8000

CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000"]
