// server.js (ESM-safe)
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import sqlite3 from 'sqlite3';
import nodemailer from 'nodemailer';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

// --- __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Safe env getters (avoid using "||" directly for module init)
const envOr = (key, fallback) =>
  (typeof process.env[key] !== 'undefined' && process.env[key] !== '')
    ? process.env[key]
    : fallback;

const toBool = (v, fallback = false) => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
  return fallback;
};

const toInt = (v, fallback) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
};

// --- Config (no "||" at top level)
const PORT = toInt(envOr('PORT', 4000), 4000);
const ADMIN_TOKEN = envOr('ADMIN_TOKEN', 'changeme');            // change in production
const CORS_ORIGIN = (() => {
  const raw = envOr('CORS_ORIGIN', 'true');                      // 'true' allows all (dev)
  return raw === 'true' ? true : raw;                            // boolean true or exact origin string
})();
const DB_FILE = envOr('DB_FILE', 'data.db');

// --- App
const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: '2mb' }));

// --- SQLite
const db = new sqlite3.Database(DB_FILE);
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    source TEXT,
    metadata TEXT,
    answers_json TEXT NOT NULL,
    email TEXT,
    ip TEXT
  )`);
});

// --- Admin guard
function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token && token === ADMIN_TOKEN) return next();
  return res.status(401).json({ ok: false, error: 'Unauthorized' });
}

// --- Optional mail transport (for forwarding)
function transporterOrNull() {
  const host = envOr('SMTP_HOST', '');
  const port = toInt(envOr('SMTP_PORT', ''), NaN);
  const user = envOr('SMTP_USER', '');
  const pass = envOr('SMTP_PASS', '');
  if (!host || !port || !user || !pass) return null;

  const secure = toBool(envOr('SMTP_SECURE', 'false'), false);
  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass }
  });
}

// --- Public submit endpoint
app.post('/submit', (req, res) => {
  try {
    const { answers, metadata, email, source } = req.body || {};
    if (!answers) return res.status(400).json({ ok: false, error: 'Missing answers' });

    const stmt = db.prepare(
      'INSERT INTO responses (created_at, source, metadata, answers_json, email, ip) VALUES (?,?,?,?,?,?)'
    );
    const createdAt = new Date().toISOString();
    stmt.run(
      createdAt,
      source ? String(source) : 'web',
      metadata ? String(metadata) : '',
      JSON.stringify(answers),
      email ? String(email) : '',
      // Express behind proxies can use req.headers['x-forwarded-for'] if desired
      req.ip || '',
      function (err) {
        if (err) return res.status(500).json({ ok: false, error: 'DB insert failed' });
        return res.json({ ok: true, id: this.lastID });
      }
    );
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// --- Admin APIs
app.get('/api/responses', requireAdmin, (req, res) => {
  const q = req.query.q;
  const sql = q
    ? 'SELECT * FROM responses WHERE answers_json LIKE ? OR metadata LIKE ? ORDER BY id DESC'
    : 'SELECT * FROM responses ORDER BY id DESC';
  const args = q ? [`%${q}%`, `%${q}%`] : [];
  db.all(sql, args, (err, rows) => {
    if (err) return res.status(500).json({ ok: false, error: 'DB error' });
    res.json({ ok: true, items: rows });
  });
});

app.get('/api/export.csv', requireAdmin, (req, res) => {
  db.all('SELECT * FROM responses ORDER BY id DESC', [], (err, rows) => {
    if (err) return res.status(500).send('DB error');
    const header = ['id', 'created_at', 'source', 'metadata', 'email', 'ip', 'answers'];
    const lines = [header.join(',')];
    for (const r of rows) {
      const answers = JSON.stringify(JSON.parse(r.answers_json));
      const row = [
        r.id,
        r.created_at,
        JSON.stringify(r.source || ''),
        JSON.stringify(r.metadata || ''),
        JSON.stringify(r.email || ''),
        JSON.stringify(r.ip || ''),
        JSON.stringify(answers)
      ].join(',');
      lines.push(row);
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="responses.csv"');
    res.send(lines.join('\n'));
  });
});

app.post('/api/responses/:id/forward', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const to = req.body?.to;
  if (!to) return res.status(400).json({ ok: false, error: 'Missing to' });

  const t = transporterOrNull();
  if (!t) return res.status(400).json({ ok: false, error: 'SMTP not configured' });

  db.get('SELECT * FROM responses WHERE id = ?', [id], async (err, row) => {
    if (err || !row) return res.status(404).json({ ok: false, error: 'Not found' });
    const answers = JSON.parse(row.answers_json);
    const pretty = Object.entries(answers)
      .map(([q, a]) => `<p><strong>${q}</strong><br/>${String(a || '').replace(/\n/g, '<br/>')}</p>`)
      .join('\n');
    const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
      <h2>Refleksjonsark – svar (ID ${row.id})</h2>
      <p><em>${row.metadata || ''}</em></p>
      ${pretty}
    </div>`;
    try {
      const info = await t.sendMail({
        from: envOr('FROM_EMAIL', envOr('SMTP_USER', '')),
        to,
        subject: `Refleksjonsark – svar (ID ${row.id})`,
        html
      });
      res.json({ ok: true, messageId: info.messageId });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
});

// --- Admin UI (static)
app.use('/admin', express.static(path.join(__dirname, 'public', 'admin')));

// --- Health
app.get('/', (req, res) => res.send('Motivasjonsark Master App OK'));

// --- Start
app.listen(PORT, () => {
  console.log(`Master app listening on http://localhost:${PORT}`);
  console.log(`DB file: ${DB_FILE}`);
  console.log(`CORS origin:`, CORS_ORIGIN);
});
