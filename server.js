require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
    ? { rejectUnauthorized: false }
    : false,
});

// ---------- schema ----------
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS teachers (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS topics (
      id SERIAL PRIMARY KEY,
      teacher_id INT REFERENCES teachers(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS progress (
      id SERIAL PRIMARY KEY,
      topic_id INT REFERENCES topics(id) ON DELETE CASCADE,
      student_key TEXT NOT NULL,
      history JSONB DEFAULT '[]'::jsonb,
      score INT DEFAULT 0,
      attempts INT DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE (topic_id, student_key)
    );
  `);
}
initDb().catch((e) => { console.error('DB init failed', e); process.exit(1); });

// ---------- helpers ----------
const sign = (v) => Buffer.from(JSON.stringify(v)).toString('base64url') + '.' +
  require('crypto').createHmac('sha256', process.env.SESSION_SECRET || 'dev-secret')
    .update(Buffer.from(JSON.stringify(v)).toString('base64url')).digest('base64url');

function verify(token) {
  if (!token || !token.includes('.')) return null;
  const [b, h] = token.split('.');
  const expect = require('crypto').createHmac('sha256', process.env.SESSION_SECRET || 'dev-secret')
    .update(b).digest('base64url');
  return h === expect ? JSON.parse(Buffer.from(b, 'base64url').toString()) : null;
}

function authTeacher(req, res, next) {
  const t = verify(req.cookies.session);
  if (!t || !t.teacherId) return res.status(401).json({ error: 'unauthorized' });
  req.teacherId = t.teacherId;
  next();
}

// ---------- auth ----------
app.post('/api/auth/register', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password || password.length < 4)
    return res.status(400).json({ error: 'Нужны email и пароль (от 4 символов)' });
  const hash = await bcrypt.hash(password, 10);
  try {
    const r = await pool.query(
      'INSERT INTO teachers (email, password_hash) VALUES ($1,$2) RETURNING id, email',
      [email.toLowerCase(), hash]);
    res.cookie('session', sign({ teacherId: r.rows[0].id }), { httpOnly: true, sameSite: 'lax' });
    res.json({ ok: true });
  } catch {
    res.status(409).json({ error: 'Такой email уже зарегистрирован' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  const r = await pool.query('SELECT * FROM teachers WHERE email=$1', [(email || '').toLowerCase()]);
  const t = r.rows[0];
  if (!t || !(await bcrypt.compare(password || '', t.password_hash)))
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  res.cookie('session', sign({ teacherId: t.id }), { httpOnly: true, sameSite: 'lax' });
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => { res.clearCookie('session'); res.json({ ok: true }); });
app.get('/api/auth/me', authTeacher, (req, res) => res.json({ ok: true }));

// ---------- topics ----------
app.get('/api/topics', async (req, res) => {
  const r = await pool.query('SELECT id, title, description, created_at FROM topics ORDER BY created_at DESC');
  res.json(r.rows);
});

app.post('/api/topics', authTeacher, async (req, res) => {
  const { title, description } = req.body || {};
  if (!title) return res.status(400).json({ error: 'Нужно название темы' });
  const r = await pool.query(
    'INSERT INTO topics (teacher_id, title, description) VALUES ($1,$2,$3) RETURNING *',
    [req.teacherId, title, description || '']);
  res.json(r.rows[0]);
});

app.delete('/api/topics/:id', authTeacher, async (req, res) => {
  await pool.query('DELETE FROM topics WHERE id=$1 AND teacher_id=$2', [req.params.id, req.teacherId]);
  res.json({ ok: true });
});

// teacher: student progress for own topics
app.get('/api/teacher/progress', authTeacher, async (req, res) => {
  const r = await pool.query(`
    SELECT t.title, p.student_key, p.score, p.attempts, p.updated_at
    FROM progress p JOIN topics t ON t.id = p.topic_id
    WHERE t.teacher_id = $1 ORDER BY p.updated_at DESC LIMIT 200`, [req.teacherId]);
  res.json(r.rows);
});

// ---------- Mistral AI ----------
const MISTRAL_MODEL = process.env.MISTRAL_MODEL || 'ministral-14b-latest';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function mistralChat(body) {
  const models = [MISTRAL_MODEL, 'ministral-8b-latest'];
  let lastErr;
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const resp = await fetch('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.MISTRAL_API_KEY}`,
        },
        body: JSON.stringify({ ...body, model, max_tokens: body.max_tokens || 700 }),
      });
      if (resp.ok) {
        const data = await resp.json();
        return data.choices[0].message.content;
      }
      lastErr = new Error(`Mistral API ${resp.status}: ${await resp.text()}`);
      const retryable = resp.status === 429 || resp.status >= 500;
      if (!retryable) throw lastErr;
      await sleep(1000 * (attempt + 1));
    }
  }
  throw lastErr;
}

async function mistral(messages) {
  const content = await mistralChat({
    messages,
    temperature: 0.4,
    response_format: { type: 'json_object' },
  });
  return JSON.parse(content);
}

const SYSTEM = `Ты — добрый, поддерживающий учитель-репетитор. Работай СТРОГО на русском языке, простыми словами.

ТЕОРИЯ: при первом ходе объясни тему коротко (5-8 предложений), с бытовым примером, без сложных терминов.

ЗАДАНИЯ — давай ПО ОДНОМУ и соблюдай правила:
• Задание должно быть конкретным и иметь ОДНОЗНАЧНЫЙ короткий ответ (число, слово, дата, выбор варианта). Не давай "объясните своими словами", "приведите примеры" — такие ответы невозможно проверить.
• Начинай с ОЧЕНЬ простых заданий (уровень 5 класса, устный счёт). Уровень повышай ТОЛЬКО если ученик отвечает верно, и повышай медленно — на полшага.
• Не задавай несколько вопросов в одном задании.

ПРОВЕРКА ОТВЕТА — будь лояльным:
• Засчитывай ответ верным, если он правильный ПО СМЫСЛУ: другая форма записи (2/4 = 0.5 = 1/2), опечатка, без единиц измерения, с лишней вежливостью — всё это ПРАВИЛЬНЫЙ ответ.
• При неполной ошибке не объявляй "неверно" сразу: сделай наводящую подсказку в feedback и оставь correct=false только при явной ошибке.
• feedback — всегда доброжелательный: сначала похвала за то, что получилось, потом мягкое объяснение ошибки. Никогда не пиши "тупо", "неправильно поняли" и т.п.

ЗАВЕРШЕНИЕ УРОКА: если ученик ответил верно 5 раз подряд (или очевидно уверенно владеет темой) — заверши урок: поставь task = "" и напиши в feedback тёплую итоговую похвалу с мини-резюме того, чему он научился. После завершения урок не давай новых заданий.

АДАПТАЦИЯ: каждое следующее задание подстраивайся под предыдущий ответ: ошибка → проще на то же слабое место + объяснение; верно → чуть сложнее (максимум на один уровень).

Ты отвечаешь ИСКЛЮЧИТЕЛЬНО валидным JSON вида:
{
  "theory": "краткое объяснение темы (только при первом ходе, иначе пустая строка)",
  "feedback": "комментарий по предыдущему ответу ученика, '' если это самое начало",
  "task": "текст нового задания (пустая строка, если урок завершён)",
  "correct": true | false | null
}
Поле "correct" — результат ПРЕДЫДУЩЕГО ответа ученика (true/false), в самом первом ходе null.`;

app.post('/api/ai/turn', async (req, res) => {
  const { topicId, studentKey, answer } = req.body || {};
  if (!topicId || !studentKey) return res.status(400).json({ error: 'topicId и studentKey обязательны' });

  const topic = (await pool.query('SELECT * FROM topics WHERE id=$1', [topicId])).rows[0];
  if (!topic) return res.status(404).json({ error: 'Тема не найдена' });

  let prog = (await pool.query('SELECT * FROM progress WHERE topic_id=$1 AND student_key=$2', [topicId, studentKey])).rows[0];
  if (!prog) {
    prog = (await pool.query(
      'INSERT INTO progress (topic_id, student_key, history) VALUES ($1,$2,$3::jsonb) RETURNING *',
      [topicId, studentKey, '[]'])).rows[0];
  }

  const history = prog.history || [];
  if (answer) {
    history.push({ role: 'student', text: String(answer).slice(0, 2000) });
  }

  // how many correct answers in a row the student currently has
  let streak = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.role !== 'teacher') break;
    try { const j = JSON.parse(h.text); if (j.correct === true) streak++; else break; } catch { break; }
  }

  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `Тема урока: «${topic.title}». ${topic.description ? 'Описание от учителя: ' + topic.description : ''}\nВерных ответов подряд: ${streak}.${streak >= 5 ? ' Ученик уверенно освоил тему — ЗАВЕРШИ урок (task = "", тёплая итоговая похвала в feedback).' : ''}\n\nИстория диалога (включая твой последний ответ и новый ответ ученика, если он есть):\n${JSON.stringify(history.slice(-10), null, 2)}\n\nДай JSON-ответ.` },
  ];

  try {
    const ai = await mistral(messages);
    history.push({ role: 'teacher', text: JSON.stringify(ai) });
    const score = history.filter(h => h.role === 'teacher').length;
    await pool.query('UPDATE progress SET history=$1::jsonb, score=$2, attempts=attempts+1, updated_at=now() WHERE id=$3',
      [JSON.stringify(history.slice(-40)), score, prog.id]);
    res.json(ai);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка ИИ: ' + e.message });
  }
});

// free voice chat (floating button on any page)
app.post('/api/ai/voice', async (req, res) => {
  const { topic, history } = req.body || {};
  try {
    const reply = await mistralChat({
      temperature: 0.5,
      messages: [
        { role: 'system', content: 'Ты — добрый учитель-репетитор. Отвечай на русском, коротко и понятно, 2-4 предложения, разговорным стилем (тебя слушают голосом).' },
        { role: 'user', content: `Тема разговора: «${topic || 'свободная беседа об учёбе'}».\nИстория диалога:\n${JSON.stringify(history || [], null, 2)}` },
      ],
    });
    res.json({ reply });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Azure Speech config (frontend SDK) ----------
app.get('/api/speech/config', (req, res) => {
  res.json({
    key: process.env.AZURE_SPEECH_KEY || '',
    region: process.env.AZURE_SPEECH_REGION || '',
    voice: process.env.AZURE_SPEECH_VOICE || 'ru-RU-SvetlanaNeural',
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AI Teacher on :${PORT}`));
