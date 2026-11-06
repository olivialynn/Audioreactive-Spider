/**
 * BodyController — the body's position, heading, and "dance."
 *
 * Movement model (what makes it read as a creature, not a roomba):
 *   - It mostly walks FORWARD. Heading changes come from a slowly random-walked
 *     turn rate, so it veers gently left/right instead of spinning to face new
 *     targets. Near the edge of its roam area it curves back toward the middle
 *     (never a sharp U-turn).
 *   - A walk/dance mode timer occasionally stops it to stand and dance in place,
 *     then it resumes walking.
 *
 * It owns the vertical "dance" too: continuous lift from bass + a springy pop on
 * each beat. It knows nothing about legs/feet — GaitPlanner reads this body's
 * pose and makes the feet follow. That decoupling lets the body wobble freely
 * while the feet stay planted.
 */
import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);
const _forward = new THREE.Vector3();
const _wobbleE = new THREE.Euler();
const _wobbleQ = new THREE.Quaternion();

export class BodyController {
  constructor(opts = {}) {
    this.baseHeight = opts.baseHeight ?? 0.55;
    this.roamRadius = opts.roamRadius ?? 7;

    // --- movement tunables (see ui/Panel.js) ---
    this.baseSpeed = opts.baseSpeed ?? 0.8;  // forward speed when quiet
    this.audioSpeed = opts.audioSpeed ?? 1.0; // extra forward speed scaled by loudness
    this.maxTurn = opts.maxTurn ?? 0.6;      // rad/s — how sharply it veers
    this.pauseToDance = opts.pauseToDance ?? true; // stop & dance occasionally
    this.pauseDance = opts.pauseDance ?? false;    // freeze the dance reaction entirely

    // --- dance tunables ---
    this.bobAmount = opts.bobAmount ?? 0.2; // continuous lift from bass
    this.beatPop = opts.beatPop ?? 3.0;     // impulse added to bob on a beat

    // --- arrangement: 'wander' (walks around) or 'circle' (stands, faces home) ---
    this.arrangement = 'wander';
    this.home = new THREE.Vector3();
    this.homeHeading = 0;

    // --- per-creature dance variety (for groups) ---
    this.responseScale = 1;                       // how hard it reacts to the audio
    this.swayPhase = Math.random() * Math.PI * 2; // idle sway LFO, random phase...
    this.swaySpeed = 0.6 + Math.random() * 0.8;   // ...and speed, so a crowd desyncs
    this.swayAmount = 0.04;                        // vertical idle sway
    this.swayTilt = 0.035;                         // rotational idle wobble (radians)
    this.shuffle = 0.3;                            // horizontal drift in 'circle' (shuffles feet)

    // Activity gate: below this audio level they ease to a standstill (like a
    // person stopping during a quiet passage), and spring back when it returns.
    this.quietCutoff = 0.04;
    this._active = 1; // smoothed 0..1

    // --- state ---
    this.position = new THREE.Vector3(0, this.baseHeight, 0);
    this.quaternion = new THREE.Quaternion();
    this.heading = Math.random() * Math.PI * 2;
    this.velDir = new THREE.Vector3(1, 0, 0); // direction * speed-fraction (for gait)
    this.speed = 0;

    // wander: a random-walked turn rate that decays back toward straight
    this._turn = 0;
    this._turnJitter = 2.0;
    this._turnDamping = 1.2;
    this._centeringGain = 1.6;

    // walk/dance mode timer
    this.mode = 'walk';
    this._modeTimer = rand(5, 10);

    // vertical spring for the bob/pop
    this._bobPos = 0;
    this._bobVel = 0;
    this._stiffness = 90;
    this._damping = 13; // firmer (ζ≈0.7): each beat pops once and settles, instead
                        // of ringing for ~1s and stacking with the next beat
  }

  update(dt, bus) {
    this.swayPhase += this.swaySpeed * dt;

    // Ease the activity gate toward on/off (quick to wake, slower to settle).
    const gate = bus.level > this.quietCutoff ? 1 : 0;
    const tau = gate > this._active ? 0.25 : 0.8;
    this._active += (gate - this._active) * (1 - Math.exp(-dt / tau));

    if (this.arrangement === 'circle') {
      // Stand near home, face the center, and shuffle a little (two out-of-phase
      // sines trace a small loop) — enough body drift that the gait lifts feet.
      // Scaled by _active so they go still when the music drops out.
      this.heading = this.homeHeading;
      this.position.x = this.home.x + Math.sin(this.swayPhase * 0.8) * this.shuffle * this._active;
      this.position.z = this.home.z + Math.sin(this.swayPhase * 0.5 + 1.3) * this.shuffle * this._active;
      this.velDir.set(0, 0, 0);
      this.quaternion.setFromAxisAngle(UP, this.heading);
      this._applyWobble();
      this._updateDance(dt, bus);
    } else {
      this._updateMode(dt, bus);
      this._updateHeading(dt);
      this._updateMovement(dt, bus);
      this._applyWobble();
      this._updateDance(dt, bus);
    }
  }

  // A small rotational idle wobble layered onto the heading, for personality.
  _applyWobble() {
    const t = this.swayTilt * this._active;
    _wobbleE.set(Math.sin(this.swayPhase * 1.3) * t, 0, Math.cos(this.swayPhase) * t);
    _wobbleQ.setFromEuler(_wobbleE);
    this.quaternion.multiply(_wobbleQ);
  }

  _updateMode(dt, bus) {
    this._modeTimer -= dt;
    if (this._modeTimer > 0) return;
    if (this.mode === 'walk') {
      // Only pause to dance if enabled, not globally paused, and there's sound.
      if (this.pauseToDance && !this.pauseDance && bus.level > 0.03) {
        this.mode = 'dance';
        this._modeTimer = rand(2.5, 5);
      } else {
        this._modeTimer = rand(4, 8); // keep walking, re-check later
      }
    } else {
      this.mode = 'walk';
      this._modeTimer = rand(6, 12);
    }
  }

  _updateHeading(dt) {
    // Random-walk the turn rate -> gentle veering, not U-turns.
    this._turn += (Math.random() * 2 - 1) * this._turnJitter * dt;
    this._turn -= this._turn * this._turnDamping * dt;
    this._turn = clamp(this._turn, -this.maxTurn, this.maxTurn);

    let turn = this._turn;

    // Near the edge of the roam area, steer back toward the center. The strength
    // ramps up with distance so it curves back gradually instead of snapping.
    const dist = Math.hypot(this.position.x, this.position.z);
    const edge = smoothstep(this.roamRadius * 0.6, this.roamRadius, dist);
    if (edge > 0) {
      const headingToCenter = Math.atan2(this.position.z, -this.position.x);
      turn += angleDiff(headingToCenter, this.heading) * this._centeringGain * edge;
    }

    this.heading += turn * dt;
    this.quaternion.setFromAxisAngle(UP, this.heading);
    _forward.set(1, 0, 0).applyQuaternion(this.quaternion);
  }

  _updateMovement(dt, bus) {
    // Ease speed toward its target so stops/starts are smooth (0 when dancing).
    // Gate the whole walk by _active so they halt when the audio goes quiet.
    const targetSpeed = (this.mode === 'dance' ? 0 : this.baseSpeed + this.audioSpeed * bus.level) * this._active;
    this.speed += (targetSpeed - this.speed) * (1 - Math.exp(-3 * dt));
    this.position.addScaledVector(_forward, this.speed * dt);

    // velDir carries direction * speed-fraction so foot step-overshoot (in the
    // gait planner) scales with pace and vanishes when standing still.
    const frac = clamp(this.speed / (this.baseSpeed + this.audioSpeed), 0, 1);
    this.velDir.copy(_forward).multiplyScalar(frac);
  }

  _updateDance(dt, bus) {
    // When paused, settle to a calm resting height and ignore beats.
    if (this.pauseDance) {
      this._bobVel = 0;
      this._bobPos *= Math.exp(-6 * dt);
      this.position.y = this.baseHeight + this._bobPos;
      return;
    }

    // Damped spring pulls the bob back to 0; each beat kicks it up so it bounces.
    // responseScale varies the reaction per creature so a group isn't in lockstep.
    const accel = -this._stiffness * this._bobPos - this._damping * this._bobVel;
    this._bobVel += accel * dt;
    if (bus.beat) this._bobVel += this.beatPop * (0.5 + 0.5 * bus.beatEnergy) * this.responseScale;
    this._bobPos += this._bobVel * dt;

    // Follow whichever band is currently active (bass/mid/treble), not always bass.
    const bandLevel = bus.bands[bus.activeBand] ?? bus.bands.bass;
    const continuousBob = bandLevel * this.bobAmount * this.responseScale;
    // Idle sway: a gentle autonomous bob (random phase/speed), gated by activity.
    const sway = Math.sin(this.swayPhase) * this.swayAmount * this._active;
    this.position.y = this.baseHeight + this._bobPos + continuousBob + sway;
  }

  get pose() {
    return { position: this.position, quaternion: this.quaternion };
  }
}

function rand(a, b) { return a + Math.random() * (b - a); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Smallest signed angle a - b, wrapped to [-pi, pi]. */
function angleDiff(a, b) {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
