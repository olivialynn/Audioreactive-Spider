/**
 * CreatureSpec — a pure-data description of a creature. No THREE objects here.
 *
 * This is the "parametric model" layer. A spec is just numbers, so building a
 * different creature is building a different spec. CreatureBuilder turns a spec
 * into meshes; GaitPlanner/IK read the leg numbers.
 *
 * Body-local coordinate convention
 * --------------------------------
 *   +X = forward (direction of travel)   +Y = up   +Z = one side
 * Legs carry explicit body-local offsets rather than a position on a circle,
 * which is what lets them be grouped left/right and fanned front-to-back like a
 * real spider (instead of equidistant spokes).
 *
 *   leg.hipOffset  : {x,y,z} where the leg attaches on the body
 *   leg.restOffset : {x,z}   the ideal foot position on the ground (body-local)
 *   leg.side       : 'left' | 'right'
 *
 * Limbs are TYPED on purpose. The MVP only implements 'leg', but the type field
 * is what lets the "biblically-accurate angel" stretch goal slot in later:
 *   - 'leg'  -> inverse kinematics + ground planting (implemented)
 *   - 'wing' -> procedural flapping, no ground contact (future)
 * And `features` is reserved for body-attached parts like eyes.
 */

const lerp = (a, b, t) => a + (b - a) * t;

// Abdomen marking patterns (used by the shader in CreatureBuilder).
export const MARK_TYPES = { none: 0, stripes: 1, hourglass: 2, dots: 3, skull: 4, cross: 5, diamond: 6 };

/**
 * Lay out `count` legs as a left/right pair of rows, fanned front-to-back and
 * bowed outward in the middle. Shared by every creature that walks on bilateral
 * legs (spider, angel) — each just passes its own proportions. Odd counts put
 * the extra leg on the right.
 *
 *   attachFront/attachBack : hip x-span along the body (front -> back)
 *   sideHip                : hip half-width (|z|)
 *   attachY                : hip height above body center
 *   footFront/footBack     : foot x-span on the ground
 *   sideFoot               : base lateral foot distance (|z|)
 *   bow                    : middle legs reach further out (0 = none)
 */
function bilateralLegs({ count, segments, legColor, bow,
  attachFront, attachBack, sideHip, attachY, footFront, footBack, sideFoot }) {
  const limbs = [];
  const buildSide = (n, sign) => {
    for (let i = 0; i < n; i++) {
      const t = n > 1 ? i / (n - 1) : 0.5; // 0 = frontmost leg
      const footZ = sideFoot * (1 + bow * Math.sin(Math.PI * t));
      limbs.push({
        type: 'leg',
        side: sign > 0 ? 'right' : 'left',
        hipOffset: { x: lerp(attachFront, attachBack, t), y: attachY, z: sign * sideHip },
        restOffset: { x: lerp(footFront, footBack, t), z: sign * footZ },
        segments: segments.slice(),
        color: legColor,
      });
    }
  };
  buildSide(Math.ceil(count / 2), +1);
  buildSide(Math.floor(count / 2), -1);
  return limbs;
}

/**
 * Build a spider: `legCount` legs split into a left and a right group, attached
 * along the sides of the cephalothorax and fanned from front to back. Works for
 * any count (odd counts put the extra leg on the right), so the leg-count slider
 * just rebuilds from a new spec.
 */
export function makeSpider(opts = {}) {
  const legCount = opts.legCount ?? 8;
  const bodyScale = opts.bodyScale ?? 1;       // overall body size multiplier
  const bodyHeight = opts.bodyHeight ?? 0.5;   // hip height — low, so knees rise above
  const legLength = opts.legLength ?? 1;       // overall leg length multiplier
  const kneeFrac = opts.kneeFrac ?? 0.45;      // femur fraction; higher = higher knee
  const sprawl = opts.sprawl ?? 1;             // how far out the feet plant
  const bow = opts.bow ?? 0.3;                 // middle legs reach further -> ) shape
  const legColor = opts.legColor ?? 0xc7b3ff;
  const bodyColor = opts.bodyColor ?? 0x6b5bb5;
  const style = opts.toon ? 'toon' : 'physical'; // render style (CreatureBuilder reads this)
  const hairs = {
    enabled: opts.hairs !== false,
    density: opts.hairDensity ?? 1,
    length: opts.hairLength ?? 1,
  };
  const marking = {
    type: MARK_TYPES[opts.markType] ?? MARK_TYPES.diamond,
    strength: opts.markAmount ?? 0.3,
    scale: opts.markScale ?? 1,
  };

  // Two-segment legs (femur + tibia) = the "upside-down checkmark": femur rises
  // steeply to a high knee, tibia drops to the foot. (solveTwoBone keeps the
  // knee up and the leg in one vertical plane, so it's straight from above.)
  // A little length headroom so the bowed-out middle legs still bend up nicely.
  const totalLeg = 2.2 * legLength;
  const segments = [totalLeg * kneeFrac, totalLeg * (1 - kneeFrac)];

  // Hips cluster on the sides of the (small) cephalothorax; feet fan out wide
  // front-to-back. The span is centered on the head (which sits around x≈0.2).
  const limbs = bilateralLegs({
    count: legCount, segments, legColor, bow,
    attachFront: 0.32, attachBack: 0.04, sideHip: 0.17, attachY: 0.1,
    footFront: 0.95 * sprawl, footBack: -0.95 * sprawl, sideFoot: 1.4 * sprawl,
  });

  const s = bodyScale;
  const detail = 2; // icosahedron subdivision — fixed (enough polys for the bump map)
  // Two body parts: a SMALL front cephalothorax (legs + eyes attach here) and a
  // BIG, round, raised rear abdomen — the dominant silhouette in the references.
  // `taper` narrows the cross-section front->back (+x -> -x).
  const ceph = {
    offset: { x: 0.2 * s, y: 0.0, z: 0 }, radius: 0.2 * s,
    scale: { x: 1.05, y: 0.72, z: 1.0 }, detail, taper: { front: 0.78, back: 1.0 },
  };
  const abdomen = {
    offset: { x: -0.5 * s, y: 0.14 * s, z: 0 }, radius: 0.5 * s, // ~2.5x the head, raised up/back
    scale: { x: 1.1, y: 1.05, z: 1.1 }, detail, taper: { front: 1.0, back: 0.72 },
    markable: true, // gets the procedural abdomen markings
  };

  // Eyes: a spider-ish cluster on the upper front of the cephalothorax. Built as
  // symmetric left/right pairs, scaled to the (already body-scaled) head radius.
  // They live in `features`, which CreatureBuilder renders in the accent color.
  const cr = ceph.radius, cx = ceph.offset.x;
  const features = [];
  const addEyePair = (fx, fy, fz, r) => {
    features.push({ type: 'eye', offset: { x: fx, y: fy, z: fz }, radius: r });
    features.push({ type: 'eye', offset: { x: fx, y: fy, z: -fz }, radius: r });
  };
  addEyePair(cx + cr * 0.82, cr * 0.28, cr * 0.20, cr * 0.17); // principal (big, inner)
  addEyePair(cx + cr * 0.78, cr * 0.52, cr * 0.32, cr * 0.12); // upper inner
  addEyePair(cx + cr * 0.58, cr * 0.58, cr * 0.62, cr * 0.10); // upper outer
  addEyePair(cx + cr * 0.52, cr * 0.18, cr * 0.70, cr * 0.09); // lower outer

  return {
    kind: 'spider',
    name: `spider-${legCount}`,
    style,
    hairs,
    marking,
    bump: opts.microBump ?? 1.5,
    body: { height: bodyHeight, color: bodyColor, segments: [ceph, abdomen] },
    limbs,
    features,
  };
}

/**
 * Build a biblically-accurate angel: a tall, upright, columnar body standing on
 * many long, high-arched legs (which later carry feathers — the "wings"), and
 * studded with eyes (expanded in a later step). Same spec shape as makeSpider, so
 * the gait/IK/body pipeline animates it with no changes. Step 1: the walking
 * skeleton — plain limbs, a small eye set, markings off.
 */
export function makeAngel(opts = {}) {
  const legCount = opts.legCount ?? 6;         // six wing-limbs by default
  const bodyScale = opts.bodyScale ?? 1;
  const bodyHeight = opts.bodyHeight ?? 0.5;   // same stance as the spider
  const legLength = opts.legLength ?? 1;
  const kneeFrac = opts.kneeFrac ?? 0.55;      // high knees -> legs arch up like furled wings
  const sprawl = opts.sprawl ?? 1;
  const bow = opts.bow ?? 0.4;
  // Same default palette as the spider (and the shared panel presets apply to both).
  const legColor = opts.legColor ?? 0xc7b3ff;
  const bodyColor = opts.bodyColor ?? 0x6b5bb5;
  const style = opts.toon ? 'toon' : 'physical';
  // No leg hairs on the angel — feathers take their place (its "wings").
  const hairs = { enabled: false, density: 1, length: 1 };
  const feathers = {
    enabled: opts.feathers !== false,
    density: opts.featherDensity ?? 1,
    length: opts.featherLength ?? 1,
  };

  // Longer, slenderer legs than the spider; same two-segment checkmark.
  const totalLeg = 2.8 * legLength;
  const segments = [totalLeg * kneeFrac, totalLeg * (1 - kneeFrac)];

  // Hips cluster near the body's vertical core (short front-back span) and sit
  // high, so the long legs sweep up and out — a furled-wing silhouette.
  const limbs = bilateralLegs({
    count: legCount, segments, legColor, bow,
    attachFront: 0.12, attachBack: -0.12, sideHip: 0.2, attachY: 0.18,
    footFront: 1.0 * sprawl, footBack: -1.1 * sprawl, sideFoot: 1.6 * sprawl,
  });

  const s = bodyScale;
  const detail = 2;
  // Body: a single sphere, sized like the spider's main body mass. A later step
  // sets one giant eye into it (the angel's signature). Kept as one rounded mass
  // rather than the earlier tall column.
  const sphere = {
    offset: { x: 0, y: 0.1 * s, z: 0 }, radius: 0.5 * s,
    scale: { x: 1.0, y: 1.0, z: 1.0 }, detail, taper: { front: 1.0, back: 1.0 },
  };

  // One giant eye set into the DORSAL (top) surface of the sphere, gazing straight
  // up. It's a flat, almond-shaped lidded eye whose corners point fore/aft, layered
  // (sclera/iris/pupil) and audio-reactive (pupil dilates, sclera glows). Later
  // steps add smaller eyes on the knees and torso.
  const features = [{
    type: 'eye',
    shape: 'almond',
    offset: { x: 0, y: 0.36 * s, z: 0 }, // recessed into the top of the sphere
    radius: 0.28 * s,                     // big, but sunk so the body still reads
    look: { x: 0, y: 1, z: 0 },           // gaze straight up
    cornerAxis: { x: 1, y: 0, z: 0 },     // corners point to head (+x) and rear (-x)
    lids: true,
    lidInner: 0.3, // opening half-width (sin) -> a narrow almond, not a wide dome
    lidOuter: 1.0, // opening half-length (corner reach)
    iris: 0.5,     // iris cap half-angle (radians)
    pupil: 0.26,   // pupil cap half-angle (dilates with the audio)
    reactive: true,
  }];

  // Torso eyes: smaller lidded almond eyes scattered over the sphere, each gazing
  // radially outward (socketed into the body). Two staggered rings below the giant
  // dorsal eye — "covered in eyes." cornerAxis is the horizontal tangent (up × dir),
  // so the almonds read roughly level.
  const torsoEye = (az, el) => {
    const ce = Math.cos(el);
    const dx = ce * Math.cos(az), dy = Math.sin(el), dz = ce * Math.sin(az);
    const cl = Math.hypot(dz, dx) || 1; // horizontal tangent = up × dir = (dz, 0, -dx)
    features.push({
      type: 'eye', shape: 'almond', lids: true,
      offset: { x: sphere.offset.x + dx * sphere.radius, y: sphere.offset.y + dy * sphere.radius, z: sphere.offset.z + dz * sphere.radius },
      radius: 0.08 * s,
      look: { x: dx, y: dy, z: dz },
      cornerAxis: { x: dz / cl, y: 0, z: -dx / cl },
      lidInner: 0.32, lidOuter: 1.0, iris: 0.6, pupil: 0.33, reactive: true,
    });
  };
  const TAU = Math.PI * 2;
  for (let i = 0; i < 5; i++) torsoEye(TAU * (i / 5) + 0.3, 0.34);          // upper ring
  for (let i = 0; i < 5; i++) torsoEye(TAU * (i / 5) + 0.3 + TAU / 10, -0.4); // lower ring, staggered

  return {
    kind: 'angel',
    name: `angel-${legCount}`,
    style,
    hairs,
    feathers,
    marking: { type: MARK_TYPES.none, strength: 0, scale: 1 }, // markings off
    bump: opts.microBump ?? 1.5,
    body: { height: bodyHeight, color: bodyColor, segments: [sphere] },
    // The ophanim's wheel: a slim hollow-cylinder band (flat top/bottom) around the
    // torso, pierced with almond (vesica) holes, each with a floating iris disc, and
    // spinning about its own axis. `spin` is radians/sec; a slight `tilt` gives depth.
    ring: {
      center: { x: 0, y: 0.1 * s, z: 0 }, // the sphere's center
      inner: 0.74 * s, outer: 0.84 * s, height: 0.18 * s,
      tilt: 0.12, spin: 0.7,
      holes: { count: 7, len: 0.24 * s, ht: 0.12 * s, iris: 0.032 * s },
    },
    limbs,
    features,
  };
}

/** Convenience: legs only, filtered from a spec's limbs. */
export function legsOf(spec) {
  return spec.limbs.filter((l) => l.type === 'leg');
}
