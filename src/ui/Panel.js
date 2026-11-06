/**
 * Panel — the lil-gui control panel. Top-level sections:
 *
 *   Group    — count, arrangement (wander/circle), re-randomize extras
 *   Creature — the HERO's Shape / Color / Markings (extras are randomized)
 *   Movement — Wander / Gait / Dance (scene-wide: applied to all creatures)
 *   Audio    — Beat + live Signal
 *   Camera   — follow/orbit rig + look-at target
 *   Lighting — key spotlight + fill point light
 *   Post-Processing — toon, ink outline, bloom, exposure, glow (scene-wide)
 *
 * Hero-only controls poke `swarm.hero`; scene-wide controls use applyAll().
 */
import GUI from 'lil-gui';
import { makeSpider, makeAngel, MARK_TYPES } from '../creature/CreatureSpec.js';

const MAKERS = { spider: makeSpider, angel: makeAngel };

export function createPanel({ swarm, audio, follow, renderer, bloomPass, outlinePass, afterimagePass, posterizePass, halftonePass, glitchPass, trail, glitchRig, keyLight, lightRig, fillLight }) {
  const gui = new GUI({ title: 'Controls' });
  injectHeadingStyle();

  const hero = swarm.hero;
  const applyAll = (fn) => swarm.creatures.forEach(fn); // scene-wide propagation
  let maxSteppingCtrl = null;
  let distanceCtrl = null;

  const addReset = (folder, after) => {
    folder.add({ reset() { folder.reset(); if (after) after(); } }, 'reset').name('↺ reset section');
  };

  // Collapse/expand all sections.
  let collapsed = false;
  const collapseBtn = gui.add({
    toggle() {
      collapsed = !collapsed;
      gui.folders.forEach((f) => (collapsed ? f.close() : f.open()));
      collapseBtn.name(collapsed ? 'expand all ▸' : 'collapse all ▾');
    },
  }, 'toggle').name('collapse all ▾');

  // ===================== GROUP =====================
  const gGroup = gui.addFolder('Group');
  const groupState = { count: 1, arrangement: 'circle', type: swarm.type };
  // Build the hero's spec with whatever creature type is selected.
  const makeHero = () => MAKERS[groupState.type](buildOpts);
  const refitCamera = () => {
    if (groupState.arrangement === 'circle') follow.distance = swarm.ringRadius * 1.8 + 4;
    else follow.distance = 8;
    if (distanceCtrl) distanceCtrl.updateDisplay();
  };
  gGroup.add(groupState, 'count', 1, 10, 1).name('count').onFinishChange((v) => { swarm.setCount(v); refitCamera(); });
  gGroup.add(groupState, 'arrangement', ['wander', 'circle']).name('arrangement')
    .onChange((v) => { swarm.setArrangement(v); refitCamera(); });
  const sepCtrl = gGroup.add(swarm, 'separation', 3, 6, 0.1).name('(wander) spacing');
  gGroup.add(hero.gait, 'circleStepThreshold', 0.1, 0.6, 0.01).name('(circle) step thresh')
    .onChange((v) => applyAll((c) => { c.gait.circleStepThreshold = v; }));
  gGroup.add({ reroll() { swarm.rerollExtras(); } }, 'reroll').name('re-randomize extras');

  // ===================== CREATURE (hero) =====================
  const gBody = gui.addFolder('Creature');

  const buildOpts = {
    legCount: hero.spec.limbs.length,
    bodyScale: 1, bodyHeight: 0.5, legLength: 1, kneeFrac: 0.45, sprawl: 1, bow: 0.3,
    hairs: true, hairDensity: 1, hairLength: 1, microBump: 1.5,
    ringCount: 1,
    markType: 'diamond', markAmount: 0.3, markScale: 1,
    bodyColor: '#6b5bb5', legColor: '#c7b3ff',
    toon: false,
  };
  const rebuild = () => {
    swarm.rebuildHero(makeHero());
    if (maxSteppingCtrl) maxSteppingCtrl.updateDisplay();
  };
  const fShape = gBody.addFolder('Shape');
  fShape.add(buildOpts, 'legCount', 3, 20, 1).name('leg count').onFinishChange(rebuild);
  fShape.add(buildOpts, 'bodyScale', 0.4, 2, 0.05).name('body size').onFinishChange(rebuild);
  fShape.add(buildOpts, 'bodyHeight', 0.2, 1.2, 0.05).name('body height').onFinishChange(rebuild);
  fShape.add(buildOpts, 'legLength', 0.85, 1.8, 0.05).name('leg length').onFinishChange(rebuild);
  fShape.add(buildOpts, 'kneeFrac', 0.25, 0.6, 0.01).name('knee height').onFinishChange(rebuild);
  fShape.add(buildOpts, 'sprawl', 0.6, 1.8, 0.05).name('sprawl').onFinishChange(rebuild);
  fShape.add(buildOpts, 'bow', 0, 0.8, 0.02).name('foot bow ( )').onFinishChange(rebuild);
  // Leg hairs are a spider-only trait — these controls hide in angel mode (angels
  // grow feathers instead, built in a later step). See updateTypeUI().
  const hairCtrls = [
    fShape.add(buildOpts, 'hairs').name('leg hairs').onFinishChange(rebuild),
    fShape.add(buildOpts, 'hairDensity', 0.2, 2, 0.1).name('hair density').onFinishChange(rebuild),
    fShape.add(buildOpts, 'hairLength', 0.3, 2, 0.1).name('hair length').onFinishChange(rebuild),
  ];
  // Ophanim rings — angel-only; hidden for the spider. See updateTypeUI().
  const ringsCtrl = fShape.add(buildOpts, 'ringCount', 0, 2, 1).name('rings').onFinishChange(rebuild);
  fShape.add(buildOpts, 'microBump', 0, 2, 0.05).name('micro-bump')
    .onChange((v) => { const ns = hero.render.bodyMat.normalScale; if (ns) ns.set(v, v); });

  // --- Color (hero): main (body) + accent (legs + eyes). ---
  const applyColors = () => {
    for (const m of [hero.render.bodyMat, hero.render.abdomenMat]) {
      m.color.set(buildOpts.bodyColor); m.emissive.set(buildOpts.bodyColor);
    }
    for (const m of [hero.render.legMat, hero.render.eyeMat]) {
      m.color.set(buildOpts.legColor); m.emissive.set(buildOpts.legColor);
    }
    hero.render.markUniforms.uMarkColor.value.set(buildOpts.legColor);
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
    bodyColorCtrl.updateDisplay(); legColorCtrl.updateDisplay(); presetCtrl.updateDisplay();
    applyColors();
  };
  const presetCtrl = fColor.add(presetState, 'preset', presetNames).name('preset').onChange(applyPreset);
  fColor.add(presetState, 'cyclePresets').name('cycle presets (5m)');
  setInterval(() => {
    if (!presetState.cyclePresets) return;
    const i = presetNames.indexOf(presetState.preset);
    applyPreset(presetNames[(i + 1) % presetNames.length]);
  }, 5 * 60 * 1000);

  // --- Markings (hero): procedural abdomen pattern in the accent color. ---
  const fMark = gBody.addFolder('Markings');
  const markCycleNames = Object.keys(MARK_TYPES).filter((n) => n !== 'none');
  const applyMarkType = (name) => {
    buildOpts.markType = name;
    hero.render.markUniforms.uMarkType.value = MARK_TYPES[name];
    markTypeCtrl.updateDisplay();
  };
  const markTypeCtrl = fMark.add(buildOpts, 'markType', Object.keys(MARK_TYPES)).name('pattern').onChange(applyMarkType);
  fMark.add(buildOpts, 'markAmount', 0, 1, 0.02).name('amount')
    .onChange((v) => { hero.render.markUniforms.uMarkStrength.value = v; });
  fMark.add(buildOpts, 'markScale', 0.3, 3, 0.1).name('scale')
    .onChange((v) => { hero.render.markUniforms.uMarkScale.value = v; });
  const markCycle = { cyclePatterns: true };
  fMark.add(markCycle, 'cyclePatterns').name('cycle patterns (5m)');
  setInterval(() => {
    if (!markCycle.cyclePatterns) return;
    const i = markCycleNames.indexOf(buildOpts.markType);
    applyMarkType(markCycleNames[(i + 1) % markCycleNames.length]);
  }, 5 * 60 * 1000);

  addReset(gBody, () => { rebuild(); applyColors(); });

  // ===================== MOVEMENT (scene-wide) =====================
  const gMove = gui.addFolder('Movement');

  const fWander = gMove.addFolder('Wander');
  fWander.add(hero.body, 'maxTurn', 0.1, 2.0, 0.05).name('veer amount').onChange((v) => applyAll((c) => { c.body.maxTurn = v; }));
  fWander.add(hero.body, 'pauseToDance').name('stop & dance').onChange((v) => applyAll((c) => { c.body.pauseToDance = v; }));

  const fGait = gMove.addFolder('Gait');
  fGait.add(hero.gait, 'stepThreshold', 0.15, 1.0, 0.01).name('step threshold').onChange((v) => applyAll((c) => { c.gait.stepThreshold = v; }));
  fGait.add(hero.gait, 'stepDuration', 0.06, 0.5, 0.01).name('step duration (s)').onChange((v) => applyAll((c) => { c.gait.stepDuration = v; }));
  fGait.add(hero.gait, 'stepLift', 0.05, 0.8, 0.01).name('step lift').onChange((v) => applyAll((c) => { c.gait.stepLift = v; }));
  maxSteppingCtrl = fGait.add(hero.gait, 'maxStepping', 1, 10, 1).name('max legs stepping (hero)');
  fGait.close();

  const fDance = gMove.addFolder('Dance');
  fDance.add(hero.body, 'bobAmount', 0, 1.0, 0.01).name('bob amplitude').onChange((v) => applyAll((c) => { c.body.bobAmount = v; }));
  fDance.add(hero.body, 'beatPop', 0, 10, 0.1).name('bob attack').onChange((v) => applyAll((c) => { c.body.beatPop = v; }));
  fDance.add(hero.body, 'baseSpeed', 0, 2, 0.05).name('walk speed').onChange((v) => applyAll((c) => { c.body.baseSpeed = v; }));
  fDance.add(hero.body, 'audioSpeed', 0, 3, 0.05).name('audio speed').onChange((v) => applyAll((c) => { c.body.audioSpeed = v; }));
  fDance.add(hero.body, 'quietCutoff', 0, 0.4, 0.005).name('quiet cutoff').onChange((v) => applyAll((c) => { c.body.quietCutoff = v; }));
  fDance.add(hero.body, 'pauseDance').name('pause dancing').onChange((v) => applyAll((c) => { c.body.pauseDance = v; }));
  addReset(gMove);

  // ===================== AUDIO =====================
  const gAudio = gui.addFolder('Audio');
  const fBeat = gAudio.addFolder('Beat');
  fBeat.add(audio, 'beatSource', ['auto', 'bass', 'mid', 'treble']).name('beat source').listen();
  fBeat.add(audio, 'sensitivity', 1.05, 3.0, 0.05).name('beat sensitivity');
  // Max tempo: how fast beats are allowed to fire. Stored as a refractory interval
  // (s) on the driver; shown here as beats/min (higher = faster beats allowed, but
  // more prone to the jitter the refractory tames). 0.2s ≈ 300, 0.5s ≈ 120.
  const beatRate = {
    get maxTempo() { return Math.round(60 / audio.minBeatInterval); },
    set maxTempo(v) { audio.minBeatInterval = 60 / v; },
  };
  fBeat.add(beatRate, 'maxTempo', 120, 600, 10).name('max tempo (bpm)');
  fBeat.add(audio, 'smoothing', 0, 2, 0.02).name('band smoothing (s)');
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
  distanceCtrl = gCam.add(follow, 'distance', 2, 40, 0.1).name('distance');
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
  fKey.add(lightRig, 'intensity', 0, 20, 0.1).name('intensity');
  fKey.addColor({ c: '#ffffff' }, 'c').name('color').onChange((v) => keyLight.color.set(v));
  fKey.add(keyLight, 'angle', 0.1, 1.4, 0.01).name('width');
  fKey.add(keyLight, 'penumbra', 0, 1, 0.01).name('softness');
  fKey.add(lightRig.offset, 'y', 3, 25, 0.5).name('height');
  fKey.add(lightRig, 'follow').name('follow spider');
  fKey.add(lightRig, 'sweep').name('sweep (roam aim)');
  fKey.add(lightRig, 'sweepRange', 0, 12, 0.5).name('sweep range');
  fKey.add(lightRig, 'sweepSpeed', 0.1, 3, 0.1).name('sweep speed');
  fKey.add(lightRig, 'strobe').name('strobe (on beat)');
  const fFill = gLight.addFolder('Fill (point light)');
  fFill.add(fillLight, 'visible').name('enabled');
  fFill.add(fillLight, 'intensity', 0, 10, 0.1).name('intensity');
  fFill.addColor({ c: '#00feff' }, 'c').name('color').onChange((v) => fillLight.color.set(v));
  addReset(gLight);

  // ===================== POST-PROCESSING (scene-wide) =====================
  const gLook = gui.addFolder('Post-Processing');
  gLook.add(buildOpts, 'toon').name('toon shading')
    .onFinishChange(() => { swarm.setStyleAll(buildOpts.toon, makeHero()); if (maxSteppingCtrl) maxSteppingCtrl.updateDisplay(); });
  gLook.add(outlinePass, 'enabled').name('ink outline');
  gLook.add(outlinePass.material.uniforms.thickness, 'value', 0.5, 3, 0.1).name('outline width');
  gLook.add(outlinePass.material.uniforms.strength, 'value', 0, 1, 0.02).name('outline opacity');
  gLook.addColor({ c: '#000000' }, 'c').name('outline color')
    .onChange((v) => outlinePass.material.uniforms.outlineColor.value.set(v));
  gLook.add(bloomPass, 'strength', 0, 0.5, 0.01).name('bloom strength');
  gLook.add(bloomPass, 'radius', 0, 1, 0.02).name('bloom radius');
  gLook.add(bloomPass, 'threshold', 0.7, 1.0, 0.005).name('bloom threshold');
  gLook.add(lightRig, 'exposure', 0.2, 2, 0.05).name('exposure');
  gLook.add(hero, 'glow', 0, 2, 0.02).name('glow').onChange((v) => applyAll((c) => { c.glow = v; }));

  // --- Stylize: optional full-screen looks / effects ---
  const fFx = gLook.addFolder('Stylize');
  fFx.add(afterimagePass, 'enabled').name('motion trails');
  fFx.add(trail, 'base', 0.5, 0.97, 0.01).name('trail length');
  fFx.add(trail, 'reactive').name('trails react to audio');
  fFx.add(posterizePass, 'enabled').name('posterize');
  fFx.add(posterizePass.uniforms.levels, 'value', 2, 12, 1).name('posterize levels');
  fFx.add(halftonePass, 'enabled').name('halftone');
  fFx.add(halftonePass.uniforms.radius, 'value', 1, 12, 0.5).name('halftone dot size');
  fFx.add(glitchRig, 'onBeat').name('beat glitch');
  fFx.add(glitchRig, 'intensity', 0, 1.5, 0.05).name('glitch intensity');
  fFx.close();

  addReset(gLook, () => { swarm.setStyleAll(buildOpts.toon, makeHero()); });

  // Show/hide type-specific controls: leg hairs are spider-only, rings are angel-only.
  const updateTypeUI = () => {
    const isAngel = groupState.type === 'angel';
    hairCtrls.forEach((c) => c.show(!isAngel));
    ringsCtrl.show(isAngel);
  };

  // Creature-type switch: a segmented Spider | Angel toggle pinned to the top of
  // the panel (scene-wide mode switch, so it gets top billing). Swaps the hero and
  // re-rolls the extras to match.
  injectTypeSwitch(gui, groupState.type, (v) => {
    groupState.type = v;
    swarm.setType(v, makeHero());
    updateTypeUI();
    sepCtrl.updateDisplay(); // separation default changed with the type
    if (maxSteppingCtrl) maxSteppingCtrl.updateDisplay();
  });
  updateTypeUI();

  refitCamera(); // match the initial arrangement

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

/**
 * Build a segmented Spider | Angel toggle and pin it to the very top of the panel
 * (above everything, since it switches the whole scene's creature type). Calls
 * `onChange(type)` on a click; the two buttons share one row, active one lit.
 */
function injectTypeSwitch(gui, initial, onChange) {
  injectTypeSwitchStyle();
  const row = document.createElement('div');
  row.className = 'creature-switch';
  const buttons = {};
  const setActive = (val) => {
    for (const k in buttons) buttons[k].classList.toggle('active', k === val);
  };
  const mk = (label, val) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', () => { setActive(val); onChange(val); });
    buttons[val] = b;
    row.appendChild(b);
  };
  mk('🕷 Spider', 'spider');
  mk('👁 Angel', 'angel');
  setActive(initial);

  const children = gui.domElement.querySelector('.children');
  children.insertBefore(row, children.firstChild);
  return { setActive };
}

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

/** Styles for the segmented Spider | Angel toggle. */
function injectTypeSwitchStyle() {
  if (document.getElementById('creature-switch-style')) return;
  const style = document.createElement('style');
  style.id = 'creature-switch-style';
  style.textContent = `
    .creature-switch {
      display: flex;
      gap: 2px;
      padding: 4px 4px 9px;
      background: #1a1626;
    }
    .creature-switch button {
      flex: 1;
      height: 100%;
      cursor: pointer;
      padding: 7px 4px;
      font: inherit;
      font-size: 12px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #9a8fb8;
      background: #2a2140;
      border: 1px solid transparent;
      border-radius: 3px;
      transition: background 0.12s, color 0.12s;
    }
    .creature-switch button:hover { background: #352a52; color: #d8c9ff; }
    .creature-switch button.active {
      background: #6b5bb5;
      color: #fff;
      border-color: #c7b3ff;
      font-weight: 700;
    }`;
  document.head.appendChild(style);
}
