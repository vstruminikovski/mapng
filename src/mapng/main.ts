// MapNG open-world driving simulator: the Debar Maalo map, no route or objectives.
// Wires import → render → physics → traffic → controls.

import * as THREE from 'three';
import './mapng.css';
import { Controls } from './controls/input';
import { loadLevel, type LevelData } from './import/loadLevel';
import { createVehicle, CAR } from './physics/vehicle';
import { createWorld, initRapier } from './physics/world';
import { carMesh, pedMesh, placeOnPose } from './render/actors';
import { loadModel } from './render/models';
import { buildProps, buildSignals } from './render/props';
import { buildRoads } from './render/roads';
import { createScene, followSun } from './render/scene';
import { buildSkirt, buildTerrainChunksAsync } from './render/terrain';
import { buildNames, type NamesFile } from './render/labels';
import { loadTerrainTexture } from './render/terrain';
import { SignalSystem } from './traffic/signals';
import { Traffic } from './traffic/traffic';
import type { LevelObjects, PropInstance } from './import/types';
import { bayLines, layoutParking, occupied } from './import/parkingLayout';
import { buildParkedCars } from './render/parking';
import { convertSurvey, frameOf, mergeSurvey, surveyPath, type SurveyCollection } from './import/manualSurvey';
import { userMarkingRoads } from './import/userMarkings';
import { buildUserItems, lampOf, type UserItem } from './render/userItems';

/** The builder's Export mod: see src/builder in the Project 03 repo. */
interface BuilderMod {
  format: 'mapng-mod';
  surveyFeatures: SurveyCollection['features'];
  objects: { trees: LevelObjects['trees']; lamps: LevelObjects['lamps'] };
  markings: { geometry: unknown; properties: { pattern?: string; width?: number }; id?: string }[];
}
const LEVEL_BASE = `${import.meta.env.BASE_URL}mapng/prviot_krug`.replace(/\/+/g, '/');
const app = document.getElementById('app')!;
const loading = document.getElementById('loading')!;
const errorText = loading.querySelector<HTMLElement>('.error-text')!;
const barFill = loading.querySelector<HTMLElement>('.bar i')!;
/** Honest progress: the fraction is what has actually loaded, never a timer. */
const pct = loading.querySelector<HTMLElement>('.pct')!;
const progress = (f: number) => {
  const v = Math.round(Math.min(1, Math.max(0, f)) * 100);
  barFill.style.width = `${v}%`;
  pct.textContent = `${v}%`;
};

boot().catch((e) => {
  console.error(e);
  errorText.textContent = `Could not start: ${e.message ?? e}`;
  loading.classList.add('error');
});

async function boot() {
  progress(0.05);
  const level = await loadLevel(LEVEL_BASE);

  // Buildings nearest the spawn start parsing now, in parallel with physics and the
  // roads. They gate the start; every other tile streams in while you drive.
  const spawn = level.route.start.p;
  const tiles = level.index.models
    .filter((m) => m.role === 'buildings' || m.role === 'sidewalks')
    .sort((a, b) => Math.hypot(a.position[0] - spawn[0], a.position[1] - spawn[1]) - Math.hypot(b.position[0] - spawn[0], b.position[1] - spawn[1]));
  // the start waits only for the buildings near the spawn point (within 300 m); the rest streams in behind it
  const nearSpawn = tiles.filter((m) => Math.hypot(m.position[0] - spawn[0], m.position[1] - spawn[1]) < 300).length;
  const FIRST = Math.max(4, nearSpawn);
  const failed: string[] = [];
  const parse = (m: (typeof tiles)[number]) =>
    loadModel(LEVEL_BASE, m, level.terrain.heightAt)
      .then((lm) => ({ m, lm }))
      .catch((e) => {
        failed.push(m.file);
        console.warn('model failed', m.file, e);
        return null;
      });
  const firstParsed = tiles.slice(0, FIRST).map(parse);

  // Manual field-survey override layer (optional file; never edits levels/).
  progress(0.2);
  const surveyUrl = `${import.meta.env.BASE_URL}${surveyPath('prviot_krug')}`.replace(/\/+/g, '/');
  const fc: SurveyCollection | null = await fetch(surveyUrl)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  // the builder's Export mod (public/survey/active.json): its survey features, trees and lamps
  const modUrl = `${import.meta.env.BASE_URL}survey/active.json`.replace(/\/+/g, '/');
  const modRaw = await fetch(modUrl).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  // version 2: every builder item, drawn by the same code as the builder (userItems.ts)
  const items: UserItem[] | null = modRaw && modRaw.format === 'mapng-mod' && modRaw.version === 2 ? (modRaw.items as UserItem[]) : null;
  // version 1: the older survey-style export
  const mod: BuilderMod | null = modRaw && modRaw.format === 'mapng-mod' && modRaw.version === 1 ? (modRaw as BuilderMod) : null;
  if (mod) {
    level.objects.trees.push(...mod.objects.trees);
    level.objects.lamps.push(...mod.objects.lamps);
  }
  const surveyAll = { type: 'FeatureCollection', features: [...(fc?.features ?? []), ...(mod?.surveyFeatures ?? [])] } as SurveyCollection;
  const merged = mergeSurvey(level, convertSurvey(surveyAll, frameOf(level.index), level.terrain.heightAt));
  level.objects = merged.objects;
  level.roads = merged.roads;
  const sv = merged.summary;
  if (sv.rejected.length) console.warn('Survey features rejected (not placed):', sv.rejected);
  if (sv.unmodelledSigns.length) console.info('Surveyed signs placed without a dedicated 3D sign model:', sv.unmodelledSigns);
  let darkLights = merged.lights.filter((l) => l.controllerId === null);

  // Parking bays from map geometry (OSM lot outlines + aisles), painted and partly filled.
  const bays = layoutParking(level.objects, level.roads, level.terrain.heightAt);
  level.roads = [...level.roads, ...bayLines(bays)];

  // CLEAN MAP: no traffic control in the game. Signs, signals, road markings, zebras and
  // lane arrows are removed (survey file kept on disk, not shown). Roads, buildings,
  // trees, lamps, parked cars and moving traffic stay.
  const CLEAN_MAP = true;
  if (CLEAN_MAP) {
    level.objects.signs = [];
    level.objects.signals.instances = [];
    darkLights = [];
    level.roads = level.roads.filter((r) => r.kind !== 'marking' && r.kind !== 'zebra');
  }
  // what you placed in the builder comes back after the clean map: its signs and its traffic lights
  const yours = (p: { provenance: { source: string } }) => p.provenance.source === 'manual-survey';
  level.objects.signs.push(...merged.signs.filter(yours).map((s) => ({ type: s.type, pos: s.pos, yaw: s.yaw, scale: s.scale, ...(s.mount ? { mount: s.mount } : {}) })));
  // every light you placed is drawn dark: the map timing it may have been matched to is removed by the clean map
  darkLights = [...darkLights, ...merged.lights.filter((l) => yours(l))];
  // lines drawn in the builder (public/survey/markings.geojson): added after the clean map, so they show
  const markingsUrl = `${import.meta.env.BASE_URL}survey/markings.geojson`.replace(/\/+/g, '/');
  const markingsFc = items ? null : mod && mod.markings.length ? { features: mod.markings } : await fetch(markingsUrl).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  level.roads = [...level.roads, ...userMarkingRoads(markingsFc, frameOf(level.index), level.terrain.heightAt)];
  if (markingsFc) console.info(`builder markings: ${markingsFc.features.length} features`);
  const start = level.route.start; // where the car is placed when the game starts or resets
  const parked = occupied(bays, [start.p]);

  progress(0.3);
  const R = await initRapier();
  const physics = createWorld(R, level.terrain);
  physics.addBoundary(level.terrain); // invisible walls at the map edge
  const kit = createScene(app);
  const { scene, camera, renderer, sun, sky } = kit;

  // heavy steps run a piece at a time with a pause between, so the loader keeps moving on slow phones
  const pause = () => new Promise<void>((r) => setTimeout(r, 0));
  progress(0.4);
  const tex = await loadTerrainTexture(`${LEVEL_BASE}/${level.index.terrain.baseTexture}`);
  await pause();
  const terrain = await buildTerrainChunksAsync(level.terrain, tex, (d, total) => progress(0.4 + (0.05 * d) / total));
  scene.add(terrain);
  await pause();
  scene.add(buildSkirt(level.terrain));
  await pause();
  scene.add(buildRoads(level.roads));
  await pause();
  scene.add(buildParkedCars(parked));
  // street and place names (OpenStreetMap)
  const names: NamesFile | null = await fetch(`${LEVEL_BASE}/names.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  // road labels come from the merged streets (same-name ways joined into one street)
  const streets: { streets: { name: string; ways: number[][][] }[] } | null = await fetch(`${LEVEL_BASE}/streets.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (names && streets) names.roads = streets.streets.flatMap((st) => st.ways.map((w) => ({ name: st.name, pts: w })));
  let nameGroup: THREE.Group | null = null; // built once the buildings are in, so labels clear roofs
  for (const b of parked) physics.addBox(b.x, b.y, b.z, b.heading, [2.05, 0.88, 0.75]);
  const drivable = level.roads.filter((r) => r.kind === 'carriageway' || r.kind === 'service');
  const signalMeshes = buildSignals(level.objects, darkLights, (p, d) => curbside(drivable, p, d, level.terrain.heightAt));
  scene.add(signalMeshes.group);
  // the builder's items (mod version 2)
  const userBuild = items ? buildUserItems(items, level.terrain.heightAt, (p, d) => curbside(drivable, p, d, level.terrain.heightAt)) : null;
  if (userBuild) for (const g of [userBuild.signs, userBuild.lights, userBuild.lights2, userBuild.props, userBuild.poles, userBuild.marks]) scene.add(g);

  // Attach the first tiles (already parsed) and wait for them.
  let firstDone = 0;
  const firstTiles = await Promise.all(firstParsed.map((p) => p.then((r) => (progress(0.45 + (0.45 * ++firstDone) / tiles.length), r))));
  const tileMeshes: { x: number; y: number; obj: THREE.Object3D }[] = [];
  const propCells: { x: number; y: number; group: THREE.Group }[] = [];
  const attach = (r: Awaited<ReturnType<typeof parse>>) => {
    if (!r) return;
    scene.add(r.lm.object);
    tileMeshes.push({ x: r.m.position[0], y: r.m.position[1], obj: r.lm.object });
    physics.addTrimesh(r.lm.collision.vertices, r.lm.collision.indices);
  };
  firstTiles.forEach(attach);

  // Props for the whole map, placed once every building is in (they are dropped where
  // they would stand inside a building or on a road).
  const placeProps = () => {
    const buildingMeshes: THREE.Mesh[] = [];
    scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && /^bld/.test(o.name)) buildingMeshes.push(o as THREE.Mesh);
    });
    const blocked = insideOrOnRoad(buildingMeshes, drivable);
    if (names) {
      const rc = new THREE.Raycaster();
      const roofAt = (x: number, y: number): number | null => {
        rc.set(new THREE.Vector3(x, 200, -y), new THREE.Vector3(0, -1, 0));
        const hit = rc.intersectObjects(buildingMeshes, false)[0];
        return hit ? hit.point.y : null;
      };
      nameGroup = buildNames(names, level.terrain, roofAt);
      scene.add(nameGroup);
    }
    // props are grouped in 256 m cells so distant cells can be hidden as a whole
    const CELL = 256;
    const cellKey = (p: { pos: number[] }) => `${Math.floor((p.pos[0] + 512) / CELL)},${Math.floor((p.pos[1] + 512) / CELL)}`;
    const o = level.objects;
    const keys = new Set([...o.trees, ...o.lamps, ...o.fences, ...o.signs].map(cellKey));
    for (const k of keys) {
      const pick = <T extends { pos: number[] }>(arr: T[]) => arr.filter((p) => cellKey(p) === k);
      const group = buildProps({ ...o, trees: pick(o.trees), lamps: pick(o.lamps), fences: pick(o.fences), signs: pick(o.signs) }, blocked);
      const [cx, cy] = k.split(',').map(Number);
      scene.add(group);
      propCells.push({ x: cx * CELL - 512 + CELL / 2, y: cy * CELL - 512 + CELL / 2, group });
      for (const w of group.userData.walls as PropInstance[]) physics.addBox(w.pos[0], w.pos[1], w.pos[2], w.yaw, [1.55, 0.15, 0.6]);
    }
  };

  // Player car at the parking start, facing along the aisle.
  const startPos = () => ({ x: start.p[0], y: level.terrain.heightAt(start.p[0], start.p[1]) + 0.9, z: -start.p[1] });
  const vehicle = createVehicle(physics, startPos(), start.heading);
  const car = carMesh(0xe9dfc8);
  scene.add(car);

  const signals = new SignalSystem(level.objects.signals);
  // One junction, one signal: heads within 15 m of each other follow a single master head
  // (a surveyed light wins over a map light), so the lights at a crossing change together.
  // Heads 5 and 7 are the two lights at the far side of the surveyed crossing (about 25 m
  // away), linked explicitly so they change with the surveyed light.
  for (const id of [5, 7]) signals.link(id, 200000);
  {
    const insts = level.objects.signals.instances;
    const done = new Set<number>();
    for (const a of [...insts].sort((p, q) => (p.id >= 200000 ? 0 : 1) - (q.id >= 200000 ? 0 : 1) || p.id - q.id)) {
      if (done.has(a.id)) continue;
      for (const b of insts)
        if (!done.has(b.id) && Math.hypot(a.pos[0] - b.pos[0], a.pos[1] - b.pos[1]) < 15) {
          signals.link(b.id, a.id);
          done.add(b.id);
        }
    }
  }
  const traffic = new Traffic(level.network, level.roads, signals, { center: [0, 0], radius: 800, cars: 70, pedestrians: 80 });
  const aiMeshes = traffic.cars.map((c) => {
    const m = carMesh(c.color, false);
    scene.add(m);
    return m;
  });
  const pedMeshes = traffic.peds.map((p) => {
    const m = pedMesh((p.id * 0.137) % 1);
    scene.add(m);
    return m;
  });

  const controls = new Controls(app);
  controls.onReset = () => vehicle.reset(startPos(), start.heading);
  let topDown = false;
  controls.onCamera = () => (topDown = !topDown);

  const hud = makeHud();

  // Only what is near the car is drawn: terrain detail, buildings, prop cells and traffic.
  const DRAW = 480; // metres
  const near2 = (x: number, y: number, r: number, ox: number, oy: number) => Math.hypot(x - ox, y - oy) < r;
  const cull = (x: number, y: number) => {
    for (const c of terrain.userData.chunks as { cx: number; cy: number; near: THREE.Mesh; far: THREE.Mesh }[]) {
      const d = Math.hypot(c.cx - x, c.cy - y);
      c.near.visible = d < 230;
      c.far.visible = d >= 230 && d < DRAW + 150;
    }
    for (const t of tileMeshes) t.obj.visible = near2(x, y, DRAW + 200, t.x, t.y);
    for (const c of propCells) c.group.visible = near2(x, y, DRAW + 150, c.x, c.y);
    if (nameGroup) for (const n of nameGroup.children) n.visible = near2(x, y, 260, n.position.x, -n.position.z);
    traffic.cars.forEach((c, i) => (aiMeshes[i].visible = near2(x, y, DRAW, c.pose.x, c.pose.y)));
    traffic.peds.forEach((p, i) => (pedMeshes[i].visible = near2(x, y, DRAW, p.pose.x, p.pose.y)));
    sky.position.copy(camera.position);
  };
  const clock = new THREE.Clock();
  let acc = 0;
  const camPos = new THREE.Vector3();
  const camLook = new THREE.Vector3();
  let first = true;

  // The game loop stays idle until the countdown ends, so loading gets the whole device.
  let running = false;
  const HELD = { throttle: 0, brake: 1, steer: 0, handbrake: true, reverse: false };
  renderer.setAnimationLoop(() => {
    const dt = Math.min(0.05, clock.getDelta());
    // at most 2 physics steps per frame: on a slow device, don't fall further behind
    acc = Math.min(acc + dt, 2 / 60);
    // during the countdown the car is held still: brake on, no steering, no physics
    const input = running ? controls.read(dt, vehicle.speed()) : HELD;
    // Physics runs in fixed 1/60 s steps; the car is drawn between the last two steps
    // (interpolated), so motion stays smooth whatever the screen refresh rate.
    const sample = () => ({ p: vehicle.body.translation(), q: vehicle.body.rotation() });
    let prev = sample(), curr = prev;
    while (running && acc >= 1 / 60) {
      vehicle.update(input, 1 / 60);
      physics.step(1 / 60);
      prev = curr;
      curr = sample();
      acc -= 1 / 60;
    }
    const alpha = running ? acc * 60 : 1;
    const t = vehicle.body.translation(); // physics position: gameplay checks use this
    if (Math.hypot(curr.p.x - prev.p.x, curr.p.z - prev.p.z) > 3) prev = curr; // reset/teleport: no smear
    const drawP = new THREE.Vector3(
      prev.p.x + (curr.p.x - prev.p.x) * alpha,
      prev.p.y + (curr.p.y - prev.p.y) * alpha,
      prev.p.z + (curr.p.z - prev.p.z) * alpha,
    );
    const drawQ = new THREE.Quaternion(prev.q.x, prev.q.y, prev.q.z, prev.q.w).slerp(
      new THREE.Quaternion(curr.q.x, curr.q.y, curr.q.z, curr.q.w),
      alpha,
    );
    car.position.set(drawP.x, drawP.y - 0.42, drawP.z);
    car.quaternion.copy(drawQ);
    const wheels: THREE.Object3D[] = car.userData.wheels;
    wheels.forEach((w, i) => {
      const s = vehicle.wheel(i);
      w.position.y = 0.31 + (CAR.restLength - s.suspension) * 0.6;
      w.rotation.set(0, i < 2 ? -vehicle.steerAngle() : 0, 0);
      (w.children[0] as THREE.Object3D).rotation.z = -s.spin;
    });
    car.userData.brake.emissiveIntensity = input.brake > 0 ? 2 : 0.4;
    const fwd = new THREE.Vector3(1, 0, 0).applyQuaternion(car.quaternion);
    const heading = Math.atan2(-fwd.z, fwd.x);
    const speed = vehicle.speed();
    const wx = t.x, wy = -t.z;

    // if the car falls through or flips, put it back at the start
    if (t.y < level.terrain.heightAt(wx, wy) - 3 || fwd.y > 0.85 || fwd.y < -0.85) controls.onReset?.();

    if (running) traffic.update(dt, { x: wx, y: wy, z: t.y, heading, speed });
    traffic.cars.forEach((c, i) => placeOnPose(aiMeshes[i], c.pose, level.terrain.heightAt));
    traffic.peds.forEach((p, i) => placeOnPose(pedMeshes[i], p.pose, level.terrain.heightAt));
    cull(wx, wy);
    signalMeshes.update((id) => signals.state(id, traffic.clock));
    if (userBuild) {
      // the placed lights run their own timers
      const now = performance.now() / 1000;
      for (const u of userBuild.lightUpdaters) u.update((id) => { const r = u.recs[-1 - id]; return r && r.cat === 'light' ? lampOf(r, now) : 'off'; });
    }
    hud.update({ speed, reverse: input.reverse });

    // camera
    const target = drawP.clone();
    const flat = new THREE.Vector3(fwd.x, 0, fwd.z).normalize();
    const want = topDown
      ? target.clone().add(new THREE.Vector3(0, 60, 0.01))
      : target.clone().addScaledVector(flat, -7.5).add(new THREE.Vector3(0, 2.9, 0));
    const look = topDown ? target : target.clone().addScaledVector(flat, 4).add(new THREE.Vector3(0, 0.8, 0));
    const k = first ? 1 : 1 - Math.exp(-dt * 5);
    camPos.lerp(want, k);
    camLook.lerp(look, k);
    first = false;
    camera.position.copy(camPos);
    camera.lookAt(camLook);
    followSun(sun, target);
    renderer.render(scene, camera);
  });

  // The rest of the map: every other building tile, then the props and the flag. One tile at a time,
  // yielding between tiles so the car never stalls. It streams in while you start driving.
  const streamRest = async () => {
    for (const m of tiles.slice(FIRST)) {
      attach(await parse(m));
      await new Promise((r) => setTimeout(r, 0));
    }
    placeProps();
    // the real flag model from the map export, at its exported position (no collision)
    const flagTile = level.index.models.find((m) => m.role === 'flag');
    if (flagTile) await loadModel(LEVEL_BASE, flagTile, level.terrain.heightAt).then((lm) => scene.add(lm.object)).catch((e) => console.warn('flag model failed', e));
  };
  progress(0.95);
  await new Promise((r) => setTimeout(r, 0));
  progress(1);

  // The game screen appears now; 3 · 2 · 1 counts down over it, then the car is live.
  loading.classList.add('fade');
  setTimeout(() => loading.remove(), 450);
  const count = document.createElement('div');
  count.className = 'mg-count';
  app.appendChild(count);
  for (const v of ['3', '2', '1']) {
    count.textContent = v;
    await new Promise((r) => setTimeout(r, 1000));
  }
  count.remove();
  running = true;
  hud.toast('You are spawned at Skopje Zoo.');
  void streamRest(); // the rest of the map loads while you drive

  // test hook
  (window as unknown as Record<string, unknown>).__mapng = { level, vehicle, traffic, failed, scene, camera, renderer, survey: merged, bays, parked, signals };
}

/** Distance from (x, y) to the nearest drivable road edge (negative = on the road), with that road's direction. */
function nearestRoad(roads: LevelData['roads'], x: number, y: number) {
  let best = { edge: Infinity, centre: Infinity, ux: 1, uy: 0, hw: 0 };
  for (const r of roads)
    for (let i = 0; i < r.points.length - 1; i++) {
      const a = r.points[i], b = r.points[i + 1];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const L = Math.hypot(dx, dy) || 1e-6;
      const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (L * L)));
      const d = Math.hypot(x - a[0] - dx * t, y - a[1] - dy * t);
      const hw = Math.min(a[3], b[3]) / 2;
      if (d - hw < best.edge) best = { edge: d - hw, centre: d, ux: dx / L, uy: dy / L, hw };
    }
  return best;
}

/** Drop props inside building volumes (roof hit well above the prop) or on a carriageway. */
function insideOrOnRoad(buildings: THREE.Mesh[], roads: LevelData['roads']) {
  const rc = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  const from = new THREE.Vector3();
  return (x: number, y: number, z: number) => {
    if (nearestRoad(roads, x, y).edge < -0.5) return true;
    rc.set(from.set(x, z + 80, -y), down);
    const hit = rc.intersectObjects(buildings, false)[0];
    return !!hit && hit.point.y > z + 2;
  };
}

/**
 * Stand a traffic-light pole at the right-hand kerb of the drivers it faces
 * (right-hand traffic), not in the middle of the carriageway.
 */
function curbside(roads: LevelData['roads'], p: number[], dir: number[], heightAt: (x: number, y: number) => number) {
  const r = nearestRoad(roads, p[0], p[1]);
  if (r.edge > 0) return p; // already off the road
  // drivers travel against dir; their right is (vy, −vx) with v = −dir
  const rx = -dir[1], ry = dir[0];
  const k = r.hw + 0.6;
  const x = p[0] + rx * k, y = p[1] + ry * k;
  return [x, y, heightAt(x, y)];
}

function makeHud() {
  const el = document.createElement('div');
  el.className = 'mg-hud';
  el.innerHTML = `
    <div class="mg-toast" hidden></div>
    <div class="mg-speed"><b>0</b><span>km/h</span><em>D</em></div>
    <div class="mg-help">W/↑ gas · S/↓ brake · A D steer · Space handbrake · R reset · C camera</div>`;
  document.getElementById('app')!.appendChild(el);
  const sp = el.querySelector<HTMLElement>('.mg-speed b')!;
  const gear = el.querySelector<HTMLElement>('.mg-speed em')!;
  const toast = el.querySelector<HTMLElement>('.mg-toast')!;
  let timer = 0;
  return {
    onRestart: () => {},
    update(s: { speed: number; reverse: boolean }) {
      sp.textContent = String(Math.round(Math.abs(s.speed) * 3.6));
      gear.textContent = s.reverse ? 'R' : 'D';
    },
    toast(text: string) {
      toast.textContent = text;
      toast.hidden = false;
      toast.classList.remove('gone');
      clearTimeout(timer);
      timer = window.setTimeout(() => toast.classList.add('gone'), 4000);
    },
  };
}
