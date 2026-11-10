# Set Aside

Browse UIUC dining hall menus and try out requesting food to be premade.

**Ordering is a demo.** This branch is hosted as static files on GitHub Pages, so requests are saved only in the visitor's own browser and no food is prepared. The `main` branch has the version with a real server and shared kitchen list.

A GitHub Actions job (`.github/workflows/update-menus.yml`) reads today's and tomorrow's menus from EatSmart each morning, commits them to `public/`, and republishes the site.

## Run it locally

```bash
node scripts/sync.js
```

```bash
python3 -m http.server 3100 --directory public
```

Then open http://localhost:3100. The kitchen list is at `/kitchen.html`.

To include other EatSmart locations, add them to `HALLS` in `lib/eatsmart.js`.
