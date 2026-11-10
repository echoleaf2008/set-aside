// Reads menus from University Housing's public EatSmart (NetNutrition) site.
// The site keeps navigation state in a server session, so every sync uses one
// cookie jar and makes its requests strictly one at a time.

const BASE = 'https://eatsmart.housing.illinois.edu';
const ROOT = '/NetNutrition/46';
const REQUEST_GAP_MS = 250;

export const HALLS = [
  { id: 1, name: 'Ikenberry', fullName: 'Ikenberry Dining Center (Ike)' },
  { id: 11, name: 'ISR', fullName: 'Illinois Street Dining Center (ISR)' },
  { id: 22, name: 'PAR', fullName: 'Pennsylvania Avenue Dining Hall (PAR)' },
  { id: 29, name: 'LAR', fullName: 'Lincoln Avenue Dining Hall (LAR)' },
];

const DIET_TAGS = new Set(['Halal', 'Jain', 'Kosher', 'Local', 'Sustainable Seafood', 'Vegan', 'Vegetarian']);
const MEAL_ORDER = ['Breakfast', 'Brunch', 'Lunch', 'Light Lunch', 'Dinner'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ENTITIES = { nbsp: ' ', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function decode(text) {
  return text
    .replace(/&(?:#(\d+)|#x([0-9a-f]+)|(\w+));/gi, (match, dec, hex, name) => {
      if (dec) return String.fromCodePoint(Number(dec));
      if (hex) return String.fromCodePoint(parseInt(hex, 16));
      return ENTITIES[name.toLowerCase()] ?? match;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

class Session {
  cookies = new Map();

  headers(extra = {}) {
    return {
      // EatSmart answers with a start-up error when these are missing.
      'User-Agent': 'set-aside-menu-sync/1.0',
      Accept: 'text/html,application/json,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      Cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '),
      ...extra,
    };
  }

  remember(response) {
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const split = pair.indexOf('=');
      this.cookies.set(pair.slice(0, split), pair.slice(split + 1));
    }
  }

  async open() {
    let url = BASE + ROOT;
    for (let hop = 0; hop < 10; hop++) {
      const response = await fetch(url, {
        headers: this.headers(),
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
      });
      this.remember(response);
      if (response.status >= 300 && response.status < 400) {
        url = new URL(response.headers.get('location'), url).href;
        continue;
      }
      if (!response.ok) throw new Error(`EatSmart home returned ${response.status}`);
      await response.text();
      return;
    }
    throw new Error('EatSmart redirected too many times');
  }

  async post(path, body) {
    await sleep(REQUEST_GAP_MS);
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetch(BASE + ROOT + path, {
          method: 'POST',
          headers: this.headers({
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
          }),
          body: new URLSearchParams(body),
          redirect: 'manual',
          signal: AbortSignal.timeout(30_000),
        });
        this.remember(response);
        if (!response.ok) throw new Error(`EatSmart ${path} returned ${response.status}`);
        const data = JSON.parse(await response.text());
        if (!data.success || !Array.isArray(data.panels)) throw new Error(`EatSmart ${path} reported failure`);
        return data;
      } catch (error) {
        lastError = error;
        await sleep(1500);
      }
    }
    throw lastError;
  }
}

const panel = (data, id) => data.panels.find((p) => p.id === id)?.html ?? '';

export function parseStations(html) {
  return [...html.matchAll(/childUnitsSelectUnit\((\d+)\);"[^>]*>([^<]+)</g)].map((m) => ({
    id: Number(m[1]),
    name: decode(m[2]),
  }));
}

function headerToIso(text) {
  const match = /([A-Z][a-z]+) (\d{1,2}), (\d{4})/.exec(text);
  if (!match) return null;
  const month = MONTHS.indexOf(match[1]) + 1;
  if (!month) return null;
  return `${match[3]}-${String(month).padStart(2, '0')}-${match[2].padStart(2, '0')}`;
}

// Returns [{ date: 'YYYY-MM-DD', meals: [{ name, menuOid }] }]
export function parseMenuList(html) {
  return html
    .split(/<section class='card mb-3 h4'>/)
    .slice(1)
    .map((card) => ({
      date: headerToIso(/<header[^>]*>([^<]+)</.exec(card)?.[1] ?? ''),
      meals: [...card.matchAll(/menuListSelectMenu\((\d+)\);"[^>]*>([^<]+)</g)].map((m) => ({
        name: decode(m[2]),
        menuOid: Number(m[1]),
      })),
    }))
    .filter((day) => day.date);
}

// Returns [{ name, items: [{ id, name, serving, allergens, diets }] }]
export function parseItems(html) {
  const groups = [];
  let current = null;
  for (const row of html.split(/<tr\b/).slice(1)) {
    if (row.includes('cbo_nn_itemGroupRow')) {
      current = { name: decode(/<div role='button'>([^<]*)/.exec(row)?.[1] ?? 'Other'), items: [] };
      groups.push(current);
      continue;
    }
    if (!/cbo_nn_item(Primary|Alternate)Row/.test(row)) continue;
    const id = /data-detailoid='(\d+)'/.exec(row)?.[1];
    const name = /class='cbo_nn_itemHover'>([^<]*)/.exec(row)?.[1];
    if (!id || !name) continue;
    if (!current) {
      current = { name: 'Other', items: [] };
      groups.push(current);
    }
    const tags = [...row.matchAll(/<img title='([^']*)'/g)].map((m) => decode(m[1]));
    current.items.push({
      id: Number(id),
      name: decode(name),
      serving: decode(/<\/a><\/td><td class='align-middle'>([^<]*)</.exec(row)?.[1] ?? ''),
      allergens: tags.filter((tag) => !DIET_TAGS.has(tag)),
      diets: tags.filter((tag) => DIET_TAGS.has(tag)),
    });
  }
  return groups.filter((group) => group.items.length);
}

function mealRank(name) {
  const rank = MEAL_ORDER.findIndex((meal) => meal.toLowerCase() === name.toLowerCase());
  return rank === -1 ? MEAL_ORDER.length : rank;
}

// Fetches several dates in one pass, because a station's menu list covers them all.
export async function fetchDays(dates) {
  const wanted = new Set(dates);
  const session = new Session();
  await session.open();

  const days = new Map(dates.map((date) => [date, new Map(HALLS.map((hall) => [hall.id, new Map()]))]));
  let menusSeen = 0;
  let itemsSeen = 0;

  for (const hall of HALLS) {
    const hallData = await session.post('/Unit/SelectUnitFromUnitsList', { unitOid: hall.id });
    const stations = parseStations(panel(hallData, 'childUnitsPanel'));
    if (!stations.length) throw new Error(`No stations found for ${hall.name}; the EatSmart page may have changed`);

    for (const station of stations) {
      await session.post('/Unit/SelectUnitFromUnitsList', { unitOid: hall.id });
      const stationData = await session.post('/Unit/SelectUnitFromChildUnitsList', { unitOid: station.id });
      for (const day of parseMenuList(panel(stationData, 'menuPanel'))) {
        if (!wanted.has(day.date)) continue;
        for (const meal of day.meals) {
          menusSeen++;
          const menuData = await session.post('/Menu/SelectMenu', { menuOid: meal.menuOid });
          const groups = parseItems(panel(menuData, 'itemPanel'));
          if (!groups.length) continue;
          itemsSeen += groups.reduce((sum, group) => sum + group.items.length, 0);
          const meals = days.get(day.date).get(hall.id);
          if (!meals.has(meal.name)) meals.set(meal.name, []);
          meals.get(meal.name).push({ name: station.name, groups });
        }
      }
    }
  }

  if (menusSeen && !itemsSeen) throw new Error('Menus were listed but no items parsed; the EatSmart page may have changed');

  const fetchedAt = new Date().toISOString();
  return dates.map((date) => ({
    date,
    fetchedAt,
    halls: HALLS.map((hall) => ({
      id: hall.id,
      name: hall.name,
      fullName: hall.fullName,
      meals: [...days.get(date).get(hall.id)]
        .map(([name, stations]) => ({ name, stations }))
        .sort((a, b) => mealRank(a.name) - mealRank(b.name)),
    })),
  }));
}
