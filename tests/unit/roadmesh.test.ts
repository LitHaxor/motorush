// A raised ribbon with no riser is a slab floating in mid-air. Seen from the
// saddle - a couple of metres up, looking a long way down the road - a view ray
// crossing the edge just below the top slips underneath it, misses every
// surface in the scene and renders the sky dome. The median island did exactly
// that: a bright hairline of sky ran the length of every divider.

import { describe, it, expect } from 'vitest';
import { Band, ribbonGeometry, withKerbFaces } from '../../src/render/roadmesh';
import { Track } from '../../src/sim/track';

const lateralOf = (band: Band, s: number) =>
  typeof band.lateral === 'function' ? band.lateral(s) : band.lateral;
const liftOf = (band: Band, s: number) =>
  band.lift === undefined ? 0 : typeof band.lift === 'function' ? band.lift(s) : band.lift;

describe('withKerbFaces', () => {
  const top: Band[] = [
    { lateral: -9, u: 0 },
    { lateral: 0, u: 0.5 },
    { lateral: 9, u: 1 },
  ];

  it('adds one column at each edge and leaves the surface untouched', () => {
    const out = withKerbFaces(top, -0.08);
    expect(out).toHaveLength(top.length + 2);
    // The original bands survive in order, still flush with the surface.
    expect(out.slice(1, -1).map((b) => lateralOf(b, 0))).toEqual([-9, 0, 9]);
    expect(out.slice(1, -1).every((b) => liftOf(b, 0) === 0)).toBe(true);
  });

  it('puts the kerb at the same lateral as the edge it closes', () => {
    const out = withKerbFaces(top, -0.08);
    // No gap in plan: a riser that is offset sideways would just move the hole.
    expect(lateralOf(out[0], 0)).toBe(lateralOf(out[1], 0));
    expect(lateralOf(out[out.length - 1], 0)).toBe(lateralOf(out[out.length - 2], 0));
  });

  it('drops both kerb faces below the surface', () => {
    const out = withKerbFaces(top, -0.08);
    expect(liftOf(out[0], 0)).toBe(-0.08);
    expect(liftOf(out[out.length - 1], 0)).toBe(-0.08);
  });

  it('tracks a drop that varies along the road', () => {
    const out = withKerbFaces(top, (s) => (s > 100 ? -0.08 : 0));
    expect(liftOf(out[0], 50)).toBe(0);
    expect(liftOf(out[0], 150)).toBe(-0.08);
  });

  it('handles a two-band ribbon, like a pavement', () => {
    const out = withKerbFaces([{ lateral: 10, u: 0 }, { lateral: 15.5, u: 1 }], -0.19);
    expect(out.map((b) => lateralOf(b, 0))).toEqual([10, 10, 15.5, 15.5]);
    expect(out.map((b) => liftOf(b, 0))).toEqual([-0.19, 0, 0, -0.19]);
  });
});

describe('ribbonGeometry', () => {
  const track = new Track({
    seed: 7,
    length: 600,
    divided: [{ from: 100, to: 500, fork: false, halfWidth: 9 }],
  });
  const s = 300; // solidly inside the divided stretch
  const bands: Band[] = [
    { lateral: (x: number) => -track.medianAt(x), u: 0 },
    { lateral: (x: number) => track.medianAt(x), u: 1 },
  ];

  it('is divided where the test expects it to be', () => {
    expect(track.medianAt(s)).toBeGreaterThan(1);
  });

  it('applies a per-band lift on top of the ribbon elevation', () => {
    const plain = ribbonGeometry(track, bands, 6, () => 0.06, 1.5);
    const kerbed = ribbonGeometry(track, withKerbFaces(bands, -0.08), 6, () => 0.06, 1.5);
    // Two extra columns, same number of rows.
    const rows = plain.getAttribute('position').count / 2;
    expect(kerbed.getAttribute('position').count).toBe(rows * 4);
  });

  it('closes the gap under a raised island', () => {
    const cols = 4;
    const geo = ribbonGeometry(track, withKerbFaces(bands, -0.08), 6, () => 0.06, 1.5);
    const pos = geo.getAttribute('position');
    const rows = pos.count / cols;
    // The tarmac the island meets: same ribbon, no lift, no elevation.
    const flat = ribbonGeometry(track, bands, 6, undefined, 1.5);
    const flatPos = flat.getAttribute('position');

    let checked = 0;
    for (let r = 0; r < rows; r++) {
      const kerbY = pos.getY(r * cols); // outermost column, the kerb face
      const topY = pos.getY(r * cols + 1); // island surface at the same lateral
      const roadY = flatPos.getY(r * 2); // asphalt at the same lateral
      if (topY - roadY < 0.001) continue; // undivided here, nothing to close
      expect(topY).toBeGreaterThan(kerbY); // the riser has height
      expect(kerbY).toBeLessThanOrEqual(roadY); // and it reaches the tarmac
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('keeps the kerb directly under the edge it closes', () => {
    const cols = 4;
    const geo = ribbonGeometry(track, withKerbFaces(bands, -0.08), 6, () => 0.06, 1.5);
    const pos = geo.getAttribute('position');
    for (let r = 0; r < pos.count / cols; r += 17) {
      expect(pos.getX(r * cols)).toBeCloseTo(pos.getX(r * cols + 1), 6);
      expect(pos.getZ(r * cols)).toBeCloseTo(pos.getZ(r * cols + 1), 6);
    }
  });
});
