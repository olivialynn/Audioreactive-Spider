/**
 * OutlinePass — a cel-style ink outline via edge detection (the missing half of
 * the toon look). It's a single extra pass: it re-renders the scene once with a
 * normal material into a buffer that also captures depth, then a fullscreen
 * shader inks pixels where depth or normals change sharply — i.e. silhouettes
 * and facet creases. Cheap, and geometry-agnostic (so it just works with the
 * per-frame leg movement).
 */
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

// Objects on this layer (the creature) are the only ones considered for the
// outline, so the ground/grid are never outlined. CreatureBuilder enables it.
export const OUTLINE_LAYER = 1;

export class OutlinePass extends Pass {
  constructor(scene, camera, opts = {}) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.enabled = opts.enabled ?? false;
    this.layer = opts.layer ?? OUTLINE_LAYER;

    const w = window.innerWidth, h = window.innerHeight;
    // Depth-only buffer: we render just the creature into it, so depth jumps mark
    // its silhouette (and leg-over-body overlaps) against the empty background.
    this.rt = new THREE.WebGLRenderTarget(w, h);
    this.rt.depthTexture = new THREE.DepthTexture(w, h);
    this.rt.depthTexture.type = THREE.UnsignedIntType;
    this.depthMaterial = new THREE.MeshBasicMaterial(); // cheap; only depth matters

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: this.rt.depthTexture },
        resolution: { value: new THREE.Vector2(w, h) },
        cameraNear: { value: camera.near },
        cameraFar: { value: camera.far },
        thickness: { value: opts.thickness ?? 1.2 },
        strength: { value: opts.strength ?? 1.0 },
        outlineColor: { value: new THREE.Color(opts.color ?? 0x000000) },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */`
        #include <packing>
        uniform sampler2D tDiffuse, tDepth;
        uniform vec2 resolution;
        uniform float cameraNear, cameraFar, thickness, strength;
        uniform vec3 outlineColor;
        varying vec2 vUv;

        float viewZ(vec2 uv) {
          float d = texture2D(tDepth, uv).x;
          return perspectiveDepthToViewZ(d, cameraNear, cameraFar);
        }

        void main() {
          vec2 t = thickness / resolution;
          vec3 col = texture2D(tDiffuse, vUv).rgb;

          // Depth discontinuities only -> the creature's silhouette (and where a
          // leg passes in front of the body). No facet creases, no ground.
          float dc = viewZ(vUv);
          float de =
            abs(dc - viewZ(vUv + vec2(t.x, 0.0))) +
            abs(dc - viewZ(vUv + vec2(-t.x, 0.0))) +
            abs(dc - viewZ(vUv + vec2(0.0, t.y))) +
            abs(dc - viewZ(vUv + vec2(0.0, -t.y)));

          // Detect the edge (silhouettes saturate), then scale by opacity so the
          // control fades the whole ink line in/out.
          float edge = clamp(de * 0.12, 0.0, 1.0) * strength;
          gl_FragColor = vec4(mix(col, outlineColor, edge), 1.0);
        }`,
    });
    this.fsQuad = new FullScreenQuad(this.material);
  }

  setSize(w, h) {
    this.rt.setSize(w, h);
    this.material.uniforms.resolution.value.set(w, h);
  }

  render(renderer, writeBuffer, readBuffer) {
    // 1. Render ONLY the creature's depth into our buffer (via the outline layer).
    const prevRT = renderer.getRenderTarget();
    const prevOverride = this.scene.overrideMaterial;
    const prevMask = this.camera.layers.mask;
    this.camera.layers.set(this.layer);
    this.scene.overrideMaterial = this.depthMaterial;
    renderer.setRenderTarget(this.rt);
    renderer.clear();
    renderer.render(this.scene, this.camera);
    this.scene.overrideMaterial = prevOverride;
    this.camera.layers.mask = prevMask;

    // 2. Ink the silhouette over the incoming color.
    this.material.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this.fsQuad.render(renderer);

    renderer.setRenderTarget(prevRT);
  }

  dispose() {
    this.rt.dispose();
    this.material.dispose();
    this.depthMaterial.dispose();
    this.fsQuad.dispose();
  }
}
