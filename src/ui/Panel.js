/**
 * Panel — the lil-gui control panel. Pure wiring: each control is a direct tap
 * into a live subsystem object. Because Creature reuses its `body` and `gait`
 * objects across rebuilds, these bindings stay valid even when the leg count
 * changes — only `maxStepping` needs its display refreshed afterward.
 */
import GUI from 'lil-gui';
import { makeSpider } from '../creature/CreatureSpec.js';

export function createPanel({ creature, audio, follow, onRebuild }) {
  const gui = new GUI({ title: 'Spider' });

  // --- Camera ---
  const fCamera = gui.addFolder('Camera');
  fCamera.add(follow, 'enabled').name('follow + orbit');
  fCamera.add(follow, 'distance', 2, 30, 0.1).name('distance');
  fCamera.add(follow, 'height', 0, 20, 0.1).name('height');
  fCamera.add(follow, 'rotateSpeed', -60, 60, 1).name('rotate speed (°/s)');
  fCamera.add(follow, 'followLerp', 0.2, 10, 0.1).name('follow smoothing');

  // --- Build: anything that changes geometry rebuilds the creature. ---
  const buildOpts = {
    legCount: creature.spec.limbs.length,
    bodyScale: 1,
    bodyHeight: 0.5,
    legLength: 1,
    kneeFrac: 0.45,
    sprawl: 1,
    bow: 0.3,
  };
  const rebuild = () => {
    onRebuild(makeSpider(buildOpts));
    maxSteppingCtrl.updateDisplay(); // gait.maxStepping was reset on rebuild
  };
  const fBuild = gui.addFolder('Build');
  fBuild.add(buildOpts, 'legCount', 3, 20, 1).name('leg count').onFinishChange(rebuild);
  fBuild.add(buildOpts, 'bodyScale', 0.4, 2, 0.05).name('body size').onFinishChange(rebuild);
  fBuild.add(buildOpts, 'bodyHeight', 0.2, 1.2, 0.05).name('body height').onFinishChange(rebuild);
  fBuild.add(buildOpts, 'legLength', 0.6, 1.8, 0.05).name('leg length').onFinishChange(rebuild);
  fBuild.add(buildOpts, 'kneeFrac', 0.25, 0.6, 0.01).name('knee height').onFinishChange(rebuild);
  fBuild.add(buildOpts, 'sprawl', 0.6, 1.8, 0.05).name('sprawl').onFinishChange(rebuild);
  fBuild.add(buildOpts, 'bow', 0, 0.8, 0.02).name('foot bow ( )').onFinishChange(rebuild);

  // --- Behavior (how it wanders) ---
  const fBehavior = gui.addFolder('Behavior');
  fBehavior.add(creature.body, 'maxTurn', 0.1, 2.0, 0.05).name('veer amount');
  fBehavior.add(creature.body, 'pauseToDance').name('stop & dance');

  // --- Gait ---
  const fGait = gui.addFolder('Gait');
  fGait.add(creature.gait, 'stepThreshold', 0.15, 1.0, 0.01).name('step threshold');
  fGait.add(creature.gait, 'stepDuration', 0.06, 0.5, 0.01).name('step duration (s)');
  fGait.add(creature.gait, 'stepLift', 0.05, 0.8, 0.01).name('step lift');
  const maxSteppingCtrl = fGait.add(creature.gait, 'maxStepping', 1, 10, 1).name('max legs stepping');

  // --- Dance (body reaction to audio) ---
  const fDance = gui.addFolder('Dance');
  fDance.add(creature.body, 'bobAmount', 0, 1.0, 0.01).name('bass bob');
  fDance.add(creature.body, 'beatPop', 0, 10, 0.1).name('beat pop');
  fDance.add(creature.body, 'baseSpeed', 0, 2, 0.05).name('walk speed');
  fDance.add(creature.body, 'audioSpeed', 0, 3, 0.05).name('audio speed');
  fDance.add(creature.body, 'pauseDance').name('pause dancing');

  // --- Audio / beat ---
  const fAudio = gui.addFolder('Audio / beat');
  fAudio.add(audio, 'beatSource', ['auto', 'bass', 'mid', 'treble']).name('beat source').listen();
  fAudio.add(audio, 'sensitivity', 1.05, 3.0, 0.05).name('beat sensitivity');
  fAudio.add(audio, 'smoothing', 0, 0.95, 0.01).name('band smoothing');
  fAudio.add({ tap: () => audio.tap() }, 'tap').name('tap tempo (or press T)');
  fAudio.add(audio, 'useTapTempo').name('use tap tempo').listen();
  fAudio.add(audio, 'bpm').name('bpm').listen().disable();
  fAudio.add(audio, 'autoBand').name('auto → band').listen().disable();

  // --- Live signal read-outs ---
  const meters = { bass: 0, mid: 0, treble: 0, beat: 0 };
  const fMeters = gui.addFolder('Signal (read-only)');
  const mBass = fMeters.add(meters, 'bass', 0, 1).disable();
  const mMid = fMeters.add(meters, 'mid', 0, 1).disable();
  const mTreble = fMeters.add(meters, 'treble', 0, 1).disable();
  const mBeat = fMeters.add(meters, 'beat', 0, 1).disable();

  function syncMeters(bus) {
    meters.bass = round(bus.bands.bass);
    meters.mid = round(bus.bands.mid);
    meters.treble = round(bus.bands.treble);
    // Decay the beat indicator so a 1-frame beat stays visible.
    meters.beat = bus.beat ? 1 : Math.max(0, meters.beat - 0.08);
    mBass.updateDisplay(); mMid.updateDisplay();
    mTreble.updateDisplay(); mBeat.updateDisplay();
  }

  return { gui, syncMeters };
}

function round(v) { return Math.round(v * 100) / 100; }
