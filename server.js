'use strict';
// Travel Suite - web service (REST API) + web client.
// Chi dung module co san cua Node (>= 22.13): http, node:sqlite, crypto. Khong can npm install.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data.db');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const MAX_IMAGE = 5 * 1024 * 1024; // 5 MB

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL COLLATE NOCASE,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('GUIDE','TRAVELER')),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS places (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  location TEXT,
  guide_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  place_id INTEGER NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  guide_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  caption TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS infos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  place_id INTEGER NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  guide_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  image_id INTEGER REFERENCES images(id) ON DELETE CASCADE,
  info_id INTEGER REFERENCES infos(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  CHECK ((image_id IS NULL) <> (info_id IS NULL)),
  UNIQUE (user_id, image_id),
  UNIQUE (user_id, info_id)
);
`);

// ---------- Tien ich ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const need = (cond, status, message) => { if (!cond) throw new HttpError(status, message); };
const str = (v, max) => String(v ?? '').trim().slice(0, max);

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    req.on('end', () => (size > limit ? reject(new HttpError(413, 'Du lieu qua lon')) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(password, salt, 64).toString('hex');
}

function checkPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const actual = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(actual, Buffer.from(hash, 'hex'));
}

// Nhan dang loai anh bang "magic bytes", khong tin vao Content-Type tu client.
function detectExt(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return '.png';
  if (buf.subarray(0, 4).toString('latin1') === 'GIF8') return '.gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return '.webp';
  return null;
}

function getToken(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

function getUser(req) {
  const token = getToken(req);
  if (!token) return null;
  return db.prepare(
    `SELECT u.id, u.username, u.email, u.role FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.created_at > datetime('now', '-7 days')`
  ).get(token) || null;
}

const requireUser = (c) => { need(c.user, 401, 'Ban chua dang nhap'); return c.user; };
const requireRole = (c, role) => {
  const u = requireUser(c);
  need(u.role === role, 403, 'Chuc nang nay danh cho ' + role);
  return u;
};

// Lay ban ghi (images/infos) va kiem tra no thuoc ve guide dang dang nhap.
function ownRow(c, table) {
  const u = requireUser(c);
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(c.params.id);
  need(row, 404, 'Khong tim thay');
  need(row.guide_id === u.id, 403, 'Ban khong co quyen voi du lieu nay');
  return row;
}

// ---------- Router ----------
const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler });
}

// ---------- Auth ----------
route('POST', '/api/auth/register', async (c) => {
  const b = await c.json();
  const username = str(b.username, 30);
  const email = str(b.email, 100).toLowerCase();
  const password = String(b.password ?? '');
  need(/^[A-Za-z0-9_]{3,30}$/.test(username), 400, 'Ten dang nhap 3-30 ky tu: chu, so hoac _');
  need(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 400, 'Email khong hop le');
  need(password.length >= 6 && password.length <= 100, 400, 'Mat khau phai tu 6 ky tu');
  need(b.role === 'GUIDE' || b.role === 'TRAVELER', 400, 'Vai tro khong hop le');
  need(!db.prepare('SELECT 1 FROM users WHERE username = ? OR email = ?').get(username, email),
    409, 'Ten dang nhap hoac email da ton tai');
  const r = db.prepare('INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(username, email, hashPassword(password), b.role);
  send(c.res, 201, { id: Number(r.lastInsertRowid), username, role: b.role });
});

route('POST', '/api/auth/login', async (c) => {
  const b = await c.json();
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(str(b.username, 30));
  need(u && checkPassword(String(b.password ?? ''), u.password_hash), 401, 'Sai ten dang nhap hoac mat khau');
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, u.id);
  send(c.res, 200, { token, user: { id: u.id, username: u.username, email: u.email, role: u.role } });
});

route('POST', '/api/auth/logout', async (c) => {
  requireUser(c);
  db.prepare('DELETE FROM sessions WHERE token = ?').run(getToken(c.req));
  send(c.res, 200, { ok: true });
});

route('GET', '/api/me', async (c) => send(c.res, 200, requireUser(c)));

// ---------- Places ----------
route('GET', '/api/places', async (c) => {
  let where = '';
  const args = [];
  if (c.query.mine) { where = 'WHERE p.guide_id = ?'; args.push(requireUser(c).id); }
  const rows = db.prepare(
    `SELECT p.id, p.name, p.description, p.location, p.guide_id, u.username AS guide,
            (SELECT file_path FROM images WHERE place_id = p.id ORDER BY id LIMIT 1) AS cover
     FROM places p JOIN users u ON u.id = p.guide_id ${where} ORDER BY p.id DESC`
  ).all(...args);
  send(c.res, 200, rows);
});

route('POST', '/api/places', async (c) => {
  const u = requireRole(c, 'GUIDE');
  const b = await c.json();
  const name = str(b.name, 150);
  need(name, 400, 'Ten dia diem la bat buoc');
  const r = db.prepare('INSERT INTO places (name, description, location, guide_id) VALUES (?, ?, ?, ?)')
    .run(name, str(b.description, 5000), str(b.location, 200), u.id);
  send(c.res, 201, { id: Number(r.lastInsertRowid), name });
});

route('GET', '/api/places/:id', async (c) => {
  const id = c.params.id;
  const place = db.prepare(
    'SELECT p.*, u.username AS guide FROM places p JOIN users u ON u.id = p.guide_id WHERE p.id = ?'
  ).get(id);
  need(place, 404, 'Khong tim thay dia diem');
  place.images = db.prepare(
    `SELECT i.id, i.file_path, i.caption,
            (SELECT ROUND(AVG(rating), 1) FROM reviews WHERE image_id = i.id) AS avg_rating,
            (SELECT COUNT(*) FROM reviews WHERE image_id = i.id) AS review_count
     FROM images i WHERE i.place_id = ? ORDER BY i.id`
  ).all(id);
  place.infos = db.prepare(
    `SELECT n.id, n.title, n.content,
            (SELECT ROUND(AVG(rating), 1) FROM reviews WHERE info_id = n.id) AS avg_rating,
            (SELECT COUNT(*) FROM reviews WHERE info_id = n.id) AS review_count
     FROM infos n WHERE n.place_id = ? ORDER BY n.id`
  ).all(id);
  send(c.res, 200, place);
});

function ownPlace(c) {
  const u = requireRole(c, 'GUIDE');
  const place = db.prepare('SELECT * FROM places WHERE id = ?').get(c.params.id);
  need(place, 404, 'Khong tim thay dia diem');
  need(place.guide_id === u.id, 403, 'Ban khong co quyen voi dia diem nay');
  return place;
}

route('PUT', '/api/places/:id', async (c) => {
  const place = ownPlace(c);
  const b = await c.json();
  const name = str(b.name, 150);
  need(name, 400, 'Ten dia diem la bat buoc');
  db.prepare('UPDATE places SET name = ?, description = ?, location = ? WHERE id = ?')
    .run(name, str(b.description, 5000), str(b.location, 200), place.id);
  send(c.res, 200, { ok: true });
});

route('DELETE', '/api/places/:id', async (c) => {
  const place = ownPlace(c);
  const files = db.prepare('SELECT file_path FROM images WHERE place_id = ?').all(place.id);
  db.prepare('DELETE FROM places WHERE id = ?').run(place.id); // images, infos, reviews xoa theo (CASCADE)
  files.forEach((f) => fs.rmSync(path.join(UPLOAD_DIR, f.file_path), { force: true }));
  send(c.res, 200, { ok: true });
});

// ---------- Images ----------
route('POST', '/api/places/:id/images', async (c) => {
  const place = ownPlace(c);
  const buf = await readBody(c.req, MAX_IMAGE);
  need(buf.length > 0, 400, 'Chua co du lieu anh');
  const ext = detectExt(buf);
  need(ext, 400, 'Chi chap nhan anh jpg, png, gif, webp');
  const file = crypto.randomBytes(16).toString('hex') + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, file), buf);
  const caption = str(c.query.caption, 200);
  const r = db.prepare('INSERT INTO images (place_id, guide_id, file_path, caption) VALUES (?, ?, ?, ?)')
    .run(place.id, place.guide_id, file, caption);
  send(c.res, 201, { id: Number(r.lastInsertRowid), file_path: file, caption });
});

route('PUT', '/api/images/:id', async (c) => {
  const row = ownRow(c, 'images');
  const b = await c.json();
  db.prepare('UPDATE images SET caption = ? WHERE id = ?').run(str(b.caption, 200), row.id);
  send(c.res, 200, { ok: true });
});

route('DELETE', '/api/images/:id', async (c) => {
  const row = ownRow(c, 'images');
  db.prepare('DELETE FROM images WHERE id = ?').run(row.id);
  fs.rmSync(path.join(UPLOAD_DIR, row.file_path), { force: true });
  send(c.res, 200, { ok: true });
});

// ---------- Infos ----------
route('POST', '/api/places/:id/infos', async (c) => {
  const place = ownPlace(c);
  const b = await c.json();
  const title = str(b.title, 150);
  const content = str(b.content, 5000);
  need(title && content, 400, 'Tieu de va noi dung la bat buoc');
  const r = db.prepare('INSERT INTO infos (place_id, guide_id, title, content) VALUES (?, ?, ?, ?)')
    .run(place.id, place.guide_id, title, content);
  send(c.res, 201, { id: Number(r.lastInsertRowid), title });
});

route('PUT', '/api/infos/:id', async (c) => {
  const row = ownRow(c, 'infos');
  const b = await c.json();
  const title = str(b.title, 150);
  const content = str(b.content, 5000);
  need(title && content, 400, 'Tieu de va noi dung la bat buoc');
  db.prepare('UPDATE infos SET title = ?, content = ? WHERE id = ?').run(title, content, row.id);
  send(c.res, 200, { ok: true });
});

route('DELETE', '/api/infos/:id', async (c) => {
  const row = ownRow(c, 'infos');
  db.prepare('DELETE FROM infos WHERE id = ?').run(row.id);
  send(c.res, 200, { ok: true });
});

// ---------- Search ----------
route('GET', '/api/search', async (c) => {
  const q = str(c.query.q, 100);
  if (!q) return send(c.res, 200, { places: [], images: [], infos: [] });
  const like = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
  const places = db.prepare(
    `SELECT p.id, p.name, p.description, p.location, p.guide_id, u.username AS guide,
            (SELECT file_path FROM images WHERE place_id = p.id ORDER BY id LIMIT 1) AS cover
     FROM places p JOIN users u ON u.id = p.guide_id
     WHERE p.name LIKE ? ESCAPE '\\' OR p.description LIKE ? ESCAPE '\\' OR p.location LIKE ? ESCAPE '\\'
     LIMIT 50`
  ).all(like, like, like);
  const images = db.prepare(
    `SELECT i.id, i.caption, i.file_path, i.place_id, p.name AS place_name
     FROM images i JOIN places p ON p.id = i.place_id
     WHERE i.caption LIKE ? ESCAPE '\\' LIMIT 50`
  ).all(like);
  const infos = db.prepare(
    `SELECT n.id, n.title, n.content, n.place_id, p.name AS place_name
     FROM infos n JOIN places p ON p.id = n.place_id
     WHERE n.title LIKE ? ESCAPE '\\' OR n.content LIKE ? ESCAPE '\\' LIMIT 50`
  ).all(like, like);
  send(c.res, 200, { places, images, infos });
});

// ---------- Reviews (rate + comment) cho image va info ----------
for (const type of ['image', 'info']) {
  const table = type + 's';
  const col = type + '_id';

  route('POST', `/api/${table}/:id/reviews`, async (c) => {
    const u = requireRole(c, 'TRAVELER');
    need(db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(c.params.id), 404, 'Khong tim thay');
    const b = await c.json();
    const rating = Number(b.rating);
    need(Number.isInteger(rating) && rating >= 1 && rating <= 5, 400, 'Diem danh gia phai tu 1 den 5');
    const comment = str(b.comment, 1000);
    const old = db.prepare(`SELECT id FROM reviews WHERE user_id = ? AND ${col} = ?`).get(u.id, c.params.id);
    if (old) { // moi traveler chi co 1 danh gia cho moi doi tuong, danh gia lai se cap nhat
      db.prepare('UPDATE reviews SET rating = ?, comment = ? WHERE id = ?').run(rating, comment, old.id);
      return send(c.res, 200, { id: old.id, updated: true });
    }
    const r = db.prepare(`INSERT INTO reviews (user_id, ${col}, rating, comment) VALUES (?, ?, ?, ?)`)
      .run(u.id, c.params.id, rating, comment);
    send(c.res, 201, { id: Number(r.lastInsertRowid) });
  });

  route('GET', `/api/${table}/:id/reviews`, async (c) => {
    const rows = db.prepare(
      `SELECT r.id, r.rating, r.comment, r.created_at, u.username
       FROM reviews r JOIN users u ON u.id = r.user_id WHERE r.${col} = ? ORDER BY r.id DESC`
    ).all(c.params.id);
    send(c.res, 200, rows);
  });
}

// ---------- File tinh (web client + anh da upload) ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp',
};

function sendFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'Khong tim thay' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
  });
}

function serveStatic(pathname, res) {
  if (pathname === '/' || pathname === '/index.html') return sendFile(res, path.join(__dirname, 'public', 'index.html'));
  if (pathname.startsWith('/uploads/')) return sendFile(res, path.join(UPLOAD_DIR, path.basename(pathname)));
  throw new HttpError(404, 'Khong tim thay');
}

// ---------- Server ----------
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // cho phep app mobile / web khac goi API
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);

    for (const r of routes) {
      const m = r.method === req.method && r.re.exec(url.pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => {
        const v = decodeURIComponent(m[i + 1]);
        params[k] = /^\d+$/.test(v) ? Number(v) : v;
      });
      const c = {
        req, res, params,
        query: Object.fromEntries(url.searchParams),
        user: getUser(req),
        json: async () => {
          const raw = await readBody(req, 1e6);
          let data;
          try { data = JSON.parse(raw.toString() || '{}'); } catch { throw new HttpError(400, 'JSON khong hop le'); }
          need(data && typeof data === 'object', 400, 'JSON khong hop le');
          return data;
        },
      };
      return await r.handler(c);
    }
    throw new HttpError(404, 'Khong tim thay');
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Loi server' });
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Travel Suite dang chay tai http://localhost:${PORT}`));
}
module.exports = server;
