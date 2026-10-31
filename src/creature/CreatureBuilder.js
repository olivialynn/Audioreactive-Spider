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
import { Brush, Evaluator, SUBTRACTION } from 'three-bvh-csg';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
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
// scratch for orienting layered eyes (building a local gaze/corner basis)
const _eyeUp = new THREE.Vector3(0, 1, 0);
const _ex = new THREE.Vector3();
const _ey = new THREE.Vector3();
const _ez = new THREE.Vector3();
const _eMat = new THREE.Matrix4();
// scratch for aiming knee eyes along the knee's outward bend each frame
const _kneeA = new THREE.Vector3();
const _kneeB = new THREE.Vector3();
const _kneeGaze = new THREE.Vector3();
const _kneeCorner = new THREE.Vector3();
// scratch for laying out flat feathers as a wing sheet along each bone each frame
const _featDir = new THREE.Vector3();
const _featX = new THREE.Vector3();
const _featS = new THREE.Vector3(); // spanwise (trailing-edge) direction, in the wing plane
const _featN = new THREE.Vector3(); // wing-plane normal (broad vane faces along it)

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

  // Layered eyes (the angel's giant eye, and later the smaller ones) get a light
  // sclera and a dark pupil; the iris reuses the accent eyeMat. The sclera glows
  // on the beat (updateEyes). Simple spider eyes stay single accent balls.
  const scleraMat = toon
    ? new THREE.MeshToonMaterial({ color: 0xf4ecd8, emissive: 0xfff2d0, emissiveIntensity: 0, gradientMap: gradient })
    : new THREE.MeshPhysicalMaterial({ color: 0xf4ecd8, roughness: 0.12, metalness: 0.0, clearcoat: 1.0, clearcoatRoughness: 0.08, emissive: 0xfff2d0, emissiveIntensity: 0 });
  const pupilMat = toon
    ? new THREE.MeshToonMaterial({ color: 0x0a0a12, gradientMap: gradient })
    : new THREE.MeshPhysicalMaterial({ color: 0x050509, roughness: 0.85, metalness: 0.0 }); // matte: no clearcoat blowout

  disposables.push(bodyMat, legMat, eyeMat, abdomenMat, scleraMat, pupilMat);

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
  const reactiveEyes = []; // pupils we dilate to the audio each frame

  // Build one layered eye (spherical eyeball + iris + pupil, optional almond lids)
  // at the origin, gazing along local +Y. The caller positions/orients the group.
  // Used for both the body's giant eye and the per-knee eyes. Returns the pupil so
  // the caller can register it as audio-reactive.
  function buildEye(cfg) {
    const R = cfg.radius;
    const g = new THREE.Group();

    const sclera = new THREE.Mesh(eyeGeo, scleraMat);
    sclera.scale.setScalar(R);
    sclera.castShadow = true;
    g.add(sclera);

    // Iris + pupil: shallow caps hugging the sphere's gaze pole — curved, flush, and
    // circular from the front. cfg.iris / cfg.pupil are the cap half-angles (radians).
    const irisGeo = new THREE.SphereGeometry(1, 32, 16, 0, Math.PI * 2, 0, cfg.iris ?? 0.55);
    disposables.push(irisGeo);
    const iris = new THREE.Mesh(irisGeo, eyeMat);
    iris.scale.setScalar(R * 1.004);
    g.add(iris);

    const pupilGeo = new THREE.SphereGeometry(1, 32, 16, 0, Math.PI * 2, 0, cfg.pupil ?? 0.3);
    disposables.push(pupilGeo);
    const pupil = new THREE.Mesh(pupilGeo, pupilMat);
    const pupilBase = new THREE.Vector3(R * 1.008, R * 1.008, R * 1.008);
    pupil.scale.copy(pupilBase);
    g.add(pupil);

    // Almond lids: two crescent shells on a sphere slightly larger than the eyeball,
    // on the ±side (local z). Each lid's inner edge runs near the gaze pole at the
    // sides and sweeps out to the rim at the fore/aft corners, so the two lids taper
    // to points where they meet (the tear ducts) — carving a curved almond opening.
    if (cfg.shape === 'almond' && cfg.lids) {
      const Rs = R * 1.02;                          // lids hug just above the sclera
      const thOut = cfg.lidOuter ?? 1.0;
      const B = R * Math.sin(cfg.lidInner ?? 0.3);  // opening half-width at the center
      const A = R * Math.sin(thOut);                // opening half-length (corner reach)
      const lidMat = bodyMat.clone();               // double-sided so the shell reads from any angle
      lidMat.side = THREE.DoubleSide;
      disposables.push(lidMat);
      for (const sign of [1, -1]) {                 // +z-side lid, then -z-side lid
        const lidGeo = makeLidGeometry(Rs, A, B, sign);
        disposables.push(lidGeo);
        const lid = new THREE.Mesh(lidGeo, lidMat);
        lid.castShadow = true;
        g.add(lid);
      }
      // Socket: a skin shell over everything below the opening, so the eyeball isn't
      // a bare white ball. It's the sphere cap from the opening's reach (thOut) down
      // to the far pole; the lids cover the upper flanks between it and the opening.
      const socketGeo = new THREE.SphereGeometry(Rs, 24, 16, 0, Math.PI * 2, thOut, Math.PI - thOut);
      disposables.push(socketGeo);
      const socket = new THREE.Mesh(socketGeo, lidMat);
      socket.castShadow = true;
      g.add(socket);
    }
    return { group: g, pupil, pupilBase };
  }

  for (const f of spec.features ?? []) {
    if (f.type !== 'eye') continue;

    // Simple eye: a single accent ball (spider's little cluster).
    if (f.iris === undefined) {
      const eye = new THREE.Mesh(eyeGeo, eyeMat);
      eye.position.set(f.offset.x, f.offset.y, f.offset.z);
      eye.scale.setScalar(f.radius);
      eye.castShadow = true;
      bodyGroup.add(eye);
      continue;
    }

    // Layered eye parented to the body, placed + aimed by its static offset/look.
    const e = buildEye(f);
    e.group.position.set(f.offset.x, f.offset.y, f.offset.z);
    orientEye(e.group, f.look, f.cornerAxis);
    bodyGroup.add(e.group);
    if (f.reactive) reactiveEyes.push({ pupil: e.pupil, pupilBase: e.pupilBase });
  }

  // Ring: the ophanim's wheel — a slim hollow-cylinder band (flat top/bottom, inner
  // and outer walls) around the torso, studded with eyes on its rim. It spins about
  // its OWN axis; the rim eyes make that rotation read. ringTilt leans it slightly;
  // ringSpin (its child) is what rotates. Accent-colored (reuses legMat).
  let ringSpin = null;
  if (spec.ring) {
    const rg = spec.ring;
    legMat.side = THREE.DoubleSide; // the pierced band reads from inside and out
    const ringTilt = new THREE.Group();
    ringTilt.position.set(rg.center.x, rg.center.y, rg.center.z);
    ringTilt.rotation.x = rg.tilt ?? 0;
    ringSpin = new THREE.Group(); // rotates about the band's own (local Y) axis
    ringTilt.add(ringSpin);

    const h = rg.height, ri = rg.inner, ro = rg.outer, midR = (ri + ro) / 2;

    // Watertight band (hollow cylinder, flat top/bottom) as a solid for the boolean.
    const bandGeo = new THREE.LatheGeometry([
      new THREE.Vector2(ri, -h / 2), new THREE.Vector2(ro, -h / 2),
      new THREE.Vector2(ro, h / 2), new THREE.Vector2(ri, h / 2),
      new THREE.Vector2(ri, -h / 2),
    ], 72);
    bandGeo.computeVertexNormals();

    const hc = rg.holes;
    if (hc) {
      // Build one vesica prism, aimed radially, cloned around the rim; merge them and
      // subtract in one boolean to punch see-through almond holes through the wall.
      const depth = (ro - ri) + 0.08; // through both walls, with margin
      const cutterGeo = new THREE.ExtrudeGeometry(vesicaShape(hc.len / 2, hc.ht / 2),
        { depth, bevelEnabled: false, curveSegments: 24 });
      cutterGeo.translate(0, 0, -depth / 2); // centered across the wall
      const cutters = [];
      for (let i = 0; i < hc.count; i++) {
        const th = (i / hc.count) * Math.PI * 2;
        const m = ringSlotBasis(th).setPosition(midR * Math.cos(th), 0, midR * Math.sin(th));
        cutters.push(cutterGeo.clone().applyMatrix4(m));
      }
      const cutGeo = mergeGeometries(cutters);
      cutters.forEach((g) => g.dispose());
      cutterGeo.dispose();

      const result = new Evaluator().evaluate(new Brush(bandGeo, legMat), new Brush(cutGeo), SUBTRACTION);
      result.castShadow = true;
      result.receiveShadow = true;
      ringSpin.add(result);
      disposables.push(bandGeo, cutGeo, result.geometry);

      // A floating accent "iris" disc centered in each hole.
      if (hc.iris) {
        const irisGeo = new THREE.CircleGeometry(hc.iris, 24);
        const irisMat = eyeMat.clone(); // accent, double-sided so it shows as it spins
        irisMat.side = THREE.DoubleSide;
        disposables.push(irisGeo, irisMat);
        for (let i = 0; i < hc.count; i++) {
          const th = (i / hc.count) * Math.PI * 2;
          const disc = new THREE.Mesh(irisGeo, irisMat);
          disc.position.set(midR * Math.cos(th), 0, midR * Math.sin(th));
          disc.quaternion.setFromRotationMatrix(ringSlotBasis(th));
          ringSpin.add(disc);
        }
      }
    } else {
      const band = new THREE.Mesh(bandGeo, legMat);
      band.castShadow = true;
      ringSpin.add(band);
      disposables.push(bandGeo);
    }
    bodyGroup.add(ringTilt);
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
  // Feathers are the angel's "wing" plumage — flat blades quilled along the legs,
  // same instancing idea as hairs but bigger, flat, and swept toward the foot.
  const featherCfg = spec.feathers ?? { enabled: false };
  let featherCount = 0;

  const legs = legSpecs.map((legSpec) => {
    const segmentCount = legSpec.segments.length;
    const segmentMeshes = [];
    const jointMeshes = [];
    const hairSegs = []; // per-segment arrays of hair descriptors
    const featherSegs = []; // per-segment arrays of feather descriptors
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

      // Lay feathers out like a bird's wing (anatomy, not a radial brush): flight
      // feathers (remiges) attach along the bone in ONE plane, all swept toward the
      // wingtip, graded longer distally (tertials/secondaries near the body -> long
      // primaries at the tip). A row of shorter coverts shingles their bases.
      const farr = [];
      if (featherCfg.enabled) {
        const fl = featherCfg.length ?? 1;
        const per = Math.max(5, Math.min(26, Math.round(legSpec.segments[i] * 9 * (featherCfg.density ?? 1))));
        for (let k = 0; k < per; k++) {
          const a = per > 1 ? k / (per - 1) : 0.5;  // along this segment, base -> tip
          const gk = (i + a) / segmentCount;         // 0 at the body -> 1 at the wingtip
          const len = (0.45 + 1.05 * gk) * 0.85 * fl; // graded: longer toward the tip
          const t = 0.05 + 0.9 * a;                   // attach point along the bone
          // Remige (flight feather): the long base layer.
          farr.push({
            index: featherCount++, t,
            sweep: 0.3 + 2.0 * gk + (Math.random() - 0.5) * 0.25, // spanwise near body -> distal at tip
            length: len,
            width: 0.18 + Math.random() * 0.05,      // narrow vane (fraction of length)
            lift: (Math.random() - 0.5) * 0.1,       // tiny out-of-plane scatter
          });
          // Greater coverts: shingle the remige bases, sitting above them.
          farr.push({
            index: featherCount++, t,
            sweep: 0.55 + 1.5 * gk,
            length: len * 0.45,
            width: 0.24 + Math.random() * 0.05,
            lift: 0.2,
          });
          // Lesser coverts: a smaller, more-forward row layered over the greater ones.
          if (k % 2 === 0) {
            farr.push({
              index: featherCount++, t,
              sweep: 0.85 + 1.1 * gk,
              length: len * 0.26,
              width: 0.3 + Math.random() * 0.06,
              lift: 0.36,
            });
          }
        }
      }
      featherSegs.push(farr);
    }

    return { spec: legSpec, segmentMeshes, jointMeshes, hairSegs, featherSegs };
  });

  // Knee eyes: a small eye riding each leg's knee (joints[1]). They move with the
  // solved joint, so they live in world space (added to `group`) and get placed +
  // aimed every frame in updateLeg. Round, lidless — the "covered in eyes" look.
  if (spec.kneeEyes) {
    const ke = spec.kneeEyes;
    for (const leg of legs) {
      const e = buildEye(ke); // ke carries radius/iris/pupil + optional shape/lids
      group.add(e.group);
      leg.kneeEye = e;
      if (ke.reactive) reactiveEyes.push({ pupil: e.pupil, pupilBase: e.pupilBase });
    }
  }

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

  // One InstancedMesh holds every feather. Double-sided so the flat vanes read from
  // both faces; accent-colored like the legs (the plumage of the "wing").
  let featherMesh = null;
  if (featherCount > 0) {
    const featherGeo = featherGeometry();
    const featherMat = legMat.clone();
    featherMat.side = THREE.DoubleSide;
    disposables.push(featherGeo, featherMat);
    featherMesh = new THREE.InstancedMesh(featherGeo, featherMat, featherCount);
    featherMesh.castShadow = true;
    featherMesh.frustumCulled = false;
    group.add(featherMesh);
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

    // Knee eye: sit on the knee (joints[1]) and gaze along the knee's outward bend
    // (the convex side of the hip->knee->foot angle). The other in-plane bisector
    // (femur + tibia dir) is perpendicular to the gaze, so it serves as the almond's
    // corner axis — the lids' points run along the limb.
    if (leg.kneeEye) {
      const hip = joints[0], knee = joints[1], foot = joints[joints.length - 1];
      leg.kneeEye.group.position.copy(knee);
      _kneeA.subVectors(knee, hip).normalize();
      _kneeB.subVectors(foot, knee).normalize();
      _kneeGaze.subVectors(_kneeA, _kneeB);
      if (_kneeGaze.lengthSq() < 1e-6) _kneeGaze.set(0, 1, 0);
      _kneeCorner.addVectors(_kneeA, _kneeB);
      orientEye(leg.kneeEye.group, _kneeGaze, _kneeCorner.lengthSq() > 1e-6 ? _kneeCorner : null);
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

    if (featherMesh) {
    for (let i = 0; i < leg.featherSegs.length; i++) {
      const arr = leg.featherSegs[i];
      if (!arr.length) continue;
      const a = joints[i], b = joints[i + 1];
      _d.subVectors(b, a);
      const segLen = _d.length();
      if (segLen < 1e-5) continue;
      _d.multiplyScalar(1 / segLen);
      // Wing plane for this bone section: the bone is the leading edge; `s` is the
      // spanwise trailing direction (horizontal, biased toward the rear so the wing
      // sweeps back), and `n` is the plane normal (the broad vanes face along it).
      _featS.crossVectors(UP, _d);
      if (_featS.lengthSq() < 1e-6) _featS.set(1, 0, 0);
      _featS.normalize();
      if (_featS.x > 0) _featS.negate();           // trail toward the rear (-x)
      _featN.crossVectors(_d, _featS).normalize();
      if (_featN.y < 0) _featN.negate();           // broad faces tend upward
      for (const f of arr) {
        // In-plane direction: spanwise + swept toward the wingtip (never radial).
        _featDir.copy(_featS).addScaledVector(_d, f.sweep).normalize();
        _featX.crossVectors(_featDir, _featN).normalize();
        _eMat.makeBasis(_featX, _featDir, _featN); // x, y = long axis, z = flat normal
        _hairQ.setFromRotationMatrix(_eMat);
        // Quill base on the bone, nudged along the plane normal (coverts sit above).
        _hairPos.copy(a).addScaledVector(_d, f.t * segLen).addScaledVector(_featN, f.lift * f.length);
        _hairScale.set(f.length * f.width, f.length, f.length * f.width); // z with x: constant fold angle
        _hairM.compose(_hairPos, _hairQ, _hairScale);
        featherMesh.setMatrixAt(f.index, _hairM);
      }
    }
    featherMesh.instanceMatrix.needsUpdate = true;
    }
  }

  // Audio-reactive eyes: pupils dilate with loudness and pop on each beat; the
  // (shared) sclera glows on the beat. Called every frame by Creature.
  let _eyePulse = 0;
  function updateEyes(bus, dt) {
    if (!reactiveEyes.length) return;
    _eyePulse = Math.max(_eyePulse - dt * 4, 0);
    if (bus.beat) _eyePulse = 1;
    const dilate = 1 + 0.6 * bus.level + 0.4 * _eyePulse;
    for (const e of reactiveEyes) {
      // Dilate in the eye plane (x = long, z = side); y is the gaze-depth axis.
      e.pupil.scale.set(e.pupilBase.x * dilate, e.pupilBase.y, e.pupilBase.z * dilate);
    }
    scleraMat.emissiveIntensity = 0.08 + 0.5 * _eyePulse;
  }

  function dispose() {
    group.removeFromParent();
    for (const d of disposables) d.dispose();
  }

  // Put every creature mesh on the outline layer so the OutlinePass can render
  // the creature alone (and thus outline only its silhouette, never the ground).
  group.traverse((o) => { if (o.isMesh) o.layers.enable(OUTLINE_LAYER); });
  // ...but keep hairs/feathers out of the silhouette buffer so they don't fuzz it.
  if (hairMesh) hairMesh.layers.disable(OUTLINE_LAYER);
  if (featherMesh) featherMesh.layers.disable(OUTLINE_LAYER);

  return {
    group, bodyGroup, legs, updateLeg, updateEyes, ringSpin, dispose,
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

/**
 * Orient an eye group: local +Y -> gaze (`look`), local +X -> `cornerAxis`
 * (projected perpendicular to the gaze), so a lidded/almond eye's corners point
 * where we want; local +Z is the remaining side axis. Without a cornerAxis the
 * roll is left free (fine for a round eye). `look` defaults to +Y.
 */
function orientEye(group, look, cornerAxis) {
  if (look) _ey.set(look.x, look.y, look.z).normalize();
  else _ey.copy(_eyeUp);
  if (cornerAxis) {
    _ex.set(cornerAxis.x, cornerAxis.y, cornerAxis.z);
    _ex.addScaledVector(_ey, -_ex.dot(_ey)).normalize(); // perpendicular to gaze
    _ez.crossVectors(_ex, _ey).normalize();
    _eMat.makeBasis(_ex, _ey, _ez);
    group.quaternion.setFromRotationMatrix(_eMat);
  } else {
    group.quaternion.setFromUnitVectors(_eyeUp, _ey);
  }
}

/**
 * Build one crescent eyelid as a patch of a sphere shell (radius Rs, +Y the gaze
 * pole). The opening it borders is an almond in the gaze-plane: half-length A along
 * the corner axis (local x), half-width B along the side axis (local z). The lid
 * covers one side (sign = +1 or -1 in z), from the almond's smooth arc out to the
 * shell's equator. Its inner edge is therefore a clean convex curve — highest at the
 * center, no dip toward the pupil — meeting its partner at points at x = ±A (the
 * tear ducts).
 */
function makeLidGeometry(Rs, A, B, sign, nu = 56, nv = 10) {
  const pos = [];
  const idx = [];
  for (let i = 0; i <= nu; i++) {
    const x = -A + 2 * A * (i / nu);
    const zIn = B * Math.sqrt(Math.max(0, 1 - (x / A) * (x / A)));  // almond (opening) edge
    const zMax = Math.sqrt(Math.max(0, Rs * Rs - x * x));           // outer edge at the equator
    for (let j = 0; j <= nv; j++) {
      const z = sign * (zIn + (zMax - zIn) * (j / nv));
      const y = Math.sqrt(Math.max(0, Rs * Rs - x * x - z * z));    // project onto the shell
      pos.push(x, y, z);
    }
  }
  const row = nv + 1;
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const a = i * row + j, b = (i + 1) * row + j, c = (i + 1) * row + (j + 1), d = i * row + (j + 1);
      idx.push(a, b, d, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** A low-poly feather: two triangular vanes that fold down from a central shaft
 *  (base -> tip along +Y), giving a ridged/cupped blade instead of a flat one. The
 *  shaft line stays at z=0; the outer vane edges dip to -h. Unindexed so each vane
 *  flat-shades to a crisp ridge. Scaled per instance; z scales with x to keep the
 *  fold angle constant. */
function featherGeometry() {
  const geo = new THREE.BufferGeometry();
  const h = 0.18; // central-ridge depth (relative to the 0.4 vane half-width)
  const pos = new Float32Array([
    0, 0, 0,  -0.4, 0.45, -h,  0, 1, 0,   // left vane
    0, 0, 0,   0, 1, 0,       0.4, 0.45, -h, // right vane
  ]);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

/** A vesica/almond 2D Shape: the intersection of two equal circles, with cusps at
 *  (±halfLen, 0) and half-height halfHt. (Two arcs meeting at the cusps.) */
function vesicaShape(halfLen, halfHt) {
  const R = (halfHt + (halfLen * halfLen) / halfHt) / 2; // circle radius...
  const c = ((halfLen * halfLen) / halfHt - halfHt) / 2; // ...and center offset
  const a = Math.atan2(c, halfLen);
  const s = new THREE.Shape();
  s.moveTo(halfLen, 0);
  s.absarc(0, -c, R, a, Math.PI - a, false);         // upper boundary (circle below)
  s.absarc(0, c, R, -(Math.PI - a), -a, false);      // lower boundary (circle above)
  return s;
}

/** Basis matrix orienting a hole/iris at angle `th` around the band: local x =
 *  tangent (the cusp axis), y = vertical, z = radial (outward). */
function ringSlotBasis(th) {
  return new THREE.Matrix4().makeBasis(
    new THREE.Vector3(-Math.sin(th), 0, Math.cos(th)),
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(Math.cos(th), 0, Math.sin(th)),
  );
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
