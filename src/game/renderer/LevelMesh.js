/**
 * Level geometry builder.
 *
 * The level is authored as a flat list of declarative brushes. This module turns
 * that list into as few draw calls as possible:
 *
 *   1. one BufferGeometry per brush, transformed into world space
 *   2. non-indexed, with world-space triplanar UVs baked in, so a 6 m wall and a
 *      0.4 m rail have the same texel density instead of the wall stretching
 *   3. merged by material, which collapses ~900 brushes into ~25 meshes
 *
 * Merging is what makes the scene renderable at all: 900 individual meshes would
 * be ~900 draw calls per frame before shadows, which is roughly three times the
 * frame budget on its own.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { getMaterial } from './textures.js';

/** Texels of world space per texture tile. Lower = larger features. */
const METRES_PER_TILE = 2.6;

/**
 * Build a triangular prism for a ramp brush.
 *
 * A ramp is a solid wedge: its walkable surface rises from `lowY` at one end to
 * `highY` at the other, and the material underneath is filled in. Rendering it
 * as a floating slope would leave a visible gap you can see straight through
 * from below.
 */
function wedgeGeometry(brush) {
  const [px, py, pz] = brush.p;
  const [sx, sy, sz] = brush.s;
  const axis = brush.axis || 'x';
  const dir = brush.dir >= 0 ? 1 : -1;

  // Half extents in (rise axis, cross axis).
  const aHalf = (axis === 'x' ? sx : sz) / 2;
  const cHalf = (axis === 'x' ? sz : sx) / 2;
  const aMin = -aHalf;
  const aMax = aHalf;
  const yMin = py - sy / 2;
  const yHigh = py + sy / 2;
  const yLow = py - sy / 2;
  const yTopAtA = (a) => (dir > 0 ? yLow + ((a - aMin) / (aMax - aMin)) * (yHigh - yLow) : yHigh - ((a - aMin) / (aMax - aMin)) * (yHigh - yLow));

  // The cross-section is a right triangle in the (a, y) plane.
  const tri = dir > 0
    ? [
        [aMin, yLow],
        [aMax, yMin],
        [aMax, yHigh],
      ]
    : [
        [aMin, yMin],
        [aMax, yLow],
        [aMin, yHigh],
      ];

  // Extrude that triangle along the cross axis.
  const vertex = (a, y, c) => (axis === 'x' ? new THREE.Vector3(px + a, y, pz + c) : new THREE.Vector3(px + c, y, pz + a));

  const positions = [];
  const pushTriangle = (pA, pB, pC) => {
    // Recompute the winding so the face normal points outward from the wedge.
    const ab = new THREE.Vector3().subVectors(pB, pA);
    const ac = new THREE.Vector3().subVectors(pC, pA);
    const normal = new THREE.Vector3().crossVectors(ab, ac);
    if (normal.lengthSq() < 1e-9) return;
    positions.push(pA.x, pA.y, pA.z, pB.x, pB.y, pB.z, pC.x, pC.y, pC.z);
  };

  const front = tri.map(([a, y]) => vertex(a, y, -cHalf));
  const back = tri.map(([a, y]) => vertex(a, y, cHalf));

  // End caps.
  pushTriangle(front[0], front[1], front[2]);
  pushTriangle(back[2], back[1], back[0]);

  // Three rectangular faces.
  const quads = [
    [0, 1],
    [1, 2],
    [2, 0],
  ];
  for (const [i, j] of quads) {
    const a = front[i];
    const b = front[j];
    const c = back[j];
    const d = back[i];
    pushTriangle(a, b, c);
    pushTriangle(a, c, d);
  }
  void yTopAtA;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** One BufferGeometry, world-space, for any brush type. */
function brushGeometry(brush) {
  const [px, py, pz] = brush.p;
  const [sx, sy, sz] = brush.s;
  let geometry;

  switch (brush.t) {
    case 'cyl': {
      // The collider for a cylinder is its bounding box, so the visual is
      // inscribed inside it -- you can never be stopped by air.
      geometry = new THREE.CylinderGeometry(sx, sx, sy, 14, 1, false);
      break;
    }
    case 'cone': {
      geometry = new THREE.ConeGeometry(sx, sy, 14, 1, false);
      break;
    }
    case 'ramp': {
      geometry = wedgeGeometry(brush);
      // Already positioned in world space.
      return geometry;
    }
    default: {
      geometry = new THREE.BoxGeometry(sx, sy, sz);
      break;
    }
  }

  geometry = geometry.toNonIndexed();
  const matrix = new THREE.Matrix4();
  const euler = new THREE.Euler(brush.rx || 0, brush.rot || 0, brush.rz || 0, 'YXZ');
  matrix.makeRotationFromEuler(euler);
  matrix.setPosition(px, py, pz);
  geometry.applyMatrix4(matrix);
  return geometry;
}

/**
 * Bake world-space planar UVs chosen per triangle by its dominant normal axis.
 * This is a triplanar projection flattened into the UV channel: cheap at build
 * time, free at render time, and it removes the seams and stretching you get
 * from per-face box UVs on merged geometry.
 */
function applyTriplanarUV(geometry, metresPerTile = METRES_PER_TILE) {
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const count = position.count;
  const uv = new Float32Array(count * 2);
  const scale = 1 / metresPerTile;

  for (let i = 0; i < count; i += 3) {
    // Use the triangle's averaged normal so all three vertices agree on a
    // projection plane; per-vertex choice would tear the triangle apart.
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let k = 0; k < 3; k++) {
      nx += normal.getX(i + k);
      ny += normal.getY(i + k);
      nz += normal.getZ(i + k);
    }
    const ax = Math.abs(nx);
    const ay = Math.abs(ny);
    const az = Math.abs(nz);

    for (let k = 0; k < 3; k++) {
      const x = position.getX(i + k);
      const y = position.getY(i + k);
      const z = position.getZ(i + k);
      let u;
      let v;
      if (ay >= ax && ay >= az) {
        // Floor or ceiling: project straight down.
        u = x * scale;
        v = z * scale;
      } else if (ax >= az) {
        u = z * scale;
        v = y * scale;
      } else {
        u = x * scale;
        v = y * scale;
      }
      uv[(i + k) * 2] = u;
      uv[(i + k) * 2 + 1] = v;
    }
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geometry;
}

/**
 * Darkness that collects where geometry meets the ground, baked as vertex
 * colour. A directional shadow map alone leaves objects looking like they float;
 * this reads as contact occlusion and costs nothing at runtime.
 */
function applyContactAO(geometry, groundY) {
  const position = geometry.getAttribute('position');
  const count = position.count;
  const color = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const y = position.getY(i);
    // 0 at ground level, easing to 1 about a metre up.
    const t = Math.min(1, Math.max(0, (y - groundY) / 1.1));
    const ao = 0.62 + 0.38 * Math.sqrt(t);
    color[i * 3] = ao;
    color[i * 3 + 1] = ao;
    color[i * 3 + 2] = ao;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(color, 3));
  return geometry;
}

/**
 * Build the renderable level.
 *
 * Returns the scene group plus a small amount of metadata the rest of the client
 * needs: the collider footprint list for the minimap, and the callouts used by
 * the HUD compass.
 */
export function buildLevelMesh(level, { shadows = true, contactAO = true } = {}) {
  const group = new THREE.Group();
  group.name = `level:${level.id}`;

  const byMaterial = new Map();
  const footprint = [];
  let triangleCount = 0;

  const groundY = level.bounds.min[1];

  for (const brush of level.brushes) {
    const key = brush.mat || 'concrete';
    let geometry = brushGeometry(brush);
    applyTriplanarUV(geometry, brush.metresPerTile || METRES_PER_TILE);
    if (contactAO) applyContactAO(geometry, groundY);

    triangleCount += geometry.getAttribute('position').count / 3;

    let list = byMaterial.get(key);
    if (!list) {
      list = [];
      byMaterial.set(key, list);
    }
    list.push(geometry);

    // Minimap footprint: everything that blocks movement or sight.
    if (brush.collide !== false) {
      const [sx, sy, sz] = brush.s;
      footprint.push({
        x: brush.p[0],
        z: brush.p[2],
        w: sx,
        d: sz,
        y0: brush.p[1] - sy / 2,
        y1: brush.p[1] + sy / 2,
        mat: key,
        top: brush.top !== false,
      });
    }
  }

  const meshes = [];
  for (const [key, geometries] of byMaterial) {
    const merged = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries, false);
    if (!merged) {
      // mergeGeometries returns null when attribute sets disagree. Falling back
      // to separate meshes is slower but never wrong.
      for (const g of geometries) {
        const mesh = new THREE.Mesh(g, makeVertexMaterial(key));
        mesh.castShadow = shadows;
        mesh.receiveShadow = shadows;
        group.add(mesh);
        meshes.push(mesh);
      }
      continue;
    }
    // Free the per-brush copies once merged: a level is hundreds of these.
    if (geometries.length > 1) for (const g of geometries) g.dispose();

    const material = makeVertexMaterial(key);
    const mesh = new THREE.Mesh(merged, material);
    mesh.name = `mat:${key}`;
    mesh.castShadow = shadows;
    // Floors must receive shadows; thin decorative slabs do not need to and
    // skipping that keeps the depth pass cheaper.
    mesh.receiveShadow = shadows;
    group.add(mesh);
    meshes.push(mesh);
  }

  return {
    group,
    meshes,
    footprint,
    triangles: Math.round(triangleCount),
    materials: [...byMaterial.keys()],
    bounds: level.bounds,
    callouts: level.callouts || [],
  };
}

/**
 * Materials are cloned per level build so vertex colours can be toggled without
 * leaking into the shared cached material (which other systems also use for
 * characters and props).
 */
function makeVertexMaterial(key) {
  const base = getMaterial(key);
  const material = base.clone();
  material.vertexColors = true;
  material.name = `level:${key}`;
  material.needsUpdate = true;
  return material;
}

/** Corner markers that read as the level's outer bounds, for orientation. */
export function buildBoundsHelper(level) {
  const { min, max } = level.bounds;
  const geometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(max[0] - min[0], max[1] - min[1], max[2] - min[2]));
  const material = new THREE.LineBasicMaterial({ color: 0x223344, transparent: true, opacity: 0.35 });
  const helper = new THREE.LineSegments(geometry, material);
  helper.position.set((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
  return helper;
}
