// Street and place names from OpenStreetMap (names.json, ODbL).
// Road names: whole labels flat on the ground, on a straight piece long enough to hold
// them, one per name per 120 m, always reading left to right.
// Place names: small sprites above the roof of the building they name, with clearance.

import * as THREE from 'three';
import type { Terrain } from '../import/loadLevel';

export interface NamesFile {
  source: string;
  roads: { name: string; pts: number[][] }[];
  places: { name: string; x: number; y: number }[];
}

const ROAD_FONT = 28; // canvas px (half of the previous 56)
const PLACE_FONT = 20; // canvas px (half of the previous 40)
const PLACE_H = 1.3; // sprite height, m (half of the previous 2.6)
const ROOF_CLEARANCE = 1.5; // m between the roof and the bottom of a place label

function textCanvas(text: string, px: number, color: string, bg: string | null) {
  const c = document.createElement('canvas');
  const x = c.getContext('2d')!;
  x.font = `600 ${px}px -apple-system, system-ui, sans-serif`;
  const w = Math.ceil(x.measureText(text).width) + px;
  c.width = w;
  c.height = Math.ceil(px * 1.6);
  const ctx = c.getContext('2d')!;
  if (bg) {
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.roundRect(0, 0, c.width, c.height, c.height / 2);
    ctx.fill();
  }
  ctx.font = `600 ${px}px -apple-system, system-ui, sans-serif`;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, c.width / 2, c.height / 2 + 1);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return { tex: t, aspect: c.width / c.height };
}

/**
 * `roofAt(x, y)` returns the top of the building at that spot (metres) or null when
 * there is no building; place labels sit above that top, or above the ground.
 */
export function buildNames(names: NamesFile, terrain: Terrain, roofAt: (x: number, y: number) => number | null): THREE.Group {
  const g = new THREE.Group();
  g.name = 'names';

  const placed: { name: string; x: number; y: number }[] = [];
  for (const r of names.roads) {
    const { tex, aspect } = textCanvas(r.name, ROAD_FONT, '#2a2a2c', 'rgba(255,255,255,0.75)');
    const h = 1.2;
    const worldLen = h * aspect; // label length in metres
    // straight pieces of this road, longest first, that can hold the whole label
    const pieces: { len: number; a: number[]; b: number[] }[] = [];
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i], b = r.pts[i + 1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len >= worldLen * 1.3) pieces.push({ len, a, b });
    }
    if (!pieces.length) continue; // no room for the whole name: show nothing rather than a cut label
    pieces.sort((p, q) => q.len - p.len);
    const p = pieces[0];
    const mx = (p.a[0] + p.b[0]) / 2, my = (p.a[1] + p.b[1]) / 2;
    if (placed.some((q) => q.name === r.name && Math.hypot(q.x - mx, q.y - my) < 120)) continue;
    placed.push({ name: r.name, x: mx, y: my });
    let theta = Math.atan2(p.b[1] - p.a[1], p.b[0] - p.a[0]);
    // keep the text upright and readable from the car: never upside down
    if (Math.cos(theta) < 0) theta += Math.PI;
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(h * aspect, h),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -8 }),
    );
    plane.rotation.x = -Math.PI / 2;
    plane.rotation.z = theta;
    plane.position.set(mx, terrain.heightAt(mx, my) + 0.12, -my);
    plane.renderOrder = 5;
    g.add(plane);
  }

  // place names: sprite above the roof of the building (or above the ground if none)
  for (const p of names.places) {
    const { tex, aspect } = textCanvas(p.name, PLACE_FONT, '#ffffff', 'rgba(20,20,22,0.62)');
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    s.scale.set(PLACE_H * aspect, PLACE_H, 1);
    const roof = roofAt(p.x, p.y);
    const base = roof ?? terrain.heightAt(p.x, p.y) + 3; // no building: 3 m above ground
    s.position.set(p.x, base + ROOF_CLEARANCE + PLACE_H / 2, -p.y);
    g.add(s);
  }
  return g;
}
