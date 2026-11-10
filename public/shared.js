// Builds DOM nodes. Text always goes through text nodes, so menu and order content is never parsed as HTML.
export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') node.className = value;
    else if (key in node && key !== 'list') node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
  return node;
}

export function formatDate(iso, options = { weekday: 'short', month: 'short', day: 'numeric' }) {
  return new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', options);
}

export function formatTime(value) {
  const [hour, minute] = value.split(':').map(Number);
  return new Date(2000, 0, 1, hour, minute).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// This site is hosted as static files, so there is no server to receive orders.
// api() answers the same requests the pages would send to one: menus come from
// the published JSON files, and demo orders stay in this browser's storage.
const ORDERS_KEY = 'set-aside-demo-orders';
const MAX_QTY = 5;
const MAX_LINES = 20;
const STATUSES = ['new', 'ready', 'picked_up'];
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function loadOrders() {
  try {
    return JSON.parse(localStorage.getItem(ORDERS_KEY)) ?? [];
  } catch {
    return [];
  }
}

function saveOrders(orders) {
  try {
    localStorage.setItem(ORDERS_KEY, JSON.stringify(orders));
  } catch {
    throw fail('This browser is blocking storage, so the demo can’t save your request.', 500);
  }
}

function chicagoNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Chicago',
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

async function getJson(path) {
  const response = await fetch(path, { cache: 'no-cache' });
  if (!response.ok) throw fail('Menu not available yet.', response.status);
  return response.json();
}

async function activeDates() {
  const meta = await getJson('meta.json');
  const today = chicagoNow().date;
  return meta.dates.filter((date) => date >= today).slice(0, 2);
}

function newCode(orders) {
  for (;;) {
    const values = crypto.getRandomValues(new Uint32Array(5));
    const code = Array.from(values, (value) => CODE_ALPHABET[value % CODE_ALPHABET.length]).join('');
    if (!orders.some((order) => order.code === code)) return code;
  }
}

const cleanText = (value, max) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');

async function createOrder(body) {
  const now = chicagoNow();
  const date = String(body.date ?? '');
  if (!(await activeDates()).includes(date)) throw fail('That day is no longer open for requests.');

  const name = cleanText(body.name, 60);
  if (!name) throw fail('Add the name for pickup.');

  const pickupTime = String(body.pickupTime ?? '');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(pickupTime)) throw fail('Choose a pickup time.');
  if (date === now.date && pickupTime <= now.time) throw fail('Choose a pickup time later than now.');

  const menu = await getJson(`menus/${date}.json`);
  const hall = menu.halls.find((entry) => entry.id === Number(body.hallId));
  const meal = hall?.meals.find((entry) => entry.name === body.meal);
  if (!meal) throw fail('That meal is not on the menu.');

  const lines = Array.isArray(body.items) ? body.items : [];
  if (!lines.length) throw fail('Add at least one item.');
  if (lines.length > MAX_LINES) throw fail(`Choose ${MAX_LINES} items or fewer.`);

  const menuItems = new Map();
  for (const station of meal.stations) {
    for (const group of station.groups) {
      for (const item of group.items) menuItems.set(item.id, { ...item, station: station.name });
    }
  }

  const items = lines.map((line) => {
    const item = menuItems.get(Number(line.id));
    const qty = Number(line.qty);
    if (!item) throw fail('One of your items is no longer on the menu. Refresh and try again.');
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) throw fail(`Quantities must be 1 to ${MAX_QTY}.`);
    return { id: item.id, name: item.name, serving: item.serving, station: item.station, allergens: item.allergens, qty };
  });

  const orders = loadOrders();
  const order = {
    code: newCode(orders),
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
  saveOrders(orders);
  return order;
}

export async function api(path, options = {}) {
  const url = new URL(path, 'https://local.invalid');
  const route = `${options.method ?? 'GET'} ${url.pathname}`;
  const body = options.body ? JSON.parse(options.body) : {};

  if (route === 'GET /api/status') return { dates: await activeDates(), now: chicagoNow(), syncing: false, failing: false };

  if (route === 'GET /api/menu') {
    const date = url.searchParams.get('date') ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw fail('Menu not available yet.', 404);
    return getJson(`menus/${date}.json`);
  }

  if (route === 'POST /api/orders') return createOrder(body);

  if (route === 'GET /api/kitchen/orders') {
    const dates = await activeDates();
    const date = url.searchParams.get('date') ?? dates[0];
    return { dates, orders: loadOrders().filter((order) => order.date === date) };
  }

  const match = /^PATCH \/api\/kitchen\/orders\/([A-Z0-9]{5})$/.exec(route);
  if (match) {
    const orders = loadOrders();
    const order = orders.find((entry) => entry.code === match[1]);
    if (!order) throw fail('Order not found.', 404);
    if (!STATUSES.includes(body.status)) throw fail('Unknown status.');
    order.status = body.status;
    saveOrders(orders);
    return order;
  }

  throw fail('Not found.', 404);
}
