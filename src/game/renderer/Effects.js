/**
 * Combat effects.
 *
 * Everything here is pooled. A 640 RPM rifle firing continuously would create
 * roughly ten objects per second per player, and allocating meshes at that rate
 * hands the garbage collector a sawtooth frame time. Pools are fixed size and
 * recycled oldest-first, which bounds both memory and draw calls.
 *
 * Draw-call budget: one mesh per tracer in flight (capped at 32), one for decals
 * (capped at 96), and one Points object per particle family. In practice a
 * firefight runs in single digits.
 */

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Procedural effect textures
// ---------------------------------------------------------------------------

function canvasTexture(size, draw, { srgb = true } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  draw(ctx, size);
  const tex = new THREE.CanvasTexture(canvas);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Dark scorch around a bullet strike, with hairline cracks outward. */
function makeImpactTexture() {
  return canvasTexture(128, (ctx, s) => {
    const c = s / 2;
    const grad = ctx.createRadialGradient(c, c, 0, c, c, c);
    grad.addColorStop(0, 'rgba(0,0,0,0.95)');
    grad.addColorStop(0.25, 'rgba(14,12,10,0.8)');
    grad.addColorStop(0.55, 'rgba(30,26,22,0.35)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, s, s);
    ctx.strokeStyle = 'rgba(8,7,6,0.55)';
    ctx.lineWidth = 1.4;
    for (let i = 0; i < 11; i++) {
      const angle = (i / 11) * Math.PI * 2 + Math.random();
      const len = c * (0.45 + Math.random() * 0.5);
      ctx.beginPath();
      ctx.moveTo(c, c);
      ctx.lineTo(c + Math.cos(angle) * len, c + Math.sin(angle) * len);
      ctx.stroke();
    }
    // Bright core so metal strikes glint.
    ctx.fillStyle = 'rgba(210,200,180,0.5)';
    ctx.beginPath();
    ctx.arc(c, c, s * 0.05, 0, Math.PI * 2);
    ctx.fill();
  });
}

function makeBloodTexture() {
  return canvasTexture(128, (ctx, s) => {
    const c = s / 2;
    for (let i = 0; i < 26; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = Math.random() * c * 0.85;
      const r = 2 + Math.random() * 9;
      const alpha = 0.25 + Math.random() * 0.6;
      ctx.fillStyle = `rgba(${90 + Math.random() * 40}, ${8 + Math.random() * 10}, ${8 + Math.random() * 12}, ${alpha})`;
      ctx.beginPath();
      ctx.ellipse(c + Math.cos(angle) * dist, c + Math.sin(angle) * dist, r, r * (0.6 + Math.random() * 0.7), Math.random() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}

function makeFlashTexture() {
  return canvasTexture(64, (ctx, s) => {
    const c = s / 2;
    const grad = ctx.createRadialGradient(c, c, 0, c, c, c);
    grad.addColorStop(0, 'rgba(255,255,245,1)');
    grad.addColorStop(0.24, 'rgba(255,232,170,0.9)');
    grad.addColorStop(0.55, 'rgba(255,170,60,0.32)');
    grad.addColorStop(1, 'rgba(255,120,20,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, s, s);
    // A few star spikes make it read as a muzzle flash rather than a blob.
    ctx.strokeStyle = 'rgba(255,240,200,0.85)';
    ctx.lineWidth = 2.4;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(c, c);
      ctx.lineTo(c + Math.cos(a) * c * 0.95, c + Math.sin(a) * c * 0.95);
      ctx.stroke();
    }
  });
}

function makeSmokeTexture() {
  return canvasTexture(64, (ctx, s) => {
    const c = s / 2;
    const grad = ctx.createRadialGradient(c, c, 0, c, c, c);
    grad.addColorStop(0, 'rgba(200,196,188,0.5)');
    grad.addColorStop(0.5, 'rgba(170,166,158,0.22)');
    grad.addColorStop(1, 'rgba(150,146,140,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, s, s);
  });
}

function makeDotTexture() {
  return canvasTexture(32, (ctx, s) => {
    const c = s / 2;
    const grad = ctx.createRadialGradient(c, c, 0, c, c, c);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.4, 'rgba(255,255,255,0.7)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, s, s);
  });
}

// ---------------------------------------------------------------------------
// Particles
// ---------------------------------------------------------------------------

/**
 * One Points object driving many particles. Per-particle lifetime, velocity,
 * gravity and size are integrated on the CPU and uploaded as three attributes,
 * which is fine for the few hundred particles a firefight actually produces.
 */
class ParticleSystem {
  constructor(scene, { count = 400, texture, color = 0xffffff, additive = true, baseSize = 0.09 }) {
    this.count = count;
    this.positions = new Float32Array(count * 3);
    this.velocities = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    this.maxLife = new Float32Array(count);
    this.sizes = new Float32Array(count);
    this.alpha = new Float32Array(count);
    this.gravity = new Float32Array(count);
    this.drag = new Float32Array(count);
    this.next = 0;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(this.sizes, 1));
    geometry.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1));
    geometry.setDrawRange(0, count);

    const material = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: texture },
        uColor: { value: new THREE.Color(color) },
        uPixelRatio: { value: Math.min(window.devicePixelRatio || 1, 2) },
      },
      vertexShader: /* glsl */ `
        attribute float size;
        attribute float alpha;
        uniform float uPixelRatio;
        varying float vAlpha;
        void main() {
          vAlpha = alpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * uPixelRatio * 320.0 / max(1.0, -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D map;
        uniform vec3 uColor;
        varying float vAlpha;
        void main() {
          vec4 tex = texture2D(map, gl_PointCoord);
          if (tex.a * vAlpha < 0.01) discard;
          gl_FragColor = vec4(uColor * tex.rgb, tex.a * vAlpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });

    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
    this.geometry = geometry;
    scene.add(this.points);
    // Park all particles out of sight until they are used.
    for (let i = 0; i < count; i++) this.positions[i * 3 + 1] = -9999;
  }

  spawn({ position, velocity, count = 6, spread = 0.6, speed = 3, life = 0.5, size = 0.08, gravity = 9, drag = 1.2, sizeJitter = 0.5 }) {
    for (let n = 0; n < count; n++) {
      const i = this.next;
      this.next = (this.next + 1) % this.count;
      const i3 = i * 3;
      this.positions[i3] = position[0];
      this.positions[i3 + 1] = position[1];
      this.positions[i3 + 2] = position[2];
      const vx = velocity[0] + (Math.random() - 0.5) * spread * speed;
      const vy = velocity[1] + (Math.random() - 0.5) * spread * speed;
      const vz = velocity[2] + (Math.random() - 0.5) * spread * speed;
      this.velocities[i3] = vx;
      this.velocities[i3 + 1] = vy;
      this.velocities[i3 + 2] = vz;
      const l = life * (0.65 + Math.random() * 0.7);
      this.life[i] = l;
      this.maxLife[i] = l;
      this.sizes[i] = size * (1 - sizeJitter / 2 + Math.random() * sizeJitter);
      this.alpha[i] = 1;
      this.gravity[i] = gravity;
      this.drag[i] = drag;
    }
  }

  update(dt) {
    const { positions, velocities, life, maxLife, alpha } = this;
    let any = false;
    for (let i = 0; i < this.count; i++) {
      if (life[i] <= 0) continue;
      any = true;
      life[i] -= dt;
      if (life[i] <= 0) {
        positions[i * 3 + 1] = -9999;
        alpha[i] = 0;
        continue;
      }
      const i3 = i * 3;
      velocities[i3 + 1] -= this.gravity[i] * dt;
      const d = Math.max(0, 1 - this.drag[i] * dt);
      velocities[i3] *= d;
      velocities[i3 + 1] *= d;
      velocities[i3 + 2] *= d;
      positions[i3] += velocities[i3] * dt;
      positions[i3 + 1] += velocities[i3 + 1] * dt;
      positions[i3 + 2] += velocities[i3 + 2] * dt;
      // Ease out, so particles fade rather than vanishing.
      const t = life[i] / maxLife[i];
      alpha[i] = t * t;
    }
    if (!any) return;
    this.geometry.getAttribute('position').needsUpdate = true;
    this.geometry.getAttribute('alpha').needsUpdate = true;
    this.geometry.getAttribute('size').needsUpdate = true;
  }

  dispose() {
    this.points.parent?.remove(this.points);
    this.geometry.dispose();
    this.points.material.dispose();
  }
}

// ---------------------------------------------------------------------------
// Tracers
// ---------------------------------------------------------------------------

/**
 * A tracer is a stretched, additive quad from muzzle to impact. It is aligned
 * along the shot and faded over ~70 ms, which is long enough to read the
 * direction of fire and short enough not to look like a laser.
 */
class TracerPool {
  constructor(scene, size = 32) {
    this.pool = [];
    const geometry = new THREE.PlaneGeometry(1, 1);
    for (let i = 0; i < size; i++) {
      const material = new THREE.MeshBasicMaterial({
        color: 0xffd9a0,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 5;
      scene.add(mesh);
      this.pool.push({ mesh, life: 0, maxLife: 0.07 });
    }
    this.geometry = geometry;
    this.next = 0;
    this.scene = scene;
  }

  spawn(from, to, { color = 0xffd9a0, width = 0.035, life = 0.07 } = {}) {
    const entry = this.pool[this.next];
    this.next = (this.next + 1) % this.pool.length;
    const { mesh } = entry;
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const dz = to[2] - from[2];
    const length = Math.hypot(dx, dy, dz);
    if (length < 0.05) return;

    mesh.position.set(from[0] + dx / 2, from[1] + dy / 2, from[2] + dz / 2);
    mesh.lookAt(to[0], to[1], to[2]);
    mesh.scale.set(width, width, 1);
    // The plane's local +Z is the shot direction after lookAt, so scaling Z
    // would not stretch it; the stretch goes on the plane's own axes instead.
    mesh.scale.set(width, length, 1);
    mesh.rotateZ(Math.PI / 2);
    mesh.material.color.set(color);
    mesh.material.opacity = 0.95;
    mesh.visible = true;
    entry.life = life;
    entry.maxLife = life;
  }

  update(dt) {
    for (const entry of this.pool) {
      if (entry.life <= 0) continue;
      entry.life -= dt;
      if (entry.life <= 0) {
        entry.mesh.visible = false;
        entry.mesh.material.opacity = 0;
        continue;
      }
      entry.mesh.material.opacity = (entry.life / entry.maxLife) * 0.95;
    }
  }

  dispose() {
    for (const entry of this.pool) {
      entry.mesh.parent?.remove(entry.mesh);
      entry.mesh.material.dispose();
    }
    this.geometry.dispose();
  }
}

// ---------------------------------------------------------------------------
// Decals
// ---------------------------------------------------------------------------

/** Impact marks laid flat on surfaces. Oldest-first recycling, faded on reuse. */
class DecalPool {
  constructor(scene, texture, size = 96) {
    this.pool = [];
    const geometry = new THREE.PlaneGeometry(1, 1);
    for (let i = 0; i < size; i++) {
      const material = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
        side: THREE.DoubleSide,
        fog: true,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.visible = false;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.pool.push({ mesh, life: 0, maxLife: 18 });
    }
    this.geometry = geometry;
    this.next = 0;
  }

  spawn(point, normal, { scale = 0.3, life = 18, opacity = 0.85, normalOffset = 0.012 } = {}) {
    const entry = this.pool[this.next];
    this.next = (this.next + 1) % this.pool.length;
    const { mesh } = entry;
    mesh.position.set(
      point[0] + normal[0] * normalOffset,
      point[1] + normal[1] * normalOffset,
      point[2] + normal[2] * normalOffset,
    );
    // Orient the quad to the surface it is stuck to. PlaneGeometry faces +Z, so
    // lookAt from just off the surface aims that axis down the normal.
    mesh.up.set(0, 1, 0);
    mesh.lookAt(
      mesh.position.x + normal[0],
      mesh.position.y + normal[1],
      mesh.position.z + normal[2],
    );
    mesh.scale.set(scale, scale, scale);
    mesh.rotateZ(Math.random() * Math.PI * 2);
    mesh.material.opacity = opacity;
    mesh.visible = true;
    entry.life = life;
    entry.maxLife = life;
    entry.opacity = opacity;
  }

  update(dt) {
    for (const entry of this.pool) {
      if (entry.life <= 0) continue;
      entry.life -= dt;
      if (entry.life <= 0) {
        entry.mesh.visible = false;
        entry.mesh.material.opacity = 0;
        continue;
      }
      // Hold full opacity, then fade the last quarter of the lifetime.
      const t = entry.life / entry.maxLife;
      entry.mesh.material.opacity = t > 0.25 ? entry.opacity : entry.opacity * (t / 0.25);
    }
  }

  clear() {
    for (const entry of this.pool) {
      entry.life = 0;
      entry.mesh.visible = false;
      entry.mesh.material.opacity = 0;
    }
  }

  dispose() {
    for (const entry of this.pool) {
      entry.mesh.parent?.remove(entry.mesh);
      entry.mesh.material.dispose();
    }
    this.geometry.dispose();
  }
}

// ---------------------------------------------------------------------------
// Muzzle flashes
// ---------------------------------------------------------------------------

/** Billboarded flash sprites attached in world space at the muzzle. */
class FlashPool {
  constructor(scene, texture, size = 8) {
    this.pool = [];
    const geometry = new THREE.PlaneGeometry(1, 1);
    for (let i = 0; i < size; i++) {
      const material = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
        fog: false,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.visible = false;
      mesh.renderOrder = 20;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.pool.push({ mesh, life: 0, maxLife: 0.05, baseScale: 0.5 });
    }
    this.geometry = geometry;
    this.next = 0;
  }

  spawn(position, { size = 0.55, life = 0.05, color = 0xffd9a0 } = {}) {
    const entry = this.pool[this.next];
    this.next = (this.next + 1) % this.pool.length;
    const { mesh } = entry;
    mesh.position.set(position[0], position[1], position[2]);
    mesh.material.color.set(color);
    mesh.material.opacity = 1;
    mesh.visible = true;
    entry.baseScale = size * (0.85 + Math.random() * 0.3);
    entry.life = life;
    entry.maxLife = life;
  }

  /** Billboarding is done here because the camera moves after spawning. */
  update(dt, camera) {
    for (const entry of this.pool) {
      if (entry.life <= 0) continue;
      entry.life -= dt;
      const { mesh } = entry;
      if (entry.life <= 0) {
        mesh.visible = false;
        mesh.material.opacity = 0;
        continue;
      }
      const t = entry.life / entry.maxLife;
      mesh.material.opacity = t;
      const s = entry.baseScale * (0.6 + (1 - t) * 0.8);
      mesh.scale.set(s, s, s);
      if (camera) mesh.quaternion.copy(camera.quaternion);
    }
  }

  dispose() {
    for (const entry of this.pool) {
      entry.mesh.parent?.remove(entry.mesh);
      entry.mesh.material.dispose();
    }
    this.geometry.dispose();
  }
}

// ---------------------------------------------------------------------------
// Facade
// ---------------------------------------------------------------------------

/**
 * Surface response table: what an impact looks like depends on what it hit,
 * which is one of the cheapest ways to make a level feel physical.
 */
const SURFACE_RESPONSE = {
  metal: { spark: 14, sparkColor: 0xffc98a, smoke: 2, decal: 0.22, sparkSpeed: 1.5, life: 0.35 },
  metalRust: { spark: 10, sparkColor: 0xffa060, smoke: 3, decal: 0.3, sparkSpeed: 1.2, life: 0.4 },
  metalGrate: { spark: 10, sparkColor: 0xffc98a, smoke: 2, decal: 0.2, sparkSpeed: 1.3, life: 0.3 },
  metalPlate: { spark: 13, sparkColor: 0xffd0a0, smoke: 2, decal: 0.22, sparkSpeed: 1.5, life: 0.32 },
  plate: { spark: 16, sparkColor: 0xffe0b0, smoke: 1, decal: 0.2, sparkSpeed: 1.8, life: 0.3 },
  glass: { spark: 18, sparkColor: 0xd8f0ff, smoke: 0, decal: 0.24, sparkSpeed: 2.2, life: 0.45 },
  containerRed: { spark: 10, sparkColor: 0xffb070, smoke: 3, decal: 0.3, sparkSpeed: 1.3, life: 0.4 },
  containerBlue: { spark: 10, sparkColor: 0xffb070, smoke: 3, decal: 0.3, sparkSpeed: 1.3, life: 0.4 },
  containerGreen: { spark: 10, sparkColor: 0xffb070, smoke: 3, decal: 0.3, sparkSpeed: 1.3, life: 0.4 },
  barrel: { spark: 11, sparkColor: 0xffb070, smoke: 3, decal: 0.3, sparkSpeed: 1.3, life: 0.4 },
  barrelYellow: { spark: 11, sparkColor: 0xffb070, smoke: 3, decal: 0.3, sparkSpeed: 1.3, life: 0.4 },
  dirt: { spark: 0, sparkColor: 0x8a7458, smoke: 8, decal: 0.34, sparkSpeed: 0.8, life: 0.7 },
  dirtTrench: { spark: 0, sparkColor: 0x6a5a44, smoke: 9, decal: 0.36, sparkSpeed: 0.8, life: 0.75 },
  dirtBerm: { spark: 0, sparkColor: 0x8a7458, smoke: 8, decal: 0.34, sparkSpeed: 0.8, life: 0.7 },
  dirtRoad: { spark: 0, sparkColor: 0x9a8468, smoke: 7, decal: 0.32, sparkSpeed: 0.9, life: 0.65 },
  sand: { spark: 0, sparkColor: 0xb7a680, smoke: 9, decal: 0.32, sparkSpeed: 0.9, life: 0.7 },
  sandbag: { spark: 0, sparkColor: 0x9a8d5f, smoke: 8, decal: 0.3, sparkSpeed: 0.9, life: 0.7 },
  crate: { spark: 3, sparkColor: 0xc09050, smoke: 5, decal: 0.3, sparkSpeed: 1.1, life: 0.5 },
  crateDark: { spark: 3, sparkColor: 0xa07840, smoke: 5, decal: 0.3, sparkSpeed: 1.1, life: 0.5 },
  woodBooth: { spark: 3, sparkColor: 0xc09050, smoke: 5, decal: 0.3, sparkSpeed: 1.1, life: 0.5 },
  treeTrunk: { spark: 3, sparkColor: 0xb08050, smoke: 4, decal: 0.28, sparkSpeed: 1.1, life: 0.5 },
  treeCanopy: { spark: 0, sparkColor: 0x4a6634, smoke: 5, decal: 0.26, sparkSpeed: 0.9, life: 0.6 },
  tarp: { spark: 0, sparkColor: 0x6d7257, smoke: 4, decal: 0.26, sparkSpeed: 0.8, life: 0.6 },
  tire: { spark: 0, sparkColor: 0x303236, smoke: 6, decal: 0.28, sparkSpeed: 0.7, life: 0.7 },
  concrete: { spark: 5, sparkColor: 0xffd0a0, smoke: 6, decal: 0.3, sparkSpeed: 1.2, life: 0.5 },
};

const DEFAULT_RESPONSE = SURFACE_RESPONSE.concrete;

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.impactTex = makeImpactTexture();
    this.bloodTex = makeBloodTexture();
    this.flashTex = makeFlashTexture();
    this.smokeTex = makeSmokeTexture();
    this.dotTex = makeDotTexture();

    this.decals = new DecalPool(scene, this.impactTex, 96);
    this.bloodDecals = new DecalPool(scene, this.bloodTex, 24);
    this.tracers = new TracerPool(scene, 32);
    this.flashes = new FlashPool(scene, this.flashTex, 8);

    this.sparks = new ParticleSystem(scene, {
      count: 420,
      texture: this.dotTex,
      color: 0xffc98a,
      additive: true,
      baseSize: 0.07,
    });
    this.smoke = new ParticleSystem(scene, {
      count: 340,
      texture: this.smokeTex,
      color: 0xc8c4bc,
      additive: false,
      baseSize: 0.4,
    });
    this.blood = new ParticleSystem(scene, {
      count: 260,
      texture: this.dotTex,
      color: 0x8e1010,
      additive: false,
      baseSize: 0.12,
    });
    this.debris = new ParticleSystem(scene, {
      count: 160,
      texture: this.dotTex,
      color: 0x9a8a70,
      additive: false,
      baseSize: 0.06,
    });
  }

  /** Bullet striking world geometry. */
  impact(point, normal, materialKey = 'concrete', { tracer = null } = {}) {
    const res = SURFACE_RESPONSE[materialKey] || DEFAULT_RESPONSE;

    this.decals.spawn(point, normal, { scale: res.decal, life: 18, opacity: 0.8 });

    if (res.spark > 0) {
      // Sparks bounce back along the surface normal, biased upward so they arc.
      const reflection = [
        normal[0] * 0.6 + (Math.random() - 0.5) * 0.4,
        Math.abs(normal[1]) * 0.5 + 0.5 + Math.random() * 0.4,
        normal[2] * 0.6 + (Math.random() - 0.5) * 0.4,
      ];
      this.sparks.spawn({
        position: [point[0] + normal[0] * 0.03, point[1] + normal[1] * 0.03, point[2] + normal[2] * 0.03],
        velocity: reflection,
        count: res.spark,
        spread: 0.9,
        speed: res.sparkSpeed * 3,
        life: res.life,
        size: 0.05,
        gravity: 11,
        drag: 1.4,
      });
    }

    if (res.smoke > 0) {
      this.smoke.spawn({
        position: [point[0] + normal[0] * 0.05, point[1] + normal[1] * 0.05, point[2] + normal[2] * 0.05],
        velocity: [normal[0] * 0.7, Math.abs(normal[1]) * 0.35 + 0.5, normal[2] * 0.7],
        count: res.smoke,
        spread: 0.7,
        speed: 0.8,
        life: res.life * 1.7,
        size: 0.42,
        gravity: -0.6,
        drag: 2.4,
      });
    }

    if (tracer) this.tracer(tracer[0], point);
    return res;
  }

  /** Blood spray where a bullet met a body. */
  spray(point, dir, part = 'torso') {
    this.bloodDecals.spawn(point, [0, 1, 0], { scale: part === 'head' ? 0.5 : 0.34, life: 14, opacity: 0.7 });
    this.blood.spawn({
      position: point,
      velocity: [dir[0] * 2.4, dir[1] * 1.6 + 0.8, dir[2] * 2.4],
      count: part === 'head' ? 22 : 12,
      spread: 1.1,
      speed: part === 'head' ? 4 : 2.6,
      life: 0.6,
      size: part === 'head' ? 0.09 : 0.07,
      gravity: 13,
      drag: 1.1,
    });
  }

  tracer(from, to, options) {
    this.tracers.spawn(from, to, options);
  }

  muzzleFlash(position, { size = 0.5, color = 0xffd9a0, life = 0.045 } = {}) {
    this.flashes.spawn(position, { size, color, life });
  }

  /** Grenade-free explosion used by explosive barrels and objective blasts. */
  explosion(position, { radius = 3.5, color = 0xffb060, sparks = 90 } = {}) {
    this.sparks.spawn({
      position,
      velocity: [0, 1.4, 0],
      count: sparks,
      spread: 1.4,
      speed: radius * 3.4,
      life: 0.8,
      size: 0.14,
      gravity: 12,
      drag: 0.9,
    });
    this.smoke.spawn({
      position,
      velocity: [0, 0.9, 0],
      count: 40,
      spread: 1.0,
      speed: radius * 1.1,
      life: 2.2,
      size: 1.4,
      gravity: -0.9,
      drag: 1.6,
    });
    this.debris.spawn({
      position,
      velocity: [0, 2.4, 0],
      count: 34,
      spread: 1.5,
      speed: radius * 2.6,
      life: 1.4,
      size: 0.11,
      gravity: 15,
      drag: 0.7,
    });
    void color;
  }

  update(dt, camera) {
    this.sparks.update(dt);
    this.smoke.update(dt);
    this.blood.update(dt);
    this.debris.update(dt);
    this.tracers.update(dt);
    this.decals.update(dt);
    this.bloodDecals.update(dt);
    this.flashes.update(dt, camera);
  }

  clear() {
    this.decals.clear();
    this.bloodDecals.clear();
  }

  dispose() {
    this.decals.dispose();
    this.bloodDecals.dispose();
    this.tracers.dispose();
    this.flashes.dispose();
    this.sparks.dispose();
    this.smoke.dispose();
    this.blood.dispose();
    this.debris.dispose();
    this.impactTex.dispose();
    this.bloodTex.dispose();
    this.flashTex.dispose();
    this.smokeTex.dispose();
    this.dotTex.dispose();
  }
}

export { SURFACE_RESPONSE };
