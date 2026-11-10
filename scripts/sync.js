// Fetches today's and upcoming menus and writes them as static files for the site.
// Nothing is written unless the whole fetch succeeds, so a failure leaves the last good menus in place.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchDays } from '../lib/eatsmart.js';

const DAYS_AHEAD = Number(process.env.DAYS_AHEAD ?? 1);
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MENU_DIR = path.join(PUBLIC_DIR, 'menus');

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());

function addDays(iso, count) {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + count)).toISOString().slice(0, 10);
}

const dates = Array.from({ length: DAYS_AHEAD + 1 }, (_, offset) => addDays(today, offset));
console.log(`Syncing menus for ${dates.join(', ')}`);
const days = await fetchDays(dates);

fs.rmSync(MENU_DIR, { recursive: true, force: true });
fs.mkdirSync(MENU_DIR, { recursive: true });
for (const day of days) fs.writeFileSync(path.join(MENU_DIR, `${day.date}.json`), JSON.stringify(day));
fs.writeFileSync(path.join(PUBLIC_DIR, 'meta.json'), JSON.stringify({ dates, fetchedAt: days[0].fetchedAt }));

const counts = days.map((day) => `${day.date}: ${day.halls.reduce((sum, hall) => sum + hall.meals.length, 0)} meals`);
console.log(`Done. ${counts.join(', ')}`);
