/**
 * HUD overlay.
 *
 * High-frequency, precisely positioned elements are drawn here rather than in
 * React. The crosshair has to sit within a pixel of the true aim point and update
 * every frame, and routing that through a component tree would both stutter and
 * burn CPU. React still owns the panels, which change slowly and benefit from
 * being real components.
 *
 * Contents: dynamic crosshair sized from actual weapon spread, hit markers,
 * directional damage indicators, teammate nameplates, objective markers, reload
 * progress and the low-ammo state.
 */

const TEAM_HEX = { a: '#7fa8dd', b: '#e08a72', solo: '#d8bd6a' };

function teamHex(team) {
  if (!team) return TEAM_HEX.solo;
  if (team.startsWith('solo')) return TEAM_HEX.solo;
  return TEAM_HEX[team] || TEAM_HEX.solo;
}

export class HudCanvas {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.hitmarker = { life: 0, duration: 0.28, kill: false, headshot: false };
    this.damageMarks = [];
    this.killConfirms = [];
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    if (this.canvas.width !== width * dpr || this.canvas.height !== height * dpr) {
      this.canvas.width = width * dpr;
      this.canvas.height = height * dpr;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.width = width;
    this.height = height;
    this.dpr = dpr;
  }

  // ------------------------------------------------------------------ events

  showHitmarker({ kill = false, headshot = false } = {}) {
    this.hitmarker.life = this.hitmarker.duration;
    this.hitmarker.kill = kill;
    this.hitmarker.headshot = headshot;
  }

  /** `angle` is radians clockwise from straight ahead, screen space. */
  showDamage(angle, amount = 20) {
    this.damageMarks.push({ angle, life: 1.1, duration: 1.1, amount });
    if (this.damageMarks.length > 6) this.damageMarks.shift();
  }

  showKillConfirm(text) {
    this.killConfirms.push({ text, life: 1.6, duration: 1.6 });
    if (this.killConfirms.length > 4) this.killConfirms.shift();
  }

  clear() {
    this.damageMarks.length = 0;
    this.killConfirms.length = 0;
    this.hitmarker.life = 0;
  }

  // ------------------------------------------------------------------- frame

  draw(dt, state) {
    const { ctx } = this;
    if (!this.width) this.resize();
    ctx.clearRect(0, 0, this.width, this.height);

    if (state.dead) {
      this.drawDeathTint(ctx, state);
      this.drawKillConfirms(ctx, dt);
      return;
    }

    this.drawDamageIndicators(ctx, dt);
    if (!state.ads || state.forceCrosshair) this.drawCrosshair(ctx, state);
    if (state.reloading) this.drawReloadRing(ctx, state);
    this.drawHitmarker(ctx, dt);
    this.drawNameplates(ctx, state);
    this.drawObjectiveMarkers(ctx, state);
    this.drawKillConfirms(ctx, dt);
    this.drawAmmoWarning(ctx, state);
  }

  /** Gap follows the real cone: what you see is the spread you actually have. */
  drawCrosshair(ctx, state) {
    const cx = this.width / 2;
    const cy = this.height / 2;
    // Convert a half-angle to pixels using the vertical FOV.
    const pixelsPerRadian = this.height / 2 / Math.tan(((state.fov || 88) * Math.PI) / 360);
    const gap = Math.min(160, Math.max(4, Math.tan(state.spread || 0.002) * pixelsPerRadian * 1.35));
    const len = state.ads ? 5 : 8;
    const thickness = 2;
    const spread = state.hitFlash ? 'rgba(255,120,90,0.95)' : 'rgba(228,238,248,0.92)';

    ctx.save();
    ctx.strokeStyle = spread;
    ctx.lineWidth = thickness;
    ctx.lineCap = 'round';
    ctx.shadowColor = 'rgba(0,0,0,0.75)';
    ctx.shadowBlur = 3;

    const arms = [
      [0, -1],
      [0, 1],
      [-1, 0],
      [1, 0],
    ];
    for (const [dx, dy] of arms) {
      ctx.beginPath();
      ctx.moveTo(cx + dx * gap, cy + dy * gap);
      ctx.lineTo(cx + dx * (gap + len), cy + dy * (gap + len));
      ctx.stroke();
    }

    // Centre dot: helpful for precision weapons, distracting for shotguns.
    if (state.precise) {
      ctx.fillStyle = spread;
      ctx.beginPath();
      ctx.arc(cx, cy, 1.1, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  drawReloadRing(ctx, state) {
    const cx = this.width / 2;
    const cy = this.height / 2 + 34;
    const radius = 14;
    const progress = Math.max(0, Math.min(1, state.reloadProgress || 0));
    ctx.save();
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(120,140,160,0.35)';
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,196,110,0.95)';
    ctx.beginPath();
    ctx.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  drawAmmoWarning(ctx, state) {
    if (!state.lowAmmo || state.reloading) return;
    const cx = this.width / 2;
    const cy = this.height / 2 - 46;
    if (Math.floor(state.time * 4) % 2 === 0) {
      ctx.save();
      ctx.font = 'bold 13px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,110,80,0.95)';
      ctx.fillText('RELOAD', cx, cy);
      ctx.restore();
    }
  }

  drawHitmarker(ctx, dt) {
    if (this.hitmarker.life <= 0) return;
    this.hitmarker.life = Math.max(0, this.hitmarker.life - dt);
    const t = this.hitmarker.life / this.hitmarker.duration;
    const cx = this.width / 2;
    const cy = this.height / 2;
    const spread = 5 + (1 - t) * 5;
    const len = 7;
    ctx.save();
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.strokeStyle = this.hitmarker.kill
      ? `rgba(255,90,70,${t})`
      : this.hitmarker.headshot
        ? `rgba(255,196,90,${t})`
        : `rgba(255,255,255,${t * 0.95})`;
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 3;
    for (const [dx, dy] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ]) {
      ctx.beginPath();
      ctx.moveTo(cx + dx * spread, cy + dy * spread);
      ctx.lineTo(cx + dx * (spread + len), cy + dy * (spread + len));
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * Damage direction arcs. The angle is relative to the view, so a hit from
   * behind appears behind the crosshair, which is the whole point.
   */
  drawDamageIndicators(ctx, dt) {
    const cx = this.width / 2;
    const cy = this.height / 2;
    const radius = Math.min(this.width, this.height) * 0.24;
    for (let i = this.damageMarks.length - 1; i >= 0; i--) {
      const mark = this.damageMarks[i];
      mark.life -= dt;
      if (mark.life <= 0) {
        this.damageMarks.splice(i, 1);
        continue;
      }
      const t = mark.life / mark.duration;
      ctx.save();
      ctx.translate(cx, cy);
      // Screen-space: 0 rad is up. The indicator is drawn as an arc segment.
      ctx.rotate(mark.angle);
      ctx.strokeStyle = `rgba(255,${60 + Math.round(60 * t)},60,${0.35 + t * 0.6})`;
      ctx.lineWidth = 7 + (1 - t) * 5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(0, 0, radius, -Math.PI / 2 - 0.42, -Math.PI / 2 + 0.42);
      ctx.stroke();
      ctx.restore();
    }
  }

  drawNameplates(ctx, state) {
    if (!state.nameplates || !state.nameplates.length) return;
    ctx.save();
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const plate of state.nameplates) {
      if (!plate.visible) continue;
      const alpha = Math.max(0, Math.min(1, plate.alpha));
      if (alpha < 0.02) continue;
      ctx.globalAlpha = alpha;
      const scale = Math.max(0.7, Math.min(1.4, 14 / Math.max(6, plate.distance)));
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.fillRect(plate.x - 46 * scale, plate.y - 10 * scale, 92 * scale, 20 * scale);
      ctx.fillStyle = teamHex(plate.team);
      ctx.font = `bold ${Math.round(11 * scale)}px ui-monospace, monospace`;
      ctx.fillText(plate.name, plate.x, plate.y - 2 * scale);
      ctx.fillStyle = 'rgba(200,214,228,0.75)';
      ctx.font = `${Math.round(9 * scale)}px ui-monospace, monospace`;
      ctx.fillText(`${Math.round(plate.distance)}m`, plate.x, plate.y + 9 * scale);
    }
    ctx.restore();
  }

  /** Objective beacons for campaign mode, projected from world space. */
  drawObjectiveMarkers(ctx, state) {
    if (!state.objectives || !state.objectives.length) return;
    ctx.save();
    ctx.textAlign = 'center';
    for (const marker of state.objectives) {
      if (!marker.visible) {
        this.drawOffscreenArrow(ctx, marker);
        continue;
      }
      const pulse = 0.6 + Math.sin(state.time * 3) * 0.25;
      ctx.globalAlpha = pulse;
      ctx.strokeStyle = marker.color || '#ffd166';
      ctx.lineWidth = 2;
      const size = Math.max(10, Math.min(38, 2600 / Math.max(4, marker.distance)));
      ctx.beginPath();
      ctx.moveTo(marker.x, marker.y - size * 0.6);
      ctx.lineTo(marker.x + size * 0.5, marker.y);
      ctx.lineTo(marker.x, marker.y + size * 0.6);
      ctx.lineTo(marker.x - size * 0.5, marker.y);
      ctx.closePath();
      ctx.stroke();
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = marker.color || '#ffd166';
      ctx.font = 'bold 11px ui-monospace, monospace';
      ctx.fillText(`${marker.label} ${Math.round(marker.distance)}m`, marker.x, marker.y + size * 0.6 + 14);
    }
    ctx.restore();
  }

  /** Edge chevron pointing at an objective that is off screen. */
  drawOffscreenArrow(ctx, marker) {
    const cx = this.width / 2;
    const cy = this.height / 2;
    const dx = marker.ndcX;
    const dy = marker.ndcY;
    const angle = Math.atan2(dy, dx);
    const radius = Math.min(this.width, this.height) * 0.36;
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.fillStyle = marker.color || '#ffd166';
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(10, 0);
    ctx.lineTo(-6, -7);
    ctx.lineTo(-6, 7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    void dx;
  }

  drawKillConfirms(ctx, dt) {
    if (!this.killConfirms.length) return;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = 'bold 14px ui-monospace, monospace';
    for (let i = this.killConfirms.length - 1; i >= 0; i--) {
      const entry = this.killConfirms[i];
      entry.life -= dt;
      if (entry.life <= 0) {
        this.killConfirms.splice(i, 1);
        continue;
      }
      const t = entry.life / entry.duration;
      const rise = (1 - t) * 18;
      ctx.globalAlpha = Math.min(1, t * 2.2);
      ctx.fillStyle = '#ffd166';
      ctx.fillText(entry.text, this.width / 2, this.height * 0.32 - rise);
    }
    ctx.restore();
  }

  drawDeathTint(ctx) {
    ctx.save();
    ctx.fillStyle = 'rgba(90,10,10,0.28)';
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.restore();
  }
}
