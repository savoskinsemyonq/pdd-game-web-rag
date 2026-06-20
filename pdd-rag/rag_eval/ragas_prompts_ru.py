"""Russian RAGAS judge prompts for PDD evaluation (adapted from stock ragas 0.2.x)."""
from __future__ import annotations

from dataclasses import dataclass

from ragas.metrics import FactualCorrectness, Faithfulness, LLMContextRecall
from ragas.metrics._context_recall import (
    ContextRecallClassification,
    ContextRecallClassificationPrompt,
    ContextRecallClassifications,
    QCA,
)
from ragas.metrics._faithfulness import (
    NLIStatementInput,
    NLIStatementOutput,
    NLIStatementPrompt,
    StatementFaithfulnessAnswer,
    StatementGeneratorInput,
    StatementGeneratorOutput,
    StatementGeneratorPrompt,
)
from ragas.metrics._factual_correctness import (
    ClaimDecompositionInput,
    ClaimDecompositionOutput,
    ClaimDecompositionPrompt,
    DecompositionType,
)


class RuStatementGeneratorPrompt(StatementGeneratorPrompt):
    instruction = (
        "Дан вопрос и ответ. Разбей каждое предложение ответа на одно или несколько "
        "самостоятельных утверждений, понятных без контекста. Не используй местоимения "
        "без явного указания субъекта. Верни результат в JSON."
    )
    examples = [
        (
            StatementGeneratorInput(
                question="Нужно ли уступить дорогу автомобилю с проблесковым маячком и сиреной?",
                answer=(
                    "Да, вы обязаны уступить дорогу. При приближении транспортного средства "
                    "с включённым проблесковым маячком и специальным звуковым сигналом "
                    "водитель должен уступить дорогу."
                ),
            ),
            StatementGeneratorOutput(
                statements=[
                    "Водитель обязан уступить дорогу транспортному средству с включённым проблесковым маячком и специальным звуковым сигналом.",
                    "При приближении такого транспортного средства водитель должен уступить дорогу.",
                ]
            ),
        )
    ]


class RuNLIStatementPrompt(NLIStatementPrompt):
    instruction = (
        "Оцени достоверность каждого утверждения относительно заданного контекста. "
        "Для каждого утверждения верни verdict: 1, если утверждение напрямую следует из контекста, "
        "или 0, если из контекста его напрямую не следует. Укажи reason на русском."
    )
    examples = [
        (
            NLIStatementInput(
                context=(
                    "13. Проезд перекрёстков\n\n13.9. На перекрёстке неравнозначных дорог водитель "
                    "транспортного средства, движущегося по второстепенной дороге, должен уступить "
                    "дорогу транспортным средствам, движущимся по главной дороге."
                ),
                statements=[
                    "На нерегулируемом перекрёстке уступает тот, кто движется по второстепенной дороге.",
                    "На перекрёстке всегда уступает тот, кто поворачивает налево.",
                    "Водитель на второстепенной дороге обязан уступить дорогу на главной.",
                ],
            ),
            NLIStatementOutput(
                statements=[
                    StatementFaithfulnessAnswer(
                        statement="На нерегулируемом перекрёстке уступает тот, кто движется по второстепенной дороге.",
                        reason="Контекст прямо указывает, что водитель на второстепенной дороге уступает движущимся по главной.",
                        verdict=1,
                    ),
                    StatementFaithfulnessAnswer(
                        statement="На перекрёстке всегда уступает тот, кто поворачивает налево.",
                        reason="В контексте нет правила про поворот налево.",
                        verdict=0,
                    ),
                    StatementFaithfulnessAnswer(
                        statement="Водитель на второстепенной дороге обязан уступить дорогу на главной.",
                        reason="Это прямо следует из п. 13.9 в контексте.",
                        verdict=1,
                    ),
                ]
            ),
        ),
    ]


class RuContextRecallClassificationPrompt(ContextRecallClassificationPrompt):
    name = "context_recall_classification_ru"
    instruction = (
        "Дан контекст и эталонный ответ. Разбери каждое предложение ответа и определи, "
        "можно ли его обосновать контекстом. Используй только бинарную классификацию: "
        "1 (да) или 0 (нет). Верни JSON с полем reason на русском."
    )
    examples = [
        (
            QCA(
                question="Какая максимальная скорость в населённом пункте?",
                context=(
                    "10. Скорость движения\n\n10.2. В населённых пунктах разрешается движение "
                    "транспортных средств со скоростью не более 60 км/ч."
                ),
                answer=(
                    "В населённом пункте максимальная скорость — 60 км/ч. "
                    "За превышение предусмотрен штраф по КоАП. "
                    "На автомагистрали в городе действует лимит 90 км/ч."
                ),
            ),
            ContextRecallClassifications(
                classifications=[
                    ContextRecallClassification(
                        statement="В населённом пункте максимальная скорость — 60 км/ч.",
                        reason="Прямо указано в п. 10.2 контекста.",
                        attributed=1,
                    ),
                    ContextRecallClassification(
                        statement="За превышение предусмотрен штраф по КоАП.",
                        reason="В контексте нет информации о штрафах.",
                        attributed=0,
                    ),
                    ContextRecallClassification(
                        statement="На автомагистрали в городе действует лимит 90 км/ч.",
                        reason="Контекст не упоминает автомагистрали и лимит 90 км/ч.",
                        attributed=0,
                    ),
                ]
            ),
        ),
    ]


class RuClaimDecompositionPrompt(ClaimDecompositionPrompt):
    instruction = (
        "Разбей каждое предложение входного текста на одно или несколько самостоятельных "
        "утверждений, которые можно проверить отдельно. Следуй уровню детализации (atomicity "
        "и coverage), показанному в примерах."
    )


def _ru_claim_decomposition_examples() -> dict:
    """PDD-themed Russian examples for all decomposition types."""
    pdd_input = ClaimDecompositionInput(
        response=(
            "На нерегулируемом перекрёстке уступает водитель на второстепенной дороге. "
            "За проезд на красный свет предусмотрен штраф."
        )
    )
    return {
        DecompositionType.LOW_ATOMICITY_LOW_COVERAGE: [
            (
                pdd_input,
                ClaimDecompositionOutput(
                    claims=[
                        "На нерегулируемом перекрёстке уступает водитель на второстепенной дороге.",
                    ]
                ),
            )
        ],
        DecompositionType.LOW_ATOMICITY_HIGH_COVERAGE: [
            (
                pdd_input,
                ClaimDecompositionOutput(
                    claims=[
                        "На нерегулируемом перекрёстке уступает водитель на второстепенной дороге.",
                        "За проезд на красный свет предусмотрен штраф.",
                    ]
                ),
            )
        ],
        DecompositionType.HIGH_ATOMICITY_LOW_COVERAGE: [
            (
                pdd_input,
                ClaimDecompositionOutput(
                    claims=[
                        "На нерегулируемом перекрёстке уступает водитель на второстепенной дороге.",
                    ]
                ),
            )
        ],
        DecompositionType.HIGH_ATOMICITY_HIGH_COVERAGE: [
            (
                pdd_input,
                ClaimDecompositionOutput(
                    claims=[
                        "На нерегулируемом перекрёстке уступает водитель на второстепенной дороге.",
                        "За проезд на красный свет предусмотрен штраф.",
                    ]
                ),
            )
        ],
    }


@dataclass
class RuFactualCorrectness(FactualCorrectness):
    """FactualCorrectness without stock English few-shot injection."""

    def __post_init__(self):
        if type(self.beta) is not float:
            raise ValueError(
                "Beta must be a float. A beta > 1 gives more weight to recall, "
                "while beta < 1 favors precision."
            )


def build_ragas_metrics(evaluator_llm, *, lang: str = "ru"):
    """Return RAGAS metric instances with optional Russian judge prompts."""
    if lang == "en":
        return [
            LLMContextRecall(llm=evaluator_llm),
            Faithfulness(llm=evaluator_llm),
            FactualCorrectness(llm=evaluator_llm),
        ]

    ru_nli = RuNLIStatementPrompt()
    ru_claim = RuClaimDecompositionPrompt()
    for item in DecompositionType:
        ru_claim.examples.extend(_ru_claim_decomposition_examples()[item])

    return [
        LLMContextRecall(
            llm=evaluator_llm,
            context_recall_prompt=RuContextRecallClassificationPrompt(),
        ),
        Faithfulness(
            llm=evaluator_llm,
            nli_statements_prompt=ru_nli,
            statement_generator_prompt=RuStatementGeneratorPrompt(),
        ),
        RuFactualCorrectness(
            llm=evaluator_llm,
            claim_decomposition_prompt=ru_claim,
            nli_prompt=ru_nli,
            language="russian",
        ),
    ]
