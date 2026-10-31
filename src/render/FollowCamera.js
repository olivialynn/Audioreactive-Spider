/**
 * FollowCamera — keeps the camera trained on a moving focus point (the spider)
 * and slowly orbits around it, so the creature never walks out of frame.
 *
 * It owns a smoothed `target` (so the camera eases after the spider instead of
 * snapping), and an `angle` it advances at `rotateSpeed`. When `enabled` is
 * false, main.js hands control back to OrbitControls but still points that
 * orbit's target at this same smoothed focus, so manual inspection also tracks
 * the spider.
 */
import * as THREE from 'three';

export class FollowCamera {
  constructor(camera, opts = {}) {
    this.camera = camera;

    // --- tunable (see ui/Panel.js) ---
    this.enabled = opts.enabled ?? true;
    this.distance = opts.distance ?? 8;    // horizontal-ish radius from target
    this.height = opts.height ?? 4;        // camera height above the target
    this.rotateSpeed = opts.rotateSpeed ?? 12; // degrees/second (0 = static, <0 = reverse)
    this.followLerp = opts.followLerp ?? 2.5;  // higher = snappier tracking

    this.angle = opts.angle ?? Math.PI * 0.25; // current orbit angle (radians)

    // Optional very-slow vertical oscillation (a low-frequency oscillator). When
    // on, the camera height sweeps 0..10 instead of using the fixed `height`.
    this.heightLFO = opts.heightLFO ?? false;
    this.lfoSpeed = opts.lfoSpeed ?? 0.5; // 1 ≈ a 30s cycle
    this.lfoMin = opts.lfoMin ?? 0;       // height sweep range
    this.lfoMax = opts.lfoMax ?? 6;
    this._lfoPhase = 0;

    this.target = new THREE.Vector3();
    this._initialized = false;
  }

  /** Ease the smoothed target toward the spider's position. Call every frame. */
  updateFocus(dt, focusPos) {
    if (!this._initialized) {
      this.target.copy(focusPos);
      this._initialized = true;
      return;
    }
    const k = 1 - Math.exp(-this.followLerp * dt);
    this.target.lerp(focusPos, k);
  }

  /** Advance the orbit and place the camera. Only call when `enabled`. */
  applyOrbit(dt) {
    this.angle += THREE.MathUtils.degToRad(this.rotateSpeed) * dt;

    let height = this.height;
    if (this.heightLFO) {
      this._lfoPhase += (Math.PI * 2 / 30) * this.lfoSpeed * dt; // base cycle ~30s
      const mid = (this.lfoMin + this.lfoMax) / 2;
      const amp = (this.lfoMax - this.lfoMin) / 2;
      height = mid + amp * Math.sin(this._lfoPhase); // sweeps lfoMin..lfoMax
    }

    this.camera.position.set(
      this.target.x + Math.cos(this.angle) * this.distance,
      this.target.y + height,
      this.target.z + Math.sin(this.angle) * this.distance,
    );
    this.camera.lookAt(this.target);
  }
}
