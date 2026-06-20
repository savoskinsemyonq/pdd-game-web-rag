import assert from "node:assert/strict";
import { resolveTopicTitle } from "../src/utils/reviewPlan.js";

function expectTitle(
  label: string,
  options: Parameters<typeof resolveTopicTitle>[0],
  expected: string,
) {
  const actual = resolveTopicTitle(options);
  assert.equal(actual, expected, `${label}: expected "${expected}", got "${actual}"`);
}

expectTitle("2.2 проблесковый + п. 3.2", {
  ruleKey: "3.2",
  displayRef: "п. 3.2",
  sampleError: "Автомобиль с включенным проблесковым маячком (п. 3.2). Штраф 500 руб.",
  missionId: "mission2",
  sceneId: "2.2",
}, "Спецсигналы и уступание");

expectTitle("2.4 минимальная скорость из текста ошибки", {
  ruleKey: "text:этот знак вводит ограничения",
  displayRef: "ПДД",
  sampleError: "Этот знак вводит ограничения на минимальную скорость 50 км/ч, значит вы должны ехать не медленнее.",
  missionId: "mission2",
  sceneId: "2.4",
}, "Минимальная скорость");

expectTitle("2.4 короткая ошибка + questionTitle", {
  ruleKey: "text:этот знак вводит ограничения",
  displayRef: "ПДД",
  sampleError: "Этот знак вводит ограничения — ПДД",
  missionId: "mission2",
  sceneId: "2.4",
}, "Выбор скорости");

expectTitle("2.9 скорость вне НП + п. 10.3", {
  ruleKey: "10.3",
  displayRef: "п. 10.3",
  sampleError: "Вне населенного пункта разрешено двигаться со скоростью не более 90 км/ч (п. 10.3).",
  missionId: "mission2",
  sceneId: "2.9",
}, "Скорость вне населённого пункта");

expectTitle("2.10 разметка + приложение 2", {
  ruleKey: "app:2",
  displayRef: "Приложение 2",
  sampleError: "При данной разметке обгон запрещен (Приложение 2). Штраф 7500 руб.",
  missionId: "mission2",
  sceneId: "2.10",
}, "Дорожная разметка");

console.log("review-plan-titles: all tests passed");
