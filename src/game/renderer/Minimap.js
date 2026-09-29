/**
 * Minimap.
 *
 * Drawn with 2D canvas rather than as 3D geometry: it is legible, cheap, and
 * does not need to fight the scene for depth or lighting. The static level layer
 * is rasterised ONCE into an offscreen canvas and then blitted and transformed
 * each frame, so the per-frame cost is a single drawImage plus a handful of blips
 * no matter how large the map is.
 *
 * Two modes:
 *   radar -- corner map centred on the player, rotated so forward is up
 *   full  -- the whole level, north-up, with callout labels
 */

const MATERIAL_HUES = {
  concrete: 210,
  concreteDark: 210,
  concreteMid: 210,
  concretePad: 210,
  asphalt: 220,
  metal: 200,
  metalRust: 26,
  metalBlue: 214,
  metalRed: 8,
  metalGrate: 200,
  metalPlate: 200,
  plate: 200,
  containerRed: 8,
  containerBlue: 208,
  containerGreen: 128,
  crate: 34,
  crateDark: 34,
  woodBooth: 34,
  sandbag: 48,
  dirt: 30,
  dirtBerm: 30,
  dirtRoad: 33,
  dirtTrench: 26,
  sand: 44,
  treeTrunk: 90,
  treeCanopy: 110,
  tarp: 80,
  tire: 0,
  glass: 190,
  barrel: 140,
  barrelYellow: 48,
  targetWhite: 0,
  marker: 48,
};

const TEAM_HEX = { a: '#5c86c4', b: '#c96f56', solo: '#c9b05c' };

function teamHex(team) {
  if (!team) return TEAM_HEX.solo;
  if (team.startsWith('solo')) return TEAM_HEX.solo;
  return TEAM_HEX[team] || TEAM_HEX.solo;
}

export class Minimap {
  constructor(canvas, level, footprint, { pixelsPerMetre = 2.6 } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.pixelsPerMetre = pixelsPerMetre;
    this.highDetail = true;
    this.setLevel(level, footprint);
  }

  /**
   * Rasterise the static footprint. Taller geometry is drawn last and lighter,
   * which reads as a height map at a glance -- catwalks and tower platforms pop
   * out from the ground plan.
   */
  setLevel(level, footprint) {
    this.level = level;
    this.footprint = footprint || [];
    const { min, max } = level.bounds;
    this.bounds = { min, max };
    this.worldWidth = max[0] - min[0];
    this.worldDepth = max[2] - min[2];

    const scale = this.pixelsPerMetre;
    const width = Math.max(64, Math.ceil(this.worldWidth * scale));
    const height = Math.max(64, Math.ceil(this.worldDepth * scale));

    const offscreen = document.createElement('canvas');
    offscreen.width = width;
    offscreen.height = height;
    const ctx = offscreen.getContext('2d');

    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, width, height);

    // A faint grid gives the map scale without a legend.
    ctx.strokeStyle = 'rgba(120,150,180,0.09)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= this.worldWidth; x += 10) {
      ctx.beginPath();
      ctx.moveTo(x * scale, 0);
      ctx.lineTo(x * scale, height);
      ctx.stroke();
    }
    for (let z = 0; z <= this.worldDepth; z += 10) {
      ctx.beginPath();
      ctx.moveTo(0, z * scale);
      ctx.lineTo(width, z * scale);
      ctx.stroke();
    }

    // Deterministic draw order: lower geometry first, so higher floors overlay.
    const sorted = [...this.footprint].sort((a, b) => a.y1 - b.y1);
    const groundY = level.bounds.min[1] + 0.2;

    for (const box of sorted) {
      const hue = MATERIAL_HUES[box.mat] ?? 210;
      // Height above ground maps to lightness, so multi-level maps read clearly.
      const elevation = Math.max(0, Math.min(9, box.y1 - groundY));
      const light = 22 + Math.min(30, elevation * 3.4);
      // Roofs (non-navigable tops high above ground) are drawn as outlines only,
      // otherwise they would hide the rooms underneath them.
      const isRoof = !box.top && box.y1 - groundY > 2.4;
      ctx.fillStyle = isRoof ? `hsla(${hue}, 16%, ${light}%, 0.28)` : `hsla(${hue}, 18%, ${light}%, 0.92)`;
      ctx.strokeStyle = `hsla(${hue}, 22%, ${light + 16}%, 0.55)`;
      ctx.lineWidth = 1;
      const x = (box.x - this.bounds.min[0] - box.w / 2) * scale;
      const z = (box.z - this.bounds.min[2] - box.d / 2) * scale;
      const w = box.w * scale;
      const d = box.d * scale;
      ctx.fillRect(x, z, w, d);
      if (isRoof || box.w * scale > 3) ctx.strokeRect(x, z, w, d);
    }

    // Spawn markers, which help you learn a map quickly.
    const spawns = level.spawns || {};
    for (const [team, list] of Object.entries(spawns)) {
      for (const sp of list || []) {
        const hex = teamHex(team === 'a' || team === 'b' || team.startsWith('solo') ? team : 'solo');
        ctx.fillStyle = `${hex}33`;
        ctx.beginPath();
        ctx.arc((sp[0] - this.bounds.min[0]) * scale, (sp[2] - this.bounds.min[2]) * scale, 4.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    this.staticLayer = offscreen;
    this.staticScale = scale;
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
  }

  /**
   * @param players [{ id, x, z, yaw, team, dead, isLocal, isBot, isHvt }]
   * @param opts    { mode: 'radar'|'full', localTeam, viewRange }
   */
  draw(players, { mode = 'radar', localTeam = null, viewRange = 46, callouts = [] } = {}) {
    const { ctx } = this;
    if (!this.width) this.resize();
    ctx.clearRect(0, 0, this.width, this.height);
    if (!this.staticLayer) return;

    if (mode === 'full') this.drawFull(players, localTeam, callouts);
    else this.drawRadar(players, localTeam, viewRange);
  }

  drawFull(players, localTeam, callouts) {
    const { ctx } = this;
    // Fit the whole level with a small margin.
    const scale = Math.min(this.width / this.worldWidth, this.height / this.worldDepth) * 0.96;
    const offsetX = (this.width - this.worldWidth * scale) / 2;
    const offsetY = (this.height - this.worldDepth * scale) / 2;

    ctx.save();
    ctx.globalAlpha = 0.92;
    ctx.drawImage(this.staticLayer, offsetX, offsetY, this.worldWidth * scale, this.worldDepth * scale);
    ctx.restore();

    ctx.strokeStyle = 'rgba(140,170,200,0.25)';
    ctx.lineWidth = 1;
    ctx.strokeRect(offsetX, offsetY, this.worldWidth * scale, this.worldDepth * scale);

    // Callout labels.
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'center';
    for (const callout of callouts) {
      const x = offsetX + (callout.p[0] - this.bounds.min[0]) * scale;
      const y = offsetY + (callout.p[2] - this.bounds.min[2]) * scale;
      ctx.fillStyle = 'rgba(190,205,220,0.5)';
      ctx.fillText(callout.name, x, y);
    }

    for (const p of players) {
      const x = offsetX + (p.x - this.bounds.min[0]) * scale;
      const y = offsetY + (p.z - this.bounds.min[2]) * scale;
      this.drawBlip(x, y, p.yaw, p, localTeam, 5.5);
    }
  }

  drawRadar(players, localTeam, viewRange) {
    const { ctx } = this;
    const me = players.find((p) => p.isLocal);
    const centreX = this.width / 2;
    const centreY = this.height / 2;
    const scale = Math.min(this.width, this.height) / Math.max(12, viewRange);
    const yaw = me ? me.yaw : 0;

    // Circular clip so the radar reads as an instrument, not a cropped image.
    ctx.save();
    ctx.beginPath();
    ctx.arc(centreX, centreY, Math.min(centreX, centreY) - 2, 0, Math.PI * 2);
    ctx.clip();

    ctx.fillStyle = '#0b0f14';
    ctx.fillRect(0, 0, this.width, this.height);

    ctx.save();
    ctx.translate(centreX, centreY);
    // Rotate so the player's forward (-Z after yaw) points up: this is what makes
    // a radar usable without re-reading it every time you turn.
    ctx.rotate(yaw);
    const originX = me ? me.x : 0;
    const originZ = me ? me.z : 0;
    ctx.drawImage(
      this.staticLayer,
      -(originX - this.bounds.min[0]) * scale,
      -(originZ - this.bounds.min[2]) * scale,
      this.worldWidth * scale,
      this.worldDepth * scale,
    );
    ctx.restore();

    // Range rings.
    ctx.strokeStyle = 'rgba(140,170,200,0.16)';
    ctx.lineWidth = 1;
    for (const metres of [viewRange * 0.33, viewRange * 0.66]) {
      ctx.beginPath();
      ctx.arc(centreX, centreY, metres * scale, 0, Math.PI * 2);
      ctx.stroke();
    }

    for (const p of players) {
      if (p.isLocal) continue;
      const dx = p.x - originX;
      const dz = p.z - originZ;
      // Radar is rotated by the player's yaw, so blips must be rotated too.
      const rotatedX = dx * Math.cos(yaw) - dz * Math.sin(yaw);
      const rotatedZ = dx * Math.sin(yaw) + dz * Math.cos(yaw);
      const x = centreX + rotatedX * scale;
      const y = centreY + rotatedZ * scale;
      if (Math.hypot(x - centreX, y - centreY) > Math.min(centreX, centreY) - 6) continue;
      this.drawBlip(x, y, p.yaw - yaw, p, localTeam, 4.5);
    }
    ctx.restore();

    // The player, always centred and unrotated, drawn last.
    if (me) this.drawBlip(centreX, centreY, 0, { ...me, team: localTeam || me.team }, localTeam, 6.5);

    // Compass letter, so the radar is not totally disorienting after a 180.
    ctx.font = 'bold 10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(180,200,220,0.6)';
    const north = -yaw;
    ctx.fillText('N', centreX + Math.sin(north) * (Math.min(centreX, centreY) - 12), centreY - Math.cos(north) * (Math.min(centreX, centreY) - 12) + 4);
  }

  drawBlip(x, y, yaw, player, localTeam, size) {
    const { ctx } = this;
    const isEnemy = localTeam != null && player.team !== localTeam;
    const hex = player.isLocal ? '#ffffff' : teamHex(player.team);

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-yaw);

    if (player.dead) {
      ctx.strokeStyle = 'rgba(150,160,170,0.7)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-size * 0.6, -size * 0.6);
      ctx.lineTo(size * 0.6, size * 0.6);
      ctx.moveTo(size * 0.6, -size * 0.6);
      ctx.lineTo(-size * 0.6, size * 0.6);
      ctx.stroke();
      ctx.restore();
      return;
    }

    // A view-cone wedge behind each blip shows which way they are facing: it is
    // the cheapest way to make a radar tactically useful.
    if (player.isLocal || !isEnemy) {
      ctx.fillStyle = `${hex}33`;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, size * 3.4, -Math.PI / 2 - 0.5, -Math.PI / 2 + 0.5);
      ctx.closePath();
      ctx.fill();
    }

    ctx.fillStyle = hex;
    ctx.strokeStyle = 'rgba(0,0,0,0.65)';
    ctx.lineWidth = 1.2;
    if (player.isLocal) {
      ctx.beginPath();
      ctx.moveTo(0, -size);
      ctx.lineTo(size * 0.78, size * 0.85);
      ctx.lineTo(0, size * 0.42);
      ctx.lineTo(-size * 0.78, size * 0.85);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(0, 0, size * 0.72, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    if (player.isHvt) {
      ctx.strokeStyle = '#ffd166';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(0, 0, size * 1.2, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }
}
