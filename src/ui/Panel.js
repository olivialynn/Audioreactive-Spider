/**
 * Panel — the lil-gui control panel, organized into a few top-level sections:
 *
 *   Creature Body     — Shape (rebuilds) + Color
 *   Creature Movement — Wander + Gait + Dance
 *   Audio             — Beat + live Signal read-outs
 *   Camera            — follow/orbit rig
 *   Look              — bloom / exposure / beat glow
 *
 * Pure wiring: each control is a direct tap into a live subsystem object. Because
 * Creature reuses its `body`/`gait` objects across rebuilds, those bindings stay
 * valid; only `maxStepping` and the color pickers need a nudge after a rebuild.
 */
import GUI from 'lil-gui';
import { makeSpider, MARK_TYPES } from '../creature/CreatureSpec.js';

export function createPanel({ creature, audio, follow, renderer, bloomPass, outlinePass, keyLight, lightRig, fillLight, onRebuild }) {
  const gui = new GUI({ title: 'Controls' });
  injectHeadingStyle(); // make top-level section titles stand out

  let maxSteppingCtrl = null; // assigned in the Gait subfolder below

  // Adds a "reset section" button that restores this folder's controls (and its
  // subfolders') to their defaults. `after` runs side effects that lil-gui's
  // reset doesn't trigger on its own (e.g. rebuilding geometry).
  const addReset = (folder, after) => {
    folder.add({ reset() { folder.reset(); if (after) after(); } }, 'reset').name('↺ reset section');
  };

  // Collapse/expand all sections. Added first so it sits at the top, under the title.
  let collapsed = false;
  const collapseBtn = gui.add({
    toggle() {
      collapsed = !collapsed;
      gui.folders.forEach((f) => (collapsed ? f.close() : f.open()));
      collapseBtn.name(collapsed ? 'expand all ▸' : 'collapse all ▾');
    },
  }, 'toggle').name('collapse all ▾');

  // ===================== CREATURE =====================
  const gBody = gui.addFolder('Creature');

  // --- Shape: anything that changes geometry rebuilds the creature. ---
  const buildOpts = {
    legCount: creature.spec.limbs.length,
    bodyScale: 1,
    bodyHeight: 0.5,
    legLength: 1,
    kneeFrac: 0.45,
    sprawl: 1,
    bow: 0.3,
    hairs: true,
    hairDensity: 1,
    hairLength: 1,
    microBump: 1.5,
    markType: 'diamond',
    markAmount: 0.3,
    markScale: 1,
    bodyColor: '#6b5bb5', // "main"
    legColor: '#c7b3ff',  // "accent" (legs + eyes)
    toon: false,          // cel shading vs. physical
  };
  const rebuild = () => {
    onRebuild(makeSpider(buildOpts));
    if (maxSteppingCtrl) maxSteppingCtrl.updateDisplay(); // gait.maxStepping reset on rebuild
  };
  const fShape = gBody.addFolder('Shape');
  fShape.add(buildOpts, 'legCount', 3, 20, 1).name('leg count').onFinishChange(rebuild);
  fShape.add(buildOpts, 'bodyScale', 0.4, 2, 0.05).name('body size').onFinishChange(rebuild);
  fShape.add(buildOpts, 'bodyHeight', 0.2, 1.2, 0.05).name('body height').onFinishChange(rebuild);
  fShape.add(buildOpts, 'legLength', 0.6, 1.8, 0.05).name('leg length').onFinishChange(rebuild);
  fShape.add(buildOpts, 'kneeFrac', 0.25, 0.6, 0.01).name('knee height').onFinishChange(rebuild);
  fShape.add(buildOpts, 'sprawl', 0.6, 1.8, 0.05).name('sprawl').onFinishChange(rebuild);
  fShape.add(buildOpts, 'bow', 0, 0.8, 0.02).name('foot bow ( )').onFinishChange(rebuild);
  fShape.add(buildOpts, 'hairs').name('leg hairs').onFinishChange(rebuild);
  fShape.add(buildOpts, 'hairDensity', 0.2, 2, 0.1).name('hair density').onFinishChange(rebuild);
  fShape.add(buildOpts, 'hairLength', 0.3, 2, 0.1).name('hair length').onFinishChange(rebuild);
  fShape.add(buildOpts, 'microBump', 0, 2, 0.05).name('micro-bump')
    .onChange((v) => { const ns = creature.render.bodyMat.normalScale; if (ns) ns.set(v, v); });

  // --- Color: main (body) + accent (legs + eyes). Applied live; stored in
  // buildOpts so a rebuild keeps them. ---
  const applyColors = () => {
    for (const m of [creature.render.bodyMat, creature.render.abdomenMat]) {
      m.color.set(buildOpts.bodyColor);
      m.emissive.set(buildOpts.bodyColor);
    }
    for (const m of [creature.render.legMat, creature.render.eyeMat]) {
      m.color.set(buildOpts.legColor);
      m.emissive.set(buildOpts.legColor);
    }
    // Markings use the accent color.
    creature.render.markUniforms.uMarkColor.value.set(buildOpts.legColor);
  };
  const presets = {
    Amethyst: { bodyColor: '#6b5bb5', legColor: '#c7b3ff' },
    Obsidian: { bodyColor: '#15151c', legColor: '#3a3550' },
    Widow: { bodyColor: '#120e14', legColor: '#d8324b' },
    Emerald: { bodyColor: '#1f5f47', legColor: '#6be0a0' },
    Ember: { bodyColor: '#5c2412', legColor: '#ff9a5c' },
    Ghost: { bodyColor: '#9aa6cc', legColor: '#e9eefc' },
    Wasp: { bodyColor: '#1a1206', legColor: '#f2b705' },
    Toxic: { bodyColor: '#0f1a0a', legColor: '#8cff2a' },
    Ocean: { bodyColor: '#0a1a2a', legColor: '#39b6ff' },
    Magma: { bodyColor: '#1a0a08', legColor: '#ff5a2a' },
    Ivory: { bodyColor: '#d9cfb8', legColor: '#7a6a4c' },
    Rose: { bodyColor: '#2a0f1a', legColor: '#ff7aa8' },
    Cyber: { bodyColor: '#12021a', legColor: '#ff2fd0' },
    Forest: { bodyColor: '#12210f', legColor: '#5bb24a' },
    Ultraviolet: { bodyColor: '#15071f', legColor: '#b14bff' },
    Steel: { bodyColor: '#1c2026', legColor: '#9fb3c8' },
    Honey: { bodyColor: '#3a2606', legColor: '#ffd24a' },
    Abyss: { bodyColor: '#06080f', legColor: '#2f6bff' },
  };
  const presetNames = Object.keys(presets);
  const fColor = gBody.addFolder('Color');
  const presetState = { preset: 'Amethyst', cyclePresets: true };
  const bodyColorCtrl = fColor.addColor(buildOpts, 'bodyColor').name('main').onChange(applyColors);
  const legColorCtrl = fColor.addColor(buildOpts, 'legColor').name('accent (legs + eyes)').onChange(applyColors);
  const applyPreset = (name) => {
    Object.assign(buildOpts, presets[name]);
    presetState.preset = name;
    bodyColorCtrl.updateDisplay();
    legColorCtrl.updateDisplay();
    presetCtrl.updateDisplay();
    applyColors();
  };
  const presetCtrl = fColor.add(presetState, 'preset', presetNames).name('preset').onChange(applyPreset);
  fColor.add(presetState, 'cyclePresets').name('cycle presets (5m)');
  // Advance to the next preset every 5 minutes while cycling is on.
  setInterval(() => {
    if (!presetState.cyclePresets) return;
    const i = presetNames.indexOf(presetState.preset);
    applyPreset(presetNames[(i + 1) % presetNames.length]);
  }, 5 * 60 * 1000);

  // --- Markings: procedural abdomen pattern, drawn in the accent color. Live
  // (no rebuild) — just updates the shader uniforms. ---
  const fMark = gBody.addFolder('Markings');
  const markCycleNames = Object.keys(MARK_TYPES).filter((n) => n !== 'none'); // skip "none" when cycling
  const applyMarkType = (name) => {
    buildOpts.markType = name;
    creature.render.markUniforms.uMarkType.value = MARK_TYPES[name];
    markTypeCtrl.updateDisplay();
  };
  const markTypeCtrl = fMark.add(buildOpts, 'markType', Object.keys(MARK_TYPES)).name('pattern').onChange(applyMarkType);
  fMark.add(buildOpts, 'markAmount', 0, 1, 0.02).name('amount')
    .onChange((v) => { creature.render.markUniforms.uMarkStrength.value = v; });
  fMark.add(buildOpts, 'markScale', 0.3, 3, 0.1).name('scale')
    .onChange((v) => { creature.render.markUniforms.uMarkScale.value = v; });
  const markCycle = { cyclePatterns: true };
  fMark.add(markCycle, 'cyclePatterns').name('cycle patterns (5m)');
  setInterval(() => {
    if (!markCycle.cyclePatterns) return;
    const i = markCycleNames.indexOf(buildOpts.markType);
    applyMarkType(markCycleNames[(i + 1) % markCycleNames.length]);
  }, 5 * 60 * 1000);

  addReset(gBody, () => { rebuild(); applyColors(); });

  // ===================== MOVEMENT =====================
  const gMove = gui.addFolder('Movement');

  const fWander = gMove.addFolder('Wander');
  fWander.add(creature.body, 'maxTurn', 0.1, 2.0, 0.05).name('veer amount');
  fWander.add(creature.body, 'pauseToDance').name('stop & dance');

  const fGait = gMove.addFolder('Gait');
  fGait.add(creature.gait, 'stepThreshold', 0.15, 1.0, 0.01).name('step threshold');
  fGait.add(creature.gait, 'stepDuration', 0.06, 0.5, 0.01).name('step duration (s)');
  fGait.add(creature.gait, 'stepLift', 0.05, 0.8, 0.01).name('step lift');
  maxSteppingCtrl = fGait.add(creature.gait, 'maxStepping', 1, 10, 1).name('max legs stepping');
  fGait.close();

  const fDance = gMove.addFolder('Dance');
  fDance.add(creature.body, 'bobAmount', 0, 1.0, 0.01).name('bob amplitude');
  fDance.add(creature.body, 'beatPop', 0, 10, 0.1).name('bob attack');
  fDance.add(creature.body, 'baseSpeed', 0, 2, 0.05).name('walk speed');
  fDance.add(creature.body, 'audioSpeed', 0, 3, 0.05).name('audio speed');
  fDance.add(creature.body, 'pauseDance').name('pause dancing');
  addReset(gMove);

  // ===================== AUDIO =====================
  const gAudio = gui.addFolder('Audio');

  const fBeat = gAudio.addFolder('Beat');
  fBeat.add(audio, 'beatSource', ['auto', 'bass', 'mid', 'treble']).name('beat source').listen();
  fBeat.add(audio, 'sensitivity', 1.05, 3.0, 0.05).name('beat sensitivity');
  fBeat.add(audio, 'smoothing', 0, 2, 0.02).name('band smoothing (s)');
  fBeat.add({ tap: () => audio.tap() }, 'tap').name('tap tempo (or press T)');
  fBeat.add(audio, 'useTapTempo').name('use tap tempo').listen();
  fBeat.add(audio, 'bpm').name('bpm').listen().disable();
  fBeat.add(audio, 'autoBand').name('auto → band').listen().disable();

  const meters = { bass: 0, mid: 0, treble: 0, beat: 0 };
  const fSignal = gAudio.addFolder('Signal (read-only)');
  const mBass = fSignal.add(meters, 'bass', 0, 1).disable();
  const mMid = fSignal.add(meters, 'mid', 0, 1).disable();
  const mTreble = fSignal.add(meters, 'treble', 0, 1).disable();
  const mBeat = fSignal.add(meters, 'beat', 0, 1).disable();
  fSignal.close();
  addReset(gAudio);

  // ===================== CAMERA =====================
  const gCam = gui.addFolder('Camera');
  gCam.add(follow, 'enabled').name('follow + orbit');
  gCam.add(follow, 'distance', 2, 30, 0.1).name('distance');
  gCam.add(follow, 'height', 0, 20, 0.1).name('height');
  gCam.add(follow, 'rotateSpeed', -60, 60, 1).name('rotate speed (°/s)');
  gCam.add(follow, 'followLerp', 0.2, 10, 0.1).name('follow smoothing');
  gCam.add(follow, 'heightLFO').name('height LFO');
  gCam.add(follow, 'lfoSpeed', 0.1, 3, 0.1).name('LFO speed');
  gCam.add(follow, 'lfoMin', 0, 20, 0.5).name('LFO min height');
  gCam.add(follow, 'lfoMax', 0, 20, 0.5).name('LFO max height');
  addReset(gCam);

  // ===================== LIGHTING =====================
  const gLight = gui.addFolder('Lighting');
  const fKey = gLight.addFolder('Key (spotlight)');
  fKey.add(keyLight, 'intensity', 0, 20, 0.1).name('intensity');
  fKey.add(keyLight, 'angle', 0.1, 1.4, 0.01).name('width');
  fKey.add(keyLight, 'penumbra', 0, 1, 0.01).name('softness');
  fKey.add(lightRig.offset, 'y', 3, 25, 0.5).name('height');
  fKey.add(lightRig, 'follow').name('follow spider');
  const fFill = gLight.addFolder('Fill (point light)');
  fFill.add(fillLight, 'visible').name('enabled');
  fFill.add(fillLight, 'intensity', 0, 10, 0.1).name('intensity');
  fFill.addColor({ c: '#00feff' }, 'c').name('color')
    .onChange((v) => fillLight.color.set(v));
  addReset(gLight);

  // ===================== POST-PROCESSING =====================
  const gLook = gui.addFolder('Post-Processing');
  gLook.add(buildOpts, 'toon').name('toon shading').onFinishChange(rebuild);
  gLook.add(outlinePass, 'enabled').name('ink outline');
  gLook.add(outlinePass.material.uniforms.thickness, 'value', 0.5, 3, 0.1).name('outline width');
  gLook.add(outlinePass.material.uniforms.strength, 'value', 0, 1, 0.02).name('outline opacity');
  gLook.addColor({ c: '#000000' }, 'c').name('outline color')
    .onChange((v) => outlinePass.material.uniforms.outlineColor.value.set(v));
  gLook.add(bloomPass, 'strength', 0, 0.5, 0.01).name('bloom strength');
  gLook.add(bloomPass, 'radius', 0, 1, 0.02).name('bloom radius');
  gLook.add(bloomPass, 'threshold', 0.7, 1.0, 0.005).name('bloom threshold');
  gLook.add(renderer, 'toneMappingExposure', 0.2, 2, 0.05).name('exposure');
  gLook.add(creature, 'glow', 0, 2, 0.02).name('glow');
  addReset(gLook, rebuild); // toon toggle lives here, so rebuild after reset

  // Start with every section collapsed.
  gui.folders.forEach((f) => f.close());
  collapsed = true;
  collapseBtn.name('expand all ▸');

  function syncMeters(bus) {
    meters.bass = round(bus.bands.bass);
    meters.mid = round(bus.bands.mid);
    meters.treble = round(bus.bands.treble);
    meters.beat = bus.beat ? 1 : Math.max(0, meters.beat - 0.08);
    mBass.updateDisplay(); mMid.updateDisplay();
    mTreble.updateDisplay(); mBeat.updateDisplay();
  }

  return { gui, syncMeters };
}

function round(v) { return Math.round(v * 100) / 100; }

/** Make the top-level section titles (not nested subfolders) stand out. */
function injectHeadingStyle() {
  if (document.getElementById('panel-heading-style')) return;
  const style = document.createElement('style');
  style.id = 'panel-heading-style';
  style.textContent = `
    .lil-gui.root > .children > .lil-gui > .title {
      text-transform: uppercase;
      letter-spacing: 0.1em;
      font-weight: 700;
      background: #2a2140;
      color: #d8c9ff;
      border-top: 1px solid rgba(0,0,0,0.5);
    }
    .lil-gui.root > .children > .lil-gui > .title:hover {
      background: #352a52;
    }`;
  document.head.appendChild(style);
}
