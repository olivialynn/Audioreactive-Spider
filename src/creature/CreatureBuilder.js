/**
 * CreatureBuilder — turns a (data-only) CreatureSpec into THREE meshes.
 *
 * This is the ONLY file that touches the creature's geometry/materials. Keeping
 * it isolated is what makes the "nice shader effects" stretch goal a localized
 * change: swap the MeshStandardMaterials here for a custom ShaderMaterial and
 * nothing else in the system needs to know.
 *
 * It returns a handle with:
 *   - group:        a THREE.Group to add to the scene
 *   - legs:         per-leg render data (joint count, segment meshes)
 *   - updateLeg():  reposition a leg's segments from solved joint positions
 *   - dispose():    free GPU resources (used when rebuilding for a new spec)
 */
import * as THREE from 'three';
import { legsOf } from './CreatureSpec.js';

const UP = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();

export function buildCreature(spec) {
  const group = new THREE.Group();
  const disposables = [];

  // --- Body: a group of parts (cephalothorax + abdomen) so it can be one rigid
  // transform we move/rotate per frame. Each part is a scaled unit sphere. ---
  const bodyGroup = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({
    color: spec.body.color, roughness: 0.5, metalness: 0.1,
  });
  const sphereGeo = new THREE.SphereGeometry(1, 24, 16); // unit; scaled per part
  disposables.push(bodyMat, sphereGeo);
  for (const part of spec.body.segments) {
    const mesh = new THREE.Mesh(sphereGeo, bodyMat);
    mesh.position.set(part.offset.x, part.offset.y, part.offset.z);
    mesh.scale.set(part.radius * part.scale.x, part.radius * part.scale.y, part.radius * part.scale.z);
    mesh.castShadow = true;
    bodyGroup.add(mesh);
  }
  group.add(bodyGroup);

  // --- Legs ---
  // Each leg is drawn as one cylinder per segment plus a small joint ball. The
  // cylinders are rebuilt (repositioned/oriented) every frame from solved joints.
  const legGeo = new THREE.CylinderGeometry(0.045, 0.02, 1, 7); // unit height; we scale y
  const jointGeo = new THREE.SphereGeometry(0.05, 8, 6);
  disposables.push(legGeo, jointGeo);

  const legs = legsOf(spec).map((legSpec) => {
    const mat = new THREE.MeshStandardMaterial({
      color: legSpec.color, roughness: 0.45, metalness: 0.15,
    });
    disposables.push(mat);

    const segmentCount = legSpec.segments.length;
    const segmentMeshes = [];
    const jointMeshes = [];
    for (let i = 0; i < segmentCount; i++) {
      const seg = new THREE.Mesh(legGeo, mat);
      seg.castShadow = true;
      group.add(seg);
      segmentMeshes.push(seg);

      const joint = new THREE.Mesh(jointGeo, mat);
      joint.castShadow = true;
      group.add(joint);
      jointMeshes.push(joint);
    }

    return { spec: legSpec, segmentMeshes, jointMeshes };
  });

  /**
   * Position one leg's segment cylinders and joint balls from solved joint
   * positions (an array of world-space THREE.Vector3, hip -> foot).
   */
  function updateLeg(legIndex, joints) {
    const leg = legs[legIndex];
    for (let i = 0; i < leg.segmentMeshes.length; i++) {
      orientSegment(leg.segmentMeshes[i], joints[i], joints[i + 1]);
      // Draw a joint ball at the far end of each segment (not the hip).
      leg.jointMeshes[i].position.copy(joints[i + 1]);
    }
  }

  function dispose() {
    group.removeFromParent();
    for (const d of disposables) d.dispose();
  }

  return { group, bodyGroup, legs, updateLeg, dispose };
}

/** Stretch/orient a unit-height cylinder so it spans from a to b. */
function orientSegment(mesh, a, b) {
  _dir.subVectors(b, a);
  const len = _dir.length();
  mesh.position.copy(a).addScaledVector(_dir, 0.5);
  mesh.scale.set(1, len, 1);
  if (len > 1e-5) {
    _dir.multiplyScalar(1 / len);
    mesh.quaternion.setFromUnitVectors(UP, _dir);
  }
}
