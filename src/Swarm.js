/**
 * Swarm — manages the group: one controllable HERO plus N-1 randomized EXTRAS.
 *
 * The hero is driven by the panel (shape/color/markings/etc.); the extras are
 * built from random specs within the same ranges and share the scene-wide look
 * (render style + glow) and movement tuning. Two arrangements:
 *   - 'wander': everyone roams (at count 1 this is the classic single spider)
 *   - 'circle': everyone stands on a ring facing the center, dancing in place
 */
import * as THREE from 'three';
import { Creature } from './creature/Creature.js';
import { makeSpider, makeAngel } from './creature/CreatureSpec.js';

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const MARKS = ['none', 'stripes', 'hourglass', 'dots', 'skull', 'cross', 'diamond'];

/** Random spec options for a spider extra, within the panel's ranges. */
function randomSpiderOpts(toon) {
  const h1 = Math.random();
  const h2 = (h1 + rand(-0.15, 0.15) + 1) % 1;
  const main = new THREE.Color().setHSL(h1, rand(0.4, 0.7), rand(0.08, 0.16));
  const accent = new THREE.Color().setHSL(h2, rand(0.6, 0.9), rand(0.5, 0.65));
  return {
    legCount: 8,
    bodyScale: rand(0.7, 1.4),
    bodyHeight: rand(0.4, 0.7),
    legLength: rand(0.85, 1.5),
    kneeFrac: rand(0.35, 0.55),
    sprawl: rand(0.8, 1.4),
    bow: rand(0.1, 0.5),
    hairs: true,
    hairDensity: rand(0.6, 1.4),
    hairLength: rand(0.6, 1.4),
    microBump: rand(0.8, 1.8),
    markType: pick(MARKS),
    markAmount: rand(0.2, 0.5),
    markScale: rand(0.7, 1.5),
    bodyColor: '#' + main.getHexString(),
    legColor: '#' + accent.getHexString(),
    toon,
  };
}

/** Random spec options for an angel extra — pale/ethereal palette, many legs. */
function randomAngelOpts(toon) {
  const h1 = Math.random();
  const h2 = (h1 + rand(-0.1, 0.1) + 1) % 1;
  const main = new THREE.Color().setHSL(h1, rand(0.15, 0.4), rand(0.3, 0.5));
  const accent = new THREE.Color().setHSL(h2, rand(0.2, 0.5), rand(0.6, 0.82));
  return {
    legCount: pick([10, 12, 14]),
    bodyScale: rand(0.8, 1.4),
    bodyHeight: rand(0.6, 0.9),
    legLength: rand(0.9, 1.6),
    kneeFrac: rand(0.5, 0.62),
    sprawl: rand(0.9, 1.4),
    bow: rand(0.2, 0.5),
    microBump: rand(0.8, 1.6),
    bodyColor: '#' + main.getHexString(),
    legColor: '#' + accent.getHexString(),
    toon,
  };
}

/** Creature-type registry: each type knows how to build a spec and roll a random one. */
const TYPES = {
  spider: { make: makeSpider, randomOpts: randomSpiderOpts },
  angel: { make: makeAngel, randomOpts: randomAngelOpts },
};

export class Swarm {
  constructor(scene, heroSpec) {
    this.scene = scene;
    this.hero = new Creature(scene, heroSpec);
    this.extras = [];
    this.extraOpts = [];
    this.creatures = [this.hero];
    this.arrangement = 'circle';
    this.ringRadius = 4;
    this.separation = 3.5; // how far apart wandering creatures are kept
    this.type = heroSpec.kind ?? 'spider'; // extras are built to match the hero's type
    this._toon = heroSpec.style === 'toon';
    this.arrange();
  }

  /** The active type's spec builder / random-opts generator. */
  _make(opts) { return TYPES[this.type].make(opts); }
  _randomOpts() { return TYPES[this.type].randomOpts(this._toon); }

  /** Easier foot-stepping only when dancing in a ring with others. */
  _updateStepMode() {
    const easy = this.arrangement === 'circle' && this.creatures.length > 1;
    for (const c of this.creatures) c.gait.easySteps = easy;
  }

  update(dt, bus) {
    for (const c of this.creatures) c.update(dt, bus);
    this._separate();
  }

  /** Keep wandering creatures from overlapping — a cheap pairwise push-apart. */
  _separate() {
    if (this.arrangement !== 'wander' || this.creatures.length < 2) return;
    const minD = this.separation;
    if (minD <= 0) return;
    const list = this.creatures;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i].body.position, b = list[j].body.position;
        let dx = b.x - a.x, dz = b.z - a.z;
        let d = Math.hypot(dx, dz);
        if (d < 1e-4) { dx = Math.random() - 0.5; dz = Math.random() - 0.5; d = Math.hypot(dx, dz) || 1; }
        if (d < minD) {
          const push = (minD - d) * 0.5;
          const ux = dx / d, uz = dz / d;
          a.x -= ux * push; a.z -= uz * push;
          b.x += ux * push; b.z += uz * push;
        }
      }
    }
  }

  /** Average position of the group (camera/light focus for 'circle'; = hero for 1). */
  center(out = new THREE.Vector3()) {
    out.set(0, 0, 0);
    for (const c of this.creatures) out.add(c.body.position);
    return out.multiplyScalar(1 / this.creatures.length);
  }

  // --- hero (panel) ---
  rebuildHero(spec) {
    this._toon = spec.style === 'toon';
    this.hero.rebuild(spec); // keeps the hero's position/arrangement
  }

  /** Switch creature type (spider/angel). Hero rebuilds from its new spec; extras
   *  re-roll to match the new type. */
  setType(type, heroSpec) {
    this.type = type;
    this._toon = heroSpec.style === 'toon';
    this.hero.rebuild(heroSpec);
    for (let i = 0; i < this.extras.length; i++) {
      const opts = this._randomOpts();
      this.extraOpts[i] = opts;
      this.extras[i].rebuild(this._make(opts));
      this._dressExtra(this.extras[i]);
    }
  }

  /** Scene-wide render style: rebuild hero (from its spec) + all extras. */
  setStyleAll(toon, heroSpec) {
    this._toon = toon;
    this.hero.rebuild(heroSpec);
    for (let i = 0; i < this.extras.length; i++) {
      this.extraOpts[i].toon = toon;
      this.extras[i].rebuild(this._make(this.extraOpts[i]));
    }
  }

  // --- group size ---
  setCount(n) {
    const needExtras = Math.max(0, Math.round(n) - 1);
    while (this.extras.length > needExtras) {
      this.extras.pop().render.dispose();
      this.extraOpts.pop();
    }
    while (this.extras.length < needExtras) {
      const opts = this._randomOpts();
      const c = new Creature(this.scene, this._make(opts));
      this._dressExtra(c);
      // New extras get a position now; existing ones keep theirs (in wander).
      this._placeOne(c, this.extras.length + 1);
      this.extras.push(c);
      this.extraOpts.push(opts);
    }
    this.creatures = [this.hero, ...this.extras];
    if (this.arrangement === 'circle') this.arrange();
    this._updateStepMode();
  }

  /** Re-roll every extra's random look (keeps their positions). */
  rerollExtras() {
    for (let i = 0; i < this.extras.length; i++) {
      const opts = this._randomOpts();
      this.extraOpts[i] = opts;
      this.extras[i].rebuild(this._make(opts));
      this._dressExtra(this.extras[i]);
    }
  }

  // --- arrangement ---
  setArrangement(a) {
    this.arrangement = a;
    this.arrange();
  }

  arrange() {
    this._updateStepMode();
    const n = this.creatures.length;
    if (this.arrangement === 'circle') {
      if (n === 1) { // a lone spider dances at the center, not off on a ring
        this.ringRadius = 2.5;
        this.hero.placeAt(0, 0, Math.random() * Math.PI * 2, 'circle');
        return;
      }
      this.ringRadius = Math.max(2.5, 1.2 + n * 0.6);
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * Math.PI * 2;
        const x = Math.cos(ang) * this.ringRadius;
        const z = Math.sin(ang) * this.ringRadius;
        this.creatures[i].placeAt(x, z, Math.atan2(z, -x), 'circle'); // face center
      }
    } else {
      this.hero.placeAt(0, 0, Math.random() * Math.PI * 2, 'wander');
      for (let i = 0; i < this.extras.length; i++) this._placeOne(this.extras[i], i + 1);
    }
  }

  // --- helpers ---
  _dressExtra(c) {
    c.glow = this.hero.glow;
    c.body.responseScale = rand(0.6, 1.3);
    copyMovement(this.hero, c);
  }

  _placeOne(c, i) {
    if (this.arrangement === 'circle') {
      const n = this.creatures.length || 1;
      const ang = (i / n) * Math.PI * 2;
      const x = Math.cos(ang) * this.ringRadius;
      const z = Math.sin(ang) * this.ringRadius;
      c.placeAt(x, z, Math.atan2(z, -x), 'circle');
    } else {
      const ang = Math.random() * Math.PI * 2;
      const r = rand(1.5, 6);
      c.placeAt(Math.cos(ang) * r, Math.sin(ang) * r, Math.random() * Math.PI * 2, 'wander');
    }
  }
}

/** Copy the scene-wide movement/dance tuning from one creature onto another. */
function copyMovement(src, dst) {
  const b = src.body, g = src.gait;
  Object.assign(dst.body, {
    bobAmount: b.bobAmount, beatPop: b.beatPop,
    baseSpeed: b.baseSpeed, audioSpeed: b.audioSpeed,
    maxTurn: b.maxTurn, pauseToDance: b.pauseToDance, pauseDance: b.pauseDance,
  });
  Object.assign(dst.gait, {
    stepThreshold: g.stepThreshold, stepDuration: g.stepDuration, stepLift: g.stepLift,
  });
}
