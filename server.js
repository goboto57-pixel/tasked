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
  await pool.query(`ALTER TABLE teachers ALTER COLUMN email DROP NOT NULL`);
  await pool.query(`ALTER TABLE teachers ADD COLUMN IF NOT EXISTS display_name TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE teachers ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT false`);
  await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS xp INT DEFAULT 0`);
  await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS streak_days INT DEFAULT 0`);
  await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS last_active DATE`);
  await pool.query(`ALTER TABLE topics ADD COLUMN IF NOT EXISTS theory_override TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE progress ADD COLUMN IF NOT EXISTS student_id INT REFERENCES students(id) ON DELETE CASCADE`);
  await pool.query(`ALTER TABLE progress ADD COLUMN IF NOT EXISTS completed BOOLEAN DEFAULT false`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS classes (
      id SERIAL PRIMARY KEY,
      teacher_id INT REFERENCES teachers(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      code TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS class_members (
      id SERIAL PRIMARY KEY,
      class_id INT REFERENCES classes(id) ON DELETE CASCADE,
      student_id INT REFERENCES students(id) ON DELETE CASCADE,
      joined_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE (class_id, student_id)
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY,
      topic_id INT REFERENCES topics(id) ON DELETE CASCADE,
      teacher_id INT REFERENCES teachers(id) ON DELETE CASCADE,
      kind TEXT DEFAULT 'choice',
      prompt TEXT NOT NULL,
      options JSONB DEFAULT '[]'::jsonb,
      answer TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // backfill teacher logins (collision-safe)
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
  // backfill progress.student_id from student_key pattern student:<login>
  await pool.query(`
    UPDATE progress p SET student_id = s.id
    FROM students s
    WHERE p.student_id IS NULL AND p.student_key = 'student:' || s.login
  `);

  // Seed the creator account only once. Never ship or restore a known
  // password on every restart; set ADMIN_PASSWORD for the first deployment.
  const adminLogin = process.env.ADMIN_LOGIN || 'pyfold';
  const exists = await pool.query('SELECT id FROM teachers WHERE login=$1 OR email=$2', [adminLogin, 'pyfold@tasked.local']);
  if (!exists.rows.length && process.env.ADMIN_PASSWORD) {
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);
    await pool.query(
      `INSERT INTO teachers (login, email, password_hash, display_name, is_admin)
       VALUES ($1,$2,$3,$4,true)`,
      [adminLogin, 'pyfold@tasked.local', hash, 'Создатель']
    );
    console.log('Seeded creator account: pyfold');
  } else if (!exists.rows.length) {
    console.warn('ADMIN_PASSWORD is unset; creator account was not seeded. Set it in the environment to create the initial admin account.');
  }
}

// ---------- sessions ----------
const SECRET = process.env.SESSION_SECRET || 'dev-secret';
const LOGIN_RE = /^[a-zA-Z0-9_.]{3,32}$/;
const normLogin = (v) => String(v || '').trim();

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
    const hb = Buffer.from(h), eb = Buffer.from(expect);
    if (hb.length !== eb.length || !crypto.timingSafeEqual(hb, eb)) return null;
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
const authStudent = requireRole('student');
function setSession(res, payload) {
  const local = (process.env.DATABASE_URL || '').includes('localhost');
  res.cookie('session', sign(payload), { httpOnly: true, sameSite: 'lax', secure: !local, maxAge: 30 * 24 * 3600 * 1000 });
}

// ---------- gamification ----------
const levelOf = (xp) => Math.floor(Math.sqrt(Math.max(0, xp || 0) / 100)) + 1;
async function awardXp(studentId, amount) {
  if (!studentId || !amount) return null;
  const r = await pool.query(`
    UPDATE students SET
      xp = xp + $2,
      streak_days = CASE
        WHEN last_active IS NULL THEN 1
        WHEN last_active = CURRENT_DATE THEN streak_days
        WHEN last_active = CURRENT_DATE - 1 THEN streak_days + 1
        ELSE 1 END,
      last_active = CURRENT_DATE
    WHERE id = $1 RETURNING xp, streak_days`, [studentId, amount]);
  return r.rows[0] || null;
}
async function touchActive(studentId) {
  if (!studentId) return;
  await pool.query(`
    UPDATE students SET
      streak_days = CASE
        WHEN last_active IS NULL THEN 1
        WHEN last_active = CURRENT_DATE THEN streak_days
        WHEN last_active = CURRENT_DATE - 1 THEN streak_days + 1
        ELSE 1 END,
      last_active = CURRENT_DATE
    WHERE id = $1`, [studentId]);
}

// ---------- localized bank-task feedback ----------
const PRAISE = {
  ru: ['Отлично! Так держать.', 'Верно! Ты молодец.', 'Правильно! Продолжаем.', 'Точно! Хорошая работа.'],
  kk: ['Тамаша! Жарайсың.', 'Дұрыс! Ары қарай.', 'Дәл сол! Керемет жұмыс.'],
};
const MISS = {
  ru: (a) => `Пока мимо. Правильный ответ: ${a}. Ничего страшного — идём дальше, получится!`,
  kk: (a) => `Әзірге дұрыс емес. Дұрыс жауап: ${a}. Ештеңе етпес — ары қарай, шығады!`,
};
const DONE_MSG = {
  ru: 'Урок завершён! Ты разобрал все задания темы — отличная работа. Так держать!',
  kk: 'Сабақ аяқталды! Тақырыптың барлық тапсырмасын орындадың — жарайсың!',
};
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
function gradeChoice(task, answer) {
  const opts = Array.isArray(task.options) ? task.options : [];
  const a = norm(answer);
  if (!a) return false;
  const letters = ['a', 'б', 'в', 'г', 'д', 'е', 'a', 'b', 'c', 'd', 'e', 'f'];
  return opts.some((o, i) => norm(o) === a || String(i + 1) === a || letters[i] === a);
}
function gradeNumber(task, answer) {
  const f = (s) => {
    const m = String(s || '').replace(',', '.').match(/-?\d+(\.\d+)?([eE][+-]?\d+)?/);
    return m ? parseFloat(m[0]) : NaN;
  };
  const a = f(answer), b = f(task.answer);
  if (Number.isFinite(a) && Number.isFinite(b)) return Math.abs(a - b) < 1e-9;
  return norm(answer) === norm(task.answer) && norm(answer) !== '';
}

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
  await touchActive(u.id);
  setSession(res, { role: 'student', id: u.id, login: u.login });
  res.json({ ok: true, login: u.login });
});

// ---------- teacher auth (login or email) ----------
app.post('/api/auth/teacher/register', async (req, res) => {
  const login = normLogin(req.body?.login || req.body?.email).toLowerCase();
  const email = req.body?.email ? String(req.body.email).toLowerCase() : null;
  const password = String(req.body?.password || '');
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

// delete own account (student or teacher; admin is protected)
app.delete('/api/account', async (req, res) => {
  const s = session(req);
  if (!s || s.role === 'admin') return res.status(401).json({ error: 'unauthorized' });
  if (s.role === 'student') {
    await pool.query('DELETE FROM class_members WHERE student_id=$1', [s.id]);
    await pool.query(`DELETE FROM progress WHERE student_id=$1 OR student_key=$2`, [s.id, 'student:' + s.login]);
    await pool.query('DELETE FROM students WHERE id=$1', [s.id]);
  } else {
    await pool.query('DELETE FROM classes WHERE teacher_id=$1', [s.id]);
    await pool.query('DELETE FROM topics WHERE teacher_id=$1', [s.id]);
    await pool.query('DELETE FROM teachers WHERE id=$1', [s.id]);
  }
  res.clearCookie('session');
  res.json({ ok: true });
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
  const r = await pool.query('SELECT id, title, description, theory_override, created_at FROM topics ORDER BY created_at DESC');
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

app.patch('/api/topics/:id', authTeacher, async (req, res) => {
  const { title, description, theory_override } = req.body || {};
  const q = req.user.role === 'admin'
    ? await pool.query('SELECT * FROM topics WHERE id=$1', [req.params.id])
    : await pool.query('SELECT * FROM topics WHERE id=$1 AND teacher_id=$2', [req.params.id, req.user.id]);
  if (!q.rows.length) return res.status(404).json({ error: 'not found' });
  const t = q.rows[0];
  const r = await pool.query(
    'UPDATE topics SET title=$1, description=$2, theory_override=$3 WHERE id=$4 RETURNING *',
    [
      title !== undefined ? String(title).slice(0, 200) : t.title,
      description !== undefined ? String(description).slice(0, 2000) : t.description,
      theory_override !== undefined ? String(theory_override).slice(0, 6000) : t.theory_override,
      req.params.id,
    ]);
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

// ---------- task bank (auto-checkable: choice | number) ----------
async function ownTopic(topicId, user) {
  if (user.role === 'admin') {
    const r = await pool.query('SELECT * FROM topics WHERE id=$1', [topicId]);
    return r.rows[0] || null;
  }
  const r = await pool.query('SELECT * FROM topics WHERE id=$1 AND teacher_id=$2', [topicId, user.id]);
  return r.rows[0] || null;
}

app.get('/api/teacher/topics/:id/tasks', authTeacher, async (req, res) => {
  const t = await ownTopic(req.params.id, req.user);
  if (!t) return res.status(404).json({ error: 'not found' });
  const r = await pool.query('SELECT * FROM tasks WHERE topic_id=$1 ORDER BY id', [req.params.id]);
  res.json(r.rows);
});

app.post('/api/teacher/topics/:id/tasks', authTeacher, async (req, res) => {
  const t = await ownTopic(req.params.id, req.user);
  if (!t) return res.status(404).json({ error: 'not found' });
  const kind = req.body?.kind === 'number' ? 'number' : 'choice';
  const prompt = String(req.body?.prompt || '').slice(0, 1000);
  const answer = String(req.body?.answer || '').slice(0, 300);
  let options = [];
  if (kind === 'choice') {
    options = String(req.body?.options || '').split('\n').map(s => s.trim()).filter(Boolean).slice(0, 6);
    if (options.length < 2) return res.status(400).json({ error: 'need_2_options' });
    if (!options.some(o => norm(o) === norm(answer))) return res.status(400).json({ error: 'answer_not_in_options' });
  }
  if (!prompt || !answer) return res.status(400).json({ error: 'need_prompt_answer' });
  const r = await pool.query(
    'INSERT INTO tasks (topic_id, teacher_id, kind, prompt, options, answer) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [req.params.id, req.user.role === 'admin' ? t.teacher_id : req.user.id, kind, prompt, JSON.stringify(options), answer]);
  res.json(r.rows[0]);
});

app.delete('/api/teacher/tasks/:id', authTeacher, async (req, res) => {
  if (req.user.role === 'admin') {
    await pool.query('DELETE FROM tasks WHERE id=$1', [req.params.id]);
  } else {
    await pool.query('DELETE FROM tasks WHERE id=$1 AND teacher_id=$2', [req.params.id, req.user.id]);
  }
  res.json({ ok: true });
});

// ---------- classes ----------
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
async function genCode() {
  for (let i = 0; i < 8; i++) {
    const c = Array.from({ length: 6 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
    const r = await pool.query('SELECT id FROM classes WHERE code=$1', [c]);
    if (!r.rows.length) return c;
  }
  throw new Error('code gen failed');
}

app.get('/api/classes', authTeacher, async (req, res) => {
  const cls = req.user.role === 'admin'
    ? await pool.query('SELECT * FROM classes ORDER BY created_at DESC')
    : await pool.query('SELECT * FROM classes WHERE teacher_id=$1 ORDER BY created_at DESC', [req.user.id]);
  const out = [];
  for (const c of cls.rows) {
    const m = await pool.query('SELECT COUNT(*)::int AS n FROM class_members WHERE class_id=$1', [c.id]);
    out.push({ ...c, members: m.rows[0].n });
  }
  res.json(out);
});

app.post('/api/classes', authTeacher, async (req, res) => {
  const name = String(req.body?.name || '').slice(0, 80);
  if (!name.trim()) return res.status(400).json({ error: 'need_name' });
  const teacherId = req.user.role === 'admin' ? (req.body.teacherId || req.user.id) : req.user.id;
  const code = await genCode();
  const r = await pool.query('INSERT INTO classes (teacher_id, name, code) VALUES ($1,$2,$3) RETURNING *', [teacherId, name.trim(), code]);
  res.json(r.rows[0]);
});

app.post('/api/classes/:id/regen', authTeacher, async (req, res) => {
  const code = await genCode();
  const r = req.user.role === 'admin'
    ? await pool.query('UPDATE classes SET code=$1 WHERE id=$2 RETURNING *', [code, req.params.id])
    : await pool.query('UPDATE classes SET code=$1 WHERE id=$2 AND teacher_id=$3 RETURNING *', [code, req.params.id, req.user.id]);
  if (!r.rows.length) return res.status(404).json({ error: 'not found' });
  res.json(r.rows[0]);
});

app.delete('/api/classes/:id', authTeacher, async (req, res) => {
  if (req.user.role === 'admin') await pool.query('DELETE FROM classes WHERE id=$1', [req.params.id]);
  else await pool.query('DELETE FROM classes WHERE id=$1 AND teacher_id=$2', [req.params.id, req.user.id]);
  res.json({ ok: true });
});

app.get('/api/classes/:id/members', authTeacher, async (req, res) => {
  const c = req.user.role === 'admin'
    ? (await pool.query('SELECT * FROM classes WHERE id=$1', [req.params.id])).rows[0]
    : (await pool.query('SELECT * FROM classes WHERE id=$1 AND teacher_id=$2', [req.params.id, req.user.id])).rows[0];
  if (!c) return res.status(404).json({ error: 'not found' });
  const r = await pool.query(`
    SELECT s.id, s.login, COALESCE(NULLIF(s.display_name,''), s.login) AS name, s.xp, s.streak_days
    FROM class_members m JOIN students s ON s.id = m.student_id
    WHERE m.class_id=$1 ORDER BY s.xp DESC`, [req.params.id]);
  res.json(r.rows.map(x => ({ ...x, level: levelOf(x.xp) })));
});

// student: join / list / leave
app.post('/api/classes/join', authStudent, async (req, res) => {
  const code = String(req.body?.code || '').trim().toUpperCase();
  const c = (await pool.query('SELECT * FROM classes WHERE code=$1', [code])).rows[0];
  if (!c) return res.status(404).json({ error: 'bad_code' });
  await pool.query('INSERT INTO class_members (class_id, student_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [c.id, req.user.id]);
  res.json({ ok: true, id: c.id, name: c.name });
});
app.get('/api/my-classes', authStudent, async (req, res) => {
  const r = await pool.query(`
    SELECT c.id, c.name, c.code, t.login AS teacher,
      (SELECT COUNT(*)::int FROM class_members WHERE class_id=c.id) AS members
    FROM class_members m JOIN classes c ON c.id=m.class_id
    LEFT JOIN teachers t ON t.id=c.teacher_id
    WHERE m.student_id=$1 ORDER BY c.created_at DESC`, [req.user.id]);
  res.json(r.rows);
});
app.delete('/api/my-classes/:id', authStudent, async (req, res) => {
  await pool.query('DELETE FROM class_members WHERE class_id=$1 AND student_id=$2', [req.params.id, req.user.id]);
  res.json({ ok: true });
});
app.get('/api/classes/:id/board', async (req, res) => {
  const s = session(req);
  if (!s) return res.status(401).json({ error: 'unauthorized' });
  const c = (await pool.query('SELECT * FROM classes WHERE id=$1', [req.params.id])).rows[0];
  if (!c) return res.status(404).json({ error: 'not found' });
  const allowed = (s.role === 'admin') ||
    (s.role === 'teacher' && c.teacher_id === s.id) ||
    (s.role === 'student' && (await pool.query('SELECT id FROM class_members WHERE class_id=$1 AND student_id=$2', [c.id, s.id])).rows.length);
  if (!allowed) return res.status(403).json({ error: 'forbidden' });
  const r = await pool.query(`
    SELECT s.login, COALESCE(NULLIF(s.display_name,''), s.login) AS name, s.xp, s.streak_days
    FROM class_members m JOIN students s ON s.id=m.student_id
    WHERE m.class_id=$1 ORDER BY s.xp DESC LIMIT 50`, [c.id]);
  res.json(r.rows.map(x => ({ ...x, level: levelOf(x.xp) })));
});

// ---------- student cabinet ----------
app.get('/api/me/overview', authStudent, async (req, res) => {
  const u = (await pool.query('SELECT id, login, display_name, xp, streak_days FROM students WHERE id=$1', [req.user.id])).rows[0];
  if (!u) return res.status(404).json({ error: 'not found' });
  const rows = await pool.query(`
    SELECT DISTINCT ON (t.id) t.id AS topic_id, t.title, p.score, p.attempts, p.completed, p.updated_at
    FROM progress p JOIN topics t ON t.id = p.topic_id
    WHERE p.student_id=$1 OR p.student_key=$2
    ORDER BY t.id, p.updated_at DESC`, [req.user.id, 'student:' + u.login]);
  res.json({
    login: u.login,
    display_name: u.display_name,
    xp: u.xp, level: levelOf(u.xp), streak_days: u.streak_days,
    topics: rows.rows,
  });
});

// ---------- CSV export ----------
const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
function sendCsv(res, name, header, rows) {
  const lines = [header.map(csvCell).join(';'), ...rows.map(r => r.map(csvCell).join(';'))];
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${name}"`);
  res.send('﻿' + lines.join('\r\n'));
}
app.get('/api/teacher/export.csv', authTeacher, async (req, res) => {
  const r = req.user.role === 'admin'
    ? await pool.query(`SELECT t.title, p.student_key, p.score, p.attempts, p.completed, p.updated_at FROM progress p JOIN topics t ON t.id=p.topic_id ORDER BY p.updated_at DESC`)
    : await pool.query(`SELECT t.title, p.student_key, p.score, p.attempts, p.completed, p.updated_at FROM progress p JOIN topics t ON t.id=p.topic_id WHERE t.teacher_id=$1 ORDER BY p.updated_at DESC`, [req.user.id]);
  sendCsv(res, 'progress.csv', ['Тема', 'Ученик', 'Пройдено', 'Попыток', 'Завершён', 'Обновлено'],
    r.rows.map(x => [x.title, x.student_key, x.score, x.attempts, x.completed ? 'да' : 'нет', x.updated_at]));
});
app.get('/api/student/export.csv', authStudent, async (req, res) => {
  const u = (await pool.query('SELECT login FROM students WHERE id=$1', [req.user.id])).rows[0];
  const r = await pool.query(`
    SELECT t.title, p.score, p.attempts, p.completed, p.updated_at
    FROM progress p JOIN topics t ON t.id=p.topic_id
    WHERE p.student_id=$1 OR p.student_key=$2 ORDER BY p.updated_at DESC`, [req.user.id, 'student:' + (u?.login || '')]);
  sendCsv(res, 'my-progress.csv', ['Тема', 'Пройдено', 'Попыток', 'Завершён', 'Обновлено'],
    r.rows.map(x => [x.title, x.score, x.attempts, x.completed ? 'да' : 'нет', x.updated_at]));
});

// ---------- Mistral AI (bilingual RU/KK) ----------
const MISTRAL_MODEL = process.env.MISTRAL_MODEL || 'ministral-14b-latest';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function mistralChat(body, maxTokens = 700) {
  const models = [MISTRAL_MODEL, 'ministral-8b-latest'];
  let lastErr;
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 45000);
      try {
        const resp = await fetch('https://api.mistral.ai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.MISTRAL_API_KEY}`,
          },
          body: JSON.stringify({ ...body, model, max_tokens: body.max_tokens || maxTokens }),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (resp.ok) {
          const data = await resp.json();
          return data.choices[0].message.content;
        }
        lastErr = new Error(`Mistral API ${resp.status}: ${await resp.text()}`);
        const retryable = resp.status === 429 || resp.status >= 500;
        if (!retryable) throw lastErr;
      } catch (e) {
        clearTimeout(timer);
        lastErr = e;
      }
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
  const m = content.match(/\{[\s\S]*\}/);
  return JSON.parse(m ? m[0] : content);
}

async function mistralTheory(topic, lang) {
  const sys = lang === 'kk'
    ? 'Сен — мейірімді мұғалімсің. Тақырыпты қазақ тілінде, қарапайым сөзбен, 5-8 сөйлеммен, тұрмыстық мысалмен түсіндір. Тек түсіндіру мәтінін жаз.'
    : 'Ты — добрый учитель. Объясни тему на русском простыми словами, 5-8 предложений, с бытовым примером. Напиши только текст объяснения.';
  return mistralChat({
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: `Тема: «${topic.title}». ${topic.description || ''}` },
    ],
    temperature: 0.4,
  }, 500);
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
• Тапсырма нақты және БІР АНЫҚ қысқа жауабы болуы керек (сан, сөз, күн, нұсқа таңдау).
• ӨТЕ оңай тапсырмалардан баста (5-сынып деңгейі). Деңгейді ТЕК оқушы дұрыс жауап берсе, баяу көтер.
• Бір тапсырмада бірнеше сұрақ қойма.

ЖАУАП ТЕКСЕРУ — адал бол:
• Жауап МАҒЫНАСЫ бойынша дұрыс болса, дұрыс деп есепте.
• feedback — әрдайым мейірімді: алдымен мақтау, сосын қатені жұмсақ түсіндіру.

САБАҚТЫ АЯҚТАУ: егер оқушы қатарынан 5 рет дұрыс жауап берсе — сабақты аяқта: task = "" қой және feedback-ке жылы қорытынды мақтау жаз.

Сен ТЕК мына валидті JSON түрінде жауап бересің:
{ "theory": "тақырыпты қысқа түсіндіру (тек бірінші қадамда, әйтпесе бос жол)", "feedback": "оқушының алдыңғы жауабына пікір, ең басында ''", "task": "жаңа тапсырма мәтіні (сабақ аяқталса бос жол)", "correct": true | false | null }
"correct" өрісі — оқушының АЛДЫҢҒЫ жауабының нәтижесі (true/false), ең бірінші қадамда null.`;

const SYSTEM_VOICE = {
  ru: 'Ты — спокойный и внимательный учитель-репетитор. Отвечай на русском, без эмодзи, уменьшительных слов и лишних вступлений. Сначала прямо ответь на вопрос ученика, затем при необходимости объясни одним простым примером. Держи ответ в пределах 2–4 коротких предложений и не повторяй вопрос.',
  kk: 'Сен — сабырлы әрі мұқият мұғалімсің. Қазақ тілінде жауап бер. Эмодзи, еркелету сөздерін және артық кіріспені қолданба. Алдымен сұраққа нақты жауап бер, қажет болса бір қарапайым мысалмен түсіндір. Жауапты 2–4 қысқа сөйлеммен шектеп, сұрақты қайталама.',
};

function parseTeacherEntries(history) {
  const out = [];
  for (const h of history) {
    if (h.role !== 'teacher') continue;
    try { out.push(JSON.parse(h.text)); } catch { /* ignore */ }
  }
  return out;
}

async function saveProgress(prog, history, topicId, studentKey, studentId) {
  // score = number of correct answers (not teacher turns)
  let score = 0;
  for (const h of history) {
    if (h.role !== 'teacher') continue;
    try { if (JSON.parse(h.text).correct === true) score++; } catch { /* ignore */ }
  }
  await pool.query(
    'UPDATE progress SET history=$1::jsonb, score=$2, attempts=attempts+1, updated_at=now(), student_id=COALESCE(student_id,$4) WHERE id=$3',
    [JSON.stringify(history.slice(-40)), score, prog.id, studentId]);
}

app.post('/api/ai/turn', async (req, res) => {
  let { topicId, studentKey, answer } = req.body || {};
  const lang = req.body?.lang === 'kk' ? 'kk' : 'ru';
  const sess = session(req);
  let studentId = null;
  if (sess && sess.role === 'student') {
    studentId = sess.id;
    studentKey = 'student:' + sess.login;
  }
  if (!topicId || !studentKey) return res.status(400).json({ error: 'bad_request' });
  studentKey = String(studentKey).slice(0, 120);

  const topic = (await pool.query('SELECT * FROM topics WHERE id=$1', [topicId])).rows[0];
  if (!topic) return res.status(404).json({ error: 'topic_not_found' });

  let prog = (await pool.query('SELECT * FROM progress WHERE topic_id=$1 AND student_key=$2', [topicId, studentKey])).rows[0];
  if (!prog) {
    prog = (await pool.query(
      'INSERT INTO progress (topic_id, student_key, history) VALUES ($1,$2,$3::jsonb) RETURNING *',
      [topicId, studentKey, '[]'])).rows[0];
  }

  const history = prog.history || [];
  const teacherEntries = parseTeacherEntries(history);
  const firstTurn = teacherEntries.length === 0;

  // bank tasks for this topic
  const bank = (await pool.query('SELECT * FROM tasks WHERE topic_id=$1 ORDER BY id', [topicId])).rows;
  const usedBankIds = new Set(teacherEntries.map(e => e.bankTaskId).filter(Boolean));
  const nextBank = bank.find(t => !usedBankIds.has(t.id)) || null;

  const finish = async (ai) => {
    history.push({ role: 'teacher', text: JSON.stringify(ai) });
    await saveProgress(prog, history, topicId, studentKey, studentId);
    await pool.query('UPDATE progress SET completed=true WHERE id=$1', [prog.id]);
    await awardXp(studentId, 50);
    res.json(ai);
  };

  if (answer) {
    history.push({ role: 'student', text: String(answer).slice(0, 2000) });
  }

  // ---- path 1: grade a pending bank task locally (no LLM) ----
  const lastT = teacherEntries[teacherEntries.length - 1];
  if (answer && lastT && lastT.bankTaskId && lastT.graded !== true) {
    const task = bank.find(t => t.id === lastT.bankTaskId);
    let correct = false;
    if (task) {
      correct = task.kind === 'number' ? gradeNumber(task, answer) : gradeChoice(task, answer);
    }
    const praise = PRAISE[lang][Math.floor(Math.random() * PRAISE[lang].length)];
    const feedback = correct ? praise : MISS[lang](task ? task.answer : '—');
    if (correct) await awardXp(studentId, 10);
    else await touchActive(studentId);
    const next = bank.filter(t => t.id !== lastT.bankTaskId && !usedBankIds.has(t.id))[0] || null;
    if (!next) {
      return finish({ theory: '', feedback: feedback + ' ' + DONE_MSG[lang], task: '', correct, taskKind: 'text' });
    }
    const ai = {
      theory: '', feedback, task: next.prompt, correct,
      taskKind: next.kind, options: next.kind === 'choice' ? next.options : [],
      bankTaskId: next.id, graded: false,
    };
    history.push({ role: 'teacher', text: JSON.stringify(ai) });
    await saveProgress(prog, history, topicId, studentKey, studentId);
    return res.json(ai);
  }

  // ---- path 2: first turn in bank mode — LLM theory + first bank task ----
  if (firstTurn && nextBank) {
    let theory = '';
    try { theory = await mistralTheory(topic, lang); }
    catch (e) { console.error('theory LLM failed', e.message); }
    if (topic.theory_override) theory = topic.theory_override;
    await touchActive(studentId);
    const ai = {
      theory, feedback: '', task: nextBank.prompt, correct: null,
      taskKind: nextBank.kind, options: nextBank.kind === 'choice' ? nextBank.options : [],
      bankTaskId: nextBank.id, graded: false,
    };
    history.push({ role: 'teacher', text: JSON.stringify(ai) });
    await saveProgress(prog, history, topicId, studentKey, studentId);
    return res.json(ai);
  }

  // ---- path 3: adaptive LLM flow ----
  let streak = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.role !== 'teacher') break;
    try { const j = JSON.parse(h.text); if (j.correct === true) streak++; else break; } catch { break; }
  }

  const finishHint = streak >= 5
    ? (lang === 'kk'
      ? ' Оқушы тақырыпты сенімді меңгерді — САБАҚТЫ АЯҚТА (task = "", feedback-ке жылы қорытынды мақтау).'
      : ' Ученик уверенно освоил тему — ЗАВЕРШИ урок (task = "", тёплая итоговая похвала в feedback).')
    : '';

  const messages = [
    { role: 'system', content: lang === 'kk' ? SYSTEM_KK : SYSTEM_RU },
    { role: 'user', content: `Тема урока: «${topic.title}». ${topic.description ? 'Описание от учителя: ' + topic.description : ''}\nВерных ответов подряд: ${streak}.${finishHint}\n\nИстория диалога:\n${JSON.stringify(history.slice(-10), null, 2)}\n\nДай JSON-ответ.` },
  ];

  try {
    const ai = await mistral(messages);
    ai.taskKind = 'text';
    if (firstTurn && topic.theory_override) ai.theory = topic.theory_override;
    // teacher bank overrides adaptive task (but never resurrects a finished lesson)
    if (ai.task && nextBank) {
      ai.task = nextBank.prompt;
      ai.taskKind = nextBank.kind;
      ai.options = nextBank.kind === 'choice' ? nextBank.options : [];
      ai.bankTaskId = nextBank.id;
      ai.graded = false;
    }
    if (!ai.task) {
      if (ai.correct) await awardXp(studentId, 10);
      return finish(ai);
    }
    if (ai.correct) await awardXp(studentId, 10);
    else await touchActive(studentId);
    history.push({ role: 'teacher', text: JSON.stringify(ai) });
    await saveProgress(prog, history, topicId, studentKey, studentId);
    res.json(ai);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'ai_error', detail: String(e.message || e).slice(0, 200) });
  }
});

app.post('/api/ai/voice', async (req, res) => {
  const { topic } = req.body || {};
  const history = Array.isArray(req.body?.history) ? req.body.history : [];
  const lang = req.body?.lang === 'kk' ? 'kk' : 'ru';
  const turns = history.slice(-12).flatMap((item) => {
    if (!item || typeof item.text !== 'string') return [];
    const role = item.role === 'student' || item.role === 'user' ? 'user'
      : item.role === 'teacher' || item.role === 'assistant' ? 'assistant' : null;
    return role ? [{ role, content: item.text.slice(0, 1500) }] : [];
  });
  while (turns.length && turns[turns.length - 1].role === 'assistant') turns.pop();
  if (!turns.length || turns[turns.length - 1].role !== 'user') {
    return res.status(400).json({ error: 'message_required' });
  }
  try {
    const reply = await mistralChat({
      temperature: 0.35,
      messages: [
        { role: 'system', content: `${SYSTEM_VOICE[lang]}\nКонтекст занятия: ${String(topic || 'учёба').slice(0, 200)}.` },
        ...turns,
      ],
    }, 400);
    res.json({ reply });
  } catch (e) {
    console.error('Voice chat failed', e);
    res.status(500).json({ error: 'ai_error' });
  }
});

// ---------- Fish Audio TTS proxy (free model s2.1-pro-free) ----------
const FISH_MODEL = process.env.FISH_MODEL || 's2.1-pro-free';
const FISH_VOICE_RU = process.env.FISH_VOICE_RU || 'e897cbd38bc94548b7f5340c9db5fc4d';
const FISH_VOICE_KK = process.env.FISH_VOICE_KK || '93bb57166f474f43bdbdadec4c20298f';

const ttsCache = new Map();
function cacheKey(text, lang, speed, voice) {
  return crypto.createHash('sha256').update(lang + ':' + speed + ':' + voice + ':' + text).digest('hex');
}

app.get('/api/voice/config', (req, res) => {
  res.json({
    fishEnabled: Boolean(process.env.FISH_API_KEY),
    azureEnabled: Boolean(process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION),
    voiceNames: { ru: 'Calm Russian Female', kk: 'AIKO' },
    stt: { ru: 'ru-RU', kk: 'kk-KZ' },
    azureVoices: { ru: 'ru-RU-SvetlanaNeural', kk: 'kk-KZ-AigulNeural' },
  });
});

app.post('/api/voice/tts', async (req, res) => {
  const text = String(req.body?.text || '').slice(0, 1000);
  const lang = req.body?.lang === 'kk' ? 'kk' : 'ru';
  let speed = parseFloat(req.body?.speed);
  if (!Number.isFinite(speed)) speed = 1;
  speed = Math.min(1.5, Math.max(0.5, speed));
  if (!text.trim()) return res.status(400).json({ error: 'empty text' });
  if (!process.env.FISH_API_KEY) return res.status(503).json({ error: 'fish_disabled' });

  const voice = lang === 'kk' ? FISH_VOICE_KK : FISH_VOICE_RU;
  const key = cacheKey(text, lang, speed, voice);
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
        reference_id: voice,
        temperature: 0.4,
        top_p: 0.7,
        format: 'mp3',
        mp3_bitrate: 128,
        normalize: true,
        latency: 'normal',
        prosody: { speed },
      }),
      signal: AbortSignal.timeout(45000),
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

initDb()
  .then(() => {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`AI Teacher on :${PORT}`));
  })
  .catch((e) => { console.error('DB init failed', e); process.exit(1); });
