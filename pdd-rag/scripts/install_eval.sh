#!/usr/bin/env bash
set -euo pipefail

echo "Upgrading pip..."
pip install --upgrade "pip==24.3.1" "packaging==24.2"

echo "Installing RAGAS core..."
pip install --no-cache-dir --no-deps "ragas==0.2.14"

echo "Installing langchain stack (pinned for ragas 0.2.14)..."
pip install --no-cache-dir \
  "langchain-core==0.3.66" \
  "langchain-openai==0.3.14" \
  "langchain-google-genai==2.0.11" \
  "langchain-groq==0.2.4" \
  "datasets==4.8.5" \
  "nest-asyncio" \
  "appdirs" \
  "diskcache" \
  "filetype" \
  "google-ai-generativelanguage>=0.6.16,<0.7.0"

python -c "import ragas; from langchain_google_genai import ChatGoogleGenerativeAI; from langchain_groq import ChatGroq; print('ragas', ragas.__version__, 'OK')"
