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
  const attachFront = 0.32, attachBack = 0.04;  // hip cluster along the head (x)
  const sideHip = 0.17;                          // hip half-width (|z|)
  const footFront = 0.95 * sprawl, footBack = -0.95 * sprawl;
  const sideFoot = 1.4 * sprawl;                 // base lateral foot distance (|z|)
  const attachY = 0.1;                           // hip height above body center

  const perRight = Math.ceil(legCount / 2);
  const perLeft = Math.floor(legCount / 2);
  const limbs = [];

  const buildSide = (count, sign) => {
    for (let i = 0; i < count; i++) {
      const t = count > 1 ? i / (count - 1) : 0.5; // 0 = frontmost leg
      // Bow the row of feet outward: middle legs (t≈0.5) reach furthest.
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
  buildSide(perRight, +1);
  buildSide(perLeft, -1);

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

/** Convenience: legs only, filtered from a spec's limbs. */
export function legsOf(spec) {
  return spec.limbs.filter((l) => l.type === 'leg');
}
