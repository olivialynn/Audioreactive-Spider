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

  // Two-segment legs (femur + tibia) = the "upside-down checkmark": femur rises
  // steeply to a high knee, tibia drops to the foot. (solveTwoBone keeps the
  // knee up and the leg in one vertical plane, so it's straight from above.)
  // A little length headroom so the bowed-out middle legs still bend up nicely.
  const totalLeg = 2.2 * legLength;
  const segments = [totalLeg * kneeFrac, totalLeg * (1 - kneeFrac)];

  // Hips cluster tightly on the sides of the (small) cephalothorax; feet fan out
  // wide front-to-back. Small attach span -> legs don't sprout from the head.
  const attachFront = 0.15, attachBack = -0.15; // tight hip cluster (x)
  const sideHip = 0.18;                          // hip half-width (|z|)
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
  return {
    name: `spider-${legCount}`,
    body: {
      height: bodyHeight,
      color: bodyColor,
      // Two parts, front (cephalothorax, legs attach here) + rear (abdomen).
      // Base radii are ~half the earlier build; bodyScale tunes from there.
      segments: [
        { offset: { x: 0.18 * s, y: 0.0, z: 0 }, radius: 0.22 * s, scale: { x: 1.0, y: 0.72, z: 0.95 } },
        { offset: { x: -0.4 * s, y: 0.06 * s, z: 0 }, radius: 0.34 * s, scale: { x: 1.3, y: 0.9, z: 1.05 } },
      ],
    },
    limbs,
    features: [], // reserved: eyes, etc.
  };
}

/** Convenience: legs only, filtered from a spec's limbs. */
export function legsOf(spec) {
  return spec.limbs.filter((l) => l.type === 'leg');
}
