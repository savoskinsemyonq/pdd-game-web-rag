# Игра по правилам — веб-версия

Браузерный порт настольной обучающей игры по ПДД («Игра по правилам 2»). Все 9 миссий и 108 уникальных дорожных ситуаций берутся напрямую из приложенного `game_logic_dump.json`. Машины и пешеходы рисуются процедурно по таблице соответствий в [src/engine/AssetMap.ts](src/engine/AssetMap.ts). Фон города строится из `../map/city.map` (скрипт генерирует ассеты в `public/city/`).

## Стек

- **React 18** + **Vite** + **TypeScript** — UI и сборка.
- **HTML5 Canvas2D** — рендер игрового поля 800×600.
- **zustand** — небольшой стор для экранов и состояния миссии.

## Структура

```
web/
  scripts/build-data.ts           # ../game_logic_dump.json -> src/data/missions.json
  scripts/extract-city-map.mjs    # ../map/city.map -> public/city/city-bg.png + city-objects.json
  public/city/                    # стилизованная карта мира (npm run build:map), не оригинальные .GLt
  src/
    types.ts                      # Mission/Scene/Actor/Case/Spline/Turn
    data/missions.json            # сгенерированный игровой контент (9 миссий, 108 узлов)
    engine/
      Spline.ts                   # парсер SPLINE и Hermite-интерполяция
      Turn.ts                     # вспомогательные функции угла
      AssetMap.ts                 # имя_спрайта -> цвет/форма/размер
      Camera.ts                   # follow MY_CAR, world->screen
      Renderer.ts                 # карта города + декор + актёры
      SceneRunner.ts              # КА Approach/Question/Answering/ErrorPopup
      Game.ts                     # цикл RAF, склейка Renderer + SceneRunner
    state/gameStore.ts            # экраны, выбор миссии, прогресс в localStorage
    components/
      GameCanvas.tsx
      Hud.tsx
      QuestionPanel.tsx           # перетаскиваемое окно с вопросом, hotkey 1/2/3
      ErrorDialog.tsx             # модал с C_ERRORINFO (Esc/Enter/Space — закрыть)
      MainMenu.tsx, MissionSelect.tsx, MissionResult.tsx
    App.tsx, main.tsx, styles.css
  index.html
```

## Запуск

```bash
cd web
npm install
npm run build:data   # генерирует src/data/missions.json из ../game_logic_dump.json
npm run build:map    # генерирует public/city/city-bg.png и city-objects.json из ../map/city.map
npm run dev          # дев-сервер на http://127.0.0.1:5173
```

### Доступ через Cloudpub (внешняя ссылка)

1. Запустите `npm run dev` в каталоге `web`.
2. В Cloudpub пробросьте **порт 5173** (Vite; API `/api` проксируется на Express :3001 автоматически).
3. Откройте выданный URL вида `https://….cloudpub.ru` — хосты `*.cloudpub.ru` уже в `allowedHosts`.
4. Если hot-reload по туннелю не подключается, добавьте в `.env` (подставьте свой поддомен из Cloudpub):

   ```env
   VITE_TUNNEL_HOST=your-subdomain.cloudpub.ru
   VITE_TUNNEL_PORT=443
   ```

   Перезапустите `npm run dev`.

Прод-сборка:

```bash
npm run build
npm run preview
```

## Управление

- Миссия выбирается в меню. На каждом узле машина подъезжает по сплайну, потом появляется окно с вопросом.
- Вариант ответа выбирается **кликом по кнопке** (цифры на клавиатуре не используются).
- При неверном ответе всплывает окно инспектора. **Enter / Space / Esc** — закрыть, машина едет дальше.
- Окно с вопросом можно перетаскивать мышью за заголовок (как в оригинале).
- **Esc** в режиме игры — выход в меню.

## Админ-доступ к редакторам

In-game редакторы (карта, калибровка NPC, анимации, светофоры, composite-редактор) доступны **только залогиненным админам**. Гости и обычные пользователи их не видят и не могут открыть горячими клавишами.

Назначить админа можно двумя способами (достаточно одного):

1. **Переменная окружения** — добавьте логин в `.env` сервера:

   ```env
   ADMIN_LOGINS=admin,dev
   ```

2. **База данных** — после применения миграции из `server/db/schema.sql`:

   ```sql
   UPDATE users SET is_admin = true WHERE login = 'admin';
   ```

Флаг `is_admin` подхватывается при следующем запросе `/api/auth/me` (перезагрузка страницы или повторный вход). Для первого админа удобнее зарегистрировать аккаунт, затем указать его логин в `ADMIN_LOGINS` или выполнить SQL.

## Логика

- Источник истины — приложенный [game_logic_dump.json](../game_logic_dump.json). Скрипт `scripts/build-data.ts` приводит данные к удобной структуре, парсит строки `POSITION`, `SPLINE`, `turn`, `c_init`, `c_spline`, `fine`, `C_ERRORINFO` и сохраняет в `src/data/missions.json`.
- Правильный ответ определяется как первый `case` без `error_info`. Поле `derived.best_cases_by_min_fine` из дампа в этом проекте не используется (для ряда сцен оно даёт неверный ответ).
- 12 узлов имеют по два варианта (`0.script` / `1.script`); при входе в сцену случайно выбирается один.
- `MY_CAR` интерпретируется как «аватар игрока» — в зависимости от миссии это `our_car`, `our_car_y`, `taxi`, `ment` или `pedestrian1` (миссия 5 — пешеход).
- Длительность подъезда к сцене берётся как `max(splineDuration, scene.timeLimit)`, время на размышление — без ограничения (оригинал ставит игру на паузу при показе вопроса).

## Карта города

- Десктопный `map/city.map` (слой тайлов 192×192 по 64 px + объекты домов/светофоров) конвертируется в стилизованный фон **без** оригинальных текстур `.GLt`: газон / асфальт / тротуар по эвристике индексов тайлов. Декорации из дампа — упрощённые фигуры поверх фона.
- При отсутствии файлов в `public/city/` рендерер падает обратно на процедурную «бесконечную» сетку дорог.

## Что осознанно вне портации

- Распаковка `common.pak`, оригинальные спрайты и текстуры `.GLt` / звук / музыка / шрифты.
- Совместимый с оригиналом формат сейвов (`players/*.ini`). Лучшие штрафы хранятся в `localStorage` под ключом `pdd-web::progress`.
- Точная физика поворотов спрайта — поворот плейсхолдеров вычисляется по направлению движения вдоль сплайна.
- Кросс-сценная непрерывность — между сценами машина «телепортируется» в `POSITION` следующего узла. Это поведение оригинала на уровне данных: каждый узел задаёт свои координаты.
