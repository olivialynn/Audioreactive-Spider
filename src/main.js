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
import { Creature } from './creature/Creature.js';
import { createPanel } from './ui/Panel.js';

const container = document.getElementById('app');
const { scene, camera, renderer, controls, composer, bloomPass, outlinePass, keyLight, fillLight } = createScene(container);

// --- Input + creature ---
const bus = new ControlBus();
const audio = new AudioDriver(bus);
const creature = new Creature(scene, makeSpider({ legCount: 8 }));

// --- Camera rig ---
const follow = new FollowCamera(camera);

// --- Key-light rig: the spotlight can ride along above the spider so the lit
// pool follows it. `offset` is its position relative to the tracked point;
// offset.y is the "height" exposed in the Lighting panel. ---
const lightRig = { follow: true, offset: new THREE.Vector3(5, 7.5, 4) };
// The fill point light always rides near the spider (offset in world space).
const fillRig = { offset: new THREE.Vector3(-2.5, 5, -3) };

// --- UI ---
const panel = createPanel({
  creature,
  audio,
  follow,
  renderer,
  bloomPass,
  outlinePass,
  keyLight,
  lightRig,
  fillLight,
  onRebuild: (spec) => creature.rebuild(spec),
});

// --- Loop ---
const clock = new THREE.Clock();
function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 1 / 30); // clamp to avoid huge steps

  audio.update(dt);       // mic -> ControlBus (no-op until started)
  creature.update(dt, bus); // ControlBus -> motion
  panel.syncMeters(bus);

  // Key spotlight rides above the spider (or stays over the origin).
  const c = creature.body.position;
  const bx = lightRig.follow ? c.x : 0;
  const bz = lightRig.follow ? c.z : 0;
  keyLight.position.set(bx + lightRig.offset.x, lightRig.offset.y, bz + lightRig.offset.z);
  keyLight.target.position.set(bx, 0.5, bz);
  keyLight.target.updateMatrixWorld();

  // Fill light always tracks the spider.
  fillLight.position.set(c.x + fillRig.offset.x, fillRig.offset.y, c.z + fillRig.offset.z);

  // Camera: the smoothed focus tracks the spider in both modes. In follow mode
  // the rig drives the camera; otherwise OrbitControls does (manual inspect),
  // but its target still follows the spider.
  follow.updateFocus(dt, creature.body.position);
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

// Press T to tap tempo (handy for live use when auto-detection drifts).
window.addEventListener('keydown', (e) => {
  if (e.key === 't' || e.key === 'T') audio.tap();
});

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
