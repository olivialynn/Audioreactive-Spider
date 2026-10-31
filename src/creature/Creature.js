/**
 * Creature — composition root for one creature. Wires together the four
 * independent subsystems and runs them in order each frame:
 *
 *   1. BodyController : where the body is + how it dances to the ControlBus
 *   2. GaitPlanner    : where each foot is planted + when it steps
 *   3. IKSolver       : bend each leg so its foot reaches its target
 *   4. CreatureBuilder: push solved joint positions into the meshes
 *
 * `rebuild(spec)` swaps in a brand-new spec at runtime (e.g. a different leg
 * count) by disposing the old meshes and re-deriving everything. That's what
 * makes the leg count a live slider.
 */
import * as THREE from 'three';
import { buildCreature } from './CreatureBuilder.js';
import { BodyController } from './BodyController.js';
import { GaitPlanner, idealFootPosition } from './GaitPlanner.js';
import { solveLeg } from './IKSolver.js';
import { legsOf } from './CreatureSpec.js';

const UP = new THREE.Vector3(0, 1, 0);
const _hipLocal = new THREE.Vector3();
const _hip = new THREE.Vector3();

export class Creature {
  constructor(scene, spec) {
    this.scene = scene;
    // body and gait are created once and REUSED across rebuilds so that UI
    // controls bound to them stay valid when the creature is rebuilt.
    this.body = new BodyController({ baseHeight: spec.body.height });
    this.gait = null;

    // Constant emissive glow (lit up by bloom).
    this.glow = 0;

    this._build(spec);
  }

  _build(spec) {
    this.spec = spec;
    this.legSpecs = legsOf(spec);

    this.render = buildCreature(spec);
    this.scene.add(this.render.group);

    if (this.gait) this.gait.rebuild(this.legSpecs);
    else this.gait = new GaitPlanner(this.legSpecs);

    // Per-leg persisted IK state: joint positions (hip..foot) and lengths.
    // Persisting joints across frames gives FABRIK the coherence it needs to
    // keep knees bent the same way; we seed a knees-up rest pose below.
    this.legIK = this.legSpecs.map((leg) => ({
      joints: Array.from({ length: leg.segments.length + 1 }, () => new THREE.Vector3()),
      lengths: leg.segments.slice(),
    }));

    this._seedPose();
  }

  /** Place feet at their ideal spots and seed a plausible knees-up leg pose. */
  _seedPose() {
    const pose = this.body.pose;
    this.gait.snapToIdeal(pose);

    for (let i = 0; i < this.legSpecs.length; i++) {
      const leg = this.legSpecs[i];
      hipWorld(leg, pose, _hip);
      const foot = this.gait.feet[i].planted;
      const ik = this.legIK[i];
      const n = ik.joints.length;
      // Straight hip->foot, then raise the middle joints so the knee points up.
      for (let j = 0; j < n; j++) {
        const t = j / (n - 1);
        ik.joints[j].lerpVectors(_hip, foot, t);
        ik.joints[j].y += Math.sin(t * Math.PI) * 0.6; // knees-up bias
      }
    }
  }

  /** Place the creature at a spot with a heading and arrangement mode, and
   *  re-seat its feet there (used when arranging a group). */
  placeAt(x, z, heading, arrangement) {
    this.body.arrangement = arrangement;
    this.body.position.set(x, this.body.baseHeight, z);
    this.body.heading = heading;
    this.body.quaternion.setFromAxisAngle(UP, heading);
    if (arrangement === 'circle') {
      this.body.home.set(x, 0, z);
      this.body.homeHeading = heading;
    }
    this.gait.snapToIdeal(this.body.pose);
    this._seedPose();
  }

  /** Swap in a new spec at runtime (e.g. changed leg count). Keeps body/gait
   *  objects (and thus their UI bindings) alive; only the meshes are rebuilt. */
  rebuild(spec) {
    this.render.dispose();
    this.body.baseHeight = spec.body.height;
    this._build(spec);
  }

  update(dt, bus) {
    // 1. Body moves + dances.
    this.body.update(dt, bus);
    const pose = this.body.pose;

    // Apply the body pose to the body group. (Legs are drawn in world space, so
    // they already follow the pose via hipWorld(); the body needs it set.)
    this.render.bodyGroup.position.copy(pose.position);
    this.render.bodyGroup.quaternion.copy(pose.quaternion);

    // Constant emissive glow across all materials.
    for (const m of this.render.materials) m.emissiveIntensity = this.glow;

    // 2. Feet decide where/when to step. Dancing in a ring uses an easier
    //    threshold so the small shuffle still lifts feet.
    const thr = (this.body.arrangement === 'circle' && this.gait.easySteps)
      ? this.gait.circleStepThreshold
      : this.gait.stepThreshold;
    this.gait.update(dt, pose, this.body.velDir, thr);

    // 3 + 4. Solve + render each leg.
    for (let i = 0; i < this.legSpecs.length; i++) {
      const leg = this.legSpecs[i];
      hipWorld(leg, pose, _hip);
      const ik = this.legIK[i];
      const footTarget = this.gait.feet[i].planted;
      solveLeg(ik.joints, ik.lengths, _hip, footTarget);
      this.render.updateLeg(i, ik.joints);
    }
  }
}

/** World-space hip position for a leg: body-local hip offset rotated by heading. */
function hipWorld(leg, pose, out) {
  _hipLocal.set(leg.hipOffset.x, leg.hipOffset.y, leg.hipOffset.z);
  _hipLocal.applyQuaternion(pose.quaternion);
  return out.copy(pose.position).add(_hipLocal);
}

export { idealFootPosition };
