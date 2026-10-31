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
    this.camera.position.set(
      this.target.x + Math.cos(this.angle) * this.distance,
      this.target.y + this.height,
      this.target.z + Math.sin(this.angle) * this.distance,
    );
    this.camera.lookAt(this.target);
  }
}
