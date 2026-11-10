import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchDays } from './lib/eatsmart.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const KITCHEN_PIN = process.env.KITCHEN_PIN || '';
const DAYS_AHEAD = Number(process.env.DAYS_AHEAD ?? 1);
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const TIME_ZONE = 'America/Chicago';

const MENU_DIR = path.join(DATA_DIR, 'menus');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const SYNC_FILE = path.join(DATA_DIR, 'sync.json');

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
if (!LOOPBACK.has(HOST) && !KITCHEN_PIN) {
  console.error('Refusing to start: set KITCHEN_PIN before exposing this server beyond this computer.');
  process.exit(1);
}

const CHECK_EVERY_MS = 10 * 60 * 1000;
const RETRY_AFTER_MS = 30 * 60 * 1000;
const MAX_BODY_BYTES = 32 * 1024;
const MAX_QTY = 5;
const MAX_LINES = 20;
const ORDER_LIMIT = { windowMs: 10 * 60 * 1000, max: 20 };
const STATUSES = ['new', 'ready', 'picked_up'];
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/kitchen': ['kitchen.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/kitchen.js': ['kitchen.js', 'text/javascript; charset=utf-8'],
  '/shared.js': ['shared.js', 'text/javascript; charset=utf-8'],
};

fs.mkdirSync(MENU_DIR, { recursive: true });

function writeJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value));
  fs.renameSync(temp, file);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function chicagoNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date())
      .map((part) => [part.type, part.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

function addDays(iso, count) {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + count)).toISOString().slice(0, 10);
}

function activeDates() {
  const today = chicagoNow().date;
  return Array.from({ length: DAYS_AHEAD + 1 }, (_, offset) => addDays(today, offset));
}

// ---- Daily menu sync ----

const sync = { running: false, syncedFor: readJson(SYNC_FILE, {}).syncedFor ?? null, failedAt: 0, failing: false };

async function runSync() {
  if (sync.running) return;
  sync.running = true;
  const dates = activeDates();
  const startedAt = Date.now();
  console.log(`Syncing menus for ${dates.join(', ')}`);
  try {
    for (const day of await fetchDays(dates)) writeJson(path.join(MENU_DIR, `${day.date}.json`), day);
    sync.syncedFor = dates[0];
    sync.failing = false;
    writeJson(SYNC_FILE, { syncedFor: sync.syncedFor });
    console.log(`Menu sync finished in ${Math.round((Date.now() - startedAt) / 1000)}s`);
  } catch (error) {
    sync.failing = true;
    sync.failedAt = Date.now();
    console.error('Menu sync failed:', error.message);
  } finally {
    sync.running = false;
  }
}

function syncIfDue() {
  if (sync.syncedFor === chicagoNow().date) return;
  if (sync.failing && Date.now() - sync.failedAt < RETRY_AFTER_MS) return;
  runSync();
}

function readMenu(date) {
  return readJson(path.join(MENU_DIR, `${date}.json`), null);
}

// ---- Orders ----

const orders = readJson(ORDERS_FILE, []);
const recentOrders = new Map();

function overOrderLimit(address) {
  const cutoff = Date.now() - ORDER_LIMIT.windowMs;
  const times = (recentOrders.get(address) ?? []).filter((time) => time > cutoff);
  const limited = times.length >= ORDER_LIMIT.max;
  if (!limited) times.push(Date.now());
  recentOrders.set(address, times);
  return limited;
}

function newCode() {
  for (;;) {
    const code = Array.from({ length: 5 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
    if (!orders.some((order) => order.code === code)) return code;
  }
}

function cleanText(value, max) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

class BadRequest extends Error {}

function createOrder(body) {
  const now = chicagoNow();
  const date = String(body.date ?? '');
  if (!activeDates().includes(date)) throw new BadRequest('That day is no longer open for requests.');

  const name = cleanText(body.name, 60);
  if (!name) throw new BadRequest('Add the name for pickup.');

  const pickupTime = String(body.pickupTime ?? '');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(pickupTime)) throw new BadRequest('Choose a pickup time.');
  if (date === now.date && pickupTime <= now.time) throw new BadRequest('Choose a pickup time later than now.');

  const hall = readMenu(date)?.halls.find((entry) => entry.id === Number(body.hallId));
  const meal = hall?.meals.find((entry) => entry.name === body.meal);
  if (!meal) throw new BadRequest('That meal is not on the menu.');

  const lines = Array.isArray(body.items) ? body.items : [];
  if (!lines.length) throw new BadRequest('Add at least one item.');
  if (lines.length > MAX_LINES) throw new BadRequest(`Choose ${MAX_LINES} items or fewer.`);

  const menuItems = new Map();
  for (const station of meal.stations) {
    for (const group of station.groups) {
      for (const item of group.items) menuItems.set(item.id, { ...item, station: station.name });
    }
  }

  const items = lines.map((line) => {
    const item = menuItems.get(Number(line.id));
    const qty = Number(line.qty);
    if (!item) throw new BadRequest('One of your items is no longer on the menu. Refresh and try again.');
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) throw new BadRequest(`Quantities must be 1 to ${MAX_QTY}.`);
    return { id: item.id, name: item.name, serving: item.serving, station: item.station, allergens: item.allergens, qty };
  });

  const order = {
    code: newCode(),
    date,
    hallId: hall.id,
    hallName: hall.name,
    meal: meal.name,
    pickupTime,
    name,
    notes: cleanText(body.notes, 300),
    items,
    status: 'new',
    createdAt: new Date().toISOString(),
  };
  orders.push(order);
  writeJson(ORDERS_FILE, orders);
  return order;
}

// ---- HTTP ----

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
      reject(new BadRequest('Expected JSON.'));
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BadRequest('Request is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (parsed === null || typeof parsed !== 'object') throw new Error('not an object');
        resolve(parsed);
      } catch {
        reject(new BadRequest('Request was not valid JSON.'));
      }
    });
  });
}

function kitchenAllowed(req) {
  if (!KITCHEN_PIN) return true;
  const digest = (value) => crypto.createHash('sha256').update(String(value)).digest();
  return crypto.timingSafeEqual(digest(req.headers['x-kitchen-pin'] ?? ''), digest(KITCHEN_PIN));
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const route = `${req.method} ${url.pathname}`;

  if (req.method === 'GET' && STATIC_FILES[url.pathname]) {
    const [file, type] = STATIC_FILES[url.pathname];
    send(res, 200, fs.readFileSync(path.join(ROOT, 'public', file)), type);
    return;
  }

  if (route === 'GET /api/status') {
    send(res, 200, { dates: activeDates(), now: chicagoNow(), syncing: sync.running, failing: sync.failing });
    return;
  }

  if (route === 'GET /api/menu') {
    const date = url.searchParams.get('date') ?? '';
    const menu = activeDates().includes(date) ? readMenu(date) : null;
    if (menu) send(res, 200, menu);
    else send(res, 404, { error: 'Menu not available yet.' });
    return;
  }

  if (route === 'POST /api/orders') {
    if (overOrderLimit(req.socket.remoteAddress)) {
      send(res, 429, { error: 'Too many requests. Try again in a few minutes.' });
      return;
    }
    const order = createOrder(await readBody(req));
    send(res, 201, { code: order.code, pickupTime: order.pickupTime, hallName: order.hallName, meal: order.meal, date: order.date });
    return;
  }

  if (url.pathname.startsWith('/api/kitchen/')) {
    if (!kitchenAllowed(req)) {
      send(res, 401, { error: 'Wrong kitchen PIN.' });
      return;
    }
    if (route === 'GET /api/kitchen/orders') {
      const date = url.searchParams.get('date') ?? chicagoNow().date;
      send(res, 200, { dates: activeDates(), orders: orders.filter((order) => order.date === date) });
      return;
    }
    const match = /^\/api\/kitchen\/orders\/([A-Z0-9]{5})$/.exec(url.pathname);
    if (req.method === 'PATCH' && match) {
      const order = orders.find((entry) => entry.code === match[1]);
      if (!order) {
        send(res, 404, { error: 'Order not found.' });
        return;
      }
      const { status } = await readBody(req);
      if (!STATUSES.includes(status)) throw new BadRequest('Unknown status.');
      order.status = status;
      writeJson(ORDERS_FILE, orders);
      send(res, 200, order);
      return;
    }
  }

  send(res, 404, { error: 'Not found.' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    if (error instanceof BadRequest) {
      send(res, 400, { error: error.message });
      return;
    }
    console.error(error);
    send(res, 500, { error: 'Something went wrong.' });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Set Aside is running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Kitchen view: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/kitchen`);
  syncIfDue();
  setInterval(syncIfDue, CHECK_EVERY_MS);
});
