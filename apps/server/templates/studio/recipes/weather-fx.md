# Weather: rain, snow, wet ground, lightning, mist

**When.** The brief names weather, a storm, a rainy or snowy place. Set the hour with
`time-of-day` first; weather goes on top.

## Numbers

- Rain falls 7 m/s (9 heavy; a 2 mm drop is 6.5 m/s). Draw a streak of speed × 1/30 s, about
  0.3 m, never a dot. Wind slants it: 2 to 5 m/s, 10 or more for a storm.
- Rain budget: 2,000 (light) to 8,000 (storm) streaks in a 30 × 16 × 30 m box that follows the
  camera, one `LineSegments`, moved in its vertex shader: 1 draw call, no buffer upload. Hide
  drops within 1.5 m of the camera. Colour `0x9fb0c8` × 0.35, additive, `depthWrite` false.
- Splashes: rings 0.1 to 0.2 m, 50 to 100 ms each, 100 to 300 alive, one `InstancedMesh`.
- Snow falls 0.5 to 1.5 m/s with a sideways sway of 0.3 to 0.5 m at 0.5 Hz (judgement); 2,000 to
  6,000 `Points`, size 0.05 to 0.1 m, normal blending, white. Snow cover: colour `0xe8eef5`
  (albedo 0.8 to 0.9), roughness 0.6, on faces with normal.y above 0.7.
- Wet porous ground (soil, stone, wood): colour × 0.55 to 0.8, roughness 0.9 down to 0.2.
  Metal, glass and paint only lose roughness. Puddles: roughness 0.02 to 0.05, flat, 2 mm above
  the ground, never coplanar. Tested: wet = 0.85 gives colour × 0.62 and roughness 0.3.
- Lightning: 3 or 4 strokes 40 to 60 ms apart, 0.2 to 0.5 s in all; each stroke snaps to peak
  and decays over 2 frames, linear. The flash is a cool `0xdde6ff` light from the strike side at
  2.5 times the key, or hemisphere × 5 and exposure × 1.3; the sky flashes too. 1 to 3 per
  minute; thunder 3 s late per km.
- Mist: FogExp2 density 1.98 / V; mist V 500 to 1,000 m, fog 100 to 500, dense 20 to 60. Low
  mist: 6 to 12 large soft camera-facing cards, opacity 0.15 to 0.3, kept clear of geometry.
- Whole weather: at most 3 draw calls and 10,000 particles (judgement).

## Steps

1. Fog first: a storm reads more from fog and wind than from more drops.
2. Rain or snow in one GPU-moved draw (Code), wrapped in a box around the camera.
3. Wet or snowy materials once at start; tune by a value, not new materials.
4. Put light behind the rain: lamps, windows or a bright sky. Wet ground then mirrors them.
5. Lightning on `ctx.after` timers, so a replay flashes the same.
6. Sound: a rain or wind loop under the mix, thunder on each flash (`sound-set-mix`).

## Pitfalls

- Front-lit rain vanishes; against a bright sky it reads dark, so darken it there.
- Updating 10,000 positions on the CPU each frame: move them in the shader.
- Wet without anything to reflect: no lights in view, no streaks on the ground.
- Constant lightning reads as a strobe; eased flashes read as a lamp.
- Weather hiding the player: keep the player's ΔE.

## Code

```js
const DROPS = 4000,
  BOX = new THREE.Vector3(30, 16, 30);
const seed = new Float32Array(DROPS * 6),
  end = new Float32Array(DROPS * 2);
for (let i = 0; i < DROPS; i++) {
  const p = [ctx.random(), ctx.random(), ctx.random()];
  seed.set([...p, ...p], i * 6);
  end[i * 2 + 1] = 1;
}
const geo = new THREE.BufferGeometry();
geo.setAttribute("position", new THREE.BufferAttribute(seed, 3));
geo.setAttribute("end", new THREE.BufferAttribute(end, 1));
const rainMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  uniforms: {
    time: { value: 0 },
    centre: { value: new THREE.Vector3() },
    box: { value: BOX },
    vel: { value: new THREE.Vector3(1.5, -9, 0) },
    streak: { value: 0.3 },
    color: { value: new THREE.Color(0x9fb0c8).multiplyScalar(0.35) },
  },
  vertexShader: `uniform float time, streak; uniform vec3 centre, box, vel;
    attribute float end; varying float vEnd;
    void main() {
      vec3 p = position * box + vel * time;
      p = mod(p - centre + box * 0.5, box) + centre - box * 0.5;
      vEnd = end;
      // too near the camera: drawn huge, so not drawn
      if (distance(p, centre) < 1.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
      p -= normalize(vel) * streak * end;
      gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
    }`,
  fragmentShader: `uniform vec3 color; varying float vEnd;
    void main() { gl_FragColor = vec4(color * (1.0 - vEnd), 1.0); }`,
});
const rain = new THREE.LineSegments(geo, rainMat);
rain.frustumCulled = false;
ctx.scene.add(rain);
// each update: rainMat.uniforms.time.value += dt; rainMat.uniforms.centre.value.copy(ctx.camera.position);
```

## Sources

EL4CTEO's blender-skills (MIT): `blender-weather-fx` (speeds, streaks, splashes, Lagarde's wet
surfaces, lightning, real-time budgets; Gunn and Kinzer's drop speeds as cited there),
translated to three.js. Rain code checked in a headless r180 block-out.
