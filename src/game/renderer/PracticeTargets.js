/**
 * Practice range targets.
 *
 * The simulation owns the targets: it decides when a pop-up is exposed, where a
 * rail mover is on its track, and how many points a plate is worth. This class
 * only draws whatever the simulation currently says, which is why a target you
 * can see is always a target you can hit.
 *
 * Each target is a plate on a stand. Pop-ups rotate up out of cover, movers slide
 * along a rail, and a hit flashes and briefly pitches backwards.
 */

import * as THREE from 'three';
import { getMaterial } from './textures.js';

const HIT_FLASH = 0.22;

export class PracticeTargets {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'practice-targets';
    scene.add(this.group);
    this.targets = new Map();
    this.plateMat = getMaterial('plate').clone();
    this.faceMat = getMaterial('targetWhite').clone();
    this.faceMat.emissive = new THREE.Color(0x000000);
    this.standMat = new THREE.MeshStandardMaterial({ color: 0x3a3f44, roughness: 0.7, metalness: 0.5 });
    this.penaltyMat = new THREE.MeshStandardMaterial({ color: 0x8a3028, roughness: 0.6, metalness: 0.4 });
  }

  /** Build a mesh for a target descriptor. */
  create(t) {
    const entry = { id: t.id, descriptor: t, node: new THREE.Group(), flash: 0, pitch: 0 };

    const size = t.size === 'small' ? 0.28 : t.size === 'popup' ? 0.42 : 0.5;
    const height = t.size === 'small' ? 0.5 : 1.15;

    // Penalty plates are modelled in the level data as negative points; paint
    // them red so the "do not shoot" rule is legible without reading numbers.
    const faceMaterial = t.points < 0 ? this.penaltyMat : this.faceMat;

    const plate = new THREE.Mesh(new THREE.BoxGeometry(size * 2, height, 0.05), faceMaterial);
    plate.position.y = size;
    plate.castShadow = true;
    entry.node.add(plate);
    entry.plate = plate;

    // A backing frame makes the plate read at distance.
    const frame = new THREE.Mesh(new THREE.BoxGeometry(size * 2 + 0.08, height + 0.08, 0.03), this.standMat);
    frame.position.set(0, size, -0.04);
    frame.castShadow = true;
    entry.node.add(frame);

    // Stand: post and base, so pop-ups have something to rotate out of.
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, size + 0.2, 8), this.standMat);
    post.position.y = -(size + 0.2) / 2;
    post.castShadow = true;
    entry.node.add(post);

    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.3, 0.06, 10), this.standMat);
    base.position.y = -size - 0.2;
    entry.node.add(base);

    if (t.type === 'mover') {
      // Rail the mover slides along, so its motion is readable rather than magic.
      const railLength = (t.range || 10) * 2;
      const along = t.axis === 'x';
      const rail = new THREE.Mesh(
        along ? new THREE.BoxGeometry(railLength, 0.06, 0.08) : new THREE.BoxGeometry(0.08, 0.06, railLength),
        this.standMat,
      );
      rail.position.copy(new THREE.Vector3(0, -0.05, 0));
      const slider = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, 0.12), this.standMat);
      entry.node.add(rail);
      entry.node.add(slider);
      entry.slider = slider;
    }

    entry.node.position.set(t.p[0], t.p[1] - size, t.p[2]);
    this.group.add(entry.node);
    this.targets.set(t.id, entry);
    return entry;
  }

  /**
   * Sync to the simulation's target list. Called every frame; `list` is the
   * serialised target array from the sim (or a local practice sim).
   */
  sync(list, dt) {
    const seen = new Set();
    for (const t of list) {
      seen.add(t.id);
      let entry = this.targets.get(t.id);
      if (!entry) entry = this.create(t);

      const baseY = t.p[1] - (t.size === 'small' ? 0.28 : t.size === 'popup' ? 0.42 : 0.5);

      // Pop-ups rotate up from flat: below the ledge means hidden.
      if (t.type === 'popup' || t.size === 'popup') {
        const target = t.up ? 0 : -Math.PI / 2 + 0.06;
        entry.pitch += (target - entry.pitch) * Math.min(1, dt * 12);
        entry.node.rotation.x = entry.pitch;
        // Rotating around the base keeps the pivot at the stand rather than the
        // plate centre, which is what makes it look like it hinges.
        entry.node.position.set(t.p[0], baseY, t.p[2]);
        entry.node.visible = entry.pitch > -1.4;
      } else {
        entry.node.visible = true;
      }

      entry.node.position.x = t.p[0];
      entry.node.position.z = t.p[2];
      if (t.type !== 'popup' && t.size !== 'popup') entry.node.position.y = baseY;

      // Rail movers slide along their axis; the slider on the rail follows.
      if (entry.slider) {
        entry.slider.position.x = 0;
        entry.slider.position.z = 0;
      }

      // Hit flash decays; a struck plate reads instantly without a damage number.
      if (entry.flash > 0) {
        entry.flash = Math.max(0, entry.flash - dt);
        const k = entry.flash / HIT_FLASH;
        entry.plate.scale.set(1 + k * 0.12, 1 + k * 0.12, 1);
        if (!entry.flashGroup) {
          entry.flashGroup = new THREE.PointLight(0xffd9a0, 0, 4, 2);
          entry.node.add(entry.flashGroup);
        }
        entry.flashGroup.intensity = k * 4;
      } else if (entry.flashGroup) {
        entry.flashGroup.intensity = 0;
        entry.plate.scale.set(1, 1, 1);
      }
    }

    for (const [id, entry] of this.targets) {
      if (seen.has(id)) continue;
      this.group.remove(entry.node);
      entry.node.traverse((c) => {
        if (c.geometry) c.geometry.dispose();
      });
      this.targets.delete(id);
    }
  }

  /** Called when the player's shot registers, so the plate reacts. */
  markHit(targetId) {
    const entry = this.targets.get(targetId);
    if (entry) entry.flash = HIT_FLASH;
  }

  clear() {
    for (const [id, entry] of this.targets) {
      this.group.remove(entry.node);
      entry.node.traverse((c) => {
        if (c.geometry) c.geometry.dispose();
      });
      void id;
    }
    this.targets.clear();
  }

  dispose() {
    this.clear();
    this.scene.remove(this.group);
    this.plateMat.dispose();
    this.faceMat.dispose();
    this.standMat.dispose();
    this.penaltyMat.dispose();
  }
}
