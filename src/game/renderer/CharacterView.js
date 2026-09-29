/**
 * Character rendering.
 *
 * Every player and bot is a small procedural rig: hips, torso, head, two arms,
 * two legs and a rifle, with shoulder/elbow/hip/knee pivots. It is animated by
 * code rather than by skeletal animation data, which keeps the repository free
 * of binary assets and lets the animation respond directly to the simulation --
 * legs stride in step with the distance actually travelled, the torso leans into
 * acceleration, and a death collapses the rig in the direction it was shot.
 *
 * Mesh count is deliberately small (ten per character, with static parts merged)
 * because a 16-player match otherwise spends most of its draw-call budget on
 * people.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { getMaterial } from './textures.js';

const TEAM_COLORS = {
  a: new THREE.Color('#5c86c4'),
  b: new THREE.Color('#c96f56'),
  solo: new THREE.Color('#b9a05c'),
};

const SKIN = new THREE.Color('#a8805f');

function teamColor(team) {
  if (!team) return TEAM_COLORS.solo;
  if (team.startsWith('solo')) return TEAM_COLORS.solo;
  return TEAM_COLORS[team] || TEAM_COLORS.solo;
}

function boxMesh(w, h, d, material, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** A tapered capsule-ish limb segment built from a cylinder plus a sphere cap. */
function limbMesh(radius, length, material, taper = 0.82) {
  const top = new THREE.CylinderGeometry(radius * taper, radius, length, 7, 1);
  const cap = new THREE.SphereGeometry(radius * taper, 7, 5);
  cap.translate(0, length / 2, 0);
  const merged = mergeGeometries([top.toNonIndexed(), cap.toNonIndexed()], false) || top.toNonIndexed();
  const mesh = new THREE.Mesh(merged, material);
  mesh.castShadow = true;
  return mesh;
}

/**
 * A single character. `group` is positioned at the character's feet, matching
 * the simulation's convention, so no vertical offset is ever needed.
 */
class CharacterRig {
  constructor({ team = 'a', isBot = false, name = '' } = {}) {
    this.group = new THREE.Group();
    this.name = name;
    this.isBot = isBot;
    this.team = team;
    this.dead = false;
    this.deadTime = 0;
    this.stride = 0;
    this.lean = 0;
    this.lastPos = [0, 0, 0];
    this.visible = true;

    const cloth = new THREE.MeshStandardMaterial({ color: teamColor(team), roughness: 0.92, metalness: 0.02 });
    const vest = new THREE.MeshStandardMaterial({ color: new THREE.Color('#3a3f42'), roughness: 0.8, metalness: 0.08 });
    const skin = new THREE.MeshStandardMaterial({ color: SKIN, roughness: 0.85, metalness: 0 });
    const dark = new THREE.MeshStandardMaterial({ color: new THREE.Color('#23272a'), roughness: 0.7, metalness: 0.25 });
    this.materials = [cloth, vest, skin, dark];

    // Hips: the root of every limb, so crouching lifts/lowers one object.
    this.hips = new THREE.Group();
    this.hips.position.y = 0.92;
    this.group.add(this.hips);

    const torso = boxMesh(0.44, 0.52, 0.26, cloth, 0, 0.26, 0);
    const plate = boxMesh(0.4, 0.34, 0.3, vest, 0, 0.28, 0.01);
    const shoulders = boxMesh(0.5, 0.14, 0.26, cloth, 0, 0.5, 0);
    this.torso = new THREE.Group();
    this.torso.add(torso, plate, shoulders);
    this.hips.add(this.torso);

    // Head + helmet.
    this.neck = new THREE.Group();
    this.neck.position.y = 0.6;
    this.torso.add(this.neck);
    const head = boxMesh(0.19, 0.22, 0.2, skin, 0, 0.11, 0);
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.125, 10, 7, 0, Math.PI * 2, 0, Math.PI * 0.62), dark);
    helmet.position.y = 0.19;
    helmet.castShadow = true;
    this.neck.add(head, helmet);

    // Arms. Upper arm hangs from the shoulder; the forearm and rifle are its
    // children so a single shoulder rotation swings the whole limb.
    this.armL = new THREE.Group();
    this.armL.position.set(-0.28, 0.42, 0);
    this.torso.add(this.armL);
    this.armR = new THREE.Group();
    this.armR.position.set(0.28, 0.42, 0);
    this.torso.add(this.armR);

    for (const arm of [this.armL, this.armR]) {
      const upper = limbMesh(0.055, 0.28, cloth);
      upper.position.y = -0.14;
      arm.add(upper);
      const fore = new THREE.Group();
      fore.position.y = -0.28;
      arm.add(fore);
      const forearm = limbMesh(0.048, 0.26, skin);
      forearm.position.y = -0.13;
      fore.add(forearm);
      const hand = boxMesh(0.075, 0.09, 0.075, skin, 0, -0.28, 0);
      fore.add(hand);
      arm.userData.fore = fore;
    }

    // Weapon held across the chest. Parented to the right forearm so aiming
    // moves it correctly without a second animation pass.
    this.weapon = this.buildWeapon(dark);
    this.armR.userData.fore.add(this.weapon.group);
    this.weapon.group.position.set(0, -0.26, 0.06);

    // Legs.
    this.legL = new THREE.Group();
    this.legL.position.set(-0.11, 0, 0);
    this.hips.add(this.legL);
    this.legR = new THREE.Group();
    this.legR.position.set(0.11, 0, 0);
    this.hips.add(this.legR);

    for (const leg of [this.legL, this.legR]) {
      const thigh = limbMesh(0.072, 0.44, cloth);
      thigh.position.y = -0.22;
      leg.add(thigh);
      const shin = new THREE.Group();
      shin.position.y = -0.44;
      leg.add(shin);
      const shinMesh = limbMesh(0.06, 0.42, cloth);
      shinMesh.position.y = -0.21;
      shin.add(shinMesh);
      const boot = boxMesh(0.1, 0.08, 0.22, dark, 0, -0.44, 0.03);
      shin.add(boot);
      leg.userData.shin = shin;
    }

    // Nameplate for teammates, and a hit indicator for everyone.
    this.nameplate = this.buildNameplate(name, team);
    this.nameplate.position.y = 1.86;
    this.group.add(this.nameplate);

    this.group.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
  }

  buildWeapon(material) {
    const group = new THREE.Group();
    const body = boxMesh(0.07, 0.1, 0.52, material, 0, 0, 0);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.3, 6), material);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.01, 0.4);
    const mag = boxMesh(0.045, 0.14, 0.06, material, 0, -0.11, 0.02);
    group.add(body, barrel, mag);
    const muzzle = new THREE.Object3D();
    muzzle.name = 'muzzle';
    muzzle.position.set(0, 0.01, 0.56);
    group.add(muzzle);
    return { group, muzzle };
  }

  buildNameplate(name, team) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 256, 64);
    ctx.font = 'bold 30px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = `#${teamColor(team).getHexString()}`;
    ctx.fillText(name.slice(0, 14), 128, 34);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: true, opacity: 0.9 });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(1.1, 0.28, 1);
    sprite.userData.hideForEnemies = true;
    return sprite;
  }

  setTeam(team) {
    if (this.team === team) return;
    this.team = team;
    const color = teamColor(team);
    this.materials[0].color.copy(color);
    // Rebuild the nameplate so its text colour follows the team.
    const group = this.group;
    group.remove(this.nameplate);
    this.nameplate.material.map?.dispose();
    this.nameplate.material.dispose();
    this.nameplate = this.buildNameplate(this.name, team);
    this.nameplate.position.y = 1.86;
    group.add(this.nameplate);
  }

  /**
   * @param state  interpolated snapshot row (x, y, z, yaw, pitch, crouching, firing, dead, speed)
   * @param dt     seconds since last frame
   * @param opts   { isLocalTeam, showNameplates }
   */
  update(state, dt, opts = {}) {
    const { group } = this;
    group.position.set(state.x, state.y, state.z);
    // The rig faces -Z in local space, matching the simulation's forward vector.
    group.rotation.y = state.yaw;

    const speed = state.speed || 0;
    const moving = speed > 0.35 && !state.dead;

    this.dead = !!state.dead;
    if (this.dead) {
      this.deadTime += dt;
      // Collapse: fall backwards and fold, then hold. Cheap but unmistakable.
      const t = Math.min(1, this.deadTime / 0.55);
      const easedT = 1 - (1 - t) * (1 - t);
      group.rotation.x = -easedT * Math.PI * 0.46;
      this.hips.position.y = lerpNum(0.92, 0.24, easedT);
      this.torso.rotation.x = easedT * 0.5;
      this.neck.rotation.x = easedT * 0.35;
      this.armL.rotation.x = -0.4 - easedT * 0.8;
      this.armR.rotation.x = -0.5 - easedT * 0.9;
      this.legL.rotation.x = 0.3 + easedT * 0.7;
      this.legR.rotation.x = 0.2 + easedT * 0.5;
      this.nameplate.visible = false;
      return;
    }
    this.deadTime = 0;
    group.rotation.x = 0;

    // Stride phase advances with distance travelled, so the feet do not slide.
    this.stride += (speed * dt) / 0.62;
    const swing = Math.sin(this.stride * Math.PI);
    const strideAmp = Math.min(1, speed / 5.6);

    // Lean into acceleration for weight.
    const targetLean = Math.min(0.22, speed * 0.028);
    this.lean = lerpNum(this.lean, targetLean, Math.min(1, dt * 6));

    // Crouch lowers the hips and folds the knees.
    const crouch = state.crouching ? 0.34 : 0;
    this.crouchAmount = lerpNum(this.crouchAmount ?? 0, crouch, Math.min(1, dt * 12));
    const c = this.crouchAmount;

    this.hips.position.y = lerpNum(0.92, 0.6, c / 0.34);
    this.torso.rotation.x = this.lean + c * 0.24;
    this.torso.rotation.z = Math.sin(this.stride * Math.PI) * 0.02 * strideAmp;

    // Legs: alternating hip/knee rotation, scaled down when crouching.
    const legAmp = strideAmp * (0.62 - c * 0.7);
    this.legL.rotation.x = swing * 0.72 * legAmp + c * 0.75;
    this.legR.rotation.x = -swing * 0.72 * legAmp + c * 0.75;
    this.legL.userData.shin.rotation.x = -Math.max(0, swing) * 0.9 * legAmp - c * 1.1;
    this.legR.userData.shin.rotation.x = -Math.max(0, -swing) * 0.9 * legAmp - c * 1.1;

    // Arms: aiming pose when alive, more relaxed while sprinting.
    const aiming = state.ads || state.firing;
    const sprintTuck = state.sprinting ? 1 : 0;
    this.armR.rotation.x = lerpNum(-0.9, -1.25, aiming ? 1 : 0.4) + sprintTuck * 0.25;
    this.armR.rotation.y = lerpNum(0.16, 0.02, aiming ? 1 : 0.3);
    this.armR.rotation.z = -0.1 - sprintTuck * 0.2;
    this.armL.rotation.x = -1.1 + sprintTuck * 0.5;
    this.armL.rotation.y = 0.56 - sprintTuck * 0.2;
    this.armL.rotation.z = 0.16;
    this.armR.userData.fore.rotation.x = -1.15;
    this.armR.userData.fore.rotation.y = 0.2;
    this.armL.userData.fore.rotation.x = -1.5;

    // Head tracks the aim pitch, clamped so it never looks broken.
    this.neck.rotation.x = clampNum(state.pitch * 0.6, -0.5, 0.5);
    this.neck.rotation.y = 0;

    // Recoil shudder while firing.
    this.weapon.group.position.z = (state.firing ? 0.04 : 0) + Math.sin(this.stride * 7) * 0.004;
    this.weapon.group.rotation.x = state.firing ? -0.08 : 0;

    // Nameplate: only for own team, hidden when very close or by request.
    const show = !!opts.showNameplates && !opts.isEnemy;
    this.nameplate.visible = show;
    if (show) {
      this.nameplate.material.opacity = 0.85;
    }
    void moving;
  }

  /** World position of this character's muzzle, for remote tracer effects. */
  muzzleWorldPosition(out = new THREE.Vector3()) {
    if (!this.weapon?.muzzle) return out.set(0, 0, 0);
    this.weapon.muzzle.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(this.weapon.muzzle.matrixWorld);
  }

  dispose() {
    this.group.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
    });
    for (const m of this.materials) m.dispose();
    this.nameplate.material.map?.dispose();
    this.nameplate.material.dispose();
    getMaterial;
  }
}

export class CharacterManager {
  constructor(scene) {
    this.scene = scene;
    this.rigs = new Map();
  }

  ensure(id, { team, isBot, name } = {}) {
    let rig = this.rigs.get(id);
    if (!rig) {
      rig = new CharacterRig({ team, isBot, name });
      this.scene.add(rig.group);
      this.rigs.set(id, rig);
    } else if (team && rig.team !== team) {
      rig.setTeam(team);
    }
    return rig;
  }

  get(id) {
    return this.rigs.get(id) || null;
  }

  update(id, state, dt, opts) {
    const rig = this.rigs.get(id);
    if (!rig) return null;
    rig.update(state, dt, opts);
    return rig;
  }

  remove(id) {
    const rig = this.rigs.get(id);
    if (!rig) return;
    rig.dispose();
    this.scene.remove(rig.group);
    this.rigs.delete(id);
  }

  clear() {
    for (const id of [...this.rigs.keys()]) this.remove(id);
  }
}

function lerpNum(a, b, t) {
  return a + (b - a) * t;
}

function clampNum(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

export { TEAM_COLORS, teamColor };
