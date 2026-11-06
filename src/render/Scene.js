/**
 * Scene — the "stage": renderer, camera, orbit controls, lights, ground, and the
 * post-processing chain. Nothing creature- or audio-specific lives here.
 *
 * Three things do most of the visual lifting here:
 *   - ACES tone mapping for cinematic contrast/color (applied by OutputPass).
 *   - Image-based lighting: a neutral studio environment generated IN CODE
 *     (RoomEnvironment + PMREMGenerator, no HDRI file) so PBR materials have
 *     something to reflect and actually read as material.
 *   - A bloom pass so emissive highlights glow (the creature pulses these on the
 *     beat; see Creature.js).
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';
import { HalftonePass } from 'three/addons/postprocessing/HalftonePass.js';
import { OutlinePass } from './OutlinePass.js';

// Gentle glitch: a brief RGB split + slight horizontal band jitter, scaled by
// `amount` (0 = passthrough). No noise/flashing, so no strobing. main.js pulses
// `amount` down from 1 on each beat.
const GlitchShader = {
  uniforms: { tDiffuse: { value: null }, amount: { value: 0 }, seed: { value: 0 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float amount; uniform float seed; varying vec2 vUv;
    float rand(float x){ return fract(sin(x * 12.9898) * 43758.5453); }
    void main(){
      vec2 uv = vUv;
      float band = floor(uv.y * 20.0);
      uv.x += (rand(band + seed) - 0.5) * amount * 0.04; // mild per-band shift
      float s = amount * 0.010;                          // chromatic split
      float r = texture2D(tDiffuse, uv + vec2(s, 0.0)).r;
      float g = texture2D(tDiffuse, uv).g;
      float b = texture2D(tDiffuse, uv - vec2(s, 0.0)).b;
      gl_FragColor = vec4(r, g, b, 1.0);
    }`,
};

// Posterize: quantize each channel into `levels` hard bands (cel/comic banding).
const PosterizeShader = {
  uniforms: { tDiffuse: { value: null }, levels: { value: 5 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float levels; varying vec2 vUv;
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      c.rgb = floor(c.rgb * levels + 0.5) / levels;
      gl_FragColor = vec4(clamp(c.rgb, 0.0, 1.0), c.a);
    }`,
};

export function createScene(container) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a0f);
  scene.fog = new THREE.Fog(0x0a0a0f, 16, 40);

  const camera = new THREE.PerspectiveCamera(
    50, window.innerWidth / window.innerHeight, 0.1, 100,
  );
  camera.position.set(5, 4, 7);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; // OutputPass applies it
  renderer.toneMappingExposure = 1.0;
  container.appendChild(renderer.domElement);

  // --- Image-based lighting (generated procedurally, no asset to load). ---
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.set(0, 0.5, 0);
  controls.maxPolarAngle = Math.PI * 0.49;

  // --- Direct lights (the env map handles ambient/reflections). ---
  // A big soft spotlight as the key — its cone angle ("width") and penumbra
  // ("softness") are exposed in the Lighting panel. decay=0 so brightness doesn't
  // fall off with distance (keeps intensity predictable to tune).
  const key = new THREE.SpotLight(0xffffff, 6, 0, 0.45, 0.25, 0);
  key.position.set(5, 12, 4);
  key.target.position.set(0, 0.5, 0);
  scene.add(key.target);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 50;
  key.shadow.bias = -0.0003;
  scene.add(key);

  // A cool rim light from behind to separate the creature from the dark bg.
  const rim = new THREE.DirectionalLight(0x8899ff, 1.2);
  rim.position.set(-6, 4, -6);
  scene.add(rim);

  // Shadow-less point light as a travelling fill — adds specular glints on the
  // chitin and eyes. decay=0 keeps its brightness predictable; it tracks the
  // spider in the render loop (main.js). Toggle via its `.visible`.
  const fill = new THREE.PointLight(0x00feff, 1.5, 0, 0);
  scene.add(fill);

  // --- Ground ---
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x12121a, roughness: 0.9, metalness: 0.0 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const grid = new THREE.GridHelper(80, 80, 0x2a2a3a, 0x1c1c28);
  grid.position.y = 0.001;
  grid.material.opacity = 0.5;
  grid.material.transparent = true;
  scene.add(grid);

  // --- Post-processing chain ---
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(window.innerWidth, window.innerHeight);
  composer.addPass(new RenderPass(scene, camera));
  const outlinePass = new OutlinePass(scene, camera); // disabled by default
  composer.addPass(outlinePass);
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.25, // strength (subtle by default)
    0.4,  // radius
    0.85, // threshold — only bright/emissive bits bloom
  );
  // Afterimage: motion trails (damp = how much of the previous frame persists). Put
  // it before bloom so trails glow too. Audio can drive damp (main.js).
  const afterimagePass = new AfterimagePass(0.9);
  afterimagePass.enabled = false;
  composer.addPass(afterimagePass);

  composer.addPass(bloomPass);

  // --- Optional stylization passes (disabled by default), before the final OutputPass. ---
  const posterizePass = new ShaderPass(PosterizeShader);
  posterizePass.enabled = false;
  composer.addPass(posterizePass);

  const halftonePass = new HalftonePass(window.innerWidth, window.innerHeight, {
    shape: 1, radius: 4, rotateR: Math.PI / 12, rotateG: Math.PI / 12 * 2, rotateB: Math.PI / 12 * 3,
    scatter: 0, blending: 1, blendingMode: 1, greyscale: false,
  });
  halftonePass.enabled = false;
  composer.addPass(halftonePass);

  // Glitch: a gentle beat-pulsed RGB split (main.js drives `amount`).
  const glitchPass = new ShaderPass(GlitchShader);
  glitchPass.enabled = false;
  composer.addPass(glitchPass);

  composer.addPass(new OutputPass()); // tone mapping + color space (always last)

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
    outlinePass.setSize(window.innerWidth, window.innerHeight);
    halftonePass.setSize(window.innerWidth, window.innerHeight);
  });

  return {
    scene, camera, renderer, controls, composer, bloomPass, outlinePass,
    afterimagePass, posterizePass, halftonePass, glitchPass,
    keyLight: key, fillLight: fill,
  };
}
