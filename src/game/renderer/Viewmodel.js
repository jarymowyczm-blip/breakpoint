/**
 * First-person viewmodel.
 *
 * Rendered in its own scene by a second RenderPass with a cleared depth buffer.
 * That is the only way to guarantee the weapon never pokes through a wall while
 * still letting it receive the same bloom and colour grade as the world -- the
 * usual alternative, a huge depth-bias offset, breaks down the moment you stand
 * against a crate.
 *
 * The view camera has the same FOV and orientation as the main camera and sits
 * at the origin in view space. That matters: it means the muzzle's world
 * position can be computed exactly, so tracers and muzzle flashes originate at
 * the barrel rather than near it.
 *
 * Animation layers, in the order they are applied each frame:
 *   base pose -> ADS blend -> switch/draw -> reload -> bob/sway -> recoil kick
 */

import * as THREE from 'three';
import { getWeapon } from '../../net/shared/weapons.js';
import { clamp, lerp } from '../../net/shared/math.js';

const BASE_POSITION = new THREE.Vector3(0.105, -0.16, -0.3);
const BASE_ROTATION = new THREE.Euler(0.02, -0.06, 0.02);
const ADS_POSITION = new THREE.Vector3(0, -0.062, -0.19);
const ADS_ROTATION = new THREE.Euler(0, 0, 0);
/** Viewmodels are modelled at real scale then shrunk to read correctly at 88° FOV. */
const VIEW_SCALE = 0.62;

function metal(color = '#2c3034', roughness = 0.55, metalness = 0.75) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

export class Viewmodel {
  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(88, 16 / 9, 0.008, 6);

    // Lighting the weapon independently of the world is deliberate: a gun that
    // is lit by the world goes black in a shadowed corner, which reads as a bug.
    this.key = new THREE.DirectionalLight(0xffffff, 2.1);
    this.key.position.set(-0.6, 1.0, 0.8);
    this.scene.add(this.key);
    this.fill = new THREE.DirectionalLight(0x9fb6cc, 0.85);
    this.fill.position.set(0.8, -0.3, 0.5);
    this.scene.add(this.fill);
    this.rim = new THREE.DirectionalLight(0xffd9a8, 0.7);
    this.rim.position.set(0.2, 0.4, -1);
    this.scene.add(this.rim);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.28));

    this.root = new THREE.Group();
    this.root.scale.setScalar(VIEW_SCALE);
    this.scene.add(this.root);

    this.weaponId = null;
    this.group = null;
    this.muzzle = null;
    this.magazine = null;
    this.bolt = null;

    // Animation state.
    this.adsAmount = 0;
    this.adsTarget = 0;
    this.bobPhase = 0;
    this.bobAmount = 0;
    this.swayX = 0;
    this.swayY = 0;
    this.recoil = 0;
    this.recoilYaw = 0;
    this.recoilRecovery = 8.5;
    this.reloadT = 0;
    this.reloadDuration = 0;
    this.switchT = 0;
    this.switchDuration = 0;
    this.kickFlip = 0;
    this.lastYaw = 0;
    this.lastPitch = 0;
    this.time = 0;

    this.setWeapon('ar');
  }

  // ------------------------------------------------------------ construction

  /** Build a weapon from its data sheet. Rebuilds only when the model changes. */
  setWeapon(weaponId) {
    const weapon = getWeapon(weaponId);
    if (this.weaponId === weapon.id && this.group) return;

    if (this.group) {
      this.root.remove(this.group);
      this.group.traverse((child) => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) child.material.dispose();
      });
    }

    this.weaponId = weapon.id;
    this.weapon = weapon;
    this.recoilRecovery = weapon.recoil.recovery;
    this.group = this.buildModel(weapon);
    this.root.add(this.group);
    this.muzzle = this.group.getObjectByName('muzzle');
    this.magazine = this.group.getObjectByName('magazine');
    this.bolt = this.group.getObjectByName('bolt');
  }

  /**
   * Low-poly but readable: receiver, barrel, handguard, magazine, stock, grip,
   * optic and sights. Silhouette does the work -- at 60 fps in the corner of the
   * screen, shape recognition beats polygon count.
   */
  buildModel(weapon) {
    const group = new THREE.Group();
    group.name = `weapon:${weapon.id}`;
    const m = weapon.model || {};
    const [rw, rh, rd] = m.receiver || [0.4, 0.16, 0.9];
    const [br, bl] = [m.barrel?.[0] ?? 0.06, m.barrel?.[2] ?? 0.5];
    const [mw, mh, md] = m.mag || [0.12, 0.3, 0.28];
    const [sw, sh, sd] = m.stock || [0.16, 0.14, 0.42];
    const bodyColor = m.color || '#3b4046';

    const bodyMat = metal(bodyColor, 0.52, 0.8);
    const darkMat = metal('#1d2024', 0.62, 0.7);
    const accentMat = metal('#5a6168', 0.4, 0.85);

    // Receiver, split into upper and lower so the shape reads as a rifle.
    const receiver = new THREE.Mesh(new THREE.BoxGeometry(rw, rh * 0.62, rd), bodyMat);
    receiver.position.set(0, 0, 0);
    group.add(receiver);

    const lower = new THREE.Mesh(new THREE.BoxGeometry(rw * 0.86, rh * 0.5, rd * 0.62), darkMat);
    lower.position.set(0, -rh * 0.5, rd * 0.06);
    group.add(lower);

    // Top rail.
    const rail = new THREE.Mesh(new THREE.BoxGeometry(rw * 0.5, 0.018, rd * 0.86), darkMat);
    rail.position.set(0, rh * 0.34, 0);
    group.add(rail);

    // Handguard with vent slots.
    const guard = new THREE.Mesh(new THREE.BoxGeometry(rw * 0.82, rh * 0.52, rd * 0.4), darkMat);
    guard.position.set(0, 0, rd * 0.62);
    group.add(guard);
    for (let i = 0; i < 3; i++) {
      const slot = new THREE.Mesh(new THREE.BoxGeometry(rw * 0.9, 0.012, 0.05), accentMat);
      slot.position.set(0, rh * 0.06, rd * 0.62 + (i - 1) * 0.09);
      group.add(slot);
    }

    // Barrel and muzzle device.
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(br, br * 1.05, bl, 10), accentMat);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0, rd * 0.62 + rd * 0.2 + bl / 2);
    group.add(barrel);

    const tipZ = rd * 0.62 + rd * 0.2 + bl;
    const tip = new THREE.Mesh(new THREE.CylinderGeometry(br * 1.5, br * 1.5, 0.075, 8), darkMat);
    tip.rotation.x = Math.PI / 2;
    tip.position.set(0, 0, tipZ + 0.02);
    group.add(tip);

    // Magazine: named so the reload animation can move it on its own.
    const magazine = new THREE.Mesh(new THREE.BoxGeometry(mw, mh, md), darkMat);
    magazine.name = 'magazine';
    magazine.position.set(0, -mh / 2 - rh * 0.4, -rd * 0.04);
    magazine.rotation.x = weapon.fireMode === 'pump' ? 0 : -0.08;
    group.add(magazine);

    // Pistol grip.
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.16, 0.075), darkMat);
    grip.position.set(0, -rh * 0.72, -rd * 0.24);
    grip.rotation.x = 0.28;
    group.add(grip);

    // Stock.
    const stock = new THREE.Mesh(new THREE.BoxGeometry(sw, sh * 0.85, sd), bodyMat);
    stock.position.set(0, -rh * 0.06, -rd * 0.5 - sd / 2);
    group.add(stock);
    const cheek = new THREE.Mesh(new THREE.BoxGeometry(sw * 0.7, 0.03, sd * 0.8), darkMat);
    cheek.position.set(0, sh * 0.14, -rd * 0.5 - sd / 2);
    group.add(cheek);

    // Optic: a tube with a lens, sitting on the rail.
    const optic = new THREE.Group();
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.13, 12), darkMat);
    tube.rotation.x = Math.PI / 2;
    optic.add(tube);
    const lens = new THREE.Mesh(
      new THREE.CircleGeometry(0.028, 12),
      new THREE.MeshStandardMaterial({ color: 0x6fa8c8, roughness: 0.08, metalness: 0.2, emissive: 0x0d2430, emissiveIntensity: 0.8 }),
    );
    lens.position.z = 0.066;
    optic.add(lens);
    const mount = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.035, 0.05), darkMat);
    mount.position.y = -0.03;
    optic.add(mount);
    optic.position.set(0, rh * 0.42, rd * 0.1);
    group.add(optic);

    // Iron sights, folded but present for silhouette.
    const frontSight = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.035, 0.01), darkMat);
    frontSight.position.set(0, rh * 0.42, rd * 0.78);
    group.add(frontSight);

    // Pump / bolt handle, animated during reload for pump-action weapons.
    const bolt = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.02, 0.1), accentMat);
    bolt.name = 'bolt';
    bolt.position.set(rw * 0.55, rh * 0.1, rd * 0.2);
    group.add(bolt);

    // Charging handle gets a slight bevel so it catches the key light.
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.012, 0.055), accentMat);
    handle.position.set(rw * 0.5, rh * 0.22, rd * 0.05);
    group.add(handle);

    // Empty object marking where bullets leave the barrel.
    const muzzle = new THREE.Object3D();
    muzzle.name = 'muzzle';
    muzzle.position.set(0, 0, tipZ + 0.06);
    group.add(muzzle);

    // Weapon-specific extras.
    if (weapon.id === 'sniper') {
      const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.3, 14), darkMat);
      scope.rotation.x = Math.PI / 2;
      scope.position.set(0, rh * 0.5, rd * 0.05);
      group.add(scope);
      const bipod = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.11, 0.02), darkMat);
      bipod.position.set(0, -rh * 0.8, rd * 0.72);
      bipod.rotation.z = 0.3;
      group.add(bipod);
    }
    if (weapon.id === 'shotgun') {
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.42, 10), accentMat);
      tube.rotation.x = Math.PI / 2;
      tube.position.set(0, -rh * 0.5, rd * 0.72);
      group.add(tube);
    }
    if (weapon.id === 'pistol') {
      group.scale.setScalar(0.92);
    }
    if (weapon.id === 'shotgun' || weapon.id === 'sniper') {
      // Long guns sit a little further forward so they do not fill the screen.
      group.position.z = -0.03;
    }

    group.traverse((child) => {
      if (child.isMesh) {
        // The viewmodel is never shadowed by the world, so casting shadows only
        // costs fill rate for no visual benefit.
        child.castShadow = false;
        child.receiveShadow = false;
      }
    });
    return group;
  }

  // -------------------------------------------------------------- animation

  fire() {
    const recoilCfg = this.weapon.recoil;
    this.recoil += recoilCfg.kick;
    this.kickFlip = Math.min(1, this.kickFlip + recoilCfg.viewKick * 0.35);
    this.recoilYaw += (Math.random() - 0.5) * recoilCfg.kick * 0.7;
  }

  reload(duration) {
    this.reloadDuration = duration;
    this.reloadT = duration;
  }

  cancelReload() {
    this.reloadT = 0;
  }

  draw(duration) {
    this.switchDuration = duration;
    this.switchT = duration;
  }

  setAds(on) {
    this.adsTarget = on ? 1 : 0;
  }

  /** Called when the weapon changes so the model and timings stay in sync. */
  syncWeapon(weaponId) {
    this.setWeapon(weaponId);
  }

  /**
   * `state` is the predicted player state, which already carries bob and swing
   * phase from the shared movement code -- the viewmodel bobs in step with the
   * footsteps the server hears, rather than on an independent timer.
   */
  update(dt, state, { yaw = 0, pitch = 0, speed = 0, grounded = true, ads = false, weaponId = null } = {}) {
    this.time += dt;
    if (weaponId && weaponId !== this.weaponId) this.setWeapon(weaponId);
    this.adsTarget = ads ? 1 : 0;

    // ADS blend uses the weapon's own timing so aiming feels different per gun.
    const adsTime = this.weapon.ads.time;
    const rate = dt / Math.max(0.05, adsTime);
    this.adsAmount = clamp(this.adsAmount + (this.adsTarget - this.adsAmount) * Math.min(1, rate * 2.4), 0, 1);

    // Bob: stepping in phase with actual travelled distance.
    const speedFactor = clamp(speed / 5.2, 0, 1.35);
    this.bobAmount = lerp(this.bobAmount, grounded ? speedFactor : speedFactor * 0.25, Math.min(1, dt * 8));
    this.bobPhase = state ? state.bob * 2.1 : this.bobPhase + dt * 6 * speedFactor;

    // Sway: the gun lags behind a fast turn, which is the single most effective
    // cue that you are moving a heavy object around.
    const dYaw = shortestAngle(yaw - this.lastYaw);
    const dPitch = pitch - this.lastPitch;
    this.lastYaw = yaw;
    this.lastPitch = pitch;
    const swayTargetX = clamp(-dYaw * 3.2, -0.05, 0.05);
    const swayTargetY = clamp(dPitch * 2.1, -0.035, 0.035);
    const swayLerp = Math.min(1, dt * 9);
    this.swayX = lerp(this.swayX, swayTargetX, swayLerp);
    this.swayY = lerp(this.swayY, swayTargetY, swayLerp);

    // Recoil recovers at the weapon's authored rate.
    const decay = Math.exp(-this.recoilRecovery * dt);
    this.recoil *= decay;
    this.recoilYaw *= decay;
    this.kickFlip *= Math.exp(-9 * dt);

    // Reload and draw use normalised progress, eased for a weighty feel.
    let reloadPose = 0;
    if (this.reloadT > 0) {
      this.reloadT = Math.max(0, this.reloadT - dt);
      reloadPose = 1 - this.reloadT / this.reloadDuration;
    }
    let drawPose = 0;
    if (this.switchT > 0) {
      this.switchT = Math.max(0, this.switchT - dt);
      drawPose = this.switchT / Math.max(0.01, this.switchDuration);
    }

    this.applyPose(reloadPose, drawPose, ads);
  }

  applyPose(reloadPose, drawPose, ads) {
    const adsEase = easeInOut(this.adsAmount);

    // 1. Base pose, blended toward the aiming pose.
    const px = lerp(BASE_POSITION.x, ADS_POSITION.x, adsEase);
    const py = lerp(BASE_POSITION.y, ADS_POSITION.y, adsEase);
    const pz = lerp(BASE_POSITION.z, ADS_POSITION.z, adsEase);

    let rx = lerp(BASE_ROTATION.x, ADS_ROTATION.x, adsEase);
    let ry = lerp(BASE_ROTATION.y, ADS_ROTATION.y, adsEase);
    let rz = lerp(BASE_ROTATION.z, ADS_ROTATION.z, adsEase);

    // 2. Bob and sway. Both are suppressed when aiming, because you steady the
    //    weapon against your shoulder to shoot.
    const suppress = 1 - adsEase * 0.72;
    const bobScale = this.bobAmount * suppress;
    const bobX = Math.cos(this.bobPhase) * 0.011 * bobScale;
    const bobY = Math.abs(Math.sin(this.bobPhase)) * 0.011 * bobScale;
    const bobRoll = Math.sin(this.bobPhase) * 0.05 * bobScale;

    // 3. Reload: pull the gun down and left, then rock it back up.
    let reloadDrop = 0;
    let reloadRoll = 0;
    let reloadPitch = 0;
    let magDrop = 0;
    let boltCycle = 0;
    if (reloadPose > 0) {
      const p = reloadPose;
      // Phase A (0-0.35): magazine out. Phase B (0.35-0.7): magazine in.
      // Phase C (0.7-1): charging handle / pump.
      if (p < 0.35) {
        magDrop = p / 0.35;
        reloadDrop = eased(p / 0.35) * 0.5;
      } else if (p < 0.7) {
        magDrop = 1 - (p - 0.35) / 0.35;
        reloadDrop = 0.5 + eased((p - 0.35) / 0.35) * 0.15;
      } else {
        magDrop = 0;
        const t = (p - 0.7) / 0.3;
        reloadDrop = 0.65 * (1 - eased(t));
        boltCycle = Math.sin(t * Math.PI);
      }
      reloadRoll = reloadDrop * 0.55;
      reloadPitch = reloadDrop * 0.5;
    }

    // 4. Draw: the weapon comes up from below with a tilt.
    let drawDrop = 0;
    let drawRoll = 0;
    if (drawPose > 0) {
      drawDrop = eased(drawPose) * 0.34;
      drawRoll = eased(drawPose) * 0.5;
    }

    // 5. Recoil: kick back and up, with a little muzzle rise.
    const recoilZ = this.recoil * 0.5;
    const recoilPitch = this.recoil * 1.5 + this.kickFlip * 0.05;

    this.root.position.set(
      px + bobX + this.swayX + reloadRoll * 0.12,
      py + bobY + this.swayY - reloadDrop * 0.42 - drawDrop,
      pz + recoilZ,
    );
    this.root.rotation.set(
      rx + bobY * 0.5 + this.swayY * 1.4 + reloadPitch + recoilPitch + drawRoll * 0.2,
      ry + this.swayX * 2.0 + this.recoilYaw,
      rz + bobRoll + reloadRoll + drawRoll,
    );

    // Magazine animation: swings out and down, then snaps back.
    if (this.magazine) {
      this.magazine.position.y = this.magazineBaseY ?? (this.magazineBaseY = this.magazine.position.y);
      this.magazine.rotation.x = (this.magazineBaseRotX ?? (this.magazineBaseRotX = this.magazine.rotation.x)) - magDrop * 1.1;
      this.magazine.position.y -= magDrop * 0.22;
      this.magazine.position.z += magDrop * 0.02;
    }
    if (this.bolt) {
      this.bolt.position.z = (this.boltBaseZ ?? (this.boltBaseZ = this.bolt.position.z)) + boltCycle * 0.09;
    }

    void ads;
  }

  /** World position of the muzzle, using the main camera's transform. */
  muzzleWorldPosition(mainCamera, out = new THREE.Vector3()) {
    if (!this.muzzle) return out.set(0, 0, 0);
    this.muzzle.updateWorldMatrix(true, false);
    out.setFromMatrixPosition(this.muzzle.matrixWorld);
    // The muzzle lives in view space; the view camera matches the main camera's
    // orientation at the origin, so applying the main camera's world matrix maps
    // it into the world exactly.
    return out.applyMatrix4(mainCamera.matrixWorld);
  }

  /** Direction the barrel points, for muzzle flash orientation and tracers. */
  muzzleWorldDirection(mainCamera, out = new THREE.Vector3()) {
    return mainCamera.getWorldDirection(out);
  }

  resize(aspect) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  setFov(fov) {
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }
}

function shortestAngle(a) {
  let d = a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function easeInOut(t) {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

function eased(t) {
  const x = clamp(t, 0, 1);
  return 1 - (1 - x) * (1 - x);
}

export { BASE_POSITION };
