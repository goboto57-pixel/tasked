# AI Репетитор

Сайт-репетитор: ИИ (Mistral Small) даёт теорию и задания, **каждое следующее задание подстраивается под результат предыдущего**. Плавающая кнопка 🎙 — ИИ слушает тебя (Azure Speech распознавание) и отвечает голосом Fish Audio; Azure Speech используется как резерв. Учитель через дэшборд (логин/пароль) создаёт темы — они появляются в каталоге.

## Стек
- Node.js + Express (деплой на Render как Web Service, `render.yaml` приложен)
- PostgreSQL (бесплатно: [neon.tech](https://neon.tech) — Free Postgres, строку подключения в `DATABASE_URL`)
- Mistral Small (`mistral-small-latest`) — теория + адаптивные задания
- Fish Audio S2.1 Pro Free — основная озвучка, спокойный женский русский голос и двуязычный женский русский/казахский голос
- Azure Speech — резервная озвучка и распознавание речи ru-RU / kk-KZ
- Таблицы `teachers`, `topics`, `progress` создаются автоматически при старте

## Запуск локально
```bash
cp .env.example .env   # заполни ключи
npm install
npm start              # http://localhost:3000
```

## Деплой на Render
1. Бесплатная БД: создай проект на [neon.tech](https://neon.tech), скопируй Connection String.
2. Новый Web Service → подключи репозиторий (или используй `render.yaml` / Blueprint).
3. Environment: `DATABASE_URL`, `MISTRAL_API_KEY`, `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`, `SESSION_SECRET`, `ADMIN_PASSWORD` (initial creator account; choose a strong unique password).

## Страницы
- `/` — каталог тем + плавающая голосовая кнопка (свободный разговор с ИИ)
- `/lesson.html?topic=ID` — урок: теория → задания с адаптацией; 🎙 диктует ответ, ИИ отвечает голосом
- `/teacher.html` — вход/регистрация учителя, создание и удаление тем, прогресс учеников
