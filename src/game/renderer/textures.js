/**
 * Procedural PBR textures.
 *
 * The whole point of this module is that the game ships with no image assets:
 * every surface, normal map and roughness map is generated from noise at load
 * time. That keeps the repository tiny, guarantees the licence is clean, and
 * means a new material is a few lines of data rather than a new binary blob.
 *
 * Each material family is described by a colour function and a height function.
 * The height field is differentiated into a tangent-space normal map, which is
 * what actually sells the surface under the sun: concrete gets pitting, metal
 * gets brushed grain, sandbags get a fabric weave.
 */

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------

function hash2(x, y, seed) {
  let h = x * 374761393 + y * 668265263 + seed * 1274126177;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Smoothly interpolated value noise. */
function valueNoise(x, y, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

/** Fractal brownian motion: the workhorse for every surface here. */
export function fbm(x, y, octaves = 4, seed = 1, gain = 0.5, lacunarity = 2) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let fx = x;
  let fy = y;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(fx, fy, seed + i * 131) * amp;
    norm += amp;
    amp *= gain;
    fx *= lacunarity;
    fy *= lacunarity;
  }
  return sum / norm;
}

/** Tileable-ish ridge noise, good for cracks and rust streaks. */
function ridged(x, y, octaves = 3, seed = 7) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let fx = x;
  let fy = y;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(valueNoise(fx, fy, seed + i * 977) * 2 - 1);
    sum += n * n * amp;
    norm += amp;
    amp *= 0.5;
    fx *= 2;
    fy *= 2;
  }
  return sum / norm;
}

// ---------------------------------------------------------------------------
// Canvas helpers
// ---------------------------------------------------------------------------

function makeCanvas(size) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

/**
 * Render a per-pixel function into a canvas and return it as a THREE texture.
 * `fn` returns [r, g, b] in 0..255.
 */
function paint(size, fn, { repeat = 1, srgb = true, aniso = 8 } = {}) {
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(size, size);
  const data = image.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const c = fn(x / size, y / size, x, y);
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = aniso;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Convert a grayscale height field into a tangent-space normal map.
 * Sampling with wraparound keeps the result seamless when tiled.
 */
function normalMapFromHeight(size, heightFn, strength = 2.2, repeat = 1) {
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(size, size);
  const data = image.data;
  const step = 1 / size;
  const h = (x, y) => heightFn(((x % size) + size) % size, ((y % size) + size) % size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Central differences give a smoother normal than forward differences.
      const dx = (h(x + 1, y) - h(x - 1, y)) / (2 * step);
      const dy = (h(x, y + 1) - h(x, y - 1)) / (2 * step);
      let nx = -dx * strength;
      let ny = -dy * strength;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      const i = (y * size + x) * 4;
      data[i] = Math.round((nx * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round((nz / len) * 0.5 * 255 + 127.5);
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Grayscale map (roughness, metalness, ao) from a scalar function. */
function scalarMap(size, fn, { repeat = 1, channel = null } = {}) {
  return paint(
    size,
    (u, v, x, y) => {
      const val = Math.max(0, Math.min(1, fn(u, v, x, y)));
      const c = Math.round(val * 255);
      if (channel === 'r') return [c, 0, 0];
      if (channel === 'g') return [0, c, 0];
      if (channel === 'b') return [0, 0, c];
      return [c, c, c];
    },
    { repeat, srgb: false },
  );
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function shade(base, amount) {
  return [base[0] * amount, base[1] * amount, base[2] * amount];
}

function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// ---------------------------------------------------------------------------
// Material definitions
// ---------------------------------------------------------------------------

/**
 * `height` values are 0..1 and are differentiated into the normal map.
 * `rough` is a roughness value, optionally a function of noise.
 * `size` trades generation time for detail; 256 is plenty at these texel
 * densities because every brush tiles its map several times.
 */
const DEFS = {
  asphalt: {
    size: 256,
    tint: '#4a4d51',
    color: (u, v, n) => {
      const grain = n.fbm(u * 90, v * 90, 5, 11);
      const patch = n.fbm(u * 6, v * 6, 3, 21);
      const pebble = n.ridged(u * 220, v * 220, 2, 31);
      const base = mix(hexToRgb('#3a3d41'), hexToRgb('#5c6066'), grain * 0.7 + patch * 0.3);
      return shade(base, 0.82 + pebble * 0.36);
    },
    height: (u, v, n) => n.fbm(u * 130, v * 130, 4, 51) * 0.7 + n.ridged(u * 260, v * 260, 2, 61) * 0.3,
    rough: 0.88,
    metal: 0.02,
    normalScale: 1.1,
  },
  concrete: {
    size: 256,
    tint: '#8d8b84',
    color: (u, v, n) => {
      const grime = n.fbm(u * 5, v * 5, 4, 71);
      const grain = n.fbm(u * 120, v * 120, 4, 81);
      const speck = n.fbm(u * 400, v * 400, 2, 91);
      let c = mix(hexToRgb('#9a978e'), hexToRgb('#6f6d67'), grime);
      c = shade(c, 0.88 + grain * 0.24);
      // Cracks: ridges that only show where the grime mask is low.
      const crack = n.ridged(u * 9, v * 9, 3, 101);
      if (crack > 0.72) c = shade(c, 0.6);
      return shade(c, 0.94 + speck * 0.14);
    },
    height: (u, v, n) => {
      const crack = n.ridged(u * 9, v * 9, 3, 101);
      return n.fbm(u * 140, v * 140, 3, 111) * 0.6 + (crack > 0.72 ? -0.5 : 0) + crack * 0.3;
    },
    rough: (u, v, n) => 0.78 + n.fbm(u * 20, v * 20, 3, 121) * 0.18,
    metal: 0.02,
    normalScale: 1.3,
  },
  concreteDark: {
    size: 256,
    tint: '#4f504f',
    color: (u, v, n) => {
      const grime = n.fbm(u * 7, v * 7, 4, 131);
      const grain = n.fbm(u * 150, v * 150, 3, 141);
      return shade(mix(hexToRgb('#5d5f5c'), hexToRgb('#33352f'), grime), 0.9 + grain * 0.2);
    },
    height: (u, v, n) => n.fbm(u * 110, v * 110, 4, 151),
    rough: 0.9,
    metal: 0.03,
    normalScale: 1.2,
  },
  concreteMid: {
    size: 256,
    tint: '#77756f',
    color: (u, v, n) => {
      const grime = n.fbm(u * 6, v * 6, 3, 161);
      const grain = n.fbm(u * 130, v * 130, 3, 171);
      return shade(mix(hexToRgb('#848179'), hexToRgb('#5b5a55'), grime), 0.9 + grain * 0.2);
    },
    height: (u, v, n) => n.fbm(u * 100, v * 100, 3, 181),
    rough: 0.85,
    metal: 0.02,
    normalScale: 1,
  },
  concretePad: {
    size: 512,
    tint: '#82817b',
    color: (u, v, n) => {
      // Expansion joints on a regular grid, which reads instantly as a vehicle
      // pad or hardstanding rather than a generic wall.
      const gx = Math.abs(((u * 4) % 1) - 0.5);
      const gy = Math.abs(((v * 4) % 1) - 0.5);
      const joint = Math.min(gx, gy) < 0.012 ? 0.35 : 1;
      const grain = n.fbm(u * 200, v * 200, 4, 191);
      const stain = n.fbm(u * 4, v * 4, 3, 201);
      return shade(mix(hexToRgb('#8d8b83'), hexToRgb('#63625d'), stain), joint * (0.9 + grain * 0.22));
    },
    height: (u, v, n) => {
      const gx = Math.abs(((u * 4) % 1) - 0.5);
      const gy = Math.abs(((v * 4) % 1) - 0.5);
      const joint = Math.min(gx, gy) < 0.012 ? -1 : 0;
      return n.fbm(u * 160, v * 160, 3, 211) + joint;
    },
    rough: 0.8,
    metal: 0.02,
    normalScale: 1.2,
  },
  dirt: {
    size: 256,
    tint: '#6b5540',
    color: (u, v, n) => {
      const patch = n.fbm(u * 8, v * 8, 4, 221);
      const grain = n.fbm(u * 180, v * 180, 4, 231);
      const grit = n.fbm(u * 420, v * 420, 2, 241);
      const base = mix(hexToRgb('#7a6144'), hexToRgb('#4b3b2b'), patch);
      return shade(base, 0.85 + grain * 0.2 + grit * 0.12);
    },
    height: (u, v, n) => n.fbm(u * 150, v * 150, 4, 251) * 0.8 + n.fbm(u * 400, v * 400, 2, 261) * 0.2,
    rough: 0.96,
    metal: 0,
    normalScale: 1.5,
  },
  dirtTrench: {
    size: 256,
    tint: '#4f4030',
    color: (u, v, n) => {
      const patch = n.fbm(u * 10, v * 10, 4, 271);
      const grain = n.fbm(u * 160, v * 160, 4, 281);
      // Standing water darkens the lowest parts.
      const wet = patch < 0.34 ? 0.6 : 1;
      return shade(mix(hexToRgb('#5c4a34'), hexToRgb('#33291d'), patch), (0.86 + grain * 0.22) * wet);
    },
    height: (u, v, n) => n.fbm(u * 120, v * 120, 4, 291),
    rough: (u, v, n) => (n.fbm(u * 10, v * 10, 3, 271) < 0.34 ? 0.45 : 0.95),
    metal: 0,
    normalScale: 1.6,
  },
  dirtRoad: {
    size: 256,
    tint: '#6a5c48',
    color: (u, v, n) => {
      // Two worn wheel ruts running along V.
      const rut = Math.exp(-Math.pow((u - 0.3) / 0.11, 2)) + Math.exp(-Math.pow((u - 0.7) / 0.11, 2));
      const grain = n.fbm(u * 170, v * 170, 4, 301);
      return shade(mix(hexToRgb('#7d6b52'), hexToRgb('#4e4335'), n.fbm(u * 6, v * 6, 3, 311)), 0.88 + grain * 0.18 - rut * 0.12);
    },
    height: (u, v, n) => {
      const rut = Math.exp(-Math.pow((u - 0.3) / 0.11, 2)) + Math.exp(-Math.pow((u - 0.7) / 0.11, 2));
      return n.fbm(u * 140, v * 140, 4, 321) - rut * 0.5;
    },
    rough: 0.93,
    metal: 0,
    normalScale: 1.4,
  },
  dirtBerm: {
    size: 256,
    tint: '#5c4c38',
    color: (u, v, n) => shade(mix(hexToRgb('#6d5a41'), hexToRgb('#413528'), n.fbm(u * 7, v * 7, 4, 331)), 0.86 + n.fbm(u * 150, v * 150, 4, 341) * 0.24),
    height: (u, v, n) => n.fbm(u * 130, v * 130, 4, 351),
    rough: 0.97,
    metal: 0,
    normalScale: 1.5,
  },
  sand: {
    size: 256,
    tint: '#a99771',
    color: (u, v, n) => shade(mix(hexToRgb('#b7a680'), hexToRgb('#8c7c5c'), n.fbm(u * 9, v * 9, 3, 361)), 0.9 + n.fbm(u * 300, v * 300, 3, 371) * 0.18),
    height: (u, v, n) => n.fbm(u * 220, v * 220, 3, 381),
    rough: 0.95,
    metal: 0,
    normalScale: 0.9,
  },
  metal: {
    size: 256,
    tint: '#8a8f95',
    color: (u, v, n) => {
      const brush = n.fbm(u * 400, v * 12, 2, 391);
      const patch = n.fbm(u * 6, v * 6, 3, 401);
      return shade(mix(hexToRgb('#9aa0a6'), hexToRgb('#6c7176'), patch), 0.9 + brush * 0.2);
    },
    height: (u, v, n) => n.fbm(u * 420, v * 10, 2, 411),
    rough: (u, v, n) => 0.32 + n.fbm(u * 8, v * 8, 3, 421) * 0.3,
    metal: 0.85,
    normalScale: 0.6,
  },
  metalRust: {
    size: 256,
    tint: '#7a5a44',
    color: (u, v, n) => {
      const rust = n.fbm(u * 8, v * 8, 5, 431);
      const streak = n.fbm(u * 30, v * 3, 4, 441);
      const mask = Math.min(1, rust * 1.4 + streak * 0.5);
      const metal = hexToRgb('#767b80');
      const rustCol = mix(hexToRgb('#8a4a24'), hexToRgb('#5a3520'), n.fbm(u * 40, v * 40, 3, 451));
      return shade(mix(metal, rustCol, mask), 0.88 + n.fbm(u * 200, v * 200, 3, 461) * 0.2);
    },
    height: (u, v, n) => n.fbm(u * 120, v * 120, 4, 471) + (n.fbm(u * 8, v * 8, 5, 431) > 0.55 ? 0.35 : 0),
    rough: (u, v, n) => 0.35 + Math.min(1, n.fbm(u * 8, v * 8, 5, 431) * 1.3) * 0.5,
    metal: (u, v, n) => 0.8 - Math.min(1, n.fbm(u * 8, v * 8, 5, 431) * 1.3) * 0.6,
    normalScale: 1.2,
  },
  metalGrate: {
    size: 256,
    tint: '#5f6469',
    color: (u, v, n) => {
      // A lattice: bars along both axes with dark voids between them.
      const barU = Math.min(u * 6 % 1, 1 - (u * 6) % 1) < 0.28 ? 1 : 0;
      const barV = Math.min(v * 6 % 1, 1 - (v * 6) % 1) < 0.28 ? 1 : 0;
      const solid = Math.max(barU, barV);
      const grain = n.fbm(u * 200, v * 200, 3, 481);
      const col = solid ? shade(hexToRgb('#767c82'), 0.9 + grain * 0.2) : [14, 15, 17];
      return col;
    },
    height: (u, v, n) => {
      const barU = Math.min(u * 6 % 1, 1 - (u * 6) % 1) < 0.28 ? 1 : 0;
      const barV = Math.min(v * 6 % 1, 1 - (v * 6) % 1) < 0.28 ? 1 : 0;
      return Math.max(barU, barV) * 0.9 + n.fbm(u * 200, v * 200, 2, 491) * 0.1;
    },
    rough: 0.45,
    metal: 0.7,
    normalScale: 2.2,
    alphaTest: 0.35,
    transparent: true,
  },
  metalPlate: {
    size: 256,
    tint: '#6f7479',
    color: (u, v, n) => {
      // Diamond tread plate: two diagonal corrugations.
      const a = Math.abs(((u + v) * 8) % 1 - 0.5);
      const b = Math.abs(((u - v) * 8) % 1 - 0.5);
      const tread = Math.min(a, b) < 0.16 ? 1.25 : 1;
      return shade(mix(hexToRgb('#7d838a'), hexToRgb('#5b6066'), n.fbm(u * 40, v * 40, 3, 501)), tread * (0.92 + n.fbm(u * 220, v * 220, 3, 511) * 0.16));
    },
    height: (u, v, n) => {
      const a = Math.abs(((u + v) * 8) % 1 - 0.5);
      const b = Math.abs(((u - v) * 8) % 1 - 0.5);
      return (Math.min(a, b) < 0.16 ? 0.8 : 0) + n.fbm(u * 180, v * 180, 3, 521) * 0.2;
    },
    rough: 0.5,
    metal: 0.75,
    normalScale: 1.8,
  },
  metalBlue: {
    size: 256,
    tint: '#39485c',
    color: (u, v, n) => {
      const wear = n.fbm(u * 12, v * 12, 4, 531);
      const scratch = n.ridged(u * 60, v * 60, 2, 541);
      let c = mix(hexToRgb('#44566d'), hexToRgb('#2a3444'), wear);
      if (scratch > 0.78) c = mix(c, hexToRgb('#6b7075'), 0.6);
      return shade(c, 0.92 + n.fbm(u * 180, v * 180, 3, 551) * 0.16);
    },
    height: (u, v, n) => n.fbm(u * 140, v * 140, 4, 561),
    rough: (u, v, n) => 0.42 + n.fbm(u * 12, v * 12, 4, 531) * 0.28,
    metal: 0.6,
    normalScale: 1,
  },
  metalRed: {
    size: 256,
    tint: '#5e3630',
    color: (u, v, n) => {
      const wear = n.fbm(u * 12, v * 12, 4, 571);
      const scratch = n.ridged(u * 60, v * 60, 2, 581);
      let c = mix(hexToRgb('#6f3f37'), hexToRgb('#3d2420'), wear);
      if (scratch > 0.78) c = mix(c, hexToRgb('#6b7075'), 0.6);
      return shade(c, 0.92 + n.fbm(u * 180, v * 180, 3, 591) * 0.16);
    },
    height: (u, v, n) => n.fbm(u * 140, v * 140, 4, 601),
    rough: (u, v, n) => 0.42 + n.fbm(u * 12, v * 12, 4, 571) * 0.28,
    metal: 0.6,
    normalScale: 1,
  },
  containerRed: {
    size: 512,
    tint: '#7a3b2e',
    color: (u, v, n) => {
      // Vertical corrugation is the thing that makes a container read as one.
      const corr = Math.sin(u * Math.PI * 2 * 18) * 0.5 + 0.5;
      const rust = Math.min(1, n.fbm(u * 5, v * 5, 5, 611) * 1.5);
      const base = mix(hexToRgb('#8a4436'), hexToRgb('#4a2a22'), rust);
      return shade(base, 0.72 + corr * 0.42);
    },
    height: (u, v, n) => {
      const corr = Math.sin(u * Math.PI * 2 * 18) * 0.5 + 0.5;
      return corr * 0.85 + n.fbm(u * 100, v * 100, 3, 621) * 0.15;
    },
    rough: (u, v, n) => 0.55 + Math.min(1, n.fbm(u * 5, v * 5, 5, 611) * 1.5) * 0.35,
    metal: (u, v, n) => 0.55 - Math.min(1, n.fbm(u * 5, v * 5, 5, 611) * 1.5) * 0.4,
    normalScale: 1.6,
  },
  containerBlue: {
    size: 512,
    tint: '#2f4a63',
    color: (u, v, n) => {
      const corr = Math.sin(u * Math.PI * 2 * 18) * 0.5 + 0.5;
      const rust = Math.min(1, n.fbm(u * 5, v * 5, 5, 631) * 1.5);
      const base = mix(hexToRgb('#38566f'), hexToRgb('#22374a'), rust);
      return shade(base, 0.72 + corr * 0.42);
    },
    height: (u, v, n) => Math.sin(u * Math.PI * 2 * 18) * 0.5 * 0.85 + 0.425 + n.fbm(u * 100, v * 100, 3, 641) * 0.15,
    rough: 0.58,
    metal: 0.5,
    normalScale: 1.6,
  },
  containerGreen: {
    size: 512,
    tint: '#38513c',
    color: (u, v, n) => {
      const corr = Math.sin(u * Math.PI * 2 * 18) * 0.5 + 0.5;
      const rust = Math.min(1, n.fbm(u * 5, v * 5, 5, 651) * 1.5);
      const base = mix(hexToRgb('#425c46'), hexToRgb('#24331f'), rust);
      return shade(base, 0.72 + corr * 0.42);
    },
    height: (u, v, n) => Math.sin(u * Math.PI * 2 * 18) * 0.5 * 0.85 + 0.425 + n.fbm(u * 100, v * 100, 3, 661) * 0.15,
    rough: 0.6,
    metal: 0.45,
    normalScale: 1.6,
  },
  crate: {
    size: 256,
    tint: '#8a6a45',
    color: (u, v, n) => {
      // Plank lines with grain running along V.
      const plank = Math.floor(v * 5) / 5;
      const seam = Math.abs((v * 5) % 1 - 0.5) > 0.46 ? 0.6 : 1;
      const grain = n.fbm(u * 14, v * 90, 3, 671, 0.5, 2.2);
      const tone = mix(hexToRgb('#9c7a52'), hexToRgb('#6d5437'), (plank * 3) % 1);
      return shade(tone, (0.85 + grain * 0.3) * seam);
    },
    height: (u, v, n) => {
      const seam = Math.abs((v * 5) % 1 - 0.5) > 0.46 ? -0.6 : 0;
      return n.fbm(u * 14, v * 90, 3, 681) + seam;
    },
    rough: 0.85,
    metal: 0,
    normalScale: 1.4,
  },
  crateDark: {
    size: 256,
    tint: '#6b5236',
    color: (u, v, n) => {
      const seam = Math.abs((v * 5) % 1 - 0.5) > 0.46 ? 0.6 : 1;
      const grain = n.fbm(u * 14, v * 90, 3, 691);
      return shade(mix(hexToRgb('#7a5f3e'), hexToRgb('#4f3c28'), grain), 0.88 + grain * 0.24) && shade(mix(hexToRgb('#7a5f3e'), hexToRgb('#4f3c28'), grain), (0.88 + grain * 0.24) * seam);
    },
    height: (u, v, n) => n.fbm(u * 14, v * 90, 3, 701),
    rough: 0.88,
    metal: 0,
    normalScale: 1.4,
  },
  sandbag: {
    size: 256,
    tint: '#8b8055',
    color: (u, v, n) => {
      // Hessian weave: a fine two-axis check, then per-bag colour variance.
      const weave = (Math.sin(u * Math.PI * 2 * 60) + Math.sin(v * Math.PI * 2 * 60)) * 0.25 + 0.5;
      const bagTone = Math.floor(u * 4) / 4;
      const tone = mix(hexToRgb('#9a8d5f'), hexToRgb('#6f6644'), (bagTone * 7) % 1);
      const dirt = n.fbm(u * 10, v * 10, 3, 711);
      return shade(mix(tone, hexToRgb('#574f36'), dirt * 0.6), 0.86 + weave * 0.28);
    },
    height: (u, v, n) => (Math.sin(u * Math.PI * 2 * 60) + Math.sin(v * Math.PI * 2 * 60)) * 0.14 + 0.5 + n.fbm(u * 60, v * 60, 3, 721) * 0.3,
    rough: 0.95,
    metal: 0,
    normalScale: 1.3,
  },
  barrel: {
    size: 256,
    tint: '#3f5a4a',
    color: (u, v, n) => {
      const ribs = Math.sin(v * Math.PI * 2 * 4) * 0.5 + 0.5;
      const rust = Math.min(1, n.fbm(u * 8, v * 8, 4, 731) * 1.4);
      const base = mix(hexToRgb('#4b6b57'), hexToRgb('#2d4135'), rust);
      return shade(base, 0.85 + ribs * 0.2 + n.fbm(u * 180, v * 180, 3, 741) * 0.12);
    },
    height: (u, v, n) => Math.sin(v * Math.PI * 2 * 4) * 0.4 + 0.5 + n.fbm(u * 120, v * 120, 3, 751) * 0.2,
    rough: 0.62,
    metal: 0.5,
    normalScale: 1.5,
  },
  barrelYellow: {
    size: 256,
    tint: '#a8862c',
    color: (u, v, n) => {
      const ribs = Math.sin(v * Math.PI * 2 * 4) * 0.5 + 0.5;
      const rust = Math.min(1, n.fbm(u * 8, v * 8, 4, 761) * 1.3);
      const base = mix(hexToRgb('#c9a238'), hexToRgb('#7d6420'), rust);
      return shade(base, 0.85 + ribs * 0.2);
    },
    height: (u, v, n) => Math.sin(v * Math.PI * 2 * 4) * 0.4 + 0.5 + n.fbm(u * 120, v * 120, 3, 771) * 0.2,
    rough: 0.55,
    metal: 0.5,
    normalScale: 1.5,
  },
  pipe: {
    size: 128,
    tint: '#6b6f74',
    color: (u, v, n) => shade(mix(hexToRgb('#7d8288'), hexToRgb('#565b60'), n.fbm(u * 6, v * 40, 3, 781)), 0.9 + n.fbm(u * 200, v * 40, 3, 791) * 0.18),
    height: (u, v, n) => n.fbm(u * 30, v * 200, 3, 801),
    rough: 0.42,
    metal: 0.8,
    normalScale: 0.7,
  },
  mesh: {
    size: 128,
    tint: '#6a6f74',
    color: (u, v, n) => {
      // Chain-link: a diagonal grid with transparent holes.
      const a = (u * 14 + v * 14) % 1;
      const b = (u * 14 - v * 14) % 1;
      const wire = Math.abs(a - 0.5) > 0.4 || Math.abs(b - 0.5) > 0.4;
      return wire ? shade(hexToRgb('#8d9298'), 0.85 + n.fbm(u * 100, v * 100, 2, 811) * 0.3) : [0, 0, 0];
    },
    height: (u, v, n) => {
      const a = (u * 14 + v * 14) % 1;
      const b = (u * 14 - v * 14) % 1;
      return Math.abs(a - 0.5) > 0.4 || Math.abs(b - 0.5) > 0.4 ? 1 : 0;
    },
    rough: 0.4,
    metal: 0.8,
    normalScale: 1.5,
    transparent: true,
    alphaTest: 0.4,
    alphaMode: 'has',
  },
  glass: {
    size: 128,
    tint: '#7d90a0',
    color: (u, v, n) => shade(hexToRgb('#8ea3b4'), 0.55 + n.fbm(u * 30, v * 30, 2, 821) * 0.12),
    height: () => 0.5,
    rough: 0.06,
    metal: 0.1,
    transparent: true,
    opacity: 0.28,
    normalScale: 0.2,
  },
  tarp: {
    size: 256,
    tint: '#5b5f4a',
    color: (u, v, n) => {
      const weave = (Math.sin(u * Math.PI * 2 * 40) + Math.sin(v * Math.PI * 2 * 40)) * 0.12 + 0.5;
      const fold = n.fbm(u * 6, v * 6, 3, 831);
      return shade(mix(hexToRgb('#6d7257'), hexToRgb('#42463a'), fold), 0.86 + weave * 0.24);
    },
    height: (u, v, n) => n.fbm(u * 8, v * 8, 3, 841) * 0.7 + (Math.sin(u * Math.PI * 2 * 40) + Math.sin(v * Math.PI * 2 * 40)) * 0.08 + 0.5,
    rough: 0.9,
    metal: 0,
    normalScale: 1.4,
  },
  tire: {
    size: 128,
    tint: '#232629',
    color: (u, v, n) => {
      const tread = Math.sin(v * Math.PI * 2 * 16) * 0.5 + 0.5;
      return shade([36, 38, 41], 0.75 + tread * 0.5 + n.fbm(u * 80, v * 80, 3, 851) * 0.12);
    },
    height: (u, v, n) => Math.sin(v * Math.PI * 2 * 16) * 0.4 + 0.5 + n.fbm(u * 60, v * 60, 3, 861) * 0.2,
    rough: 0.95,
    metal: 0,
    normalScale: 1.8,
  },
  treeTrunk: {
    size: 256,
    tint: '#4a3f33',
    color: (u, v, n) => {
      // Vertical bark striations.
      const bark = Math.abs(((u * 22) % 1) - 0.5);
      const grain = n.fbm(u * 40, v * 6, 4, 871);
      const col = mix(hexToRgb('#5a4c3c'), hexToRgb('#33291f'), grain);
      return shade(col, 0.75 + (bark > 0.34 ? 0.35 : 0));
    },
    height: (u, v, n) => {
      const bark = Math.abs(((u * 22) % 1) - 0.5);
      return (bark > 0.34 ? 0.9 : 0.1) + n.fbm(u * 60, v * 10, 4, 881) * 0.3;
    },
    rough: 0.95,
    metal: 0,
    normalScale: 2,
  },
  treeCanopy: {
    size: 256,
    tint: '#2f4526',
    color: (u, v, n) => {
      const leaf = n.fbm(u * 26, v * 26, 5, 891);
      const shadev = Math.min(1, Math.max(0, (leaf - 0.35) * 2.2));
      const col = mix(hexToRgb('#22331c'), hexToRgb('#4a6634'), shadev);
      // Punch holes so foliage reads as sparse rather than a solid ball.
      return leaf < 0.24 ? [0, 0, 0] : shade(col, 0.85 + leaf * 0.3);
    },
    height: (u, v, n) => n.fbm(u * 26, v * 26, 5, 891),
    rough: 0.88,
    metal: 0,
    normalScale: 1.2,
    transparent: true,
    alphaTest: 0.35,
    alphaMode: 'has',
  },
  woodBooth: {
    size: 256,
    tint: '#7a6244',
    color: (u, v, n) => {
      const plank = Math.abs(((u * 4) % 1) - 0.5) > 0.46 ? 0.55 : 1;
      const grain = n.fbm(u * 90, v * 12, 3, 901);
      return shade(mix(hexToRgb('#8a7050'), hexToRgb('#5a4832'), grain), (0.88 + grain * 0.24) * plank);
    },
    height: (u, v, n) => n.fbm(u * 90, v * 12, 3, 911),
    rough: 0.88,
    metal: 0,
    normalScale: 1.3,
  },
  plate: {
    size: 128,
    tint: '#9aa0a5',
    color: (u, v, n) => shade(mix(hexToRgb('#b6bcc2'), hexToRgb('#888e94'), n.fbm(u * 20, v * 20, 3, 921)), 0.94 + n.fbm(u * 200, v * 200, 2, 931) * 0.12),
    height: (u, v, n) => n.fbm(u * 180, v * 180, 3, 941),
    rough: 0.38,
    metal: 0.85,
    normalScale: 0.8,
  },
  targetWhite: {
    size: 128,
    tint: '#c8cac6',
    color: (u, v, n) => {
      // Painted steel with a red centre ring, which is a hit-plate idiom.
      const d = Math.hypot(u - 0.5, v - 0.5);
      const col = d < 0.14 ? hexToRgb('#a8332a') : d < 0.2 ? hexToRgb('#d8d5cc') : hexToRgb('#9aa09c');
      return shade(col, 0.86 + n.fbm(u * 120, v * 120, 3, 951) * 0.2);
    },
    height: (u, v, n) => n.fbm(u * 130, v * 130, 3, 961),
    rough: 0.5,
    metal: 0.4,
    normalScale: 0.8,
  },
  marker: {
    size: 128,
    tint: '#d8b23a',
    color: (u, v, n) => {
      const stripe = Math.floor(u * 8) % 2 === 0;
      const col = stripe ? hexToRgb('#e0ba42') : hexToRgb('#22242a');
      return shade(col, 0.9 + n.fbm(u * 100, v * 100, 2, 971) * 0.16);
    },
    height: () => 0.5,
    rough: 0.7,
    metal: 0.1,
    normalScale: 0.4,
  },
};

const DEFAULT_DEF = DEFS.concrete;

/** Materials that read as foliage/vegetation get a slightly emissive tint. */
const SHEEN = {
  metal: { env: 1.0 },
  metalRust: { env: 0.6 },
  metalGrate: { env: 0.8 },
  metalPlate: { env: 0.9 },
  plate: { env: 0.9 },
  glass: { env: 1.4 },
};

function resolve(value, u, v, n) {
  return typeof value === 'function' ? value(u, v, n) : value;
}

const cache = new Map();

/**
 * Build (and cache) a MeshStandardMaterial for a material key.
 * Textures are generated once and shared, which is why every wall of the same
 * family tiles pixel-perfectly into the next.
 */
export function getMaterial(key, { texelScale = 0.5 } = {}) {
  const cached = cache.get(key);
  if (cached) return cached;
  const def = DEFS[key] || DEFAULT_DEF;

  const api = { fbm, ridged };
  const size = def.size || 256;

  const map = paint(size, (u, v) => def.color(u, v, api), { repeat: 1 });
  const normalMap = normalMapFromHeight(size, (x, y) => {
    const u = x / size;
    const v = y / size;
    const val = resolve(def.height, u, v, api);
    return typeof val === 'number' ? val : 0.5;
  }, def.normalScale ?? 1.2);

  // Roughness and metalness are packed into one map (G and B) so a single
  // texture fetch covers both, halving the texture bandwidth per surface.
  const ormMap = paint(
    size,
    (u, v) => {
      const r = (typeof def.rough === 'function' ? def.rough(u, v, api) : def.rough) ?? 0.8;
      const m = (typeof def.metal === 'function' ? def.metal(u, v, api) : def.metal) ?? 0;
      // R channel: ambient occlusion approximated from the height field.
      const hRaw = resolve(def.height, u, v, api);
      const h = typeof hRaw === 'number' ? hRaw : 0.5;
      return [Math.round((0.6 + h * 0.4) * 255), Math.round(Math.min(1, r) * 255), Math.round(Math.min(1, m) * 255)];
    },
    { srgb: false },
  );

  const material = new THREE.MeshStandardMaterial({
    map,
    normalMap,
    roughnessMap: ormMap,
    metalnessMap: ormMap,
    roughness: 1,
    metalness: 1,
    aoMapIntensity: 0.6,
  });

  material.userData.texelScale = texelScale;
  material.userData.defKey = key;

  if (def.transparent) {
    material.transparent = true;
    material.alphaTest = def.alphaTest ?? 0;
    material.side = THREE.DoubleSide;
    material.depthWrite = def.depthWrite ?? true;
    if (def.opacity != null) material.opacity = def.opacity;
  }
  if (def.alphaMode === 'has') material.alphaTest = def.alphaTest ?? 0.5;

  const sheen = SHEEN[key];
  if (sheen) {
    material.envMapIntensity = sheen.env;
    material.metalness = 0.9;
    material.roughness = 0.45;
  }

  material.name = key;
  cache.set(key, material);
  return material;
}

/** Material keys that are purely decorative (no collision). */
export function isDecorative(key) {
  return key === 'glass' || key === 'marker';
}

export const MATERIAL_KEYS = Object.keys(DEFS);

/**
 * Vertex-coloured material for cases where many brushes of one family need
 * per-brush tint without extra draw calls (the merged level mesh uses this for
 * team-coloured structures).
 */
export function makeTintedMaterial(base) {
  const material = base.clone();
  material.vertexColors = true;
  material.needsUpdate = true;
  return material;
}

export { fbm as noiseFbm };
