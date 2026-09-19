# Credits

MotoRush uses only CC0 / public-domain assets. Nothing here requires
attribution, but the sources deserve it anyway.

## Textures

| Asset                      | Source                                          | Licence |
| -------------------------- | ----------------------------------------------- | ------- |
| Asphalt (road surface)     | [Poly Haven — Asphalt Track](https://polyhaven.com/a/asphalt_track) | CC0 |
| Gravel (shoulders)         | [Poly Haven — Bicolour Gravel](https://polyhaven.com/a/bicolour_gravel) | CC0 |
| Grass (terrain)            | [ambientCG — Grass005](https://ambientcg.com/view?id=Grass005) | CC0 |
| Conifer branches (trees)   | [ambientCG — LeafSet019](https://ambientcg.com/view?id=LeafSet019) | CC0 |
| Broadleaf leaves (trees)   | [ambientCG — LeafSet005](https://ambientcg.com/view?id=LeafSet005) | CC0 |

### Trees

Whole-tree cut-outs are not something the CC0 libraries carry, so the trees are
composited at runtime: real photographed conifer sprays and broadleaf sprigs
are drawn tier by tier into a tree-shaped billboard (`src/render/foliage.ts`),
then rendered on crossed alpha-cut planes. Twelve canopy variants, tinted
per-instance, cost two draw calls each for the whole track.

Each set ships as colour + normal + a packed AO/roughness/metalness map,
downscaled and re-encoded for the web (~3.8 MB total).

## Models

| Asset                 | Source                                                    | Licence |
| --------------------- | --------------------------------------------------------- | ------- |
| Trees, rocks          | [Kenney — Nature Kit](https://kenney.nl/assets/nature-kit) | CC0 |
| Traffic vehicles      | [Kenney — Car Kit](https://kenney.nl/assets/car-kit)       | CC0 |

## Made in-engine

Everything else is generated at runtime with no asset files at all:

- **Motorcycles and riders** — built from primitives in `src/render/bikemesh.ts`
  so the rider can lean, punch and swing a club.
- **Sky, sun and clouds** — a GLSL gradient dome (`src/render/sky.ts`).
- **Lane markings, billboards, checkered flags** — drawn to canvas
  (`src/render/textures.ts`).
- **All audio** — synthesised with the Web Audio API (`src/audio/audio.ts`).
  There is not a single sound file in the repo.
