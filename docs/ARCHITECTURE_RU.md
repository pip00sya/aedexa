# Устройство AEDEXA

Приложение на `vinext` (React Server Components поверх Vite). Разворачивается одним
воркером Cloudflare: сервер — `worker/index.ts`, статика — `dist/client`.

## Путь чертежа

1. DWG или DXF читается в браузере. `app/lib/cad` поднимает LibreDWG (WASM) в web
   worker и собирает сущности по слоям.
2. `app/lib/cad/classification.ts` определяет тип документа: топосъёмка, генплан,
   здание или узел.
3. Для участка `app/lib/placement` строит границу, зоны сетей, отступы и пятно
   застройки, `terrain.ts` — рельеф.
4. Результат показывается в `PlacementWorkspace`, лист СПОЗУ выгружается через
   `dxfAdapter.ts`, объекты сохраняются в браузере.

Режим 2D → 3D работает на сервере: `app/lib/reconstruction/server` собирает контекст
и вызывает модель, `buildingSolver.ts` строит геометрию. Серверный ключ нужен только
этому режиму.

## Папки

| Путь | Что там |
|---|---|
| `app/components/AedexaApp.tsx` | Шапка и переключение режимов |
| `app/components/placement/PlacementWorkspace.tsx` | Посадка и открытие сохранённого объекта |
| `app/components/CadProcessingView.tsx` | Топосъёмка |
| `app/components/ReconstructionWorkspace.tsx` | Реконструкция на клиенте |
| `app/lib/geometry` | Общая геометрия |
| `app/lib/placement` | Граница, зоны, нормы, варианты посадки, рельеф |
| `app/lib/cad` | Чтение DWG, классификация, поверхности, экспорт |
| `app/lib/reconstruction` | Модель, схемы, решатель |
| `app/lib/reconstruction/server` | Серверная часть реконструкции |
| `app/lib/norms` | Реестр норм |
| `app/api` | HTTP-маршруты |
| `worker` | Точка входа Cloudflare |
| `tests`, `scripts` | Тесты и служебные скрипты |

Правило без подтверждённого основания получает `MISSING_DATA` или `EXPERT_REVIEW`,
но не `PASS`.

## Проверки

`npm run check` — типы, ESLint, форматирование, сборка и тесты.

Прогон по набору чертежей (папка `fixtures/drawings` в репозиторий не входит, три
примера лежат в `judges/`):

```bash
npm run check:drawings -- fixtures/drawings
```
