# Audioreactive Spider

A parametric, many-legged creature that walks with inverse kinematics in a 3D
scene and dances to live audio from your microphone. Browser-based (three.js),
**no build step** — just static files and an import map.

## Run it

The microphone requires a secure context, which `localhost` counts as. Serve the
folder with anything static:

```bash
cd audioreactive-spider
python3 -m http.server 8000
# then open http://localhost:8000  and click "Enable mic & start"
```

(Any static server works — `npx serve`, VS Code Live Server, etc. Opening
`index.html` as a `file://` URL will *not* work: ES-module imports and the mic
both need `http`/`https`.)

## How it's split

The whole design rests on **decoupling "body dances to music" from "feet follow
the ground."** That's why each subsystem is its own file:

```
index.html              import map + start overlay
src/
  main.js               composition + the animation loop (the only file that
                        knows about everything at once)
  Swarm.js              the group: one controllable hero + randomized extras,
                        and the wander/circle arrangements

  input/                --- signal in ---
    ControlBus.js       normalized signals every input writes / the creature reads
    AudioDriver.js      mic -> FFT -> bands + energy-based beat detection

  creature/             --- the creature ---
    CreatureSpec.js     pure-data, parametric description (typed limbs)
    CreatureBuilder.js  spec -> THREE meshes (the only geometry/material file)
    IKSolver.js         inverse kinematics: analytic 2-bone (knee-up, in-plane)
                        for 2-segment legs, FABRIK fallback for other counts
    GaitPlanner.js      where feet plant / when they step (any leg count)
    BodyController.js   body position, heading, and the dance (bob + beat pop)
    Creature.js         wires the four above together; runs them per frame

  render/
    Scene.js            renderer, camera, orbit controls, lights, ground

  ui/
    Panel.js            lil-gui live controls + signal read-outs
```

Per-frame order (in `Creature.update`): **Body** → **Gait** → **IK** → **render**.

## The seams we built in on purpose

- **MIDI later.** All input flows through `ControlBus`. A future `MidiDriver`
  implements the same shape as `AudioDriver` (a `start()` and an `update(dt)`
  that writes the same bus) and nothing downstream changes.
- **Variable leg count, live.** `GaitPlanner` has no hardcoded gait pattern:
  a leg steps when its foot drifts past `stepThreshold`, capped globally by
  `maxStepping`. That emerges into a believable gait for *any* count, so the
  leg-count slider just rebuilds the creature from a new spec.
- **Custom shaders (stretch).** All meshes/materials live in `CreatureBuilder`.
  Swap the `MeshStandardMaterial`s for a `ShaderMaterial` there and nothing else
  needs to know.
- **Biblically-accurate-angel creature (stretch).** Limbs in `CreatureSpec` are
  **typed** (`type: 'leg'` today; `type: 'wing'` later gets procedural flapping,
  no ground contact), and `features` is reserved for body-attached parts like
  eyes. The data model won't have to change to grow into it.

## Tuning

Open the panel (top-right). Beat detection from a room mic is noisy by nature —
expect to adjust **beat sensitivity** and **band smoothing** per room/song. Good
first move: play music, raise **band bob** and **bob attack** to taste, then nudge
**beat sensitivity** until the pops land on the beat.

## Stretch goals / ideas

- **Procedural abdomen markings** — stripes / hourglass / fresnel pattern in the
  accent color (the last of the "group 3" surface-detail work; noise bumps, leg
  hairs and joint spikes are done).
- **Biblically-accurate-angel creature** — reuses the typed-limb + eyes system:
  feathery wing-like legs that still step with IK, plus many eyes.
- **MIDI input.** A `MidiDriver` mirroring `AudioDriver` into the same
  `ControlBus` (the seam is already there).
