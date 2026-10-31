/**
 * GaitPlanner — decides WHERE each foot is planted and WHEN it takes a step.
 *
 * This is the subsystem that makes the walk read as a walk instead of sliding:
 * feet stay planted on the ground while the body moves over them, and only step
 * (lifting in an arc to a new spot) when they've drifted too far.
 *
 * Why this generalizes to any leg count
 * -------------------------------------
 * There is no hardcoded gait pattern. Each leg independently wants to step when
 * its planted foot is farther than `stepThreshold` from its ideal position. The
 * only coordination is a global cap, `maxStepping`, on how many legs may be
 * mid-step at once. That single rule yields a believable alternating gait for
 * 4 legs, 8 legs, or 20 — so changing the leg count needs no gait changes.
 *
 * All foot positions live on the ground plane (world y = 0); the lift during a
 * step is purely visual.
 */
import * as THREE from 'three';

const _ideal = new THREE.Vector3();
const _local = new THREE.Vector3();

export class GaitPlanner {
  constructor(legs, opts = {}) {
    // --- tunable (see ui/Panel.js) ---
    this.stepThreshold = opts.stepThreshold ?? 0.45; // drift before a leg steps
    this.circleStepThreshold = opts.circleStepThreshold ?? 0.3; // smaller, for dancing in a ring
    this.easySteps = false; // set by the Swarm when circle + count > 1
    this.stepDuration = opts.stepDuration ?? 0.18;   // seconds per step
    this.stepLift = opts.stepLift ?? 0.35;           // peak foot height mid-step
    this.maxStepping = opts.maxStepping ?? Math.max(1, Math.floor(legs.length / 2));
    this.overshoot = opts.overshoot ?? 0.5; // land ahead of ideal, toward motion

    // Per-leg state, parallel to the legs array.
    this.feet = legs.map((leg) => ({
      leg,
      planted: new THREE.Vector3(), // current foot position (ground)
      stepStart: new THREE.Vector3(),
      stepTarget: new THREE.Vector3(),
      stepping: false,
      progress: 0,
    }));
  }

  /** Place every foot at its ideal spot immediately (used at build/teleport). */
  snapToIdeal(pose) {
    for (const foot of this.feet) {
      idealFootPosition(foot.leg, pose, foot.planted);
    }
  }

  /**
   * @param dt       seconds
   * @param pose     { position, quaternion } of the body this frame
   * @param velDir   THREE.Vector3 horizontal movement direction (unit-ish)
   * @param threshold drift that triggers a step (defaults to stepThreshold)
   */
  update(dt, pose, velDir, threshold = this.stepThreshold) {
    const steppingNow = this.feet.reduce((n, f) => n + (f.stepping ? 1 : 0), 0);
    let budget = this.maxStepping - steppingNow;

    for (const foot of this.feet) {
      if (foot.stepping) {
        // Advance an in-progress step: lerp along the ground, arc up in y.
        foot.progress += dt / this.stepDuration;
        const t = Math.min(1, foot.progress);
        foot.planted.lerpVectors(foot.stepStart, foot.stepTarget, t);
        foot.planted.y = Math.sin(t * Math.PI) * this.stepLift;
        if (t >= 1) {
          foot.stepping = false;
          foot.planted.y = 0;
        }
        continue;
      }

      // Not stepping: does this foot need to?
      idealFootPosition(foot.leg, pose, _ideal);
      const drift = foot.planted.distanceTo(_ideal);
      if (drift > threshold && budget > 0) {
        foot.stepping = true;
        foot.progress = 0;
        foot.stepStart.copy(foot.planted);
        // Land slightly ahead, in the direction of travel, so the gait leads.
        foot.stepTarget.copy(_ideal).addScaledVector(velDir, this.overshoot);
        foot.stepTarget.y = 0;
        budget--;
      }
    }
  }

  /** Rebuild per-leg state for a new set of legs (e.g. leg-count changed). */
  rebuild(legs) {
    this.maxStepping = Math.max(1, Math.floor(legs.length / 2));
    this.feet = legs.map((leg) => ({
      leg,
      planted: new THREE.Vector3(),
      stepStart: new THREE.Vector3(),
      stepTarget: new THREE.Vector3(),
      stepping: false,
      progress: 0,
    }));
  }
}

/**
 * The ideal resting foot position for a leg, in world space, on the ground.
 * It's the leg's body-local foot offset, rotated by the body's heading and
 * placed under the body's ground position.
 */
export function idealFootPosition(leg, pose, out) {
  _local.set(leg.restOffset.x, 0, leg.restOffset.z);
  _local.applyQuaternion(pose.quaternion);
  out.set(pose.position.x + _local.x, 0, pose.position.z + _local.z);
  return out;
}
