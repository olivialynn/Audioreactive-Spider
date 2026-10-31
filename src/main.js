/**
 * main.js — composition + the animation loop. This is the only file that knows
 * about all the pieces at once; everything else stays in its own lane:
 *
 *   input/    ControlBus, AudioDriver        (signal in)
 *   creature/ Spec, Builder, IK, Gait, Body  (the creature)
 *   render/   Scene                          (the stage)
 *   ui/       Panel                          (live controls)
 */
import * as THREE from 'three';
import { createScene } from './render/Scene.js';
import { FollowCamera } from './render/FollowCamera.js';
import { ControlBus } from './input/ControlBus.js';
import { AudioDriver } from './input/AudioDriver.js';
import { makeSpider } from './creature/CreatureSpec.js';
import { Swarm } from './Swarm.js';
import { createPanel } from './ui/Panel.js';

const container = document.getElementById('app');
const { scene, camera, renderer, controls, composer, bloomPass, outlinePass, keyLight, fillLight } = createScene(container);

// --- Input + creatures ---
const bus = new ControlBus();
const audio = new AudioDriver(bus);
const swarm = new Swarm(scene, makeSpider({ legCount: 8 })); // hero + (later) extras

// --- Camera rig ---
const follow = new FollowCamera(camera);

// --- Key-light rig: the spotlight can ride along above the spider so the lit
// pool follows it. `offset` is its position relative to the tracked point;
// offset.y is the "height" exposed in the Lighting panel. ---
// `intensity` is the spotlight's *base* brightness; the strobe modulates it each
// frame (so the slider stays the "full on" level). The strobe flashes on each
// detected beat, and also dims the whole scene (via exposure, so the ambient/rim/
// fill lights blink too), bottoming out at STROBE_FLOOR of the base exposure so
// the spiders nearly vanish between flashes. `exposure` is the base it modulates.
const lightRig = {
  follow: true,
  offset: new THREE.Vector3(5, 7.5, 4),
  intensity: keyLight.intensity,
  exposure: renderer.toneMappingExposure,
  strobe: false,
  // Sweep: roam the beam's aim around like a moving-head stage light. `range` is
  // how far (world units) the aim wanders from the focus; `speed` sets the pace.
  sweep: false,
  sweepRange: 8,
  sweepSpeed: 2,
};
const STROBE_FLOOR = 0.1;
// The fill point light always rides near the spider (offset in world space).
const fillRig = { offset: new THREE.Vector3(-2.5, 5, -3) };

// --- UI ---
const panel = createPanel({
  swarm,
  audio,
  follow,
  renderer,
  bloomPass,
  outlinePass,
  keyLight,
  lightRig,
  fillLight,
});

// --- Loop ---
const _focus = new THREE.Vector3();
const clock = new THREE.Clock();
let _strobeFlash = 0; // beat-synced strobe envelope (1 on a beat, decays)
let _sweepT = Math.random() * 100; // beam-roam time (random start so it varies)
function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 1 / 30); // clamp to avoid huge steps

  audio.update(dt);        // mic -> ControlBus (no-op until started)
  swarm.update(dt, bus);   // ControlBus -> motion (all creatures)
  panel.syncMeters(bus);

  // Focus point: the group's center (= the hero when there's only one).
  swarm.center(_focus);

  // Key spotlight rides above the focus (or stays over the origin).
  const bx = lightRig.follow ? _focus.x : 0;
  const bz = lightRig.follow ? _focus.z : 0;
  keyLight.position.set(bx + lightRig.offset.x, lightRig.offset.y, bz + lightRig.offset.z);

  // Sweep the beam's aim with smooth, non-repeating wander (two incommensurate
  // sines per axis so it roams organically instead of tracing a tidy circle).
  let tx = bx, tz = bz;
  if (lightRig.sweep) {
    _sweepT += dt * lightRig.sweepSpeed;
    const r = lightRig.sweepRange;
    tx += (Math.sin(_sweepT * 0.7) + 0.5 * Math.sin(_sweepT * 1.3 + 1.1)) / 1.5 * r;
    tz += (Math.cos(_sweepT * 0.9 + 2.3) + 0.5 * Math.sin(_sweepT * 1.7)) / 1.5 * r;
  }
  keyLight.target.position.set(tx, 0.5, tz);
  keyLight.target.updateMatrixWorld();

  // Strobe: flash on each detected beat (bright pop that decays), modulating the
  // key light and dimming the whole scene with it (via exposure) so ambient/rim/
  // fill blink too.
  let strobeK = 1;
  if (lightRig.strobe) {
    if (bus.beat) _strobeFlash = 1;
    _strobeFlash = Math.max(0, _strobeFlash - dt * 10); // quick decay per flash
    strobeK = _strobeFlash;
    renderer.toneMappingExposure = lightRig.exposure * (STROBE_FLOOR + (1 - STROBE_FLOOR) * strobeK);
  } else {
    renderer.toneMappingExposure = lightRig.exposure;
  }
  keyLight.intensity = lightRig.intensity * strobeK;

  // Fill light tracks the focus.
  fillLight.position.set(_focus.x + fillRig.offset.x, fillRig.offset.y, _focus.z + fillRig.offset.z);

  // Camera: smoothed focus; in follow mode the rig drives the camera, otherwise
  // OrbitControls does (manual inspect) with its target following the focus.
  follow.updateFocus(dt, _focus);
  controls.target.copy(follow.target);
  if (follow.enabled) {
    controls.enabled = false;
    follow.applyOrbit(dt);
  } else {
    controls.enabled = true;
    controls.update();
  }

  composer.render();
}
tick();

// --- Start overlay: the mic needs a user gesture + a secure context. ---
const overlay = document.getElementById('start');
const startBtn = document.getElementById('start-btn');
const errEl = document.getElementById('start-err');

// Keep running when the window loses focus: browsers suspend the AudioContext
// when the tab is hidden, so resume it on return (no restart needed).
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && audio.ctx && audio.ctx.state === 'suspended') audio.ctx.resume();
});

// If the GPU drops the WebGL context (common when a tab is backgrounded), let it
// restore instead of throwing — the loop picks back up on its own.
renderer.domElement.addEventListener('webglcontextlost', (e) => e.preventDefault());

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  errEl.textContent = '';
  try {
    await audio.start();
    overlay.style.display = 'none';
  } catch (err) {
    startBtn.disabled = false;
    errEl.textContent =
      'Could not access the microphone: ' + (err?.message || err) +
      '  (needs localhost/https + permission)';
  }
});
