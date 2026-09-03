// Всё-в-одном: раздаёт Mini App (public/index.html), API и сам бот — один процесс.
// Так проще всего задеплоить на бесплатном хостинге (Replit, Render, Railway и т.п.).
//
// Нужно указать только 2 переменные окружения:
//   BOT_TOKEN   — токен от @BotFather
//   PUBLIC_URL  — публичный HTTPS-адрес этого сервиса (его даёт хостинг),
//                 например https://your-app.onrender.com
//
// Запуск:
//   npm install
//   BOT_TOKEN=xxxx PUBLIC_URL=https://your-app.onrender.com node app.js

const path = require('path');
const fs = require('fs');
const express = require('express');
const crypto = require('crypto');
const TelegramBot = require('node-telegram-bot-api');

const BOT_TOKEN = process.env.BOT_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL;
if (!BOT_TOKEN || !PUBLIC_URL) {
  console.error('Укажи переменные окружения BOT_TOKEN и PUBLIC_URL.');
  process.exit(1);
}
const WEBAPP_URL = PUBLIC_URL.replace(/\/$/, '') + '/';

/* ---------------- DB: простое хранилище в JSON-файле, без нативной сборки ---------------- */
const DB_FILE = path.join(__dirname, 'data.json');
function loadDb() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch (e) { return { profiles: {}, entries: {}, nextId: 1 }; }
}
function saveDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db));
}
let db = loadDb();

const round2 = n => Math.round(n * 100) / 100;
const validWeight = w => typeof w === 'number' && isFinite(w) && w > 0 && w <= 400;
const fmt = n => { const r = Math.round(n * 10) / 10; return Number.isInteger(r) ? String(r) : r.toFixed(1); };

/* ---------------- Telegram initData verification ---------------- */
function verifyInitData(initData) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const arr = [...params.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `${k}=${v}`);
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const computed = crypto.createHmac('sha256', secretKey).update(arr.join('\n')).digest('hex');
  if (computed !== hash) return null;
  const userJson = params.get('user');
  return userJson ? JSON.parse(userJson) : null;
}
function auth(req, res, next) {
  const initData = req.header('X-Telegram-Init-Data');
  const user = initData ? verifyInitData(initData) : null;
  if (!user) return res.status(401).json({ error: 'invalid_init_data' });
  req.userId = String(user.id);
  req.tgUser = user;
  next();
}

/* ---------------- API ---------------- */
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/profile', auth, (req, res) => {
  const row = db.profiles[req.userId];
  if (!row) return res.json(null);
  res.json({ startWeight: row.startWeight, goalWeight: row.goalWeight, height: row.height, createdAt: row.createdAt });
});

app.post('/api/profile', auth, (req, res) => {
  const { startWeight, goalWeight, height } = req.body || {};
  if (!validWeight(startWeight) || !validWeight(goalWeight)) return res.status(400).json({ error: 'invalid_weight' });
  const now = new Date().toISOString();
  const u = req.tgUser || {};
  const existing = db.profiles[req.userId];
  db.profiles[req.userId] = {
    startWeight: round2(startWeight), goalWeight: round2(goalWeight), height: height || null,
    createdAt: existing ? existing.createdAt : now,
    tgFirstName: u.first_name || null, tgLastName: u.last_name || null, tgUsername: u.username || null,
  };
  if (!existing) {
    if (!db.entries[req.userId]) db.entries[req.userId] = [];
    db.entries[req.userId].push({ id: db.nextId++, weight: round2(startWeight), date: now });
  }
  saveDb(db);
  res.json({ ok: true });
});

app.put('/api/profile/goal', auth, (req, res) => {
  const { goalWeight } = req.body || {};
  if (!validWeight(goalWeight)) return res.status(400).json({ error: 'invalid_weight' });
  if (!db.profiles[req.userId]) return res.status(404).json({ error: 'no_profile' });
  db.profiles[req.userId].goalWeight = round2(goalWeight);
  saveDb(db);
  res.json({ ok: true });
});

app.get('/api/entries', auth, (req, res) => {
  res.json((db.entries[req.userId] || []).slice().sort((a, b) => a.date.localeCompare(b.date)));
});

app.post('/api/entries', auth, (req, res) => {
  const { weight } = req.body || {};
  if (!validWeight(weight)) return res.status(400).json({ error: 'invalid_weight' });
  const now = new Date().toISOString();
  const entry = { id: db.nextId++, weight: round2(weight), date: now };
  if (!db.entries[req.userId]) db.entries[req.userId] = [];
  db.entries[req.userId].push(entry);
  saveDb(db);
  res.json(entry);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Web + API запущены на порту ' + PORT));

/* ---------------- Bot ---------------- */
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const displayName = u => [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || (u.username ? '@' + u.username : 'друг');

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, `Привет, ${displayName(msg.from)}! Это трекер веса и цели. Открой приложение 👇`, {
    reply_markup: { inline_keyboard: [[{ text: '🚀 Открыть приложение', web_app: { url: WEBAPP_URL } }]] },
  });
});

bot.onText(/\/progress/, (msg) => {
  const p = db.profiles[String(msg.from.id)];
  if (!p) return bot.sendMessage(msg.chat.id, 'Сначала настрой цель в приложении — нажми /start.');
  const entries = (db.entries[String(msg.from.id)] || []).slice().sort((a, b) => a.date.localeCompare(b.date));
  const current = entries.length ? entries[entries.length - 1].weight : p.startWeight;
  const span = p.goalWeight - p.startWeight;
  const pct = span === 0 ? 100 : Math.max(0, Math.min(100, ((current - p.startWeight) / span) * 100));
  bot.sendMessage(msg.chat.id, `Старт: ${fmt(p.startWeight)} кг\nСейчас: ${fmt(current)} кг\nЦель: ${fmt(p.goalWeight)} кг\nПрогресс: ${fmt(pct)}%\nОсталось: ${fmt(Math.abs(p.goalWeight - current))} кг`);
});

bot.onText(/\/goal/, (msg) => {
  const p = db.profiles[String(msg.from.id)];
  if (!p) return bot.sendMessage(msg.chat.id, 'Цель ещё не установлена — открой приложение через /start.');
  bot.sendMessage(msg.chat.id, `Твоя цель: ${fmt(p.startWeight)} → ${fmt(p.goalWeight)} кг`);
});

bot.onText(/\/weight(?:\s+([\d.,]+))?/, (msg, match) => {
  const p = db.profiles[String(msg.from.id)];
  if (!p) return bot.sendMessage(msg.chat.id, 'Сначала настрой цель в приложении — нажми /start.');
  if (!match[1]) {
    return bot.sendMessage(msg.chat.id, 'Открой приложение, чтобы добавить вес 👇', {
      reply_markup: { inline_keyboard: [[{ text: '🚀 Открыть приложение', web_app: { url: WEBAPP_URL } }]] },
    });
  }
  const v = parseFloat(match[1].replace(',', '.'));
  if (isNaN(v) || v <= 0 || v > 400) return bot.sendMessage(msg.chat.id, 'Не похоже на вес. Пример: /weight 53.4');
  const uid = String(msg.from.id);
  if (!db.entries[uid]) db.entries[uid] = [];
  db.entries[uid].push({ id: db.nextId++, weight: round2(v), date: new Date().toISOString() });
  saveDb(db);
  bot.sendMessage(msg.chat.id, `Записал: ${fmt(v)} кг ✅`);
});

console.log('Бот запущен (polling)...');
