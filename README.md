# Reisewetter

An interactive, client-side travel weather comparison map. Click anywhere on the world map to drop a marker; the app fetches historical daily weather from [NASA's POWER API](https://power.larc.nasa.gov/) (1981–present) for that location and plots weekly average max/min temperature and rainfall (with uncertainty bands) so you can compare multiple destinations side by side.

Live demo: https://kartoffelecke.github.io/reisewetter/

## How it works

- Pure static HTML/CSS/JS — no backend, no build step, no dependencies to install.
- Map: [Leaflet](https://leafletjs.com/) + OpenStreetMap tiles.
- Charts: [Plotly.js](https://plotly.com/javascript/).
- Weather data: [NASA POWER daily point API](https://power.larc.nasa.gov/docs/services/api/temporal/daily/), fetched directly from the browser and aggregated into weekly statistics client-side.

## Running locally

```
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

## AI authorship

This entire project — code, styling, aggregation logic, and CI/deploy setup — was written by Claude (Anthropic's AI coding assistant), based on a series of prompts describing the desired features. No hand-written code is included.
