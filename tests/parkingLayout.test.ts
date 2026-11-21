// Parking bays come from map geometry only (OSM lot outline + aisle), never imagery.
import { describe, expect, it } from 'vitest';
import { BAY_D, BAY_W, bayLines, layoutParking, occupied } from '../src/mapng/import/parkingLayout';
import type { ImportedRoad } from '../src/mapng/import/types';

const aisle: ImportedRoad = { id: 'service_parking_aisle_1', group: 'g', kind: 'service', material: 'a', oneWay: true, lanesLeft: 0, lanesRight: 1, points: [[0, 0, 1, 6], [50, 0, 1, 6]] };
const lot = { id: '1', name: 'lot', polygon: [[0, -8.5], [50, -8.5], [50, 8.5], [0, 8.5], [0, -8.5]] as [number, number][] };

describe('parking layout', () => {
  it('lays standard bays on both sides of the aisle, inside the lot only', () => {
    const bays = layoutParking({ parkingAreas: [lot], parkingSpots: [] }, [aisle], () => 1);
    const left = bays.filter((b) => b.y > 0), right = bays.filter((b) => b.y < 0);
    expect(left.length).toBe(Math.floor(50 / BAY_W) - 1);
    expect(right.length).toBe(left.length);
    for (const b of bays) expect(Math.abs(b.y)).toBeCloseTo(3 + BAY_D / 2, 6);
  });

  it('no bays where the lot outline does not reach, none on another road', () => {
    const road: ImportedRoad = { ...aisle, id: 'road_x', kind: 'carriageway', points: [[0, 8, 1, 6], [50, 8, 1, 6]] };
    const bays = layoutParking({ parkingAreas: [lot], parkingSpots: [] }, [aisle, road], () => 1);
    expect(bays.every((b) => b.y < 0)).toBe(true);
    expect(layoutParking({ parkingAreas: [], parkingSpots: [] }, [aisle], () => 1)).toHaveLength(0);
  });

  it('paints two side lines and a surface per bay; occupancy is fixed and keeps the start clear', () => {
    const bays = layoutParking({ parkingAreas: [lot], parkingSpots: [] }, [aisle], () => 1);
    expect(bayLines(bays)).toHaveLength(bays.length * 3);
    const a = occupied(bays, [[bays[0].x, bays[0].y, 1]]);
    expect(occupied(bays, [[bays[0].x, bays[0].y, 1]])).toEqual(a);
    expect(a.includes(bays[0])).toBe(false);
  });
});
