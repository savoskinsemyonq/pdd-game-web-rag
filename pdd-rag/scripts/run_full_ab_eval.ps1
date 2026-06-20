# Full A/B RAG eval: reranker on/off × max_tokens 800/1536, RU RAGAS judge.
# Usage: powershell -File pdd-rag/scripts/run_full_ab_eval.ps1
$ErrorActionPreference = "Stop"
$Root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
if (-not (Test-Path "$Root\pdd-rag\.eval-venv\Scripts\python.exe")) {
  Write-Host "Create venv first: py -3.11 -m venv pdd-rag/.eval-venv"
  Write-Host "Then: pip install -e pdd-rag && pip install -r pdd-rag/requirements-eval.txt"
  exit 1
}

$Python = "$Root\pdd-rag\.eval-venv\Scripts\python.exe"
$Results = "$Root\pdd-rag\rag_eval\results"
New-Item -ItemType Directory -Force -Path $Results | Out-Null

$env:QDRANT_URL = "http://127.0.0.1:6333"
$env:LLM_PROVIDER = "gemini"
$env:RAGAS_LLM_PROVIDER = if ($env:RAGAS_LLM_PROVIDER) { $env:RAGAS_LLM_PROVIDER } else { "mistral" }
$env:RAGAS_PROMPT_LANG = if ($env:RAGAS_PROMPT_LANG) { $env:RAGAS_PROMPT_LANG } else { "ru" }
$env:RAG_EVAL_OUTPUT = $Results
$env:RAG_EVAL_SLEEP_SECS = if ($env:RAG_EVAL_SLEEP_SECS) { $env:RAG_EVAL_SLEEP_SECS } else { "5" }
$env:RAG_EVAL_TEMPERATURE = if ($env:RAG_EVAL_TEMPERATURE) { $env:RAG_EVAL_TEMPERATURE } else { "0.1" }
$env:RERANKER_THRESHOLD = if ($env:RERANKER_THRESHOLD) { $env:RERANKER_THRESHOLD } else { "0" }

Write-Host "=== Preflight ==="
curl.exe -sf http://127.0.0.1:6333/collections | Out-Null
curl.exe -sf http://localhost:8000/health

& $Python -m rag_eval.validate_dataset
Set-Location "$Root\pdd-rag"

$limit = if ($env:SMOKE_ONLY -eq "1") { @("--limit", "2") } else { @() }

function Run-Eval {
  param([string]$Reranker, [int]$MaxTokens, [string]$Suffix)
  $env:RAG_EVAL_MAX_TOKENS = "$MaxTokens"
  Write-Host "=== Run: reranker=$Reranker max_tokens=$MaxTokens ($Suffix) ==="
  & $Python -m rag_eval.run_ragas --with-generation --reranker $Reranker --output-suffix $Suffix @limit
}

Run-Eval -Reranker off -MaxTokens 800 -Suffix "no_reranker_t800"
Run-Eval -Reranker on -MaxTokens 800 -Suffix "with_reranker_t800"
Run-Eval -Reranker off -MaxTokens 1536 -Suffix "no_reranker_t1536"
Run-Eval -Reranker on -MaxTokens 1536 -Suffix "with_reranker_t1536"

Write-Host "=== Comparison ==="
& $Python "$Root\pdd-rag\scripts\compare_eval_results.py" $Results
