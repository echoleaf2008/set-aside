import { api, formatDate, formatTime, h } from '/shared.js';

const NEXT = { new: ['ready', 'Mark ready'], ready: ['picked_up', 'Picked up'] };
const LABEL = { new: 'New', ready: 'Ready', picked_up: 'Picked up' };

const datesEl = document.getElementById('dates');
const board = document.getElementById('board');
const state = { date: null, dates: [], orders: [], pin: '', needsPin: false, error: '' };

const headers = () => (state.pin ? { 'X-Kitchen-Pin': state.pin } : {});

async function load() {
  try {
    const query = state.date ? `?date=${encodeURIComponent(state.date)}` : '';
    const data = await api(`/api/kitchen/orders${query}`, { headers: headers() });
    state.dates = data.dates;
    state.date ??= data.dates[0];
    state.orders = data.orders;
    state.needsPin = false;
    state.error = '';
  } catch (error) {
    if (error.status === 401) state.needsPin = true;
    state.error = error.message;
  }
  render();
}

async function setStatus(order, status) {
  try {
    await api(`/api/kitchen/orders/${order.code}`, {
      method: 'PATCH',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
  } catch (error) {
    state.error = error.message;
  }
  load();
}

function pinForm() {
  const input = h('input', { type: 'password', required: true, autocomplete: 'off', 'aria-label': 'Kitchen PIN', placeholder: 'Kitchen PIN' });
  return h('form', {
    class: 'pin',
    onSubmit: (event) => {
      event.preventDefault();
      state.pin = input.value;
      load();
    },
  }, input, h('button', { class: 'primary', type: 'submit' }, 'Open'), state.pin && h('p', { class: 'error' }, state.error));
}

function prepTotals(orders) {
  const totals = new Map();
  for (const order of orders) {
    if (order.status !== 'new') continue;
    const key = `${order.hallName} · ${order.meal}`;
    if (!totals.has(key)) totals.set(key, new Map());
    for (const item of order.items) {
      const label = `${item.station}: ${item.name}`;
      totals.get(key).set(label, (totals.get(key).get(label) ?? 0) + item.qty);
    }
  }
  return totals;
}

function orderCard(order) {
  const next = NEXT[order.status];
  return h('article', { class: `order status-${order.status}` },
    h('header', {},
      h('div', {}, h('strong', {}, order.name), h('span', { class: 'code-small' }, order.code)),
      h('div', { class: 'order-when' }, `${formatTime(order.pickupTime)} · ${order.hallName} · ${order.meal}`),
    ),
    h('ul', {}, order.items.map((item) => h('li', {}, h('b', {}, `${item.qty} × `), item.name, h('small', {}, ` ${item.station}`)))),
    order.notes && h('p', { class: 'order-notes' }, order.notes),
    h('footer', {},
      h('span', { class: 'badge' }, LABEL[order.status]),
      next && h('button', { type: 'button', class: 'secondary', onClick: () => setStatus(order, next[0]) }, next[1]),
    ),
  );
}

function render() {
  datesEl.replaceChildren(
    ...state.dates.map((date) =>
      h('button', {
        type: 'button',
        class: date === state.date ? 'is-on' : '',
        'aria-pressed': String(date === state.date),
        onClick: () => {
          state.date = date;
          load();
        },
      }, formatDate(date)),
    ),
  );
  if (state.needsPin) return board.replaceChildren(pinForm());

  const orders = [...state.orders].sort((a, b) => a.pickupTime.localeCompare(b.pickupTime));
  const totals = prepTotals(orders);
  board.replaceChildren(
    ...(state.error ? [h('p', { class: 'error', role: 'alert' }, state.error)] : []),
    h('section', { class: 'prep' },
      h('h2', {}, 'To make'),
      totals.size
        ? [...totals].map(([key, items]) =>
            h('div', { class: 'group' },
              h('h3', {}, key),
              h('ul', {}, [...items].sort().map(([label, qty]) => h('li', {}, h('b', {}, `${qty} × `), label))),
            ),
          )
        : h('p', { class: 'empty' }, 'Nothing waiting to be made.'),
    ),
    h('section', { class: 'orders' },
      h('h2', {}, 'Requests'),
      orders.length ? orders.map(orderCard) : h('p', { class: 'empty' }, 'No requests for this day yet.'),
    ),
  );
}

load();
setInterval(() => {
  if (!state.needsPin) load();
}, 20_000);
