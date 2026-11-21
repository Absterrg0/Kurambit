# Stylised sea: Gerstner swell, depth colour, foam

**When.** Open water a player crosses or looks at: a boat game, a coast, a harbour.

## Numbers

- Gerstner wave: `k = 2π / wavelength`, amplitude `a = steepness / k`, phase speed
  `c = sqrt(9.8 / k)`: 10 m waves move 3.95 m/s, 40 m waves 7.9 m/s.
- **The steepness of all waves summed stays under 1**, or crests loop over (0.9 stays smooth,
  1.2 loops; checked numerically).
- The shortest wavelength is more than **twice the mesh's edge length**.
- Toon depth colour (Roystan): shallow `(0.325, 0.807, 0.971, 0.725)`, deep
  `(0.086, 0.407, 1, 0.749)`, depth range **1**, foam distance **0.4**, noise cutoff **0.777**.
- three's `Water` example: textureWidth 512, distortionScale **3.7**, waterColor `0x001e0f`,
  sun colour white. Its mirror draws the scene twice.
- Tropical water: turquoise near hulls and coasts, deep blue offshore (judgement).
- The gameplay height query equals the drawn surface within **5 cm** (judgement).

## Steps

1. Sum 3 to 4 Gerstner waves of different direction and wavelength in one function used by
   both the vertex shader and `height(x, z)` for gameplay.
2. Colour by depth under the surface (shallow to deep), add foam where depth is under the foam
   distance, broken by noise above the cutoff.
3. Add a wake behind moving hulls (`boat-buoyancy`).
4. Light it with the scene's sun and sky (`light-rig`, `sky-fog`).

## Pitfalls

- Steepness summing past 1: loops and spikes.
- A swell drawn in the shader but not in the height query: boats float above or sink into it.
- Foam bands that copy the coastline exactly unless wobbled with noise.
- Flat water with no wake: it read as a picture on bench 4.

## Code

three's `Water` and `Water2` (MIT), already in the runtime's three. Gerstner is a few shader
lines (Catlike Coding's code is MIT-0; its prose is not copied).

## Sources

GPU Gems ch. 1, "Effective water simulation" (read). Catlike Coding, "Waves" (read; code
MIT-0). Roystan, "Toon water" (read; code Unlicense). three.js r180 `webgl_shaders_ocean`.
