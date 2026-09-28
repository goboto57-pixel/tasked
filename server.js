require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
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
      email TEXT UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS students (
      id SERIAL PRIMARY KEY,
      login TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT DEFAULT '',
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
  // light migrations for existing installs
  await pool.query(`ALTER TABLE teachers ADD COLUMN IF NOT EXISTS login TEXT UNIQUE`);
  await pool.query(`ALTER TABLE teachers ADD COLUMN IF NOT EXISTS display_name TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE teachers ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT false`);

  // backfill login from email prefix where missing (collision-safe)
  const missing = await pool.query(`SELECT id, email FROM teachers WHERE login IS NULL`);
  for (const row of missing.rows) {
    let base = (String(row.email || '').split('@')[0] || '').toLowerCase().replace(/[^a-z0-9_.]/g, '');
    if (!LOGIN_RE.test(base)) base = 'teacher_' + row.id;
    let login = base;
    for (let n = 0; n < 50; n++) {
      try {
        await pool.query('UPDATE teachers SET login=$1 WHERE id=$2', [login, row.id]);
        break;
      } catch (e) {
        if (e.code === '23505') { login = `${base}_${n + 1}`; continue; }
        throw e;
      }
    }
  }

  // seed creator account: login pyfold
  const adminLogin = process.env.ADMIN_LOGIN || 'pyfold';
  const adminPass = process.env.ADMIN_PASSWORD || 'Hopedeke_725280';
  const exists = await pool.query('SELECT id FROM teachers WHERE login=$1 OR email=$2', [adminLogin, 'pyfold@tasked.local']);
  const hash = await bcrypt.hash(adminPass, 10);
  if (!exists.rows.length) {
    await pool.query(
      `INSERT INTO teachers (login, email, password_hash, display_name, is_admin)
       VALUES ($1,$2,$3,$4,true)`,
      [adminLogin, 'pyfold@tasked.local', hash, 'Создатель']
    );
    console.log('Seeded creator account: pyfold');
  } else {
    // keep seeded password in sync with env (so deploy never locks out)
    await pool.query(
      `UPDATE teachers SET login=$2, password_hash=$3, is_admin=true WHERE id=$1`,
      [exists.rows[0].id, adminLogin, hash]
    );
  }
}
initDb().catch((e) => { console.error('DB init failed', e); process.exit(1); });

// ---------- sessions ----------
const SECRET = process.env.SESSION_SECRET || 'dev-secret';
const sign = (v) => {
  const b = Buffer.from(JSON.stringify(v)).toString('base64url');
  const h = crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
  return b + '.' + h;
};
function verify(token) {
  try {
    if (!token || !token.includes('.')) return null;
    const [b, h] = token.split('.');
    const expect = crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
    if (h !== expect) return null;
    return JSON.parse(Buffer.from(b, 'base64url').toString());
  } catch { return null; }
}
function session(req) { return verify(req.cookies.session); }
function requireRole(...roles) {
  return (req, res, next) => {
    const s = session(req);
    if (!s || !roles.includes(s.role)) return res.status(401).json({ error: 'unauthorized' });
    req.user = s;
    next();
  };
}
const authTeacher = requireRole('teacher', 'admin');
const authAdmin = requireRole('admin');
function setSession(res, payload) {
  res.cookie('session', sign(payload), { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000 });
}

const LOGIN_RE = /^[a-zA-Z0-9_.]{3,32}$/;
const normLogin = (v) => String(v || '').trim();

// ---------- student auth ----------
app.post('/api/auth/student/register', async (req, res) => {
  const login = normLogin(req.body?.login).toLowerCase();
  const password = String(req.body?.password || '');
  const displayName = String(req.body?.name || '').slice(0, 60);
  if (!LOGIN_RE.test(login)) return res.status(400).json({ error: 'login_taken_or_invalid' });
  if (password.length < 4) return res.status(400).json({ error: 'password_too_short' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      'INSERT INTO students (login, password_hash, display_name) VALUES ($1,$2,$3) RETURNING id, login',
      [login, hash, displayName || login]
    );
    setSession(res, { role: 'student', id: r.rows[0].id, login: r.rows[0].login });
    res.json({ ok: true, login: r.rows[0].login });
  } catch {
    res.status(409).json({ error: 'login_taken' });
  }
});

app.post('/api/auth/student/login', async (req, res) => {
  const login = normLogin(req.body?.login).toLowerCase();
  const r = await pool.query('SELECT * FROM students WHERE login=$1', [login]);
  const u = r.rows[0];
  if (!u || !(await bcrypt.compare(String(req.body?.password || ''), u.password_hash)))
    return res.status(401).json({ error: 'bad_credentials' });
  setSession(res, { role: 'student', id: u.id, login: u.login });
  res.json({ ok: true, login: u.login });
});

// ---------- teacher auth (login or email) ----------
app.post('/api/auth/teacher/register', async (req, res) => {
  const login = normLogin(req.body?.login || req.body?.email).toLowerCase();
  const email = req.body?.email ? String(req.body.email).toLowerCase() : null;
  const password = String(req.body?.password || '');
  if (!LOGIN_RE.test(login) && email) {
    // allow email-style login: derive
  }
  if (!LOGIN_RE.test(login)) return res.status(400).json({ error: 'login_taken_or_invalid' });
  if (password.length < 4) return res.status(400).json({ error: 'password_too_short' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      'INSERT INTO teachers (login, email, password_hash, display_name) VALUES ($1,$2,$3,$4) RETURNING id, login',
      [login, email, hash, login]
    );
    setSession(res, { role: 'teacher', id: r.rows[0].id, login: r.rows[0].login });
    res.json({ ok: true, login: r.rows[0].login });
  } catch {
    res.status(409).json({ error: 'login_taken' });
  }
});

async function teacherLogin(req, res) {
  const ident = normLogin(req.body?.login || req.body?.email).toLowerCase();
  const r = await pool.query('SELECT * FROM teachers WHERE login=$1 OR email=$1', [ident]);
  const t = r.rows[0];
  if (!t || !(await bcrypt.compare(String(req.body?.password || ''), t.password_hash)))
    return res.status(401).json({ error: 'bad_credentials' });
  setSession(res, { role: t.is_admin ? 'admin' : 'teacher', id: t.id, login: t.login });
  res.json({ ok: true, login: t.login, role: t.is_admin ? 'admin' : 'teacher' });
}
app.post('/api/auth/teacher/login', teacherLogin);
// backward compat with old frontend (email-based teacher auth)
app.post('/api/auth/register', async (req, res) => {
  const email = req.body?.email ? String(req.body.email).toLowerCase() : '';
  const login = email.split('@')[0];
  req.body = { login, email, password: req.body?.password };
  if (!LOGIN_RE.test(login)) return res.status(400).json({ error: 'login_taken_or_invalid' });
  if (String(req.body.password || '').length < 4) return res.status(400).json({ error: 'password_too_short' });
  try {
    const hash = await bcrypt.hash(String(req.body.password), 10);
    const r = await pool.query(
      'INSERT INTO teachers (login, email, password_hash, display_name) VALUES ($1,$2,$3,$4) RETURNING id, login',
      [login, email, hash, login]
    );
    setSession(res, { role: 'teacher', id: r.rows[0].id, login: r.rows[0].login });
    res.json({ ok: true, login: r.rows[0].login });
  } catch {
    res.status(409).json({ error: 'login_taken' });
  }
});
app.post('/api/auth/login', teacherLogin);

app.post('/api/auth/logout', (req, res) => { res.clearCookie('session'); res.json({ ok: true }); });
app.get('/api/auth/me', (req, res) => {
  const s = session(req);
  if (!s) return res.status(401).json({ error: 'unauthorized' });
  res.json({ ok: true, role: s.role, login: s.login, id: s.id });
});

// ---------- admin: manage teacher logins ----------
app.get('/api/admin/teachers', authAdmin, async (req, res) => {
  const r = await pool.query(`
    SELECT t.id, t.login, t.email, t.display_name, t.created_at,
           COUNT(DISTINCT top.id) AS topics,
           COUNT(DISTINCT p.student_key) AS students
    FROM teachers t
    LEFT JOIN topics top ON top.teacher_id = t.id
    LEFT JOIN progress p ON p.topic_id = top.id
    WHERE t.is_admin = false
    GROUP BY t.id ORDER BY t.created_at DESC`);
  res.json(r.rows);
});

app.post('/api/admin/teachers', authAdmin, async (req, res) => {
  const login = normLogin(req.body?.login).toLowerCase();
  const password = String(req.body?.password || '');
  const email = req.body?.email ? String(req.body.email).toLowerCase() : null;
  if (!LOGIN_RE.test(login)) return res.status(400).json({ error: 'bad_login' });
  if (password.length < 4) return res.status(400).json({ error: 'password_too_short' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      'INSERT INTO teachers (login, email, password_hash, display_name) VALUES ($1,$2,$3,$4) RETURNING id, login',
      [login, email, hash, login]
    );
    res.json({ ok: true, id: r.rows[0].id, login: r.rows[0].login });
  } catch {
    res.status(409).json({ error: 'login_taken' });
  }
});

app.post('/api/admin/teachers/:id/reset', authAdmin, async (req, res) => {
  const password = String(req.body?.password || '');
  if (password.length < 4) return res.status(400).json({ error: 'password_too_short' });
  const hash = await bcrypt.hash(password, 10);
  await pool.query('UPDATE teachers SET password_hash=$1 WHERE id=$2 AND is_admin=false', [hash, req.params.id]);
  res.json({ ok: true });
});

app.delete('/api/admin/teachers/:id', authAdmin, async (req, res) => {
  await pool.query('DELETE FROM teachers WHERE id=$1 AND is_admin=false', [req.params.id]);
  res.json({ ok: true });
});

// ---------- topics ----------
app.get('/api/topics', async (req, res) => {
  const r = await pool.query('SELECT id, title, description, created_at FROM topics ORDER BY created_at DESC');
  res.json(r.rows);
});

app.post('/api/topics', authTeacher, async (req, res) => {
  const { title, description } = req.body || {};
  if (!title) return res.status(400).json({ error: 'Нужно название темы' });
  const teacherId = req.user.role === 'admin' ? (req.body.teacherId || req.user.id) : req.user.id;
  const r = await pool.query(
    'INSERT INTO topics (teacher_id, title, description) VALUES ($1,$2,$3) RETURNING *',
    [teacherId, title, description || '']);
  res.json(r.rows[0]);
});

app.delete('/api/topics/:id', authTeacher, async (req, res) => {
  if (req.user.role === 'admin') {
    await pool.query('DELETE FROM topics WHERE id=$1', [req.params.id]);
  } else {
    await pool.query('DELETE FROM topics WHERE id=$1 AND teacher_id=$2', [req.params.id, req.user.id]);
  }
  res.json({ ok: true });
});

app.get('/api/teacher/progress', authTeacher, async (req, res) => {
  const r = req.user.role === 'admin'
    ? await pool.query(`
      SELECT t.title, p.student_key, p.score, p.attempts, p.updated_at
      FROM progress p JOIN topics t ON t.id = p.topic_id
      ORDER BY p.updated_at DESC LIMIT 200`)
    : await pool.query(`
      SELECT t.title, p.student_key, p.score, p.attempts, p.updated_at
      FROM progress p JOIN topics t ON t.id = p.topic_id
      WHERE t.teacher_id = $1 ORDER BY p.updated_at DESC LIMIT 200`, [req.user.id]);
  res.json(r.rows);
});

// ---------- Mistral AI (bilingual RU/KK) ----------
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

const SYSTEM_RU = `Ты — добрый, поддерживающий учитель-репетитор. Работай СТРОГО на русском языке, простыми словами.

ТЕОРИЯ: при первом ходе объясни тему коротко (5-8 предложений), с бытовым примером, без сложных терминов.

ЗАДАНИЯ — давай ПО ОДНОМУ и соблюдай правила:
• Задание должно быть конкретным и иметь ОДНОЗНАЧНЫЙ короткий ответ (число, слово, дата, выбор варианта). Не давай "объясните своими словами", "приведите примеры" — такие ответы невозможно проверить.
• Начинай с ОЧЕНЬ простых заданий (уровень 5 класса, устный счёт). Уровень повышай ТОЛЬКО если ученик отвечает верно, и повышай медленно — на полшага.
• Не задавай несколько вопросов в одном задании.

ПРОВЕРКА ОТВЕТА — будь лояльным:
• Засчитывай ответ верным, если он правильный ПО СМЫСЛУ: другая форма записи (2/4 = 0.5 = 1/2), опечатка, без единиц измерения, с лишней вежливостью — всё это ПРАВИЛЬНЫЙ ответ.
• При неполной ошибке не объявляй "неверно" сразу: сделай наводящую подсказку в feedback и оставь correct=false только при явной ошибке.
• feedback — всегда доброжелательный: сначала похвала за то, что получилось, потом мягкое объяснение ошибки.

ЗАВЕРШЕНИЕ УРОКА: если ученик ответил верно 5 раз подряд — заверши урок: поставь task = "" и напиши в feedback тёплую итоговую похвалу с мини-резюме того, чему он научился.

АДАПТАЦИЯ: каждое следующее задание подстраивай под предыдущий ответ: ошибка → проще на то же слабое место + объяснение; верно → чуть сложнее (максимум на один уровень).

Ты отвечаешь ИСКЛЮЧИТЕЛЬНО валидным JSON вида:
{ "theory": "краткое объяснение темы (только при первом ходе, иначе пустая строка)", "feedback": "комментарий по предыдущему ответу ученика, '' если это самое начало", "task": "текст нового задания (пустая строка, если урок завершён)", "correct": true | false | null }
Поле "correct" — результат ПРЕДЫДУЩЕГО ответа ученика (true/false), в самом первом ходе null.`;

const SYSTEM_KK = `Сен — мейірімді, қолдайтын мұғалім-репетиторсың. ҚАТАҢ түрде қазақ тілінде, қарапайым сөздермен жұмыс істе.

ТЕОРИЯ: бірінші қадамда тақырыпты қысқаша түсіндір (5-8 сөйлем), тұрмыстық мысалмен, күрделі терминдерсіз.

ТАПСЫРМАЛАР — БІР-БІРДЕН бер және ережелерді сақта:
• Тапсырма нақты және БІР ANЫҚ қысқа жауабы болуы керек (сан, сөз, күн, нұсқа таңдау). "Өз сөзіңмен түсіндір", "мысал келтір" дегенді берме — ондай жауаптарды тексеру мүмкін емес.
• ӨТЕ оңай тапсырмалардан баста (5-сынып деңгейі). Деңгейді ТЕК оқушы дұрыс жауап берсе, баяу көтер.
• Бір тапсырмада бірнеше сұрақ қойма.

ЖАУАissage ТЕКСЕРУ — адал бол:
• Жауап МАҒЫНАСЫ бойынша дұрыс болса, дұрыс деп есепте: басқа жазу формасы, емле қатесі, өлшем бірлігінсіз — бәрі ДҰРЫС жауап.
• feedback — әрдайым мейірімді: алдымен мақтау, сосын қатені жұмсақ түсіндіру.

САБАҚТЫ АЯҚТАУ: егер оқушы қатарынан 5 рет дұрыс жауап берсе — сабақты аяқта: task = "" қой және feedback-ке жылы қорытынды мақтау жаз.

БЕЙІМДЕЛУ: әр келесі тапсырманы алдыңғы жауапқа бейімде: қате → сол әлсіз тұсқа оңайырақ + түсіндіру; дұрыс → сәл қиынырақ (максимум бір деңгей).

Сен ТЕК мына валидті JSON түрінде жауап бересің:
{ "theory": "тақырыпты қысқа түсіндіру (тек бірінші қадамда, әйтпесе бос жол)", "feedback": "оқушының алдыңғы жауабына пікір, ең басында ''", "task": "жаңа тапсырма мәтіні (сабақ аяқталса бос жол)", "correct": true | false | null }
"correct" өрісі — оқушының АЛДЫҢҒЫ жауабының нәтижесі (true/false), ең бірінші қадамда null.`;

const SYSTEM_VOICE = {
  ru: 'Ты — добрый учитель-репетитор. Отвечай на русском, коротко и понятно, 2-4 предложения, разговорным стилем (тебя слушают голосом).',
  kk: 'Сен — мейірімді мұғалімсің. Қазақ тілінде, қысқа және түсінікті, 2-4 сөйлеммен, ауызекі стильде жауап бер (сені дауыстап тыңдайды).',
};

app.post('/api/ai/turn', async (req, res) => {
  const { topicId, studentKey, answer, lang } = req.body || {};
  if (!topicId || !studentKey) return res.status(400).json({ error: 'topicId и studentKey обязательны' });
  const useLang = lang === 'kk' ? 'kk' : 'ru';

  const topic = (await pool.query('SELECT * FROM topics WHERE id=$1', [topicId])).rows[0];
  if (!topic) return res.status(404).json({ error: 'Тема не найдена' });

  let prog = (await pool.query('SELECT * FROM progress WHERE topic_id=$1 AND student_key=$2', [topicId, studentKey])).rows[0];
  if (!prog) {
    prog = (await pool.query(
      'INSERT INTO progress (topic_id, student_key, history) VALUES ($1,$2,$3::jsonb) RETURNING *',
      [topicId, studentKey, '[]'])).rows[0];
  }

  const history = prog.history || [];
  if (answer) history.push({ role: 'student', text: String(answer).slice(0, 2000) });

  let streak = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.role !== 'teacher') break;
    try { const j = JSON.parse(h.text); if (j.correct === true) streak++; else break; } catch { break; }
  }

  const finishHint = streak >= 5
    ? (useLang === 'kk'
      ? ' Оқушы тақырыпты сенімді меңгерді — САБАҚТЫ АЯҚТА (task = "", feedback-ке жылы қорытынды мақтау).'
      : ' Ученик уверенно освоил тему — ЗАВЕРШИ урок (task = "", тёплая итоговая похвала в feedback).')
    : '';

  const messages = [
    { role: 'system', content: useLang === 'kk' ? SYSTEM_KK : SYSTEM_RU },
    { role: 'user', content: `Тема урока: «${topic.title}». ${topic.description ? 'Описание от учителя: ' + topic.description : ''}\nВерных ответов подряд: ${streak}.${finishHint}\n\nИстория диалога:\n${JSON.stringify(history.slice(-10), null, 2)}\n\nДай JSON-ответ.` },
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

app.post('/api/ai/voice', async (req, res) => {
  const { topic, history, lang } = req.body || {};
  const useLang = lang === 'kk' ? 'kk' : 'ru';
  try {
    const reply = await mistralChat({
      temperature: 0.5,
      messages: [
        { role: 'system', content: SYSTEM_VOICE[useLang] },
        { role: 'user', content: `Тема разговора: «${topic || 'свободная беседа об учёбе'}».\nИстория диалога:\n${JSON.stringify(history || [], null, 2)}` },
      ],
    });
    res.json({ reply });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Fish Audio TTS proxy (free model s2.1-pro-free) ----------
// Voice: female teacher voice. Defaults use public library female RU voice
// "Училка" (e3ca0b02...). Override via env for RU/KK separately.
// Fish auto-detects language (83 langs incl. Kazakh), so one voice speaks both.
const FISH_MODEL = process.env.FISH_MODEL || 's2.1-pro-free';
const FISH_VOICE_RU = process.env.FISH_VOICE_RU || 'e3ca0b027dc349539885834f450e35eb';
const FISH_VOICE_KK = process.env.FISH_VOICE_KK || process.env.FISH_VOICE_RU || 'e3ca0b027dc349539885834f450e35eb';

const ttsCache = new Map();
function cacheKey(text, lang) {
  return crypto.createHash('sha256').update(lang + ':' + text).digest('hex');
}

app.get('/api/voice/config', (req, res) => {
  res.json({
    fishEnabled: Boolean(process.env.FISH_API_KEY),
    stt: { ru: 'ru-RU', kk: 'kk-KZ' },
    azureVoices: { ru: 'ru-RU-SvetlanaNeural', kk: 'kk-KZ-AigulNeural' },
  });
});

app.post('/api/voice/tts', async (req, res) => {
  const text = String(req.body?.text || '').slice(0, 1000);
  const lang = req.body?.lang === 'kk' ? 'kk' : 'ru';
  if (!text.trim()) return res.status(400).json({ error: 'empty text' });
  if (!process.env.FISH_API_KEY) return res.status(503).json({ error: 'fish_disabled' });

  const key = cacheKey(text, lang);
  const hit = ttsCache.get(key);
  if (hit) {
    res.set('Content-Type', 'audio/mpeg');
    res.set('X-Cache', 'HIT');
    return res.send(hit);
  }

  try {
    const resp = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.FISH_API_KEY}`,
        'Content-Type': 'application/json',
        model: FISH_MODEL,
      },
      body: JSON.stringify({
        text,
        reference_id: lang === 'kk' ? FISH_VOICE_KK : FISH_VOICE_RU,
        format: 'mp3',
        mp3_bitrate: 128,
        normalize: true,
        latency: 'normal',
      }),
    });
    if (!resp.ok) {
      const t = await resp.text();
      console.error('Fish TTS error', resp.status, t);
      return res.status(502).json({ error: 'fish_tts_failed', detail: t.slice(0, 300) });
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (ttsCache.size > 120) ttsCache.delete(ttsCache.keys().next().value);
    ttsCache.set(key, buf);
    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  } catch (e) {
    console.error('Fish TTS exception', e);
    res.status(502).json({ error: 'fish_tts_failed' });
  }
});

// ---------- Azure Speech config (browser SDK: STT ru-RU + kk-KZ) ----------
app.get('/api/speech/config', (req, res) => {
  res.json({
    key: process.env.AZURE_SPEECH_KEY || '',
    region: process.env.AZURE_SPEECH_REGION || '',
    voices: {
      ru: process.env.AZURE_SPEECH_VOICE || 'ru-RU-SvetlanaNeural',
      kk: process.env.AZURE_SPEECH_VOICE_KK || 'kk-KZ-AigulNeural',
    },
    stt: { ru: 'ru-RU', kk: 'kk-KZ' },
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AI Teacher on :${PORT}`));
