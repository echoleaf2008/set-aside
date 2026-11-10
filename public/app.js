import { api, formatDate, formatTime, h } from '/shared.js';

const DIETS = ['Vegetarian', 'Vegan', 'Halal', 'Kosher', 'Jain'];
const ALLERGENS = ['Alcohol', 'Coconut', 'Corn', 'Eggs', 'Fish', 'Gelatin', 'Gluten', 'Milk', 'MSG', 'Peanuts', 'Pork', 'Red Dye', 'Sesame', 'Shellfish', 'Soy', 'Sulfites', 'Tree Nuts', 'Wheat'];
const MAX_QTY = 5;
const CARTS_KEY = 'set-aside-carts';

const el = Object.fromEntries(
  ['dates', 'halls', 'meals', 'search', 'diets', 'avoid', 'avoidCount', 'menu', 'tray', 'trayToggle'].map((id) => [id, document.getElementById(id)]),
);

const state = {
  status: null,
  menus: {},
  date: null,
  hallId: null,
  meal: null,
  diets: new Set(),
  avoid: new Set(),
  query: '',
  carts: loadCarts(),
  confirmation: null,
  form: { name: '', pickupTime: '', notes: '' },
  error: '',
  submitting: false,
  trayOpen: false,
};

function loadCarts() {
  try {
    return JSON.parse(localStorage.getItem(CARTS_KEY)) ?? {};
  } catch {
    return {};
  }
}

function saveCarts() {
  try {
    localStorage.setItem(CARTS_KEY, JSON.stringify(state.carts));
  } catch {
    // The plate still works for this visit without storage.
  }
}

const menu = () => state.menus[state.date] ?? null;
const hall = () => menu()?.halls.find((entry) => entry.id === state.hallId) ?? null;
const meal = () => hall()?.meals.find((entry) => entry.name === state.meal) ?? null;
const cartKey = () => `${state.date}|${state.hallId}|${state.meal}`;
const cart = () => state.carts[cartKey()] ?? {};

function allItems() {
  const items = new Map();
  for (const station of meal()?.stations ?? []) {
    for (const group of station.groups) {
      for (const item of group.items) items.set(item.id, item);
    }
  }
  return items;
}

function setQty(id, qty) {
  const key = cartKey();
  const next = { ...(state.carts[key] ?? {}) };
  if (qty > 0) next[id] = Math.min(qty, MAX_QTY);
  else delete next[id];
  if (Object.keys(next).length) state.carts[key] = next;
  else delete state.carts[key];
  state.confirmation = null;
  state.error = '';
  saveCarts();
  render();
}

function matches(item) {
  if (state.query && !item.name.toLowerCase().includes(state.query)) return false;
  for (const diet of state.diets) if (!item.diets.includes(diet)) return false;
  for (const allergen of state.avoid) if (item.allergens.includes(allergen)) return false;
  return true;
}

function defaultMeal(meals) {
  const today = state.status?.now.date === state.date;
  const time = state.status?.now.time ?? '';
  const preferred = !today || time >= '15:00' ? 'Dinner' : time >= '10:30' ? 'Lunch' : 'Breakfast';
  if (!today && meals.some((entry) => entry.name === 'Lunch')) return 'Lunch';
  return (meals.find((entry) => entry.name === preferred) ?? meals[0])?.name ?? null;
}

function settleSelection() {
  const halls = menu()?.halls ?? [];
  if (!halls.some((entry) => entry.id === state.hallId)) state.hallId = (halls.find((entry) => entry.meals.length) ?? halls[0])?.id ?? null;
  const meals = hall()?.meals ?? [];
  if (!meals.some((entry) => entry.name === state.meal)) state.meal = defaultMeal(meals);
}

function dayLabel(date) {
  if (date === state.status.dates[0]) return 'Today';
  if (date === state.status.dates[1]) return 'Tomorrow';
  return formatDate(date, { weekday: 'long' });
}

function tabButton(label, selected, onClick, sublabel) {
  return h('button', { type: 'button', class: selected ? 'is-on' : '', 'aria-pressed': String(selected), onClick }, label, sublabel && h('small', {}, sublabel));
}

function renderControls() {
  el.dates.replaceChildren(
    ...(state.status?.dates ?? []).map((date) =>
      tabButton(dayLabel(date), date === state.date, () => selectDate(date), formatDate(date, { month: 'short', day: 'numeric' })),
    ),
  );
  el.halls.replaceChildren(
    ...(menu()?.halls ?? []).map((entry) =>
      h('button', {
        type: 'button',
        class: entry.id === state.hallId ? 'is-on' : '',
        'aria-pressed': String(entry.id === state.hallId),
        title: entry.fullName,
        onClick: () => {
          state.hallId = entry.id;
          state.confirmation = null;
          settleSelection();
          render();
        },
      }, entry.name),
    ),
  );
  el.meals.replaceChildren(
    ...(hall()?.meals ?? []).map((entry) =>
      tabButton(entry.name, entry.name === state.meal, () => {
        state.meal = entry.name;
        state.confirmation = null;
        render();
      }),
    ),
  );
  el.avoidCount.textContent = state.avoid.size ? ` (${state.avoid.size})` : '';
}

function renderFilters() {
  const chip = (label, set, container) =>
    h('label', { class: 'chip' },
      h('input', {
        type: 'checkbox',
        onChange: (event) => {
          if (event.target.checked) set.add(label);
          else set.delete(label);
          render();
        },
      }),
      h('span', {}, label),
    );
  el.diets.replaceChildren(...DIETS.map((label) => chip(label, state.diets)));
  el.avoid.replaceChildren(...ALLERGENS.map((label) => chip(label, state.avoid)));
}

function notice(title, detail) {
  return h('div', { class: 'notice' }, h('h2', {}, title), detail && h('p', {}, detail));
}

function renderItem(item) {
  const qty = cart()[item.id] ?? 0;
  return h('li', { class: qty ? 'item is-picked' : 'item' },
    h('div', { class: 'item-text' },
      h('div', { class: 'item-name' }, item.name),
      h('div', { class: 'item-meta' },
        item.serving && h('span', {}, item.serving),
        item.diets.filter((diet) => diet !== 'Local').map((diet) => h('span', { class: 'tag' }, diet)),
      ),
      item.allergens.length > 0 && h('div', { class: 'item-allergens' }, `Contains ${item.allergens.join(', ').toLowerCase()}`),
    ),
    qty
      ? h('div', { class: 'stepper' },
          h('button', { type: 'button', 'aria-label': `Remove one ${item.name}`, onClick: () => setQty(item.id, qty - 1) }, '−'),
          h('output', {}, String(qty)),
          h('button', { type: 'button', 'aria-label': `Add one more ${item.name}`, disabled: qty >= MAX_QTY, onClick: () => setQty(item.id, qty + 1) }, '+'),
        )
      : h('button', { type: 'button', class: 'add', 'aria-label': `Add ${item.name}`, onClick: () => setQty(item.id, 1) }, 'Add'),
  );
}

function renderMenu() {
  if (!state.status) return el.menu.replaceChildren(notice('Loading menus…'));
  if (!menu()) {
    if (state.status.failing) return el.menu.replaceChildren(notice('Menus are unavailable right now', 'We couldn’t reach EatSmart. This page will retry on its own.'));
    return el.menu.replaceChildren(notice('Getting the day’s menus from EatSmart…', 'The first load of the day takes a minute or two.'));
  }
  if (!meal()) return el.menu.replaceChildren(notice('No menu posted', `${hall()?.fullName ?? 'This hall'} has nothing listed for ${formatDate(state.date)}.`));

  const sections = meal().stations
    .map((station) => {
      const groups = station.groups
        .map((group) => ({ ...group, items: group.items.filter(matches) }))
        .filter((group) => group.items.length);
      if (!groups.length) return null;
      return h('section', { class: 'station' },
        h('h2', {}, station.name),
        groups.map((group) => h('div', { class: 'group' }, h('h3', {}, group.name), h('ul', {}, group.items.map(renderItem)))),
      );
    })
    .filter(Boolean);

  el.menu.replaceChildren(...(sections.length ? sections : [notice('Nothing matches those filters', 'Try removing a filter or changing your search.')]));
}

function renderConfirmation() {
  const done = state.confirmation;
  return h('div', { class: 'confirmation' },
    h('p', { class: 'eyebrow' }, 'Request sent'),
    h('p', { class: 'code' }, done.code),
    h('p', {}, `Give this code at ${done.hallName} for ${done.meal.toLowerCase()}, ${formatDate(done.date)} at ${formatTime(done.pickupTime)}.`),
    h('button', { type: 'button', class: 'secondary', onClick: () => { state.confirmation = null; render(); } }, 'Start another'),
  );
}

async function submitOrder(event, lines) {
  event.preventDefault();
  if (state.submitting) return;
  state.submitting = true;
  state.error = '';
  render();
  const key = cartKey();
  try {
    state.confirmation = await api('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date: state.date,
        hallId: state.hallId,
        meal: state.meal,
        ...state.form,
        items: lines.map(([item, qty]) => ({ id: item.id, qty })),
      }),
    });
    delete state.carts[key];
    state.form.pickupTime = '';
    state.form.notes = '';
    saveCarts();
  } catch (error) {
    state.error = error.message;
  } finally {
    state.submitting = false;
    render();
  }
}

function renderTray() {
  const items = allItems();
  const lines = Object.entries(cart())
    .map(([id, qty]) => [items.get(Number(id)), qty])
    .filter(([item]) => item);
  const count = lines.reduce((sum, [, qty]) => sum + qty, 0);

  el.trayToggle.hidden = !count && !state.confirmation;
  el.trayToggle.textContent = state.confirmation ? 'View your code' : state.trayOpen ? 'Back to menu' : `Review plate (${count})`;
  el.tray.classList.toggle('is-open', state.trayOpen);

  if (state.confirmation) return el.tray.replaceChildren(renderConfirmation());

  const field = (label, control) => h('label', { class: 'field' }, h('span', {}, label), control);
  const bind = (name) => (event) => { state.form[name] = event.target.value; };

  const activeElement = document.activeElement?.name;
  el.tray.replaceChildren(...[
    h('h2', {}, 'Your plate'),
    meal() && h('p', { class: 'tray-context' }, `${hall().name} · ${state.meal} · ${formatDate(state.date)}`),
    lines.length
      ? h('ul', { class: 'lines' },
          lines.map(([item, qty]) =>
            h('li', {},
              h('span', {}, h('b', {}, `${qty} × `), item.name),
              h('button', { type: 'button', class: 'link', 'aria-label': `Remove ${item.name}`, onClick: () => setQty(item.id, 0) }, 'Remove'),
            ),
          ),
        )
      : h('p', { class: 'empty' }, 'Add food from the menu and it will appear here.'),
    lines.length > 0 &&
      h('form', { onSubmit: (event) => submitOrder(event, lines) },
        field('Name for pickup', h('input', { name: 'name', required: true, maxLength: 60, autocomplete: 'name', value: state.form.name, onInput: bind('name') })),
        field('Pickup time', h('input', { name: 'pickupTime', type: 'time', required: true, value: state.form.pickupTime, onInput: bind('pickupTime') })),
        field('Notes (optional)', h('textarea', { name: 'notes', rows: 2, maxLength: 300, value: state.form.notes, onInput: bind('notes') })),
        state.error && h('p', { class: 'error', role: 'alert' }, state.error),
        h('button', { type: 'submit', class: 'primary', disabled: state.submitting }, state.submitting ? 'Sending…' : 'Send request'),
      ),
  ].filter(Boolean));
  if (activeElement) el.tray.querySelector(`[name="${activeElement}"]`)?.focus();
}

function render() {
  settleSelection();
  renderControls();
  renderMenu();
  renderTray();
}

async function loadMenu(date) {
  if (state.menus[date]) return;
  try {
    state.menus[date] = await api(`/api/menu?date=${encodeURIComponent(date)}`);
  } catch (error) {
    if (error.status !== 404) console.error(error);
  }
}

async function selectDate(date) {
  state.date = date;
  state.confirmation = null;
  render();
  await loadMenu(date);
  render();
}

async function refresh() {
  try {
    state.status = await api('/api/status');
  } catch (error) {
    console.error(error);
    return;
  }
  if (!state.status.dates.includes(state.date)) state.date = state.status.dates[0];
  await loadMenu(state.date);
  render();
  const waiting = !menu();
  setTimeout(refresh, waiting ? 4000 : 5 * 60 * 1000);
}

el.search.addEventListener('input', (event) => {
  state.query = event.target.value.trim().toLowerCase();
  renderMenu();
});
el.trayToggle.addEventListener('click', () => {
  state.trayOpen = !state.trayOpen;
  renderTray();
});

renderFilters();
render();
refresh();
