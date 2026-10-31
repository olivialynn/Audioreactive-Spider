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
import { OUTLINE_LAYER } from '../render/OutlinePass.js';

const UP = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
// scratch vectors for placing instanced hairs each frame
const _d = new THREE.Vector3();
const _u = new THREE.Vector3();
const _v = new THREE.Vector3();
const _hairDir = new THREE.Vector3();
const _hairPos = new THREE.Vector3();
const _hairQ = new THREE.Quaternion();
const _hairScale = new THREE.Vector3();
const _hairM = new THREE.Matrix4();

export function buildCreature(spec) {
  const group = new THREE.Group();
  const disposables = [];

  const legSpecs = legsOf(spec);
  const legColor = legSpecs.length ? legSpecs[0].color : 0xc7b3ff;
  const toon = spec.style === 'toon';

  // A shared stepped gradient for the toon look (hard light bands).
  let gradient = null;
  if (toon) { gradient = makeToonGradient(3); disposables.push(gradient); }

  // Materials come in two styles. Both expose .color / .emissive / emissiveIntensity
  // so color controls and the beat-glow pulse work identically for either.
  //   physical: glossy clearcoat chitin with a touch of iridescence (needs the env map)
  //   toon:     flat cel bands via the gradient ramp
  // emissive is set to the base color; Creature pulses emissiveIntensity on beats.
  const bodyMat = toon
    ? new THREE.MeshToonMaterial({ color: spec.body.color, emissive: spec.body.color, emissiveIntensity: 0, gradientMap: gradient, flatShading: true })
    : new THREE.MeshPhysicalMaterial({ color: spec.body.color, roughness: 0.45, metalness: 0.0, clearcoat: 0.8, clearcoatRoughness: 0.35, iridescence: 0.35, iridescenceIOR: 1.3, emissive: spec.body.color, emissiveIntensity: 0, flatShading: true });

  // One shared leg material (all legs the same color for now) — the "accent".
  const legMat = toon
    ? new THREE.MeshToonMaterial({ color: legColor, emissive: legColor, emissiveIntensity: 0, gradientMap: gradient })
    : new THREE.MeshPhysicalMaterial({ color: legColor, roughness: 0.4, metalness: 0.1, clearcoat: 0.6, clearcoatRoughness: 0.4, iridescence: 0.45, iridescenceIOR: 1.3, emissive: legColor, emissiveIntensity: 0 });

  // Eyes share the accent color; wet-looking in physical, flat in toon.
  const eyeMat = toon
    ? new THREE.MeshToonMaterial({ color: legColor, emissive: legColor, emissiveIntensity: 0, gradientMap: gradient })
    : new THREE.MeshPhysicalMaterial({ color: legColor, roughness: 0.08, metalness: 0.0, clearcoat: 1.0, clearcoatRoughness: 0.06, emissive: legColor, emissiveIntensity: 0 });

  // The abdomen gets its own material (same look as the body) so it can carry the
  // procedural markings without touching the cephalothorax.
  const abdomenMat = toon
    ? new THREE.MeshToonMaterial({ color: spec.body.color, emissive: spec.body.color, emissiveIntensity: 0, gradientMap: gradient, flatShading: true })
    : new THREE.MeshPhysicalMaterial({ color: spec.body.color, roughness: 0.45, metalness: 0.0, clearcoat: 0.8, clearcoatRoughness: 0.35, iridescence: 0.35, iridescenceIOR: 1.3, emissive: spec.body.color, emissiveIntensity: 0, flatShading: true });

  disposables.push(bodyMat, legMat, eyeMat, abdomenMat);

  // Marking uniforms — shared references so the panel can mutate them live.
  const mk = spec.marking ?? { type: 0, strength: 0, scale: 1 };
  const markUniforms = {
    uMarkType: { value: mk.type },
    uMarkStrength: { value: mk.strength },
    uMarkScale: { value: mk.scale },
    uMarkColor: { value: new THREE.Color(legColor) }, // accent color
  };
  applyMarkings(abdomenMat, markUniforms);

  // Micro-bump surface detail on the body chitin: a shared procedural (tileable)
  // noise normal map. The texture is a module singleton (never disposed).
  const bump = spec.bump ?? 0.6;
  for (const m of [bodyMat, abdomenMat]) {
    m.normalMap = bumpNormalMap();
    m.normalScale = new THREE.Vector2(bump, bump);
  }

  // --- Body: a group of parts (cephalothorax + abdomen) so it can be one rigid
  // transform we move/rotate per frame. Each part is a low-poly icosahedron,
  // tapered into an egg/teardrop, flat-shaded for faceting. ---
  const bodyGroup = new THREE.Group();
  for (const part of spec.body.segments) {
    const geo = new THREE.IcosahedronGeometry(1, part.detail ?? 1);
    if (part.taper) applyTaper(geo, part.taper);
    geo.computeVertexNormals();
    disposables.push(geo);

    const mesh = new THREE.Mesh(geo, part.markable ? abdomenMat : bodyMat);
    mesh.position.set(part.offset.x, part.offset.y, part.offset.z);
    mesh.scale.set(part.radius * part.scale.x, part.radius * part.scale.y, part.radius * part.scale.z);
    mesh.castShadow = true;
    bodyGroup.add(mesh);
  }

  // Eyes (features) — parented to the body group so they ride along with it.
  const eyeGeo = new THREE.SphereGeometry(1, 16, 12); // unit; scaled per eye
  disposables.push(eyeGeo);
  for (const f of spec.features ?? []) {
    if (f.type !== 'eye') continue;
    const eye = new THREE.Mesh(eyeGeo, eyeMat);
    eye.position.set(f.offset.x, f.offset.y, f.offset.z);
    eye.scale.setScalar(f.radius);
    eye.castShadow = true;
    bodyGroup.add(eye);
  }
  group.add(bodyGroup);

  // --- Legs ---
  // Each leg is drawn as one cylinder per segment plus a small joint ball. The
  // cylinders are rebuilt (repositioned/oriented) every frame from solved joints.
  const legGeo = new THREE.CylinderGeometry(0.045, 0.02, 1, 10); // unit height; we scale y
  const jointGeo = new THREE.SphereGeometry(0.05, 12, 10);
  disposables.push(legGeo, jointGeo);

  // Hair/bristle config. Hairs are rendered as one shared InstancedMesh of tiny
  // cones; here we just lay out each hair's parameters (where on the segment, which
  // way it sticks out, how long). They're repositioned each frame in updateLeg.
  const hairCfg = spec.hairs ?? { enabled: false };
  let hairCount = 0;

  const legs = legSpecs.map((legSpec) => {
    const segmentCount = legSpec.segments.length;
    const segmentMeshes = [];
    const jointMeshes = [];
    const hairSegs = []; // per-segment arrays of hair descriptors
    for (let i = 0; i < segmentCount; i++) {
      const seg = new THREE.Mesh(legGeo, legMat);
      seg.castShadow = true;
      group.add(seg);
      segmentMeshes.push(seg);

      const joint = new THREE.Mesh(jointGeo, legMat);
      joint.castShadow = true;
      group.add(joint);
      jointMeshes.push(joint);

      const arr = [];
      if (hairCfg.enabled) {
        const per = Math.max(3, Math.min(16, Math.round(legSpec.segments[i] * 9 * (hairCfg.density ?? 1))));
        for (let k = 0; k < per; k++) {
          arr.push({
            index: hairCount++,
            t: 0.08 + 0.84 * Math.random(),     // position along the segment
            angle: Math.random() * Math.PI * 2, // around the segment axis
            tilt: -0.1 + Math.random() * 0.5,   // lean along the segment (toward the foot)
            length: (0.05 + Math.random() * 0.07) * (hairCfg.length ?? 1),
            thickness: 0.006 + Math.random() * 0.006,
          });
        }
      }
      hairSegs.push(arr);
    }

    return { spec: legSpec, segmentMeshes, jointMeshes, hairSegs };
  });

  // One InstancedMesh holds every hair across all legs (cheap even in the hundreds).
  let hairMesh = null;
  if (hairCount > 0) {
    const coneGeo = new THREE.ConeGeometry(1, 1, 5); // unit; scaled per instance
    disposables.push(coneGeo);
    hairMesh = new THREE.InstancedMesh(coneGeo, legMat, hairCount);
    hairMesh.castShadow = true;
    hairMesh.frustumCulled = false; // instance matrices change every frame
    group.add(hairMesh);
  }

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

    if (hairMesh) {
    for (let i = 0; i < leg.hairSegs.length; i++) {
      const arr = leg.hairSegs[i];
      if (!arr.length) continue;
      const a = joints[i], b = joints[i + 1];
      _d.subVectors(b, a);
      const segLen = _d.length();
      if (segLen < 1e-5) continue;
      _d.multiplyScalar(1 / segLen);
      // Orthonormal basis perpendicular to the segment, so hairs can fan around it.
      _u.set(0, 1, 0);
      if (Math.abs(_d.y) > 0.9) _u.set(1, 0, 0);
      _v.crossVectors(_d, _u).normalize();
      _u.crossVectors(_v, _d).normalize();
      for (const h of arr) {
        _hairDir.copy(_u).multiplyScalar(Math.cos(h.angle))
          .addScaledVector(_v, Math.sin(h.angle))
          .addScaledVector(_d, h.tilt)
          .normalize();
        _hairPos.copy(a).addScaledVector(_d, h.t * segLen).addScaledVector(_hairDir, h.length * 0.5);
        _hairQ.setFromUnitVectors(UP, _hairDir);
        _hairScale.set(h.thickness, h.length, h.thickness);
        _hairM.compose(_hairPos, _hairQ, _hairScale);
        hairMesh.setMatrixAt(h.index, _hairM);
      }
    }
    hairMesh.instanceMatrix.needsUpdate = true;
    }
  }

  function dispose() {
    group.removeFromParent();
    for (const d of disposables) d.dispose();
  }

  // Put every creature mesh on the outline layer so the OutlinePass can render
  // the creature alone (and thus outline only its silhouette, never the ground).
  group.traverse((o) => { if (o.isMesh) o.layers.enable(OUTLINE_LAYER); });
  // ...but keep hairs out of the silhouette buffer so they don't fuzz the outline.
  if (hairMesh) hairMesh.layers.disable(OUTLINE_LAYER);

  return {
    group, bodyGroup, legs, updateLeg, dispose,
    bodyMat, abdomenMat, legMat, eyeMat, markUniforms,
    materials: [bodyMat, abdomenMat, legMat, eyeMat], // for color + glow control
  };
}

/**
 * Inject procedural abdomen markings into a body material: it blends the accent
 * color into the surface where the marking mask is set. Works for physical and
 * toon materials (both include the <color_fragment> chunk). The uniforms are
 * passed in by reference so they can be tweaked live from the panel.
 */
function applyMarkings(material, markUniforms) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, markUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vMark;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMark = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */`#include <common>
        varying vec3 vMark;
        uniform int uMarkType;
        uniform float uMarkStrength;
        uniform float uMarkScale;
        uniform vec3 uMarkColor;
        float markMask(vec3 p) {
          float top = smoothstep(0.0, 0.5, p.y); // dorsal (upper) surface
          float m = 0.0;
          // uMarkScale reads intuitively: bigger value = bigger marking.
          if (uMarkType == 1) {            // stripes across the back
            float s = abs(sin(p.x * (6.0 / uMarkScale)));
            m = smoothstep(0.55, 0.78, s) * top;
          } else if (uMarkType == 2) {     // hourglass / widow mark
            vec2 h = vec2(p.x, p.z) / uMarkScale;
            float w = mix(0.1, 0.5, abs(h.x) * 1.3);
            m = (1.0 - smoothstep(w, w + 0.06, abs(h.y))) * top * smoothstep(0.95, 0.55, abs(h.x));
          } else if (uMarkType == 3) {     // dots
            vec2 g = fract(vec2(p.x, p.z) * (3.0 / uMarkScale)) - 0.5;
            m = (1.0 - smoothstep(0.14, 0.2, length(g))) * top;
          } else if (uMarkType == 4) {     // skull: round cranium, square jaw
            vec2 q = vec2(p.z, p.x) / uMarkScale;
            float cran = 1.0 - smoothstep(0.5, 0.58, length((q - vec2(0.0, 0.28)) * vec2(1.05, 0.95)));
            vec2 jc = abs(q - vec2(0.0, -0.28));
            float jaw = (1.0 - smoothstep(0.2, 0.26, jc.x)) * (1.0 - smoothstep(0.22, 0.28, jc.y));
            float sk = max(cran, jaw);
            float eyeL = 1.0 - smoothstep(0.12, 0.17, length(q - vec2(-0.2, 0.3)));
            float eyeR = 1.0 - smoothstep(0.12, 0.17, length(q - vec2(0.2, 0.3)));
            float nose = 1.0 - smoothstep(0.06, 0.1, length((q - vec2(0.0, 0.1)) * vec2(1.0, 0.7)));
            m = sk * (1.0 - eyeL) * (1.0 - eyeR) * (1.0 - nose) * top;
          } else if (uMarkType == 5) {     // cross
            vec2 q = vec2(p.z, p.x) / uMarkScale;
            float barV = (1.0 - smoothstep(0.1, 0.16, abs(q.x))) * (1.0 - smoothstep(0.72, 0.82, abs(q.y)));
            float barH = (1.0 - smoothstep(0.1, 0.16, abs(q.y - 0.15))) * (1.0 - smoothstep(0.5, 0.6, abs(q.x)));
            m = max(barV, barH) * top;
          } else if (uMarkType == 6) {     // diamond
            vec2 q = vec2(p.z, p.x) / uMarkScale;
            m = (1.0 - smoothstep(0.75, 0.85, abs(q.x) + abs(q.y))) * top;
          }
          return clamp(m, 0.0, 1.0);
        }`)
      .replace('#include <color_fragment>', /* glsl */`#include <color_fragment>
        diffuseColor.rgb = mix(diffuseColor.rgb, uMarkColor, markMask(vMark) * uMarkStrength);`);
  };
}

/**
 * Procedural, seamlessly-tileable noise normal map for micro-bump chitin detail.
 * Built once and shared across all creatures (it's view-independent surface noise).
 */
let _bumpMap = null;
function bumpNormalMap() {
  if (_bumpMap) return _bumpMap;

  const px = 256;
  const cells = 8, octaves = 4, relief = 2.0;

  const hash = (ix, iy, period) => {
    ix = ((ix % period) + period) % period;
    iy = ((iy % period) + period) % period;
    let n = (ix * 374761393 + iy * 668265263) | 0;
    n = (n ^ (n >> 13)) * 1274126177;
    n = n ^ (n >> 16);
    return (n >>> 0) / 4294967295;
  };
  const smooth = (t) => t * t * (3 - 2 * t);
  const vnoise = (x, y, period) => {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = smooth(x - x0), fy = smooth(y - y0);
    const v00 = hash(x0, y0, period), v10 = hash(x0 + 1, y0, period);
    const v01 = hash(x0, y0 + 1, period), v11 = hash(x0 + 1, y0 + 1, period);
    return (v00 + (v10 - v00) * fx) + ((v01 + (v11 - v01) * fx) - (v00 + (v10 - v00) * fx)) * fy;
  };
  const height = (u, v) => {
    let sum = 0, amp = 0.5, freq = cells, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * vnoise(u * freq, v * freq, freq);
      norm += amp; amp *= 0.5; freq *= 2;
    }
    return sum / norm;
  };

  const data = new Uint8Array(px * px * 4);
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      // Finite differences with wrap-around keep the normal map seamless.
      const hL = height(((x - 1 + px) % px) / px, y / px);
      const hR = height(((x + 1) % px) / px, y / px);
      const hD = height(x / px, ((y - 1 + px) % px) / px);
      const hU = height(x / px, ((y + 1) % px) / px);
      const nx = -(hR - hL) * relief, ny = -(hU - hD) * relief, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      const i = (y * px + x) * 4;
      data[i] = Math.round((nx / len * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round((ny / len * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round((nz / len * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  }

  _bumpMap = new THREE.DataTexture(data, px, px, THREE.RGBAFormat);
  _bumpMap.wrapS = _bumpMap.wrapT = THREE.RepeatWrapping;
  _bumpMap.repeat.set(3, 3);
  _bumpMap.needsUpdate = true;
  return _bumpMap;
}

/** A tiny stepped gradient texture for MeshToonMaterial (hard cel bands). */
function makeToonGradient(steps = 3) {
  const data = new Uint8Array(steps);
  for (let i = 0; i < steps; i++) data[i] = Math.round((i / (steps - 1)) * 255);
  const tex = new THREE.DataTexture(data, steps, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Narrow a unit-radius geometry's cross-section along its local x axis: vertices
 * near +x (front) are scaled by `front`, near -x (back) by `back`, lerped between.
 * Turns a ball into an egg/teardrop. Mutates positions in place.
 */
function applyTaper(geo, { front = 1, back = 1 }) {
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const t = (pos.getX(i) + 1) / 2; // 0 at back (-x), 1 at front (+x)
    const f = back + (front - back) * t;
    pos.setY(i, pos.getY(i) * f);
    pos.setZ(i, pos.getZ(i) * f);
  }
  pos.needsUpdate = true;
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
