/**
 * Renderer.
 *
 * Owns the scene graph, camera, lighting rig and post-processing chain. The game
 * layer drives it through a small interface (`setLevel`, `updateCamera`,
 * `render`) rather than reaching into Three.js directly, which keeps the WebGL
 * details in one place.
 *
 * Lighting rig:
 *   - a procedural gradient sky that also feeds a cheap image-based ambient
 *   - one directional sun with soft shadows whose shadow camera FOLLOWS the
 *     player, so a 72 m arena gets centimetre-resolution shadows instead of
 *     pixelated ones spread across the whole map
 *   - the level's authored point lights, capped and sorted by distance so a map
 *     with thirty lamps does not cost thirty shader permutations
 *   - exponential fog matched to the sky's horizon so distance reads as haze
 *     rather than grey soup
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { SAOPass } from 'three/addons/postprocessing/SAOPass.js';
import { buildLevelMesh } from './LevelMesh.js';
import { getMaterial } from './textures.js';

const MAX_POINT_LIGHTS = 10;

const SkyShader = {
  uniforms: {
    topColor: { value: new THREE.Color('#1b2836') },
    midColor: { value: new THREE.Color('#8ea6bd') },
    horizonColor: { value: new THREE.Color('#c9b28c') },
    sunDir: { value: new THREE.Vector3(0.5, 0.6, 0.3) },
    sunColor: { value: new THREE.Color('#fff2dd') },
    sunIntensity: { value: 1.4 },
    haze: { value: 1.0 },
  },
  vertexShader: /* glsl */ `
    varying vec3 vDir;
    void main() {
      vDir = normalize(position);
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mv;
    }
  `,
  fragmentShader: /* glsl */ `
    uniform vec3 topColor;
    uniform vec3 midColor;
    uniform vec3 horizonColor;
    uniform vec3 sunDir;
    uniform vec3 sunColor;
    uniform float sunIntensity;
    uniform float haze;
    varying vec3 vDir;

    void main() {
      vec3 d = normalize(vDir);
      // Upward gradient with a warmer band pressed against the horizon.
      float h = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
      vec3 col = mix(horizonColor, midColor, smoothstep(0.42, 0.62, h));
      col = mix(col, topColor, smoothstep(0.6, 1.0, h));

      // A slight ground haze so the horizon does not read as a hard line.
      col = mix(col, horizonColor, smoothstep(0.5, 0.34, h) * 0.85 * haze);

      // Sun disc plus a wide forward-scattering bloom around it.
      float cosA = dot(d, normalize(sunDir));
      float disc = smoothstep(0.9986, 0.9995, cosA);
      float glow = pow(max(cosA, 0.0), 24.0) * 0.55 + pow(max(cosA, 0.0), 5.0) * 0.18;
      col += sunColor * (disc * 6.0 + glow) * sunIntensity;

      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }
  `,
};

/** Final grade: vignette, grain, saturation, edge fringing, damage flash. */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    resolution: { value: new THREE.Vector2(1, 1) },
    time: { value: 0 },
    vignette: { value: 0.42 },
    saturation: { value: 1.08 },
    contrast: { value: 1.05 },
    grain: { value: 0.035 },
    aberration: { value: 0.0016 },
    damage: { value: 0 },
    heal: { value: 0 },
    lowHealth: { value: 0 },
    flash: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 resolution;
    uniform float time;
    uniform float vignette;
    uniform float saturation;
    uniform float contrast;
    uniform float grain;
    uniform float aberration;
    uniform float damage;
    uniform float heal;
    uniform float lowHealth;
    uniform float flash;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }

    void main() {
      vec2 uv = vUv;
      vec2 centred = uv - 0.5;
      float r2 = dot(centred, centred);

      // Lateral chromatic aberration that grows toward the edges, which is where
      // a real lens shows it.
      vec2 offset = centred * r2 * aberration * 6.0;
      vec3 col;
      col.r = texture2D(tDiffuse, uv + offset).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - offset).b;

      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(luma), col, saturation);
      col = (col - 0.5) * contrast + 0.5;

      // Vignette.
      col *= 1.0 - vignette * smoothstep(0.18, 0.85, r2 * 1.9);

      // Damage: red push from the edges, plus a low-health desaturation toward
      // the centre so the screen feels like it is closing in.
      col = mix(col, vec3(col.r * 1.25, col.g * 0.55, col.b * 0.55), damage * (0.35 + 0.65 * smoothstep(0.0, 0.5, r2)));
      col = mix(col, vec3(luma * 0.7, luma * 0.12, luma * 0.12), lowHealth * 0.35);
      col += vec3(0.55, 0.85, 1.0) * heal * 0.25;
      col += vec3(flash);

      // Fine grain, slightly animated. Static grain looks like a broken image.
      float g = hash(uv * resolution + fract(time) * 137.0) - 0.5;
      col += g * grain;

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

export class Renderer {
  constructor(canvas, { settings } = {}) {
    this.canvas = canvas;
    this.settings = {
      shadows: true,
      bloom: true,
      ambientOcclusion: true,
      antialias: 'smaa',
      renderScale: 1,
      shadowQuality: 2048,
      bloomStrength: 0.42,
      motionBlur: false,
      fov: 88,
      ...settings,
    };

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // SMAA in the composer replaces MSAA
      powerPreference: 'high-performance',
      stencil: false,
      alpha: false,
    });
    this.renderer.setClearColor(0x0a0c10, 1);
    this.renderer.shadowMap.enabled = this.settings.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.info.autoReset = false;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(this.settings.fov, 16 / 9, 0.06, 420);
    this.camera.rotation.order = 'YXZ';

    this.levelInfo = null;
    this.levelGroup = null;
    this.dust = null;
    this.pointLights = [];
    this.clock = new THREE.Clock();
    this.time = 0;

    this.buildRig();
    this.buildComposer();

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this.resize();
  }

  // -------------------------------------------------------------- scene rig

  buildRig() {
    const { scene } = this;

    this.skyMaterial = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(SkyShader.uniforms),
      vertexShader: SkyShader.vertexShader,
      fragmentShader: SkyShader.fragmentShader,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(300, 32, 20), this.skyMaterial);
    this.sky.frustumCulled = false;
    scene.add(this.sky);

    this.hemi = new THREE.HemisphereLight(0x5d7794, 0x33291d, 0.55);
    scene.add(this.hemi);
    this.ambient = new THREE.AmbientLight(0xffffff, 0.12);
    scene.add(this.ambient);

    this.sun = new THREE.DirectionalLight(0xfff2dd, 2.6);
    this.sun.castShadow = this.settings.shadows;
    this.sun.shadow.mapSize.set(this.settings.shadowQuality, this.settings.shadowQuality);
    this.sun.shadow.bias = -0.0009;
    this.sun.shadow.normalBias = 0.035;
    // A tight orthographic frustum that follows the player: this is the single
    // biggest visual win available without a full cascaded shadow implementation.
    const extent = 34;
    this.shadowExtent = extent;
    const cam = this.sun.shadow.camera;
    cam.left = -extent;
    cam.right = extent;
    cam.top = extent;
    cam.bottom = -extent;
    cam.near = 1;
    cam.far = 190;
    cam.updateProjectionMatrix();
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.scene.fog = new THREE.FogExp2(0x93a6b8, 0.0115);

    // Muzzle-flash and explosion light, off until something uses it.
    this.pulseLight = new THREE.PointLight(0xffcf8a, 0, 22, 2);
    this.pulseLight.visible = false;
    scene.add(this.pulseLight);
  }

  buildComposer() {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.composer = new EffectComposer(this.renderer);
    this.composer.setSize(size.x, size.y);

    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    if (this.settings.ambientOcclusion) {
      try {
        this.saoPass = new SAOPass(this.scene, this.camera, false, false);
        this.saoPass.params.saoBias = 0.055;
        this.saoPass.params.saoIntensity = 0.0055;
        this.saoPass.params.saoScale = 6;
        this.saoPass.params.saoKernelRadius = 22;
        this.saoPass.params.saoMinResolution = 0;
        this.saoPass.params.saoBlur = true;
        this.composer.addPass(this.saoPass);
      } catch {
        this.saoPass = null;
      }
    }

    // The viewmodel is drawn here, after ambient occlusion and before bloom, so
    // it receives the same glow and grade as the world while never being
    // clipped by world geometry (its depth buffer is cleared first).
    this.viewPass = new RenderPass(new THREE.Scene(), new THREE.Camera());
    this.viewPass.clear = false;
    this.viewPass.clearDepth = true;
    this.viewPass.enabled = false;
    this.composer.addPass(this.viewPass);

    if (this.settings.bloom) {
      this.bloomPass = new UnrealBloomPass(size, this.settings.bloomStrength, 0.72, 0.72);
      this.composer.addPass(this.bloomPass);
    }

    this.gradePass = new ShaderPass(GradeShader);
    this.gradePass.uniforms.resolution.value.set(size.x, size.y);
    this.composer.addPass(this.gradePass);

    this.outputPass = new OutputPass();
    this.composer.addPass(this.outputPass);

    if (this.settings.antialias === 'smaa') {
      try {
        this.smaaPass = new SMAAPass(size.x, size.y);
        this.composer.addPass(this.smaaPass);
      } catch {
        this.smaaPass = null;
      }
    }
  }

  // ------------------------------------------------------------------ level

  /** Swap in a new level: builds geometry, lighting and atmosphere. */
  setLevel(level) {
    if (this.levelGroup) {
      this.scene.remove(this.levelGroup);
      disposeTree(this.levelGroup);
      this.levelGroup = null;
    }
    for (const light of this.pointLights) this.scene.remove(light);
    this.pointLights.length = 0;
    if (this.dust) {
      this.scene.remove(this.dust);
      this.dust.geometry.dispose();
      this.dust.material.dispose();
      this.dust = null;
    }

    const built = buildLevelMesh(level, {
      shadows: this.settings.shadows,
      contactAO: true,
    });
    this.levelInfo = built;
    this.levelGroup = built.group;
    this.scene.add(this.levelGroup);

    const env = level.environment || {};
    const sky = env.sky || ['#1b2836', '#8ea6bd', '#c9b28c'];
    this.skyMaterial.uniforms.topColor.value.set(sky[0]);
    this.skyMaterial.uniforms.midColor.value.set(sky[1]);
    this.skyMaterial.uniforms.horizonColor.value.set(sky[2]);

    const sun = env.sun || { dir: [-0.4, 0.7, 0.3], color: '#fff2dd', intensity: 2.6 };
    const dir = new THREE.Vector3(sun.dir[0], sun.dir[1], sun.dir[2]).normalize();
    this.sunDirection = dir;
    this.sun.color.set(sun.color);
    this.sun.intensity = sun.intensity;
    this.skyMaterial.uniforms.sunDir.value.copy(dir);
    this.skyMaterial.uniforms.sunColor.value.set(sun.color);
    this.skyMaterial.uniforms.sunIntensity.value = Math.min(1.6, sun.intensity * 0.5);

    const ambient = env.ambient || { color: '#5d7794', intensity: 0.55 };
    this.hemi.color.set(ambient.color);
    this.hemi.intensity = ambient.intensity;

    const fog = env.fog || { color: '#93a6b8', density: 0.011 };
    this.scene.fog = new THREE.FogExp2(new THREE.Color(fog.color).getHex(), fog.density);
    this.skyMaterial.uniforms.haze.value = Math.min(1.4, fog.density * 90);

    this.renderer.toneMappingExposure = env.exposure ?? 1.05;
    this.sun.shadow.mapSize.set(this.settings.shadowQuality, this.settings.shadowQuality);
    if (this.sun.shadow.map) {
      this.sun.shadow.map.dispose();
      this.sun.shadow.map = null;
    }

    // Authored lamps: capped at the brightest few and sorted nearest-first each
    // frame, so the shader never carries more than MAX_POINT_LIGHTS uniforms.
    const lights = (level.lights || []).slice(0, MAX_POINT_LIGHTS * 2);
    for (const def of lights) {
      const light = new THREE.PointLight(new THREE.Color(def.color), 0, def.distance || 18, 2);
      light.position.set(def.p[0], def.p[1], def.p[2]);
      light.userData.baseIntensity = def.intensity;
      light.userData.range = def.distance || 18;
      this.scene.add(light);
      this.pointLights.push(light);
    }

    if (env.dust && env.dust.count) this.buildDust(env.dust, level.bounds);
    this.activeLightIndices = new Set();

    return built;
  }

  /** Floating motes lit by the sun. Cheap, and it makes the air feel occupied. */
  buildDust(dust, bounds) {
    const count = Math.min(dust.count, 3000);
    const positions = new Float32Array(count * 3);
    const speeds = new Float32Array(count * 3);
    const w = bounds.max[0] - bounds.min[0];
    const h = bounds.max[1] - bounds.min[1];
    const d = bounds.max[2] - bounds.min[2];
    for (let i = 0; i < count; i++) {
      positions[i * 3] = bounds.min[0] + Math.random() * w;
      positions[i * 3 + 1] = bounds.min[1] + Math.random() * h;
      positions[i * 3 + 2] = bounds.min[2] + Math.random() * d;
      speeds[i * 3] = (Math.random() - 0.5) * 0.34;
      speeds[i * 3 + 1] = -Math.random() * 0.16 - 0.02;
      speeds[i * 3 + 2] = (Math.random() - 0.5) * 0.34;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({
      color: new THREE.Color(dust.color || '#d8d2c6'),
      size: dust.size || 0.05,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: true,
    });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.userData.speeds = speeds;
    points.userData.bounds = bounds;
    this.dust = points;
    this.scene.add(points);
  }

  // ------------------------------------------------------------------ frame

  /**
   * Drive the camera. The game layer supplies the already-reconciled position
   * and view angles, so this method stays purely presentational.
   */
  updateCamera({ position, yaw, pitch, fov, roll = 0, eyeHeight = 0 }) {
    this.camera.position.set(position[0], position[1] + eyeHeight, position[2]);
    this.camera.rotation.set(pitch, yaw, roll, 'YXZ');
    if (fov != null && Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    // A 200 m sky sphere cannot be fogged by distance, so it is parented to the
    // camera's position instead -- cheaper and always exactly correct.
    this.sky.position.copy(this.camera.position);
  }

  setGradeUniform(name, value) {
    if (this.gradePass && this.gradePass.uniforms[name]) this.gradePass.uniforms[name].value = value;
  }

  /** Install (or clear, with null) the first-person weapon overlay pass. */
  setViewmodel(scene, camera) {
    if (!this.viewPass) return;
    this.viewPass.scene = scene || new THREE.Scene();
    this.viewPass.camera = camera || new THREE.Camera();
    this.viewPass.enabled = !!(scene && camera);
  }

  update(dt, renderPos) {
    this.time += dt;
    const { scene } = this;

    // Shadow camera follows the player, snapped to the shadow texel grid so the
    // edge of every shadow does not crawl as you walk.
    if (this.sun && renderPos) {
      const texelSize = (this.shadowExtent * 2) / this.settings.shadowQuality;
      const sx = Math.round(renderPos[0] / texelSize) * texelSize;
      const sz = Math.round(renderPos[2] / texelSize) * texelSize;
      const dir = this.sunDirection || new THREE.Vector3(-0.4, 0.7, 0.3);
      this.sun.target.position.set(sx, renderPos[1], sz);
      this.sun.position.set(sx + dir.x * 90, renderPos[1] + dir.y * 90, sz + dir.z * 90);
      this.sun.target.updateMatrixWorld();
      this.sun.updateMatrixWorld();
    }

    // Only the nearest few lamps are lit; the rest are switched off entirely so
    // they cost nothing in the shader.
    if (this.pointLights.length) {
      const sorted = this.pointLights
        .map((light) => ({
          light,
          d: renderPos
            ? Math.hypot(light.position.x - renderPos[0], light.position.z - renderPos[2])
            : 0,
        }))
        .sort((a, b) => a.d - b.d);
      for (let i = 0; i < sorted.length; i++) {
        const { light, d } = sorted[i];
        const active = i < MAX_POINT_LIGHTS && d < 70;
        light.visible = active;
        light.intensity = active ? light.userData.baseIntensity * (1 - Math.min(1, d / 80) * 0.55) : 0;
      }
      this.activeLightIndices = new Set(sorted.slice(0, MAX_POINT_LIGHTS).map((s) => s.light.uuid));
    }

    if (this.dust) {
      const positions = this.dust.geometry.getAttribute('position');
      const speeds = this.dust.userData.speeds;
      const bounds = this.dust.userData.bounds;
      const arr = positions.array;
      for (let i = 0; i < positions.count; i++) {
        const i3 = i * 3;
        arr[i3] += speeds[i3] * dt;
        arr[i3 + 1] += speeds[i3 + 1] * dt;
        arr[i3 + 2] += speeds[i3 + 2] * dt;
        if (arr[i3 + 1] < bounds.min[1]) {
          arr[i3 + 1] = bounds.max[1];
          arr[i3] = bounds.min[0] + Math.random() * (bounds.max[0] - bounds.min[0]);
          arr[i3 + 2] = bounds.min[2] + Math.random() * (bounds.max[2] - bounds.min[2]);
        }
      }
      positions.needsUpdate = true;
    }

    if (this.gradePass) this.gradePass.uniforms.time.value = this.time;
    void scene;
  }

  render() {
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
    this.renderer.info.reset();
  }

  /** A brief world-space flash, used for muzzle flashes and explosions. */
  pulse(position, color = 0xffcf8a, intensity = 14, distance = 18, duration = 0.07) {
    this.pulseLight.color.set(color);
    this.pulseLight.intensity = intensity;
    this.pulseLight.distance = distance;
    this.pulseLight.position.set(position[0], position[1], position[2]);
    this.pulseLight.visible = true;
    this.pulseUntil = this.time + duration;
  }

  /** Call every frame so the flash decays instead of sticking on. */
  decayPulse() {
    if (this.pulseLight.visible && this.pulseUntil != null && this.time > this.pulseUntil) {
      this.pulseLight.intensity *= 0.4;
      if (this.pulseLight.intensity < 0.2) {
        this.pulseLight.intensity = 0;
        this.pulseLight.visible = false;
      }
    }
  }

  resize() {
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    const scale = this.settings.renderScale;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.max(2, Math.floor(width * scale));
    const pixelHeight = Math.max(2, Math.floor(height * scale));

    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(pixelWidth, pixelHeight, false);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();

    const buffer = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    if (this.composer) this.composer.setSize(buffer.x, buffer.y);
    if (this.gradePass) this.gradePass.uniforms.resolution.value.set(buffer.x, buffer.y);
    if (this.bloomPass) this.bloomPass.setSize(buffer.x, buffer.y);
    if (this.smaaPass) this.smaaPass.setSize(buffer.x, buffer.y);
    if (this.saoPass) this.saoPass.setSize(buffer.x, buffer.y);
  }

  applySettings(settings) {
    const prev = this.settings;
    this.settings = { ...prev, ...settings };

    if (this.settings.shadows !== prev.shadows) {
      this.renderer.shadowMap.enabled = this.settings.shadows;
      this.sun.castShadow = this.settings.shadows;
      for (const mesh of this.levelInfo?.meshes || []) {
        mesh.castShadow = this.settings.shadows;
        mesh.receiveShadow = this.settings.shadows;
      }
      this.renderer.shadowMap.needsUpdate = true;
    }
    if (this.settings.shadowQuality !== prev.shadowQuality) {
      this.sun.shadow.mapSize.set(this.settings.shadowQuality, this.settings.shadowQuality);
      if (this.sun.shadow.map) {
        this.sun.shadow.map.dispose();
        this.sun.shadow.map = null;
      }
    }
    if (this.bloomPass && this.settings.bloomStrength !== prev.bloomStrength) {
      this.bloomPass.strength = this.settings.bloomStrength;
    }
    if (this.gradePass) {
      this.gradePass.uniforms.saturation.value = this.settings.saturation ?? 1.08;
    }
    if (this.settings.renderScale !== prev.renderScale) this.resize();
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    if (this.levelGroup) disposeTree(this.levelGroup);
    if (this.dust) {
      this.dust.geometry.dispose();
      this.dust.material.dispose();
    }
    this.composer?.dispose?.();
    this.renderer.dispose();
  }
}

function disposeTree(root) {
  root.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
    // Materials are clones from the shared texture cache, so disposing them is
    // correct but their textures are deliberately left alone.
    if (child.material) {
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const m of materials) m.dispose();
    }
  });
}

export { getMaterial };
