require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { Pool } = require('pg');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.get('/lesson.html', (req, res, next) => {
  if (!session(req) || session(req).role !== 'student') return res.redirect('/?auth=required&next=' + encodeURIComponent(req.originalUrl));
  next();
});
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
      login TEXT UNIQUE,
      password_hash TEXT,
      display_name TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS email_login_codes (
      email TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL,
      attempts INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_email_sends (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      request_ip TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS topics (
      id SERIAL PRIMARY KEY,
      teacher_id INT REFERENCES teachers(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      theory_cache JSONB,
      theory_status TEXT NOT NULL DEFAULT 'pending',
      theory_version INT NOT NULL DEFAULT 0,
      prepared_task JSONB,
      task_status TEXT NOT NULL DEFAULT 'pending',
      task_started_at TIMESTAMPTZ,
      published BOOLEAN NOT NULL DEFAULT true,
      theory_started_at TIMESTAMPTZ,
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
  await pool.query(`ALTER TABLE students ALTER COLUMN login DROP NOT NULL`);
  await pool.query(`ALTER TABLE students ALTER COLUMN password_hash DROP NOT NULL`);
  await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS email TEXT`);
  await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS firebase_uid TEXT`);
  await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS students_firebase_uid_uq ON students(firebase_uid) WHERE firebase_uid IS NOT NULL`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS students_email_uq ON students(LOWER(email)) WHERE email IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS auth_email_sends_email_time_idx ON auth_email_sends(email, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS auth_email_sends_ip_time_idx ON auth_email_sends(request_ip, created_at DESC)`);
  await pool.query(`ALTER TABLE topics ADD COLUMN IF NOT EXISTS theory_override TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE topics ADD COLUMN IF NOT EXISTS theory_cache JSONB`);
  await pool.query(`ALTER TABLE topics ADD COLUMN IF NOT EXISTS theory_status TEXT NOT NULL DEFAULT 'pending'`);
  await pool.query(`ALTER TABLE topics ADD COLUMN IF NOT EXISTS theory_version INT NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE topics ADD COLUMN IF NOT EXISTS theory_started_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE topics ADD COLUMN IF NOT EXISTS prepared_task JSONB`);
  await pool.query(`ALTER TABLE topics ADD COLUMN IF NOT EXISTS task_status TEXT NOT NULL DEFAULT 'pending'`);
  await pool.query(`ALTER TABLE topics ADD COLUMN IF NOT EXISTS task_started_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE topics ADD COLUMN IF NOT EXISTS published BOOLEAN NOT NULL DEFAULT true`);
  await pool.query(`UPDATE topics SET theory_cache=NULL, theory_status='pending' WHERE theory_version < 2 AND theory_cache IS NOT NULL`);
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
let firebaseAuth = null;
const firebaseWebConfig = {
  apiKey: process.env.FIREBASE_API_KEY || '',
  authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
  projectId: process.env.FIREBASE_PROJECT_ID || '',
  appId: process.env.FIREBASE_APP_ID || '',
};
function initFirebaseAuth() {
  if (firebaseAuth) return firebaseAuth;
  if (!process.env.FIREBASE_SERVICE_ACCOUNT || !process.env.FIREBASE_PROJECT_ID) return null;
  try {
    let serviceAccount;
    try { serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT); }
    catch { serviceAccount = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString('utf8')); }
    const app = getApps().find(x => x.name === 'tasked-auth') || initializeApp({ credential: cert(serviceAccount), projectId: process.env.FIREBASE_PROJECT_ID }, 'tasked-auth');
    firebaseAuth = getAuth(app);
    return firebaseAuth;
  } catch (e) { console.error('Firebase Admin configuration is invalid:', e.message); return null; }
}
app.get('/api/auth/config', (req, res) => {
  const enabled = Boolean(firebaseWebConfig.apiKey && firebaseWebConfig.authDomain && firebaseWebConfig.projectId && firebaseWebConfig.appId && initFirebaseAuth());
  res.json({ enabled, firebase: enabled ? firebaseWebConfig : null });
});
app.post('/api/auth/firebase', async (req, res) => {
  const auth = initFirebaseAuth();
  if (!auth) return res.status(503).json({ error: 'auth_not_configured' });
  try {
    const decoded = await auth.verifyIdToken(String(req.body?.idToken || ''), true);
    const email = String(decoded.email || '').trim().toLowerCase();
    if (!email || decoded.email_verified !== true) return res.status(403).json({ error: 'email_not_verified' });
    const uid = String(decoded.uid);
    const displayName = String(decoded.name || email.split('@')[0]).trim().slice(0, 60);
    const result = await pool.query(`
      INSERT INTO students (email, firebase_uid, email_verified, display_name)
      VALUES ($1,$2,true,$3)
      ON CONFLICT (LOWER(email)) WHERE email IS NOT NULL
      DO UPDATE SET firebase_uid=EXCLUDED.firebase_uid, email_verified=true,
        display_name=CASE WHEN students.display_name='' THEN EXCLUDED.display_name ELSE students.display_name END
      RETURNING id, login, email, display_name`, [email, uid, displayName]);
    const student = result.rows[0];
    await touchActive(student.id);
    setSession(res, { role: 'student', id: student.id, login: student.login || student.email, email: student.email, displayName: student.display_name });
    res.json({ ok: true, role: 'student', id: student.id, login: student.login || student.email, email: student.email, displayName: student.display_name });
  } catch (e) {
    console.error('Firebase sign-in failed:', e.message);
    res.status(401).json({ error: 'invalid_token' });
  }
});
const normalizeEmail = value => String(value || '').trim().toLowerCase().slice(0, 254);
function emailCodeHash(email, code) {
  return crypto.createHmac('sha256', SECRET).update(`${email}:${code}`).digest('hex');
}
app.post('/api/auth/email-code/send', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'invalid_email' });
  if (!process.env.BREVO_API_KEY || !process.env.BREVO_SENDER_EMAIL || !initFirebaseAuth()) {
    return res.status(503).json({ error: 'email_auth_not_configured' });
  }
  try {
    await pool.query(`DELETE FROM auth_email_sends WHERE created_at < now() - interval '8 days'`);
    const limits = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE email=$1) AS email_day,
        COUNT(*) FILTER (WHERE request_ip=$2) AS ip_day,
        MAX(created_at) FILTER (WHERE email=$1) AS last_email
      FROM auth_email_sends
      WHERE created_at > now() - interval '24 hours' AND (email=$1 OR request_ip=$2)`, [email, String(req.ip || '').slice(0, 100)]);
    const quota = limits.rows[0];
    if (Number(quota.email_day) >= 10 || Number(quota.ip_day) >= 30) return res.status(429).json({ error: 'email_rate_limited' });
    if (quota.last_email && Date.now() - new Date(quota.last_email).getTime() < 60_000) return res.status(429).json({ error: 'email_wait_before_resend' });

    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    await pool.query(`INSERT INTO auth_email_sends (email, request_ip) VALUES ($1,$2)`, [email, String(req.ip || '').slice(0, 100)]);
    await pool.query(`INSERT INTO email_login_codes (email, code_hash, attempts, expires_at)
      VALUES ($1,$2,0,now()+interval '10 minutes')
      ON CONFLICT (email) DO UPDATE SET code_hash=EXCLUDED.code_hash, attempts=0, created_at=now(), expires_at=EXCLUDED.expires_at`,
    [email, emailCodeHash(email, code)]);
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', accept: 'application/json', 'api-key': process.env.BREVO_API_KEY },
      body: JSON.stringify({
        sender: { name: String(process.env.BREVO_SENDER_NAME || 'Tasked').slice(0, 70), email: process.env.BREVO_SENDER_EMAIL },
        to: [{ email }], subject: 'Код входа в Tasked',
        textContent: `Ваш код входа в Tasked: ${code}. Он действует 10 минут. Если вы не запрашивали вход, просто проигнорируйте письмо.`,
        htmlContent: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:28px;color:#20252b"><div style="font-size:13px;letter-spacing:2px;color:#68717c">TASKED · ВХОД В АККАУНТ</div><p style="font-size:16px">Введите этот код в окне входа:</p><div style="font-size:34px;font-weight:700;letter-spacing:8px;padding:18px 20px;background:#f2f4f6;border-radius:12px;text-align:center">${code}</div><p style="color:#68717c;font-size:13px">Код действует 10 минут. Если вы не запрашивали вход, проигнорируйте это письмо.</p></div>`,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const details = await response.json().catch(() => ({}));
      console.error('Brevo email send failed:', response.status, details.message || 'provider error');
      await pool.query('DELETE FROM email_login_codes WHERE email=$1', [email]);
      await pool.query(`DELETE FROM auth_email_sends WHERE id=(SELECT id FROM auth_email_sends WHERE email=$1 ORDER BY id DESC LIMIT 1)`, [email]);
      return res.status(502).json({ error: 'email_send_failed' });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('Email code request failed:', e.message);
    res.status(503).json({ error: 'email_send_failed' });
  }
});
app.post('/api/auth/email-code/verify', async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const code = String(req.body?.code || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^\d{6}$/.test(code)) return res.status(400).json({ error: 'invalid_code' });
  const auth = initFirebaseAuth();
  if (!auth) return res.status(503).json({ error: 'email_auth_not_configured' });
  try {
    const challenge = (await pool.query(`UPDATE email_login_codes SET attempts=attempts+1
      WHERE email=$1 AND expires_at>now() AND attempts<5 RETURNING code_hash, attempts`, [email])).rows[0];
    if (!challenge) return res.status(401).json({ error: 'invalid_or_expired_code' });
    const expected = Buffer.from(challenge.code_hash, 'hex');
    const actual = Buffer.from(emailCodeHash(email, code), 'hex');
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      if (challenge.attempts >= 5) await pool.query('DELETE FROM email_login_codes WHERE email=$1', [email]);
      return res.status(401).json({ error: 'invalid_or_expired_code' });
    }
    let user;
    try { user = await auth.getUserByEmail(email); }
    catch (e) {
      if (e.code !== 'auth/user-not-found') throw e;
      user = await auth.createUser({ email, emailVerified: true, displayName: email.split('@')[0].slice(0, 60) });
    }
    if (!user.emailVerified) user = await auth.updateUser(user.uid, { emailVerified: true });
    const customToken = await auth.createCustomToken(user.uid);
    await pool.query('DELETE FROM email_login_codes WHERE email=$1', [email]);
    res.json({ ok: true, customToken });
  } catch (e) {
    console.error('Email code verification failed:', e.message);
    res.status(503).json({ error: 'email_auth_failed' });
  }
});
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
app.post('/api/auth/student/register', (req, res) => res.status(410).json({ error: 'password_auth_removed' }));
app.post('/api/auth/student/login', (req, res) => res.status(410).json({ error: 'password_auth_removed' }));

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
  const r = await pool.query('SELECT id, title, description, theory_status, task_status, created_at FROM topics WHERE published=true ORDER BY created_at DESC');
  res.json(r.rows);
});

app.get('/api/teacher/topics', authTeacher, async (req, res) => {
  const r = req.user.role === 'admin'
    ? await pool.query('SELECT id, title, description, theory_override, theory_status, task_status, published, created_at FROM topics ORDER BY created_at DESC')
    : await pool.query('SELECT id, title, description, theory_override, theory_status, task_status, published, created_at FROM topics WHERE teacher_id=$1 ORDER BY created_at DESC', [req.user.id]);
  res.json(r.rows);
});

app.get('/api/teacher/topics/:id/preview', authTeacher, async (req, res) => {
  await pool.query("UPDATE topics SET theory_status='pending' WHERE id=$1 AND theory_status='generating' AND theory_started_at < now()-interval '5 minutes'", [req.params.id]);
  await pool.query("UPDATE topics SET task_status='pending' WHERE id=$1 AND task_status='generating' AND task_started_at < now()-interval '5 minutes'", [req.params.id]);
  const r = req.user.role === 'admin'
    ? await pool.query('SELECT * FROM topics WHERE id=$1', [req.params.id])
    : await pool.query('SELECT * FROM topics WHERE id=$1 AND teacher_id=$2', [req.params.id, req.user.id]);
  const topic = r.rows[0];
  if (!topic) return res.status(404).json({ error: 'topic_not_found' });
  startTopicPreparation(topic);
  res.set('Cache-Control', 'no-store').json({ id: topic.id, title: topic.title, description: topic.description,
    published: topic.published, theoryStatus: topic.theory_status, taskStatus: topic.task_status,
    theory: topic.theory_cache, firstTask: topic.prepared_task });
});

app.post('/api/teacher/topics/:id/publish', authTeacher, async (req, res) => {
  const where = req.user.role === 'admin' ? 'id=$1' : 'id=$1 AND teacher_id=$2';
  const params = req.user.role === 'admin' ? [req.params.id] : [req.params.id, req.user.id];
  const r = await pool.query(`SELECT theory_status, task_status, theory_cache, prepared_task FROM topics WHERE ${where}`, params);
  if (!r.rows[0]) return res.status(404).json({ error: 'topic_not_found' });
  if (r.rows[0].theory_status !== 'ready' || r.rows[0].task_status !== 'ready' || !r.rows[0].theory_cache || !r.rows[0].prepared_task) return res.status(409).json({ error: 'preparation_not_ready' });
  await pool.query(`UPDATE topics SET published=true WHERE ${where}`, params);
  res.json({ published: true });
});

app.post('/api/teacher/topics/:id/regenerate', authTeacher, async (req, res) => {
  const where = req.user.role === 'admin' ? 'id=$1' : 'id=$1 AND teacher_id=$2';
  const params = req.user.role === 'admin' ? [req.params.id] : [req.params.id, req.user.id];
  if (theoryJobs.has(Number(req.params.id)) || firstTaskJobs.has(Number(req.params.id))) return res.status(409).json({ error: 'preparation_in_progress' });
  const r = await pool.query(`UPDATE topics SET theory_cache=NULL, theory_status='pending', theory_version=0, prepared_task=NULL, task_status='pending', published=false WHERE ${where} RETURNING *`, params);
  if (!r.rows[0]) return res.status(404).json({ error: 'topic_not_found' });
  startTopicPreparation(r.rows[0]);
  res.status(202).json({ status: 'preparing' });
});

app.get('/api/topics/:id/theory', authStudent, async (req, res) => {
  const result = await pool.query('SELECT id, title, description, theory_override, theory_cache, theory_status, theory_version, theory_started_at, published FROM topics WHERE id=$1', [req.params.id]);
  const topic = result.rows[0];
  if (!topic) return res.status(404).json({ error: 'topic_not_found' });
  if (!topic.published) return res.status(404).json({ error: 'topic_not_found' });
  if (Number(topic.theory_version) < 2) {
    // A worker that died mid-generation leaves 'generating' behind forever —
    // treat generations older than 5 minutes as stale and restart them.
    const stale = topic.theory_status === 'generating' && topic.theory_started_at &&
      (Date.now() - new Date(topic.theory_started_at).getTime() > 5 * 60 * 1000);
    if (topic.theory_status !== 'generating' || stale) {
      if (stale) await pool.query("UPDATE topics SET theory_status='pending' WHERE id=$1", [topic.id]).catch(() => {});
      generateAndCacheTopicTheory(topic).catch(error => console.error('Topic theory generation failed:', error.message));
    }
    return res.status(202).json({ status: stale ? 'pending' : topic.theory_status });
  }
  if (!topic.theory_cache) return res.status(503).json({ status: topic.theory_status || 'failed' });
  res.set('Cache-Control', 'private, no-store').json({ status: 'ready', theory: topic.theory_cache });
});

app.post('/api/topics', authTeacher, async (req, res) => {
  const { title, description } = req.body || {};
  if (!title) return res.status(400).json({ error: 'Нужно название темы' });
  const teacherId = req.user.role === 'admin' ? (req.body.teacherId || req.user.id) : req.user.id;
  const r = await pool.query(
    'INSERT INTO topics (teacher_id, title, description, published) VALUES ($1,$2,$3,false) RETURNING *',
    [teacherId, title, description || '']);
  startTopicPreparation(r.rows[0]);
  res.json(r.rows[0]);
});

app.patch('/api/topics/:id', authTeacher, async (req, res) => {
  const { title, description, theory_override } = req.body || {};
  const q = req.user.role === 'admin'
    ? await pool.query('SELECT * FROM topics WHERE id=$1', [req.params.id])
    : await pool.query('SELECT * FROM topics WHERE id=$1 AND teacher_id=$2', [req.params.id, req.user.id]);
  if (!q.rows.length) return res.status(404).json({ error: 'not found' });
  const t = q.rows[0];
  if (theoryJobs.has(t.id) || firstTaskJobs.has(t.id)) return res.status(409).json({ error: 'preparation_in_progress' });
  const r = await pool.query(
    'UPDATE topics SET title=$1, description=$2, theory_override=$3 WHERE id=$4 RETURNING *',
    [
      title !== undefined ? String(title).slice(0, 200) : t.title,
      description !== undefined ? String(description).slice(0, 2000) : t.description,
      theory_override !== undefined ? String(theory_override).slice(0, 6000) : t.theory_override,
      req.params.id,
    ]);
  if (r.rows[0].title !== t.title || r.rows[0].description !== t.description || r.rows[0].theory_override !== t.theory_override) {
    const refreshed = await pool.query("UPDATE topics SET theory_cache=NULL, theory_status='pending', theory_version=0, prepared_task=NULL, task_status='pending', published=false WHERE id=$1 RETURNING *", [req.params.id]);
    startTopicPreparation(refreshed.rows[0]);
    return res.json(refreshed.rows[0]);
  }
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
    SELECT COALESCE(s.login,s.email) AS login, COALESCE(NULLIF(s.display_name,''), s.login, s.email) AS name, s.xp, s.streak_days
    FROM class_members m JOIN students s ON s.id=m.student_id
    WHERE m.class_id=$1 ORDER BY s.xp DESC LIMIT 50`, [c.id]);
  res.json(r.rows.map(x => ({ ...x, level: levelOf(x.xp) })));
});

// ---------- student cabinet ----------
app.get('/api/me/overview', authStudent, async (req, res) => {
  const u = (await pool.query('SELECT id, COALESCE(login,email) AS login, display_name, xp, streak_days FROM students WHERE id=$1', [req.user.id])).rows[0];
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
  const u = (await pool.query('SELECT COALESCE(login,email) AS login FROM students WHERE id=$1', [req.user.id])).rows[0];
  const r = await pool.query(`
    SELECT t.title, p.score, p.attempts, p.completed, p.updated_at
    FROM progress p JOIN topics t ON t.id=p.topic_id
    WHERE p.student_id=$1 OR p.student_key=$2 ORDER BY p.updated_at DESC`, [req.user.id, 'student:' + (u?.login || '')]);
  sendCsv(res, 'my-progress.csv', ['Тема', 'Пройдено', 'Попыток', 'Завершён', 'Обновлено'],
    r.rows.map(x => [x.title, x.score, x.attempts, x.completed ? 'да' : 'нет', x.updated_at]));
});

// ---------- Mistral AI (bilingual RU/KK) ----------
// Primary: ministral-14b — proven fast and reliable for lessons. Magistral
// models stay in the chain as fallback for when their quota allows.
const MISTRAL_MODEL = process.env.MISTRAL_MODEL || 'mistral-small-latest';

async function mistralChat(messages, maxTokens = 900, json = false, timeoutMs = 60000) {
  if (!process.env.MISTRAL_API_KEY) throw new Error('MISTRAL_API_KEY is not configured');
  const systemInstruction = messages.find(m => m.role === 'system')?.content || '';
  const msgs = messages.filter(m => m.role !== 'system').map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content || ''),
  }));
  const config = {
    model: MISTRAL_MODEL,
    messages: [
      ...(systemInstruction ? [{ role: 'system', content: systemInstruction }] : []),
      ...msgs
    ],
    temperature: json ? 0.2 : 0.4,
    max_tokens: maxTokens,
  };
  if (json) config.response_format = { type: 'json_object' };
  
  // Fallback chain for Mistral models
  const fallbackChain = [
    process.env.MISTRAL_FALLBACK_MODEL || 'ministral-14b-latest',
    'magistral-small-latest', 'magistral-medium-latest',
  ];
  const models = [MISTRAL_MODEL, ...fallbackChain].filter((m, i, a) => m && a.indexOf(m) === i);
  let lastErr;
  for (const model of models) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.MISTRAL_API_KEY}`,
        },
        body: JSON.stringify({ ...config, model }),
        signal: ctrl.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const detail = payload.error?.message || `Mistral API ${response.status}`;
        lastErr = new Error(detail.slice(0, 240));
        // 429 (quota): move on immediately
        // 503 (overload): brief pause, then try next model
        if (response.status === 503) {
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }
        if (response.status === 429) continue;
        throw lastErr;
      }
      const text = payload.choices?.[0]?.message?.content?.trim();
      if (!text) { lastErr = new Error('Mistral returned an empty response'); continue; }
      return text;
    } catch (e) {
      if (e.name === 'AbortError') { lastErr = new Error('Mistral timeout'); }
      else lastErr = e;
    } finally { clearTimeout(timer); }
  }
  throw lastErr;
}

function sanitizeJsonText(text) {
  // Models sometimes emit literal control chars inside strings (raw newlines
  // etc.) which is invalid JSON — escape them so the payload still parses.
  // Zero-width/format chars (U+200B–U+200D, U+FEFF) also break parsing, as do
  // non-breaking and other unicode spaces outside of strings (U+00A0 etc.
  // are NOT valid JSON whitespace) — normalize them to plain spaces.
  return text
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
    .replace(/[\u0000-\u001F]/g, ch => {
      if (ch === '\n') return '\\n';
      if (ch === '\r') return '\\r';
      if (ch === '\t') return '\\t';
      return '';
    });
}
// Text fields sometimes arrive as nested objects ({title,text}) instead of
// plain strings — unwrap them instead of producing "[object Object]".
function jstr(value, max = 500) {
  if (typeof value === 'string') return value.trim().slice(0, max);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const k of ['text', 'title', 'value', 'content', 'key']) {
      if (typeof value[k] === 'string' && value[k].trim()) return value[k].trim().slice(0, max);
    }
  }
  return '';
}
async function mistralJson(messages, maxTokens = 900, timeoutMs = 60000) {
  const content = await mistralChat(messages, maxTokens, true, timeoutMs);
  // Start at the first '{"' (guards against stray/duplicated opening braces).
  let start = content.search(/\{\s*"/);
  if (start < 0) start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Mistral returned invalid JSON');
  const raw = content.slice(start, end + 1);
  try { return JSON.parse(raw); }
  catch (e1) {
    try { return JSON.parse(sanitizeJsonText(raw)); }
    catch (e2) {
      const snippet = raw.slice(0, 200).replace(/\s+/g, ' ');
      throw new Error(`Mistral returned invalid JSON (${e2.message}). Head: ${snippet}`);
    }
  }
}

const theoryJobs = new Map();
const firstTaskJobs = new Map();
function startTopicPreparation(topic) {
  const staleTheory = topic.theory_status === 'generating' && topic.theory_started_at && Date.now() - new Date(topic.theory_started_at).getTime() > 5 * 60_000;
  const staleTask = topic.task_status === 'generating' && topic.task_started_at && Date.now() - new Date(topic.task_started_at).getTime() > 5 * 60_000;
  if (staleTheory && !theoryJobs.has(topic.id)) topic.theory_status = 'pending';
  if (staleTask && !firstTaskJobs.has(topic.id)) topic.task_status = 'pending';
  if (!topic.theory_cache && topic.theory_status === 'pending') {
    generateAndCacheTopicTheory(topic).catch(error => console.error('Topic theory generation failed:', error.message));
  }
  if (!topic.prepared_task && topic.task_status === 'pending') {
    generateAndCacheFirstTask(topic).catch(error => console.error('First task generation failed:', error.message));
  }
}
function generateAndCacheFirstTask(topic) {
  if (firstTaskJobs.has(topic.id)) return firstTaskJobs.get(topic.id);
  const job = generateFirstTaskJob(topic).finally(() => firstTaskJobs.delete(topic.id));
  firstTaskJobs.set(topic.id, job);
  return job;
}
async function generateFirstTaskJob(topic) {
  await pool.query("UPDATE topics SET task_status='generating', task_started_at=now() WHERE id=$1", [topic.id]);
  try {
    const requestedType = ['scenario_choice', 'evidence_choice', 'multiple_select', 'ordering', 'categorize'][topic.id % 5];
    const output = await mistralJson([
      { role: 'system', content: `Ты проектируешь диагностическое задание для школьного интерактивного урока. Верни JSON {"ru":{...},"kk":{...}}: одно и то же содержательное задание на русском и казахском. Формат ${requestedType}. Уровень 3 из 5: нужна работа с ситуацией, данными или причинной связью, а не повторение определения. Для каждого языка обязательны task, taskType, options (для выбора), items (для порядка), pairs (для категорий), visualSpec {kind:"concept|sequence|compare|bars",title,items:[{label,value}]}, visualCaption и answerKey {expected,accepted:[],rubric,rationale}. Для выбора answerKey.expected — точный текст верного варианта; для multiple_select — массив точных текстов; для ordering — массив всех items в правильной последовательности; для categorize — объект соответствий left:right. Сделай правдоподобные неверные варианты, однозначное условие и краткое объяснение решения. Не раскрывай ответ в тексте задания или схеме. Если формат не подходит к предмету, используй scenario_choice. Только валидный JSON.` },
      { role: 'user', content: `Тема: ${String(topic.title).slice(0, 200)}\nОписание и программа: ${String(topic.description || '').slice(0, 1500)}\nМатериал учителя: ${String(topic.theory_override || '').slice(0, 2500)}` },
    ], 2400, 90000);
    const root = findTheoryPayload(output) || output;
    const clean = {};
    for (const lang of ['ru', 'kk']) {
      clean[lang] = normalizeLessonTurn(root[lang], false);
      clean[lang].difficulty = 3;
      clean[lang].correct = null;
      clean[lang].feedback = '';
      if (!validPreparedTask(clean[lang])) throw new Error(`Incomplete or inconsistent ${lang} first task`);
    }
    await pool.query("UPDATE topics SET prepared_task=$1::jsonb, task_status='ready' WHERE id=$2", [JSON.stringify(clean), topic.id]);
  } catch (error) {
    await pool.query("UPDATE topics SET task_status='failed' WHERE id=$1", [topic.id]).catch(() => {});
    throw error;
  }
}
function validPreparedTask(task) {
  if (task.taskType === 'short_answer') return false;
  return validGeneratedTask(task);
}
function validGeneratedTask(task) {
  if (!task.task || !task.answerKey || task.answerKey.expected == null || task.answerKey.expected === '') return false;
  const expected = task.answerKey.expected;
  if (TASK_OPTION_FORMATS.has(task.taskType)) return typeof expected === 'string' && task.options.some(option => comparable(option) === comparable(expected));
  if (task.taskType === 'multiple_select') return Array.isArray(expected) && expected.length > 0 && expected.every(value => task.options.some(option => comparable(option) === comparable(value)));
  if (task.taskType === 'ordering') return Array.isArray(expected) && sameSet(expected, task.items);
  if (TASK_PAIR_FORMATS.has(task.taskType)) return expected && typeof expected === 'object' && !Array.isArray(expected) && task.pairs.length === Object.keys(expected).length && task.pairs.every(pair => Object.prototype.hasOwnProperty.call(expected, pair.left) && comparable(expected[pair.left]) === comparable(pair.right));
  if (task.taskType === 'numeric') return Number.isFinite(numericValue(expected));
  return typeof expected === 'string' || typeof expected === 'number';
}
function generateAndCacheTopicTheory(topic) {
  if (theoryJobs.has(topic.id)) return theoryJobs.get(topic.id);
  const job = generateTopicTheoryJob(topic).finally(() => theoryJobs.delete(topic.id));
  theoryJobs.set(topic.id, job);
  return job;
}
// Models don't always return the exact requested shape — sometimes the
// payload arrives nested (e.g. {response:{status,data:{ru,...}}}). Unwrap it.
function findTheoryPayload(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (obj.ru || obj.kk) return obj;
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && (v.ru || v.kk)) return v;
  }
  return null;
}
async function generateTopicTheoryJob(topic) {
  await pool.query("UPDATE topics SET theory_status='generating', theory_started_at=now() WHERE id=$1", [topic.id]);
  try {
    const theory = await mistralJson([
      { role: 'system', content: 'Ты — автор содержательных школьных мини-уроков, а не генератор конспектов. Верни JSON на русском и казахском языках. В каждом языке: intro — ОБЫЧНАЯ СТРОКА до 220 знаков (не объект) — и ровно 3 последовательные pages. Строй обучение так: 1) что это за явление/идея и зачем она нужна; 2) как рассуждать или применять её — подробно разобранный пример по шагам; 3) перенос в новый контекст, границы применения и типичная ошибка с её исправлением. На каждой странице: title, text до 750 знаков с точными понятиями и связью причин/следствий, example с реальным разбором или применением, key как короткий вывод, и visualSpec {kind: sequence|cycle|compare|bars|concept, title, items:[{label,value}]} на 2–5 пунктов. Не подменяй объяснение лозунгами и определениями в одну строку. Используй конкретику именно этой темы; для формальных тем проверь обозначения и расчёт, для ИИ различай методы, данные, обучение и вывод. Не выдумывай факты. Материал учителя учитывай в первую очередь. Схемы строятся локально из visualSpec, внешние изображения не запрашивай. JSON: {"ru":{"intro":"","pages":[{"title":"","text":"","example":"","key":"","visualSpec":{"kind":"concept","title":"","items":[{"label":"","value":""},{"label":"","value":""}]}},{"title":"","text":"","example":"","key":"","visualSpec":{"kind":"sequence","title":"","items":[{"label":"","value":""},{"label":"","value":""}]}},{"title":"","text":"","example":"","key":"","visualSpec":{"kind":"compare","title":"","items":[{"label":"","value":""},{"label":"","value":""}]}}]},"kk":{"intro":"","pages":[{"title":"","text":"","example":"","key":"","visualSpec":{"kind":"concept","title":"","items":[{"label":"","value":""},{"label":"","value":""}]}},{"title":"","text":"","example":"","key":"","visualSpec":{"kind":"sequence","title":"","items":[{"label":"","value":""},{"label":"","value":""}]}},{"title":"","text":"","example":"","key":"","visualSpec":{"kind":"compare","title":"","items":[{"label":"","value":""},{"label":"","value":""}]}}]}}' },
      { role: 'user', content: `Тема: ${topic.title}\nОписание: ${topic.description || ''}\nМатериал учителя: ${topic.theory_override || 'не указан'}` },
    ], 4500, 300000);
    const root = findTheoryPayload(theory) || {};
    const clean = {};
    for (const lang of ['ru', 'kk']) {
      const version = root[lang] || root.ru;
      clean[lang] = {
        intro: jstr(version?.intro, 260),
        pages: (Array.isArray(version?.pages) ? version.pages : []).slice(0, 3).map(page => ({
          title: jstr(page?.title, 100), text: jstr(page?.text, 850),
          example: jstr(page?.example, 400), key: jstr(page?.key, 240),
          visualSpec: cleanVisualSpec(page?.visualSpec) || { kind: 'concept', title: jstr(page?.title, 100), items: [{ label: jstr(page?.title, 60) || 'Тема', value: 'идея' }, { label: 'Пример', value: jstr(page?.key || page?.text, 60) }] },
        })),
      };
      if (clean[lang].pages.length < 3 || !clean[lang].intro) throw new Error(`Incomplete ${lang} theory`);
    }
    await pool.query("UPDATE topics SET theory_cache=$1::jsonb, theory_status='ready', theory_version=2 WHERE id=$2", [JSON.stringify(clean), topic.id]);
  } catch (error) {
    await pool.query("UPDATE topics SET theory_status='failed' WHERE id=$1", [topic.id]).catch(() => {});
    throw error;
  }
}

const SYSTEM_RU = `Ты — сильный школьный учитель и автор интерактивных уроков. Пиши только по-русски, простыми точными словами, без эмодзи, сюсюканья и длинных лекций. Урок должен ощущаться как живое занятие: короткая мысль → наглядный пример → действие ученика → конкретная обратная связь.
ТЕОРИЯ ГОТОВИТСЯ ОТДЕЛЬНО ДО УРОКА. В ответах практики всегда оставляй поля theory, theoryBlocks, theoryVisualPrompt и theoryVisualCaption пустыми. Сразу создавай только очередную интерактивную задачу.
КАЖДЫЙ ХОД: придумай одно новое задание по теме, лучше в содержательном контексте (эксперимент, мини-ситуация, выбор стратегии, ошибка персонажа, наблюдение за рисунком/схемой). Чередуй 15 форматов: choice (один вариант), true_false, multiple_select (несколько правильных), ordering, matching, short_answer, fill_blank, numeric, categorize, diagnose_error, predict, scenario_choice, evidence_choice, table_read, explain. Не повторяй формат из последних трёх без причины; на ошибке закрепи навык другим способом. Указывай правильный формат и соответствующие options/items/pairs. Для каждого формата заполни соответствующие поля: options, items или pairs. В задании ровно одна понятная цель; вопрос должен иметь проверяемый ответ. Для short формулируй вопрос так, чтобы ответ был коротким и однозначным.
ВИЗУАЛЫ: подготовь visualPrompt как краткое смысловое описание и visualSpec как структурированные данные локальной SVG-схемы (kind: sequence/cycle/compare/bars/concept; title; 2–5 items с label/value). Схема должна показывать ход процесса, отношения или данные задачи; подписи и числа должны совпадать с условием. Это векторная иллюстрация, а не фотография. Промпт должен описывать один чёткий учебный кадр, спокойную книжную иллюстрацию/инфографику без неона, без декоративного текста и без готового ответа. Само задание должно содержать все точные подписи/числа, нужные для решения: не полагайся на надписи внутри изображения. Добавь короткие подписи к изображениям. Не используй случайные стоковые сцены вместо точной учебной визуализации.
ПРОВЕРКА: оцени только последний ответ по последнему заданию и его формату. Допускай эквивалентные записи и ясные мелкие опечатки. Будь строгим к смыслу, но не к способу записи. feedback кратко говорит, что понял ученик, и что поправить; при верном ответе объясни почему это верно, а не просто хвали.
АДАПТАЦИЯ: уровень 1–5 дан во входе. После ошибки объясни слабое место и дай на том же навыке другую, проще устроенную задачу. После верного ответа проверь перенос навыка в новый контекст, затем постепенно усложняй. Веди журнал последних форматов и не повторяй предыдущий тип без причины. Не перескакивай с темы.
КЛЮЧ ОТВЕТА: для каждого задания обязательно заполни answerKey. Для choice/true_false/scenario_choice/evidence_choice/table_read укажи expected как точный текст правильного варианта. Для multiple_select — expected как массив точных текстов всех правильных вариантов. Для ordering — массив элементов в правильном порядке. Для matching/categorize — объект «левая часть»: «правильная правая часть/категория». Для numeric — число (без единицы измерения) и tolerance. Для коротких открытых ответов заполни expected и accepted массивом разумных смысловых формулировок. Для explain/diagnose_error/predict задай эталонный ответ и rubric из 1–3 проверяемых смысловых критериев; не делай эталон неоднозначным. Никогда не ставь options, answerKey и формулировку вопроса в противоречие.
СЛОЖНОСТЬ: первый вопрос — диагностический уровня 3/5, не тривиальный. Уровень 1 — базовый шаг с опорой; 2 — применение правила; 3 — перенос на новый контекст или 2 шага рассуждения; 4 — сравнение стратегий, данных или исключений; 5 — обоснованный вывод/многошаговая задача. Не путай сложность с длинным текстом. Не используй очевидные отвлекающие варианты, вопросы на угадывание термина или задания, где достаточно переписать определение. Каждый правильный вариант должен быть обоснован условием, а проверяемый ключ должен совпадать с ним.
НЕ ЗАВЕРШАЙ УРОК САМОСТОЯТЕЛЬНО. Верни только валидный JSON с полями: {"theory":"короткий лид, только в начале","theoryBlocks":[{"title":"...","text":"..."}],"theoryVisualPrompt":"...","theoryVisualCaption":"...","feedback":"...","task":"...","taskType":"choice|true_false|multiple_select|ordering|matching|short_answer|fill_blank|numeric|categorize|diagnose_error|predict|scenario_choice|evidence_choice|table_read|explain","options":["..."],"items":["..."],"pairs":[{"left":"...","right":"..."}],"answerKey":{"expected":"строка, число, массив или объект соответствующего формату","accepted":["допустимая формулировка"],"rubric":"критерии для свободного ответа","rationale":"короткое объяснение","tolerance":0},"visualPrompt":"...","visualCaption":"...","visualSpec":{"kind":"sequence|cycle|compare|bars|concept","title":"...","items":[{"label":"...","value":"..."},{"label":"...","value":"..."}]},"correct":true|false|null}. Неиспользуемые массивы верни пустыми; на первом ходе correct=null и feedback пустой.`;

const SYSTEM_KK = `Сен — тәжірибелі мектеп мұғалімі әрі интерактивті сабақ авторысың. Тек қазақша жаз, қарапайым әрі нақты тіл қолдан; эмодзи, еркелету сөздері мен ұзақ дәрістен аулақ бол. Сабақ тірі сабақтай сезілсін: қысқа ой → көрнекі мысал → оқушы әрекеті → нақты кері байланыс.
ТЕОРИЯ САБАҚТАН БҰРЫН БӨЛЕК ДАЙЫНДАЛАДЫ. Практика жауаптарында theory, theoryBlocks, theoryVisualPrompt және theoryVisualCaption өрістерін бос қалдыр. Тек келесі интерактивті тапсырманы жаса.
ӘР ҚАДАМДА: тақырыпқа сай жаңа тапсырма құрастыр; тәжірибе, шағын жағдай, стратегия таңдау, кейіпкер қатесін табу немесе сурет/сызбаны бақылау сияқты мағыналы контекст таңда. 15 форматты алмастыр: choice, true_false, multiple_select, ordering, matching, short_answer, fill_blank, numeric, categorize, diagnose_error, predict, scenario_choice, evidence_choice, table_read, explain. Соңғы үш форматты себепсіз қайталама. Құрылымды форматтардың тиісті массивтерін нақты толтыр. Тиісті options, items немесе pairs өрістерін толтыр. Бір тапсырмада бір ғана анық мақсат және тексерілетін жауап болсын.
КӨРНЕКІ МАТЕРИАЛ: visualPrompt қысқа мағыналық сипаттама болсын, ал visualSpec жергілікті SVG сызбасын құратын деректерді берсін (kind: sequence/cycle/compare/bars/concept; title; label/value бар 2–5 item). Сызба үдерісті, байланысты не есеп деректерін көрсетсін; белгілер мен сандар шартқа сай болсын. Бұл — векторлық көрнекілік, фото емес. Бір нақты оқу көрінісін сипатта; сабырлы оқулық иллюстрациясы/инфографикасы болсын, неонсыз, сәндік жазусыз және дайын жауапсыз. Шешуге керекті нақты атаулар мен сандар тапсырма мәтінінде болсын — суреттегі жазуға тәуелді болма. Қысқа сурет сипаттамасын да бер. Дәл пәндік көрнекіліктің орнына кездейсоқ фотосурет ұсынба.
ТЕКСЕРУ: тек соңғы жауапты соңғы тапсырма және оның форматы бойынша бағала. Мағынасы бірдей жазылым мен түсінікті ұсақ қатені қабылда. Мағынаға мұқият бол, жазу тәсіліне емес. feedback оқушының нені түсінгенін және нені түзету керегін қысқаша айтсын; дұрыс болса, неге дұрыс екенін түсіндір.
БЕЙІМДЕУ: кірісте 1–5 деңгей беріледі. Қате болса, әлсіз тұсты түсіндіріп, сол дағдыға басқа әрі жеңіл тапсырма бер. Дұрыс болса, дағдыны жаңа жағдайда тексеріп, кейін біртіндеп күрделендір. Соңғы форматтарды қарап, себепсіз бір типті қайталама. Тақырыптан ауытқыма.
ЖАУАП КІЛТІ: әр тапсырмаға answerKey міндетті түрде толтыр. choice/true_false/scenario_choice/evidence_choice/table_read үшін expected — дұрыс нұсқаның дәл мәтіні. multiple_select үшін expected — барлық дұрыс жауап мәтіндерінің массиві. ordering үшін дұрыс реттегі массив. matching/categorize үшін «сол жақ элемент»: «дұрыс жұбы/санаты» объектісі. numeric үшін tolerance мәнімен сан. Ашық қысқа жауапқа expected және мағынасы бірдей accepted тұжырымдарын бер. explain/diagnose_error/predict үшін эталон жауап пен 1–3 тексерілетін өлшемнен тұратын rubric бер. answerKey, нұсқалар мен сұрақ бір-біріне қайшы болмасын.
КҮРДЕЛІЛІК: бірінші сұрақ 3/5 деңгейінде болсын, тривиалды болмасын. 1 — тірекпен негізгі қадам; 2 — ережені қолдану; 3 — жаңа жағдайға көшіру не екі қадамды ойлау; 4 — стратегияларды, деректерді не ерекшеліктерді салыстыру; 5 — негізделген қорытынды/көпқадамды есеп. Ұзақ мәтін күрделілік емес. Анық емес алаңдатқыштар мен анықтаманы көшіруді талап ететін сұрақтарды қолданба.
Сабақты өз бетіңше аяқтама. Тек валидті JSON қайтар: {"theory":"қысқа кіріспе, тек басында","theoryBlocks":[{"title":"...","text":"..."}],"theoryVisualPrompt":"...","theoryVisualCaption":"...","feedback":"...","task":"...","taskType":"choice|true_false|multiple_select|ordering|matching|short_answer|fill_blank|numeric|categorize|diagnose_error|predict|scenario_choice|evidence_choice|table_read|explain","options":["..."],"items":["..."],"pairs":[{"left":"...","right":"..."}],"answerKey":{"expected":"жол, сан, массив немесе форматқа сай объект","accepted":["қабылданатын тұжырым"],"rubric":"ашық жауап критерийлері","rationale":"қысқа түсініктеме","tolerance":0},"visualPrompt":"...","visualCaption":"...","visualSpec":{"kind":"sequence|cycle|compare|bars|concept","title":"...","items":[{"label":"...","value":"..."},{"label":"...","value":"..."}]},"correct":true|false|null}. Қолданылмайтын массивтер бос болсын; бірінші қадамда correct=null, feedback бос.`;

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

function masteryState(outcomes) {
  const recent = outcomes.slice(-8);
  const correct = recent.filter(Boolean).length;
  const accuracy = recent.length ? correct / recent.length : 0;
  const lastThreeCorrect = outcomes.slice(-3).filter(Boolean).length;
  const mastered = outcomes.length >= 6 && recent.length >= 6 && accuracy >= 0.75 && lastThreeCorrect >= 2;
  const progress = Math.round(Math.min(1, outcomes.length / 6) * Math.min(1, accuracy / 0.75) * 100);
  return {
    mastery: mastered ? 100 : Math.min(95, progress),
    answered: outcomes.length,
    mastered,
  };
}

function targetDifficulty(entries, correct) {
  const last = entries[entries.length - 1];
  const current = Number(last?.difficulty) || 2.5;
  if (correct === null) return Math.max(1, Math.min(5, current));
  const change = correct ? 0.5 : -0.75;
  return Math.max(1, Math.min(5, Math.round((current + change) * 2) / 2));
}

const TASK_FORMATS = ['choice', 'true_false', 'multiple_select', 'ordering', 'matching', 'short_answer', 'fill_blank', 'numeric', 'categorize', 'diagnose_error', 'predict', 'scenario_choice', 'evidence_choice', 'table_read', 'explain'];
const TASK_OPTION_FORMATS = new Set(['choice', 'true_false', 'scenario_choice', 'evidence_choice', 'table_read']);
const TASK_PAIR_FORMATS = new Set(['matching', 'categorize']);
const answerText = (value, max = 500) => String(value ?? '').trim().slice(0, max);
function cleanAnswerKey(input) {
  if (input === undefined || input === null) return null;
  const value = input && typeof input === 'object' && !Array.isArray(input)
    ? (input.expected ?? input.answer ?? input.value ?? null)
    : input;
  const clean = item => typeof item === 'object' && item !== null
    ? Object.fromEntries(Object.entries(item).slice(0, 8).map(([k, v]) => [answerText(k, 120), answerText(v, 180)]))
    : answerText(item, 300);
  const accepted = Array.isArray(input?.accepted) ? input.accepted.slice(0, 8).map(clean).filter(Boolean) : [];
  const expected = Array.isArray(value) ? value.slice(0, 8).map(clean) : clean(value);
  return {
    expected,
    accepted,
    rubric: answerText(input?.rubric, 700),
    rationale: answerText(input?.rationale, 500),
    tolerance: Number.isFinite(Number(input?.tolerance)) ? Math.max(0, Math.min(Number(input.tolerance), 1e6)) : null,
  };
}
function cleanVisualSpec(input) {
  if (!input || typeof input !== 'object') return null;
  const kinds = new Set(['sequence', 'cycle', 'compare', 'bars', 'concept']);
  const kind = kinds.has(input.kind) ? input.kind : 'concept';
  const items = Array.isArray(input.items) ? input.items.slice(0, 5).map(item => ({
    label: String(item?.label || '').trim().slice(0, 60),
    value: String(item?.value || '').trim().slice(0, 60),
  })).filter(item => item.label) : [];
  return items.length >= 2 ? { kind, title: String(input.title || '').trim().slice(0, 100), items } : null;
}
function normalizeLessonTurn(value, firstTurn) {
  const ai = value && typeof value === 'object' ? value : {};
  const text = (input, max) => jstr(input, max);
  const legacyType = { order: 'ordering', match: 'matching', short: 'short_answer' };
  let taskType = TASK_FORMATS.includes(ai.taskType) ? ai.taskType : legacyType[ai.taskType] || 'short_answer';
  const options = Array.isArray(ai.options) ? ai.options.map(x => text(x, 180)).filter(Boolean).slice(0, 6) : [];
  const items = Array.isArray(ai.items) ? ai.items.map(x => text(x, 180)).filter(Boolean).slice(0, 6) : [];
  const pairs = Array.isArray(ai.pairs) ? ai.pairs.slice(0, 5).map(x => ({ left: text(x?.left, 160), right: text(x?.right, 160) })).filter(x => x.left && x.right) : [];
  if ((TASK_OPTION_FORMATS.has(taskType) || taskType === 'multiple_select') && options.length < 2) taskType = 'short_answer';
  if (taskType === 'ordering' && items.length < 3) taskType = 'short_answer';
  if (TASK_PAIR_FORMATS.has(taskType) && pairs.length < 2) taskType = 'short_answer';
  const theoryBlocks = firstTurn && Array.isArray(ai.theoryBlocks)
    ? ai.theoryBlocks.slice(0, 4).map(x => ({ title: text(x?.title, 100), text: text(x?.text, 500) })).filter(x => x.title || x.text)
    : [];
  return {
    theory: firstTurn ? text(ai.theory, 700) : '',
    theoryBlocks,
    theoryVisualPrompt: firstTurn ? text(ai.theoryVisualPrompt, 1400) : '',
    theoryVisualCaption: firstTurn ? text(ai.theoryVisualCaption, 240) : '',
    feedback: text(ai.feedback, 1000),
    task: text(ai.task, 1400),
    taskType,
    options: TASK_OPTION_FORMATS.has(taskType) || taskType === 'multiple_select' ? options : [],
    items: taskType === 'ordering' ? items : [],
    pairs: TASK_PAIR_FORMATS.has(taskType) ? pairs : [],
    visualPrompt: text(ai.visualPrompt, 1400),
    visualCaption: text(ai.visualCaption, 240),
    visualSpec: cleanVisualSpec(ai.visualSpec),
    answerKey: cleanAnswerKey(ai.answerKey),
    correct: typeof ai.correct === 'boolean' ? ai.correct : null,
  };
}

function comparable(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase('ru')
    .replace(/ё/g, 'е').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ')
    .trim().replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, '');
}
function numericValue(value) {
  const compact = String(value ?? '').replace(/\s/g, '').replace(',', '.');
  const fraction = compact.match(/^([+-]?\d+)\/([+-]?\d+)$/);
  if (fraction && Number(fraction[2]) !== 0) return Number(fraction[1]) / Number(fraction[2]);
  const match = compact.match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i);
  return match ? Number(match[0]) : NaN;
}
function exactSame(a, b) {
  return comparable(a) !== '' && comparable(a) === comparable(b);
}
function sameSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const left = a.map(comparable).sort(), right = b.map(comparable).sort();
  return left.every((value, index) => value && value === right[index]);
}
function gradeDeterministically(task, submitted) {
  const key = task.answerKey;
  if (!key) return null;
  const expected = key.expected;
  if (TASK_OPTION_FORMATS.has(task.taskType)) {
    const answer = String(submitted ?? '');
    const expectedText = String(expected ?? '');
    const opts = Array.isArray(task.options) ? task.options : [];
    const choiceIndex = value => {
      const token = comparable(value);
      const byText = opts.findIndex(option => exactSame(option, token));
      if (byText >= 0) return byText;
      if (/^[1-9]\d?$/.test(token)) return Number(token) - 1;
      const letters = { a: 0, а: 0, b: 1, б: 1, c: 2, в: 2, d: 3, г: 3, e: 4, д: 4, f: 5, е: 5 };
      return Object.prototype.hasOwnProperty.call(letters, token) ? letters[token] : -1;
    };
    const actualIndex = choiceIndex(answer), expectedIndex = choiceIndex(expectedText);
    const correct = expectedIndex >= 0 && expectedIndex < opts.length && actualIndex === expectedIndex;
    return { correct: Boolean(correct), basis: 'key' };
  }
  if (task.taskType === 'multiple_select') {
    const submittedItems = Array.isArray(submitted) ? submitted : [submitted];
    const expectedItems = Array.isArray(expected) ? expected : [expected];
    return { correct: sameSet(submittedItems, expectedItems), basis: 'key' };
  }
  if (task.taskType === 'ordering') {
    const submittedItems = Array.isArray(submitted) ? submitted : String(submitted ?? '').split(/\s*(?:>|→|,)\s*/);
    return { correct: Array.isArray(expected) && submittedItems.length === expected.length && expected.every((item, index) => exactSame(item, submittedItems[index])), basis: 'key' };
  }
  if (TASK_PAIR_FORMATS.has(task.taskType)) {
    if (!submitted || typeof submitted !== 'object' || Array.isArray(submitted) || !expected || typeof expected !== 'object' || Array.isArray(expected)) return { correct: false, basis: 'key' };
    const entries = Object.entries(expected);
    return { correct: entries.length === Object.keys(submitted).length && entries.every(([left, right]) => exactSame(submitted[left], right)), basis: 'key' };
  }
  if (task.taskType === 'numeric') {
    const actual = numericValue(submitted), wanted = numericValue(expected);
    const tolerance = Number.isFinite(key.tolerance) ? key.tolerance : Math.max(1e-8, Math.abs(wanted) * 1e-6);
    return { correct: Number.isFinite(actual) && Number.isFinite(wanted) && Math.abs(actual - wanted) <= tolerance, basis: 'key' };
  }
  const variants = [expected, ...(Array.isArray(key.accepted) ? key.accepted : [])].filter(value => typeof value === 'string' && value.trim());
  if (variants.some(value => exactSame(submitted, value))) return { correct: true, basis: 'key' };
  return null;
}
async function gradeOpenAnswer(task, submitted, lang) {
  const key = task.answerKey || {};
  const expected = key.expected ?? 'Сравни ответ с условием задания и оцени по критериям.';
  const result = await mistralJson([
    { role: 'system', content: lang === 'kk'
      ? 'Сен оқушы жауабын әділ бағалайтын пән мұғалімісің. Бағалау өлшемін қолдан. Мағынасы дұрыс баламаларды қабылда, тек сөзбе-сөз сәйкес келмеуі үшін қатені белгілеме. Тек JSON қайтар: {"correct":true|false,"assessment":"Оқушы жауабындағы нақты дұрыс не жетіспейтін ой, бағалау сөздерінсіз","expected":"Қысқа дұрыс жауап"}. assessment ішінде «дұрыс/қате» деп үкім шығарма. Толық емес жауап — false.'
      : 'Ты проверяешь ответ как справедливый учитель-предметник. Следуй критериям проверки. Принимай правильные ответы, сформулированные другими словами; не считай ошибкой только за несовпадение формулировки. Верни только JSON: {"correct":true|false,"assessment":"конкретно какой смысловой элемент ответа совпал или отсутствует, без словесного вердикта","expected":"краткий правильный ответ"}. В assessment не пиши «верно/неверно». Неполный ответ оцени false.' },
    { role: 'user', content: JSON.stringify({ task: task.task, format: task.taskType, choices: task.options, answerKey: expected, accepted: key.accepted || [], rubric: key.rubric || '', studentAnswer: submitted }) },
  ], 300);
  return { correct: result.correct === true, assessment: answerText(result.assessment, 400), expected: answerText(result.expected || expected, 300), basis: 'ai' };
}
function formatGradingFeedback(grade, task, lang) {
  const rawExpected = task.answerKey?.expected;
  const expected = grade.expected || (typeof rawExpected === 'string' || typeof rawExpected === 'number'
    ? String(rawExpected)
    : Array.isArray(rawExpected) ? rawExpected.join(', ')
      : rawExpected && typeof rawExpected === 'object' ? Object.entries(rawExpected).map(([left, right]) => `${left} → ${right}`).join('; ') : '');
  let explanation = grade.assessment || task.answerKey?.rationale || task.answerKey?.rubric || '';
  const contradictory = grade.correct
    ? /(?:неверн|ошиб|неправильн|не соответствует|қате|дұрыс емес)/i
    : /(?:верно|правильн|ответ соответствует|полностью вер|дұрыс|сәйкес келеді)/i;
  if (contradictory.test(explanation)) explanation = task.answerKey?.rationale || task.answerKey?.rubric || '';
  if (grade.correct) return lang === 'kk'
    ? `Дұрыс. ${explanation || 'Жауабың тапсырманың шартына сәйкес келеді.'}`
    : `Верно. ${explanation || 'Твой ответ соответствует условию задания.'}`;
  const prefix = lang === 'kk' ? 'Әлі дұрыс емес.' : 'Пока неверно.';
  const detail = explanation ? ` ${explanation}` : '';
  const correct = expected ? (lang === 'kk' ? ` Дұрыс жауап: ${expected}.` : ` Правильный ответ: ${expected}.`) : '';
  return `${prefix}${detail}${correct}`;
}

async function adaptiveTurn({ topic, lang, history, answer, grading = null, difficulty, firstTurn, teacherExamples = [] }) {
  const previousTaskEntry = [...parseTeacherEntries(history)].reverse().find(entry => entry.task);
  const priorOutcomes = parseTeacherEntries(history).filter(entry => typeof entry.correct === 'boolean').map(entry => entry.correct);
  const previousType = previousTaskEntry?.taskType;
  const recentTypes = parseTeacherEntries(history).filter(entry => entry.taskType).slice(-4).map(entry => entry.taskType);
  const availableTypes = TASK_FORMATS.filter(type => !recentTypes.slice(-3).includes(type));
  const preferredType = previousType && TASK_FORMATS.includes(previousType)
    ? availableTypes[(TASK_FORMATS.indexOf(previousType) + Math.floor(Math.random() * Math.max(1, availableTypes.length))) % availableTypes.length]
    : availableTypes[Math.floor(Math.random() * availableTypes.length)];
  const context = history.slice(-16).map(item => ({
    role: item.role,
    text: item.role === 'teacher' ? (() => { try { const v = JSON.parse(item.text); return JSON.stringify({ task: v.task, taskType: v.taskType, options: v.options, items: v.items, pairs: v.pairs, feedback: v.feedback, correct: v.correct, difficulty: v.difficulty }); } catch { return ''; } })() : String(item.text || '').slice(0, 500),
  }));
  const teacherReference = String(topic.theory_override || '').slice(0, 2000);
  const examples = teacherExamples.slice(0, 8).map(item => ({
    prompt: String(item.prompt || '').slice(0, 240), kind: String(item.kind || '').slice(0, 30),
    answer: String(item.answer || '').slice(0, 120),
    options: Array.isArray(item.options) ? item.options.slice(0, 6).map(x => String(x).slice(0, 100)) : [],
  }));
  const prompt = `Тема: ${String(topic.title || '').slice(0, 300)}\nОписание учителя: ${String(topic.description || '').slice(0, 1000)}\nМатериал учителя для точности: ${teacherReference || 'не задан'}\nПримеры заданий учителя для понимания охвата темы (не копируй дословно; сам придумай новое): ${JSON.stringify(examples)}\nСейчас обязательно выбери формат ${preferredType} (если объективно невозможно — выбери ближайший другой формат из списка, но избегай последних: ${recentTypes.join(', ')}).\nДоступные форматы: choice — выбрать один ответ; true_false — оценить утверждение; multiple_select — отметить все подходящие варианты (минимум 2 правильных); ordering — расположить 3–5 карточек по правилу; matching — соединить 3–4 пары; short_answer — короткий свободный ответ; fill_blank — вставить недостающее слово/значение в предложение; numeric — вычислить число с единицами; categorize — распределить 3–5 понятий по категориям, pairs содержит {left: понятие, right: категория}; diagnose_error — найти и объяснить конкретную ошибку в решении; predict — предсказать результат опыта/изменения условия; scenario_choice — принять решение в практической ситуации, 4 варианта; evidence_choice — выбрать вывод, подтверждённый данными/фактами, 4 варианта; table_read — ответить на вопрос по маленькой таблице, представленной прямо в тексте, 4 варианта; explain — объяснить причинно-следственную связь в 1–2 предложениях.\nПоследние форматы: ${recentTypes.join(', ') || 'нет'}.\nСложность следующего задания: ${difficulty} из 5. Уровни: 1 — простой шаг с опорой, 2 — применение правила, 3 — перенос или два шага, 4 — анализ условий/исключений/данных, 5 — самостоятельное обоснование и многошаговый перенос. Первый вопрос тоже должен быть минимум диагностического уровня 3. Не делай задачу тривиальной, не спрашивай просто определение, не используй нелепые отвлекающие варианты и повторение теории своими словами. Требуй рассуждения по предмету, а не длинного ответа. Для выбора каждый вариант должен быть правдоподобен и отражать конкретное заблуждение. После правильного ответа усложни ход мысли или контекст; после ошибки сохрани тот же учебный навык, добавь опору.\nПроверенные ответы до этого хода: ${priorOutcomes.length}.\nПредыдущая задача: ${String(previousTaskEntry?.task || 'начало практики').slice(0, 600)}\nОтвет ученика: ${answer === null ? 'ещё не отвечал' : String(answer).slice(0, 1000)}\nНезависимый результат проверки этого ответа: ${grading ? JSON.stringify({ correct: grading.correct, assessment: grading.assessment, expected: grading.expected }) : 'ответ не проверялся, это первый ход'}. Не меняй этот вердикт, если ответ проверялся; сформулируй своё собственное следующее задание на основании слабого места или продемонстрированного навыка.\nКонтекст недавних ходов: ${JSON.stringify(context)}\n\nТеория подготовлена заранее. theory, theoryBlocks, theoryVisualPrompt, theoryVisualCaption верни пустыми. Если ответ уже проверен, feedback можешь оставить пустым: сервер сам построит его из оценки. На первом ходе correct=null. Создай ровно одно новое задание в содержательном контексте, с однозначным условием, проверяемым ключом и заполни answerKey.expected точно в соответствии с задачей и options/items/pairs; для свободного ответа добавь accepted либо проверяемый rubric. Заполни соответствующие массивы. Не повторяй недавний сюжет и числа. Не завершай урок самостоятельно.`;
  return mistralJson([
    { role: 'system', content: lang === 'kk' ? SYSTEM_KK : SYSTEM_RU },
    { role: 'user', content: prompt },
  ], 1100);
}

async function saveProgress(prog, history, topicId, studentKey, studentId, answered = true) {
  // score = number of correct answers (not teacher turns)
  let score = 0;
  for (const h of history) {
    if (h.role !== 'teacher') continue;
    try { if (JSON.parse(h.text).correct === true) score++; } catch { /* ignore */ }
  }
  await pool.query(
    'UPDATE progress SET history=$1::jsonb, score=$2, attempts=attempts+$5, updated_at=now(), student_id=COALESCE(student_id,$4) WHERE id=$3',
    [JSON.stringify(history.slice(-80)), score, prog.id, studentId, answered ? 1 : 0]);
}

app.post('/api/ai/turn', authStudent, async (req, res) => {
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
  const hasAnswer = answer !== undefined && answer !== null && answer !== '';
  const answerText = hasAnswer
    ? (typeof answer === 'string' ? answer.slice(0, 2000) : JSON.stringify(answer).slice(0, 2000))
    : null;

  const topic = (await pool.query('SELECT * FROM topics WHERE id=$1', [topicId])).rows[0];
  if (!topic) return res.status(404).json({ error: 'topic_not_found' });
  if (!topic.published) return res.status(404).json({ error: 'topic_not_found' });
  const teacherExamples = (await pool.query('SELECT kind, prompt, answer, options FROM tasks WHERE topic_id=$1 ORDER BY id LIMIT 8', [topicId])).rows;

  let prog = (await pool.query('SELECT * FROM progress WHERE topic_id=$1 AND student_key=$2', [topicId, studentKey])).rows[0];
  if (!prog) {
    prog = (await pool.query(
      'INSERT INTO progress (topic_id, student_key, history) VALUES ($1,$2,$3::jsonb) RETURNING *',
      [topicId, studentKey, '[]'])).rows[0];
  }

  const history = prog.history || [];
  const teacherEntries = parseTeacherEntries(history);
  const firstTurn = teacherEntries.length === 0;
  const outcomes = teacherEntries.filter(e => typeof e.correct === 'boolean').map(e => e.correct);
  const currentMastery = masteryState(outcomes);
  if (prog.completed) {
    return res.json({
      theory: '', theoryBlocks: [], theoryVisualPrompt: '', visualPrompt: '',
      feedback: DONE_MSG[lang], task: '', correct: null, taskType: 'short',
      difficulty: Number(teacherEntries[teacherEntries.length - 1]?.difficulty) || 1,
      ...currentMastery, mastered: true, alreadyCompleted: true,
    });
  }
  if (!hasAnswer && !firstTurn) {
    const latest = teacherEntries[teacherEntries.length - 1];
    const first = teacherEntries[0];
    return res.json({
      ...((({ answerKey, ...publicTurn }) => publicTurn)(latest)),
      taskType: latest.taskType || (latest.taskKind === 'choice' ? 'choice' : 'short'),
      theory: first.theory || '', theoryBlocks: first.theoryBlocks || [],
      theoryVisualPrompt: first.theoryVisualPrompt || '', theoryVisualCaption: first.theoryVisualCaption || '',
      mastery: currentMastery.mastery, answered: currentMastery.answered,
      mastered: false, resumed: true,
    });
  }
  if (!hasAnswer && firstTurn) {
    if (!topic.prepared_task || topic.task_status !== 'ready') {
      if (topic.task_status === 'failed') return res.status(503).json({ error: 'first_task_unavailable' });
      startTopicPreparation(topic);
      return res.status(202).json({ status: 'preparing_first_task' });
    }
    const prepared = topic.prepared_task[lang] || topic.prepared_task.ru;
    if (!prepared?.task || !prepared?.answerKey) return res.status(503).json({ error: 'first_task_unavailable' });
    const initial = { ...prepared, correct: null, feedback: '', difficulty: 3, ...currentMastery };
    history.push({ role: 'teacher', text: JSON.stringify(initial) });
    await saveProgress(prog, history, topicId, studentKey, studentId, false);
    const { answerKey, ...publicTurn } = initial;
    return res.json(publicTurn);
  }
  let grading = null;
  if (hasAnswer) {
    const activeTask = [...teacherEntries].reverse().find(entry => entry.task);
    if (!activeTask) return res.status(409).json({ error: 'no_active_task' });
    grading = gradeDeterministically(activeTask, answer);
    if (!grading) {
      try { grading = await gradeOpenAnswer(activeTask, answerText, lang); }
      catch (error) {
        console.error('Answer grading failed:', error.message);
        return res.status(502).json({ error: 'grading_unavailable' });
      }
    }
    grading.feedback = formatGradingFeedback(grading, activeTask, lang);
  }
  if (hasAnswer) history.push({ role: 'student', text: answerText });

  try {
    const nextDifficulty = hasAnswer ? targetDifficulty(teacherEntries, grading.correct) : targetDifficulty(teacherEntries, null);
    let ai;
    for (let attempt = 0; attempt < 2; attempt++) {
      const generated = await adaptiveTurn({ topic, lang, history, answer: answerText, grading,
        difficulty: nextDifficulty, firstTurn, teacherExamples });
      ai = normalizeLessonTurn(generated, false);
      if (validGeneratedTask(ai)) break;
      if (attempt === 1) throw new Error('Mistral returned an inconsistent task key');
    }
    ai.correct = hasAnswer ? grading.correct : null;
    if (hasAnswer) ai.feedback = grading.feedback;
    ai.difficulty = nextDifficulty;
    if (firstTurn && !ai.theoryVisualPrompt) {
      ai.theoryVisualPrompt = `A clear, calm school textbook illustration explaining the idea of ${topic.title}: ${ai.theory.slice(0, 260)}. No labels, no lettering, no answer.`;
    }
    if (!ai.visualPrompt) {
      ai.visualPrompt = `One calm educational illustration for a school lesson about ${topic.title}, showing this situation: ${ai.task.slice(0, 320)}. No labels, no lettering, no answer.`;
    }
    if (!ai.task) throw new Error('Mistral did not provide the next task');

    const nextOutcomes = hasAnswer ? [...outcomes, ai.correct] : outcomes;
    const progress = masteryState(nextOutcomes);
    Object.assign(ai, progress);
    if (hasAnswer && progress.mastered) {
      ai.task = '';
      ai.feedback = `${ai.feedback} ${DONE_MSG[lang]}`.trim();
    }
    const privateAnswerKey = ai.answerKey;
    delete ai.answerKey;
    history.push({ role: 'teacher', text: JSON.stringify({ ...ai, answerKey: privateAnswerKey }) });
    await saveProgress(prog, history, topicId, studentKey, studentId);
    if (hasAnswer && progress.mastered) {
      await pool.query('UPDATE progress SET completed=true WHERE id=$1', [prog.id]);
      if (ai.correct) await awardXp(studentId, 10);
      await awardXp(studentId, 50);
    } else if (hasAnswer && ai.correct) {
      await awardXp(studentId, 10);
    } else {
      await touchActive(studentId);
    }
    res.json(ai);
  } catch (e) {
    console.error('Adaptive lesson generation failed', e);
    res.status(500).json({ error: 'ai_error' });
  }
});

app.post('/api/ai/voice', authStudent, async (req, res) => {
  const { topicId } = req.body || {};
  const history = Array.isArray(req.body?.history) ? req.body.history : [];
  const lang = req.body?.lang === 'kk' ? 'kk' : 'ru';
  const topicRow = (await pool.query('SELECT title, description, theory_cache, published FROM topics WHERE id=$1', [topicId])).rows[0];
  if (!topicRow?.published) return res.status(404).json({ error: 'topic_not_found' });
  const theory = topicRow.theory_cache?.[lang] || topicRow.theory_cache?.ru;
  const lessonContext = theory ? [theory.intro, ...theory.pages.flatMap(page => [page.title, page.text, page.example, page.key])].filter(Boolean).join('\n').slice(0, 6500) : '';
  const currentTask = String(req.body?.currentTask || '').slice(0, 900);
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
    const reply = await mistralChat([
        { role: 'system', content: `${SYSTEM_VOICE[lang]}\nТы сопровождаешь конкретный урок. Отвечай по теме и данным ниже; если ученик просит подсказку к текущей задаче, дай первый шаг и вопрос для размышления, не называя готовый вариант ответа. Если в материале нет нужного факта, объясни, что это общий ответ, и не выдумывай содержимое урока. Тема: ${String(topicRow.title).slice(0, 200)}. Описание: ${String(topicRow.description || '').slice(0, 800)}. Теория урока: ${lessonContext}. Текущая задача: ${currentTask}.` },
        ...turns,
      ], 380);
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

app.post('/api/voice/tts', authStudent, async (req, res) => {
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
