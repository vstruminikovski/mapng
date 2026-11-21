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
import { buildDirectionArrows, buildRoads } from './render/roads';
import { createScene, followSun } from './render/scene';
import { buildSkirt, buildTerrain } from './render/terrain';
import { SignalSystem } from './traffic/signals';
import { Traffic } from './traffic/traffic';
import type { PropInstance } from './import/types';
import { bayLines, layoutParking, occupied } from './import/parkingLayout';
import { buildParkedCars } from './render/parking';
import { convertSurvey, frameOf, mergeSurvey, surveyPath, type SurveyCollection } from './import/manualSurvey';

const LEVEL_BASE = `${import.meta.env.BASE_URL}mapng/prviot_krug`.replace(/\/+/g, '/');
const app = document.getElementById('app')!;
const loading = document.getElementById('loading')!;
const status = (s: string) => (loading.querySelector('p')!.textContent = s);

boot().catch((e) => {
  console.error(e);
  status(`Could not start: ${e.message ?? e}`);
  loading.classList.add('error');
});

async function boot() {
  status('Loading map data…');
  const level = await loadLevel(LEVEL_BASE, (m) => status(`Loading ${m}…`));

  // Manual field-survey override layer (optional file; never edits levels/).
  status('Loading surveyed traffic control…');
  const surveyUrl = `${import.meta.env.BASE_URL}${surveyPath('prviot_krug')}`.replace(/\/+/g, '/');
  const fc: SurveyCollection | null = await fetch(surveyUrl)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  const merged = mergeSurvey(level, convertSurvey(fc, frameOf(level.index), level.terrain.heightAt));
  level.objects = merged.objects;
  level.roads = merged.roads;
  const sv = merged.summary;
  if (sv.rejected.length) console.warn('Survey features rejected (not placed):', sv.rejected);
  if (sv.unmodelledSigns.length) console.info('Surveyed signs placed without a dedicated 3D sign model:', sv.unmodelledSigns);
  const darkLights = merged.lights.filter((l) => l.controllerId === null);

  // Parking bays from map geometry (OSM lot outlines + aisles), painted and partly filled.
  const bays = layoutParking(level.objects, level.roads, level.terrain.heightAt);
  level.roads = [...level.roads, ...bayLines(bays)];
  const start = level.route.start; // where the car is placed when the game starts or resets
  const parked = occupied(bays, [start.p]);

  status('Starting physics…');
  const R = await initRapier();
  const physics = createWorld(R, level.terrain);
  physics.addBoundary(level.terrain); // invisible walls at the map edge
  const kit = createScene(app);
  const { scene, camera, renderer, sun } = kit;

  status('Building terrain and roads…');
  scene.add(buildTerrain(level.terrain, `${LEVEL_BASE}/${level.index.terrain.baseTexture}`));
  scene.add(buildSkirt(level.terrain));
  scene.add(buildRoads(level.roads));
  scene.add(buildDirectionArrows(level.roads));
  scene.add(buildParkedCars(parked));
  for (const b of parked) physics.addBox(b.x, b.y, b.z, b.heading, [2.05, 0.88, 0.75]);
  const drivable = level.roads.filter((r) => r.kind === 'carriageway' || r.kind === 'service');
  const signalMeshes = buildSignals(level.objects, darkLights, (p, d) => curbside(drivable, p, d, level.terrain.heightAt));
  scene.add(signalMeshes.group);

  // Every building and sidewalk tile of the 1×1 km map: visuals and Rapier trimeshes.
  const near = level.index.models.filter((m) => m.role === 'buildings' || m.role === 'sidewalks');
  let done = 0;
  const failed: string[] = [];
  await Promise.all(
    near.map((m) =>
      loadModel(LEVEL_BASE, m, level.terrain.heightAt)
        .then((lm) => {
          scene.add(lm.object);
          physics.addTrimesh(lm.collision.vertices, lm.collision.indices);
          status(`Loading buildings and sidewalks… ${++done}/${near.length}`);
        })
        .catch((e) => {
          failed.push(m.file);
          console.warn('model failed', m.file, e);
        }),
    ),
  );

  // Props for the whole map, minus those that would stand inside a building or on a road.
  const buildingMeshes: THREE.Mesh[] = [];
  scene.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && /^bld/.test(o.name)) buildingMeshes.push(o as THREE.Mesh);
  });
  const props = buildProps(level.objects, insideOrOnRoad(buildingMeshes, drivable));
  scene.add(props);
  console.info('Props dropped (inside a building or on a road):', props.userData.dropped);
  for (const w of props.userData.walls as PropInstance[]) physics.addBox(w.pos[0], w.pos[1], w.pos[2], w.yaw, [1.55, 0.15, 0.6]);

  // Player car at the parking start, facing along the aisle.
  const startPos = () => ({ x: start.p[0], y: level.terrain.heightAt(start.p[0], start.p[1]) + 0.9, z: -start.p[1] });
  const vehicle = createVehicle(physics, startPos(), start.heading);
  const car = carMesh(0xe9dfc8);
  scene.add(car);

  const signals = new SignalSystem(level.objects.signals);
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

  const hud = makeHud(failed, merged.summary);

  loading.remove();
  const clock = new THREE.Clock();
  let acc = 0;
  const camPos = new THREE.Vector3();
  const camLook = new THREE.Vector3();
  let first = true;

  renderer.setAnimationLoop(() => {
    const dt = Math.min(0.05, clock.getDelta());
    acc += dt;
    const input = controls.read(dt, vehicle.speed());
    while (acc >= 1 / 60) {
      vehicle.update(input, 1 / 60);
      physics.step(1 / 60);
      acc -= 1 / 60;
    }

    // player pose
    const t = vehicle.body.translation();
    const q = vehicle.body.rotation();
    car.position.set(t.x, t.y - 0.42, t.z);
    car.quaternion.set(q.x, q.y, q.z, q.w);
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

    traffic.update(dt, { x: wx, y: wy, z: t.y, heading, speed });
    traffic.cars.forEach((c, i) => placeOnPose(aiMeshes[i], c.pose, level.terrain.heightAt));
    traffic.peds.forEach((p, i) => placeOnPose(pedMeshes[i], p.pose, level.terrain.heightAt));
    signalMeshes.update((id) => signals.state(id, traffic.clock));
    hud.update({ speed, reverse: input.reverse });

    // camera
    const target = new THREE.Vector3(t.x, t.y, t.z);
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

  // test hook
  (window as unknown as Record<string, unknown>).__mapng = { level, vehicle, traffic, failed, scene, camera, renderer, survey: merged, bays, parked };
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

function makeHud(failed: string[], sv: ReturnType<typeof mergeSurvey>['summary']) {
  const n = (k: 'signs' | 'lights' | 'markings') => sv[k].survey;
  const surveyed = n('signs') + n('lights') + n('markings');
  const el = document.createElement('div');
  el.className = 'mg-hud';
  el.innerHTML = `
    <div class="mg-top">
      <div class="mg-task"><b>Debar Maalo · open world</b><span class="mg-msg"></span></div>
    </div>
    <div class="mg-speed"><b>0</b><span>km/h</span><em>D</em></div>
    <div class="mg-source" role="note">
      ${surveyed ? `Field survey: ${n('signs')} signs, ${n('lights')} lights, ${n('markings')} markings. ` : 'No field-survey data yet. '}
      Other signs, markings and lights: OpenStreetMap via MapNG, <b>not verified</b>.
      Light timing is <b>simulated</b>. Map data © OpenStreetMap contributors (ODbL).${failed.length ? ` ${failed.length} model tiles failed to load.` : ''}
    </div>
    <div class="mg-help">W/↑ gas · S/↓ brake/reverse · A D steer · Space handbrake · R reset · C camera</div>`;
  document.getElementById('app')!.appendChild(el);
  const sp = el.querySelector<HTMLElement>('.mg-speed b')!;
  const gear = el.querySelector<HTMLElement>('.mg-speed em')!;
  return {
    onRestart: () => {},
    update(s: { speed: number; reverse: boolean }) {
      sp.textContent = String(Math.round(Math.abs(s.speed) * 3.6));
      gear.textContent = s.reverse ? 'R' : 'D';
    },
  };
}
