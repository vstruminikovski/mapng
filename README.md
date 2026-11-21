# MapNG — Zoo parking → junction

Browser driving game built from the MapNG/BeamNG export of Debar Maalo, Skopje (`levels/prviot_krug`, read-only).
Three.js rendering, Rapier physics, SUMO-style (Krauss) traffic over the whole 1×1 km map.

Live: https://vstruminikovski.github.io/mapng/

```
npm install
npm run dev          # http://localhost:5173
npm test
npm run mapng:import # rebuild public/mapng/ from levels/ (never edits levels/)
```

- Signs, markings and lights are OpenStreetMap data via MapNG, **not verified**; signal timing is **simulated**.
- Field-surveyed traffic control goes in `public/survey/prviot_krug.geojson` — see `docs/MANUAL_SURVEY.md`.
- Textures: CC0 (ambientCG), see `public/textures/cc0/LICENSE.md`. Map data © OpenStreetMap contributors (ODbL).
