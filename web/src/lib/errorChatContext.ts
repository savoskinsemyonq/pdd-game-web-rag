import type { CaseAction, Scene } from "../types";

export function buildErrorChatContext(
  scene: Scene,
  nodeId: string,
  picked: CaseAction,
): string {
  const optionIdx = scene.cases.findIndex((c) => c.case === picked.case);
  const answer =
    optionIdx >= 0 && scene.questionOptions[optionIdx]
      ? scene.questionOptions[optionIdx]
      : `вариант ${picked.case}`;

  const lines = [
    `Сцена ${scene.sceneId} (узел ${nodeId}).`,
    `Вопрос: ${scene.questionTitle}`,
    `Ответ ученика: ${answer}`,
  ];
  if (picked.errorInfo) {
    lines.push(`Суть ошибки: ${picked.errorInfo}`);
  }
  return lines.join("\n");
}

export function buildErrorContextKey(
  nodeId: string,
  sceneId: string,
  pickedCase: number,
): string {
  return `${nodeId}:${sceneId}:${pickedCase}`;
}
