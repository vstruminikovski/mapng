// The items placed in the builder, drawn the same way in the builder and in the game.
// Both the builder and the game call buildUserItems(), so what you place is what you drive past.
// Coordinates are the game's world metres (x east, y north, height up), the same in both.

import * as THREE from 'three';
import { buildProps, buildSignals } from './props';
import { buildRoads } from './roads';
import { yawFromRotation } from '../import/cityGis';
import type { ImportedRoad, LevelObjects, PropInstance } from '../import/types';
import type { Lamp } from '../traffic/signals';

export const POLE_W = 0.24; // the pole: 3x the sign post thickness
export const POLE_L = 0.8;  // the pole: a third of the sign post length

/** One item placed in the builder. Exported as-is, so the game gets exactly what the builder had. */
export type UserItem =
  | { id: number; cat: 'sign'; type: string; floating?: boolean; x: number; y: number; z: number; facing: number; verified: boolean; note: string }
  | { id: number; cat: 'light'; mode?: string; x: number; y: number; z: number; facing: number; green: number; yellow: number; red: number; offset: number; verified: boolean; note: string }
  | { id: number; cat: 'mark'; key: string; pts: [number, number][]; strokes?: [number, number][][]; width: number; kind: 'marking' | 'zebra'; material: string; verified: boolean; note: string }
  | { id: number; cat: 'prop'; kind: 'tree' | 'lamp'; type: string; x: number; y: number; z: number; facing: number; verified: boolean; note: string }
  | { id: number; cat: 'pole'; orient: 'vert' | 'horiz'; yaw: number; x: number; y: number; z: number; facing: number; verified: boolean; note: string };

export function strokesOf(r: { pts: [number, number][]; strokes?: [number, number][][] }): [number, number][][] { return r.strokes ?? [r.pts]; }
export function markPoints(r: { pts: [number, number][]; strokes?: [number, number][][] }): [number, number][] { return strokesOf(r).flat(); }

/** Box and turn of a pole. Horizontal: the long side runs along the pole's yaw. Three.js y is up. */
export function poleBox(orient: 'vert' | 'horiz') {
  return orient === 'vert' ? new THREE.BoxGeometry(POLE_W, POLE_L, POLE_W) : new THREE.BoxGeometry(POLE_L, POLE_W, POLE_W);
}
export function poleRotY(r: { orient: 'vert' | 'horiz'; yaw: number }) {
  return r.orient === 'vert' ? 0 : Math.PI / 2 - (r.yaw * Math.PI) / 180;
}

/** Lamp of a placed light at time t (seconds): its own green, yellow and red times, with an offset. */
export function lampOf(r: { green: number; yellow: number; red: number; offset: number }, t: number): Lamp {
  const g = r.green ?? 10, y = r.yellow ?? 3, rd = r.red ?? 12;
  const cycle = g + y + rd;
  if (cycle <= 0) return 'off';
  const tc = (((t - (r.offset ?? 0)) % cycle) + cycle) % cycle;
  return tc < g ? 'green' : tc < g + y ? 'yellow' : 'red';
}

export interface UserBuild {
  signs: THREE.Group;
  lights: THREE.Group;
  lights2: THREE.Group;
  props: THREE.Group;
  poles: THREE.Group;
  marks: THREE.Group;
  /** call with the clock (seconds) every frame to run the placed lights' timers */
  lightUpdaters: { update: (state: (id: number) => Lamp) => void; recs: UserItem[] }[];
}

function emptyObjects(): LevelObjects {
  return { spawn: { p: [0, 0, 0], heading: 0 }, parkingSpots: [], parkingAreas: [], signals: { instances: [], controllers: [], sequences: [] }, signs: [], lamps: [], trees: [], fences: [], pois: [] };
}

/** Draws every placed item: the game's own sign, light, prop and road renderers, plus the poles. */
export function buildUserItems(items: UserItem[], heightAt: (x: number, y: number) => number, poleAt: (pos: number[], dir: number[]) => number[]): UserBuild {
  // signs: the game's own prop builder, one sign per item
  const signs: PropInstance[] = items.flatMap((r) => (r.cat === 'sign' ? [{ type: r.type, pos: [r.x, r.y, r.z] as [number, number, number], yaw: Math.PI - (r.facing * Math.PI) / 180, scale: 1, floating: !!r.floating }] : []));
  const signGroup = buildProps({ ...emptyObjects(), signs });

  // traffic lights: glued ones carry their own z (the head sits on the pole block); the others stand on the ground
  const lightOf = (r: Extract<UserItem, { cat: 'light' }>) => {
    const dir = [Math.cos(yawFromRotation(r.facing, 'geographic')), Math.sin(yawFromRotation(r.facing, 'geographic')), 0];
    const z = r.mode === 'glue' || r.mode === undefined ? r.z : heightAt(r.x, r.y);
    return { rec: r as UserItem, pos: [r.x, r.y, z], dir };
  };
  const all = items.filter((r): r is Extract<UserItem, { cat: 'light' }> => r.cat === 'light');
  const withPole = all.filter((r) => r.mode === 'pole').map(lightOf);
  const others = all.filter((r) => r.mode !== 'pole').map(lightOf);
  const lightsA = buildSignals(emptyObjects(), others.map((o) => ({ pos: o.pos, dir: o.dir })), poleAt, { pole: false });
  const lightsB = buildSignals(emptyObjects(), withPole.map((o) => ({ pos: o.pos, dir: o.dir })), poleAt, { pole: true });

  // trees and lamps: the game's prop builder
  const toProp = (r: Extract<UserItem, { cat: 'prop' }>): PropInstance => ({ type: r.type, pos: [r.x, r.y, r.z], yaw: 0, scale: 1 });
  const propRecs = items.filter((r): r is Extract<UserItem, { cat: 'prop' }> => r.cat === 'prop');
  const props = buildProps({ ...emptyObjects(), trees: propRecs.filter((r) => r.kind === 'tree').map(toProp), lamps: propRecs.filter((r) => r.kind === 'lamp').map(toProp) });

  // poles: one box per item, centred on the item; the group keeps each id for picking
  const poles = new THREE.Group();
  const poleMat = new THREE.MeshLambertMaterial({ color: 0x8a8f96 });
  for (const r of items) {
    if (r.cat !== 'pole') continue;
    const o = r.orient ?? 'vert'; // items saved before the orientation existed stand up
    const m = new THREE.Mesh(poleBox(o), poleMat);
    m.position.set(r.x, r.z, -r.y);
    m.rotation.y = poleRotY({ orient: o, yaw: r.yaw ?? 0 });
    m.userData.id = r.id;
    poles.add(m);
  }

  // markings: the game's road renderer, same materials as the map; lifted clear of the ground
  const roads: ImportedRoad[] = items.flatMap((r) => (r.cat === 'mark' ? strokesOf(r).map((st, k) => ({
    id: `user_${r.id}_${k}`, group: 'builder', kind: r.kind, material: r.material, oneWay: false, lanesLeft: 0, lanesRight: 0,
    points: st.map(([x, y]) => [x, y, heightAt(x, y) + 0.08, r.width] as [number, number, number, number]),
  })) : []));
  const marks = buildRoads(roads);

  return {
    signs: signGroup,
    lights: lightsA.group,
    lights2: lightsB.group,
    props,
    poles,
    marks,
    lightUpdaters: [
      { update: lightsA.update, recs: others.map((o) => o.rec) },
      { update: lightsB.update, recs: withPole.map((o) => o.rec) },
    ],
  };
}
