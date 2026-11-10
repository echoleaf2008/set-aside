# Set Aside

Browse UIUC dining hall menus and request food to be premade.

Needs Node 20 or newer. There is nothing to install.

```bash
node server.js
```

- Student menu: http://localhost:3000
- Kitchen list: http://localhost:3000/kitchen

The server reads today's and tomorrow's menus from EatSmart once per day (Central time) and saves them in `data/`. It only updates while it is running. If it was off, it catches up when started.

Requests are saved in `data/orders.json`. They are not sent to University Housing.

## Settings

Set these as environment variables.

| Name | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port to serve on |
| `HOST` | `127.0.0.1` | Set to `0.0.0.0` to allow other devices. Requires `KITCHEN_PIN`. |
| `KITCHEN_PIN` | none | PIN required to open the kitchen list |
| `DAYS_AHEAD` | `1` | Extra days to show after today |
| `DATA_DIR` | `./data` | Where menus and requests are stored |

To include other EatSmart locations, add them to `HALLS` in `lib/eatsmart.js`.
