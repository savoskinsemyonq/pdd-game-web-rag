from __future__ import annotations

import os


def create_ragas_evaluator_llm():
    """Create LangChain LLM wrapper for RAGAS judge metrics."""
    from ragas.llms import LangchainLLMWrapper

    provider = os.environ.get("RAGAS_LLM_PROVIDER", "").lower()
    if not provider:
        if os.environ.get("MISTRAL_API_KEY"):
            provider = "mistral"
        elif os.environ.get("GROQ_API_KEY"):
            provider = "groq"
        elif os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY"):
            provider = "gemini"
        else:
            provider = "gemini"

    if provider == "gemini":
        try:
            from langchain_google_genai import ChatGoogleGenerativeAI
        except ImportError as exc:
            raise RuntimeError(
                "Для RAGAS с Gemini установите langchain-google-genai локально "
                "или используйте RAGAS_LLM_PROVIDER=mistral"
            ) from exc
        api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY is required for RAGAS evaluation")

        model = os.environ.get("RAGAS_GEMINI_MODEL", os.environ.get("GEMINI_MODEL", "gemini-2.0-flash"))
        return LangchainLLMWrapper(
            ChatGoogleGenerativeAI(model=model, google_api_key=api_key, temperature=0)
        )

    if provider == "groq":
        api_key = os.environ.get("GROQ_API_KEY")
        if not api_key:
            raise RuntimeError("GROQ_API_KEY is required for RAGAS evaluation")
        from langchain_groq import ChatGroq

        model = os.environ.get("RAGAS_GROQ_MODEL", os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile"))
        return LangchainLLMWrapper(ChatGroq(model=model, api_key=api_key, temperature=0))

    if provider == "mistral":
        api_key = os.environ.get("MISTRAL_API_KEY")
        if not api_key:
            raise RuntimeError("MISTRAL_API_KEY is required for RAGAS evaluation")
        from langchain_openai import ChatOpenAI

        model = os.environ.get("RAGAS_MISTRAL_MODEL", os.environ.get("MISTRAL_MODEL", "mistral-small-latest"))
        return LangchainLLMWrapper(
            ChatOpenAI(
                model=model,
                api_key=api_key,
                base_url="https://api.mistral.ai/v1",
                temperature=0,
            )
        )

    if provider == "openai":
        api_key = os.environ.get("OPENAI_API_KEY")
        if not api_key:
            raise RuntimeError("OPENAI_API_KEY is required for RAGAS evaluation")
        from langchain_openai import ChatOpenAI

        model = os.environ.get("RAGAS_OPENAI_MODEL", "gpt-4o-mini")
        return LangchainLLMWrapper(ChatOpenAI(model=model, api_key=api_key, temperature=0))

    raise RuntimeError(f"Unsupported RAGAS_LLM_PROVIDER: {provider}")


def create_ragas_evaluator_embeddings():
    """Reuse project embedding model for semantic similarity metric."""
    from ragas.embeddings import LangchainEmbeddingsWrapper
    from langchain_community.embeddings import HuggingFaceEmbeddings

    model_name = os.environ.get(
        "EMBEDDING_MODEL",
        "intfloat/multilingual-e5-base",
    )
    return LangchainEmbeddingsWrapper(
        HuggingFaceEmbeddings(
            model_name=model_name,
            encode_kwargs={"normalize_embeddings": True},
        )
    )
