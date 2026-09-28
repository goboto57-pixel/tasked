# AI Репетитор

Сайт-репетитор: ИИ (Mistral Small) даёт теорию и задания, **каждое следующее задание подстраивается под результат предыдущего**. Плавающая кнопка 🎙 — ИИ слушает тебя (Azure Speech распознавание) и отвечает голосом Fish Audio; Azure Speech используется как резерв. Учитель через дэшборд (логин/пароль) создаёт темы — они появляются в каталоге.

## Стек
- Node.js + Express (деплой на Render как Web Service, `render.yaml` приложен)
- PostgreSQL (бесплатно: [neon.tech](https://neon.tech) — Free Postgres, строку подключения в `DATABASE_URL`)
- Gemini 3.8 Flash — короткие блоки теории, адаптивные задания разных интерактивных форматов и голосовой помощник
- Gemini 3.1 Flash Image — тематические иллюстрации к объяснению и текущему заданию
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
3. Environment: `DATABASE_URL`, `GEMINI_API_KEY`, `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`, `SESSION_SECRET`, `ADMIN_PASSWORD` (initial creator account; choose a strong unique password).

### Student sign-in (Firebase Authentication)

Students sign in with Google or a one-time email code. For Google, create a Firebase project, enable Google under Authentication providers, add the app domain (plus `localhost` for development) to authorized domains, and set `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID`, `FIREBASE_APP_ID`, and the private Admin SDK service-account JSON in `FIREBASE_SERVICE_ACCOUNT`. For email codes, create a Brevo account, verify the sender address, and set `BREVO_API_KEY`, `BREVO_SENDER_EMAIL`, and optionally `BREVO_SENDER_NAME`. Codes expire after 10 minutes; resend cooldown and daily abuse limits are enforced by the app. Brevo's free plan currently includes 300 sends per day. The server creates a verified Firebase account only after the code is confirmed, so Google and code sign-in share the same account. Until Firebase and Brevo are configured, student lessons and AI endpoints stay locked. Legacy student password endpoints are disabled; teacher/admin dashboard credentials remain separate.

Gemini text requests may use the free tier when the selected model and project quota allow it. Image generation with `gemini-3.1-flash-image` is paid-tier only and is opt-in (`GEMINI_IMAGE_ENABLED=true`); leave it off on a free-only key.

## Страницы
- `/` — каталог тем + плавающая голосовая кнопка (свободный разговор с ИИ)
- `/lesson.html?topic=ID` — урок: теория → задания с адаптацией; 🎙 диктует ответ, ИИ отвечает голосом
- `/teacher.html` — вход/регистрация учителя, создание и удаление тем, прогресс учеников
