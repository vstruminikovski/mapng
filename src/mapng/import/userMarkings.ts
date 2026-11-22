// Lines drawn in the builder (public/survey/markings.geojson): solid, dashed, double lines and
// arrows. Each feature becomes road-marking strokes that the game draws with its own materials.
import type { ImportedRoad } from './types';
import { latLngToWorld, type GeoFrame } from './cityGis';

interface MarkingFeature {
  geometry: { type: 'LineString' | 'MultiLineString'; coordinates: number[][] | number[][][] };
  properties: { pattern?: string; width?: number };
  id?: string;
}

const MATERIAL: Record<string, string> = {
  solid: 'm_line_white',
  double: 'm_line_white',
  dashed: 'm_line_white_discontinue',
};

export function userMarkingRoads(
  fc: { features?: MarkingFeature[] } | null,
  frame: GeoFrame,
  heightAt: (x: number, y: number) => number,
): ImportedRoad[] {
  const out: ImportedRoad[] = [];
  for (const f of fc?.features ?? []) {
    const lines = f.geometry.type === 'LineString' ? [f.geometry.coordinates as number[][]] : (f.geometry.coordinates as number[][][]);
    const pattern = f.properties.pattern ?? 'solid';
    const width = f.properties.width ?? 0.12;
    lines.forEach((line, k) => {
      const pts = line.map(([lon, lat]) => {
        const w = latLngToWorld(frame, lat, lon);
        return [w.x, w.y, heightAt(w.x, w.y) + 0.06, width] as [number, number, number, number];
      });
      if (pts.length < 2) return;
      out.push({
        id: `user_${f.id ?? out.length}_${k}`,
        group: 'user_markings',
        kind: 'marking',
        material: MATERIAL[pattern] ?? 'm_line_white',
        oneWay: false,
        lanesLeft: 0,
        lanesRight: 0,
        points: pts,
      });
    });
  }
  return out;
}
