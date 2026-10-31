/**
 * IKSolver — FABRIK (Forward And Backward Reaching Inverse Kinematics).
 *
 * FABRIK is the general-purpose choice here because it handles any chain length
 * (so it works regardless of how many segments a leg has) and is simple and
 * stable. We solve in 3D and rely on frame-to-frame coherence plus a knees-up
 * rest pose (see Creature.js) to keep the bend looking natural.
 *
 * `joints`  : array of THREE.Vector3, mutated in place. joints[0] is the hip,
 *             joints[n-1] is the foot. Persisted across frames (coherence).
 * `lengths` : array of segment lengths, length === joints.length - 1.
 * `root`    : THREE.Vector3, the fixed hip position this frame.
 * `target`  : THREE.Vector3, where we want the foot to be this frame.
 */
import * as THREE from 'three';

const _dir = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const _n = new THREE.Vector3();
const _m = new THREE.Vector3();

/**
 * solveLeg — the entry point Creature uses. Picks the right method:
 *   - exactly 2 segments -> analytic 2-bone (clean, controllable, in-plane)
 *   - anything else       -> FABRIK (general fallback, keeps variable legs working)
 */
export function solveLeg(joints, lengths, root, target, pole = UP) {
  if (lengths.length === 2) solveTwoBone(joints, lengths, root, target, pole);
  else solveFABRIK(joints, lengths, root, target);
}

/**
 * Analytic two-bone IK (law of cosines). Given a hip (root), a foot (target),
 * and segment lengths [femur, tibia], it places the knee.
 *
 * The `pole` picks which way the knee bends: we project it perpendicular to the
 * hip->foot axis, so with pole = up the knee always lifts UPWARD, in the
 * vertical plane containing hip and foot. Two consequences we want:
 *   - the bend is deterministic (no flipping), and the knee rides high → the
 *     "upside-down checkmark" silhouette;
 *   - everything stays in one vertical plane, so from directly above the leg
 *     projects to a straight line.
 */
export function solveTwoBone(joints, lengths, root, target, pole = UP) {
  const a = lengths[0]; // femur
  const b = lengths[1]; // tibia

  _n.subVectors(target, root);
  let d = _n.length();
  if (d < 1e-6) { _n.set(1, 0, 0); d = 1e-6; } else { _n.multiplyScalar(1 / d); }
  // Clamp reach so the triangle is always solvable.
  d = Math.min(Math.max(d, Math.abs(a - b) + 1e-4), a + b - 1e-4);

  // Angle at the hip between the hip->foot axis and the femur.
  const cosA = Math.min(1, Math.max(-1, (a * a + d * d - b * b) / (2 * a * d)));
  const sinA = Math.sqrt(1 - cosA * cosA);

  // Bend direction: the pole, with its along-axis component removed.
  _m.copy(pole).addScaledVector(_n, -pole.dot(_n));
  if (_m.lengthSq() < 1e-8) {
    // pole parallel to the axis (leg pointing straight up/down): pick any up-ish
    _m.set(0, 1, 0).addScaledVector(_n, -_n.y);
    if (_m.lengthSq() < 1e-8) _m.set(1, 0, 0);
  }
  _m.normalize();

  joints[0].copy(root);                                          // hip
  joints[1].copy(root).addScaledVector(_n, a * cosA).addScaledVector(_m, a * sinA); // knee
  joints[2].copy(root).addScaledVector(_n, d);                   // foot
}

export function solveFABRIK(joints, lengths, root, target, iterations = 12, tolerance = 0.001) {
  const n = joints.length;

  const totalLength = lengths.reduce((a, b) => a + b, 0);
  const rootToTarget = target.distanceTo(root);

  // Target out of reach: straighten the whole chain toward it.
  if (rootToTarget >= totalLength) {
    joints[0].copy(root);
    _dir.subVectors(target, root).normalize();
    for (let i = 1; i < n; i++) {
      joints[i].copy(joints[i - 1]).addScaledVector(_dir, lengths[i - 1]);
    }
    return;
  }

  for (let it = 0; it < iterations; it++) {
    // Backward pass: pin the foot to the target, walk toward the hip.
    joints[n - 1].copy(target);
    for (let i = n - 2; i >= 0; i--) {
      _dir.subVectors(joints[i], joints[i + 1]).normalize();
      joints[i].copy(joints[i + 1]).addScaledVector(_dir, lengths[i]);
    }

    // Forward pass: pin the hip back to the root, walk toward the foot.
    joints[0].copy(root);
    for (let i = 1; i < n; i++) {
      _dir.subVectors(joints[i], joints[i - 1]).normalize();
      joints[i].copy(joints[i - 1]).addScaledVector(_dir, lengths[i - 1]);
    }

    if (joints[n - 1].distanceTo(target) < tolerance) break;
  }
}
