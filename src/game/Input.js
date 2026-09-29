/**
 * Input.
 *
 * Owns pointer lock, the keyboard map and mouse look. It accumulates raw
 * movement deltas between frames rather than sampling per event, so a 1000 Hz
 * mouse produces the same turn as a 125 Hz one. Mouse acceleration is
 * deliberately absent: an FPS needs 1:1 mapping between hand and crosshair, and
 * the single biggest reason a browser shooter feels wrong is the OS pointer
 * being allowed to introduce acceleration.
 *
 * The action map is data, so keybinds are rebindable from the settings screen
 * without touching this file.
 */

export const DEFAULT_BINDS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  crouch: ['ControlLeft', 'KeyC'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  walk: ['AltLeft'],
  reload: ['KeyR'],
  primary: ['Digit1'],
  secondary: ['Digit2'],
  quickSwitch: ['KeyQ'],
  scoreboard: ['Tab'],
  map: ['KeyM'],
  pause: ['Escape'],
  interact: ['KeyE'],
  grenade: ['KeyG'],
  melee: ['KeyF'],
};

const CAPTURED = new Set([
  'Tab',
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'KeyR',
  'KeyC',
  'KeyQ',
  'KeyE',
  'KeyF',
  'KeyG',
  'KeyM',
  'Digit1',
  'Digit2',
  'AltLeft',
]);

export class Input {
  constructor(canvas, { binds = DEFAULT_BINDS, sensitivity = 1, invertY = false, adsSensitivity = 0.85 } = {}) {
    this.canvas = canvas;
    this.binds = { ...DEFAULT_BINDS, ...binds };
    this.sensitivity = sensitivity;
    this.adsSensitivity = adsSensitivity;
    this.invertY = invertY;
    this.locked = false;
    this.enabled = false;

    this.keys = new Set();
    this.mouse = { dx: 0, dy: 0, left: false, right: false, middle: false };
    /** Edge-triggered presses consumed once per frame. */
    this.pressed = new Set();
    this.released = new Set();
    this.wheel = 0;
    this.ads = false;
    /** Set by the game layer so ADS can lower the look sensitivity. */
    this.adsActive = false;

    this.onLockChange = null;
    this.onAction = null;

    this._bound = {
      keydown: (e) => this.handleKeyDown(e),
      keyup: (e) => this.handleKeyUp(e),
      mousemove: (e) => this.handleMouseMove(e),
      mousedown: (e) => this.handleMouseDown(e),
      mouseup: (e) => this.handleMouseUp(e),
      wheel: (e) => this.handleWheel(e),
      contextmenu: (e) => e.preventDefault(),
      blur: () => this.clear(),
      pointerlockchange: () => this.handleLockChange(),
      pointerlockerror: () => {
        this.locked = false;
        if (this.onLockChange) this.onLockChange(false);
      },
    };

    this.attach();
  }

  attach() {
    window.addEventListener('keydown', this._bound.keydown);
    window.addEventListener('keyup', this._bound.keyup);
    window.addEventListener('mousemove', this._bound.mousemove);
    window.addEventListener('mousedown', this._bound.mousedown);
    window.addEventListener('mouseup', this._bound.mouseup);
    window.addEventListener('wheel', this._bound.wheel, { passive: true });
    window.addEventListener('blur', this._bound.blur);
    this.canvas.addEventListener('contextmenu', this._bound.contextmenu);
    document.addEventListener('pointerlockchange', this._bound.pointerlockchange);
    document.addEventListener('pointerlockerror', this._bound.pointerlockerror);
  }

  detach() {
    window.removeEventListener('keydown', this._bound.keydown);
    window.removeEventListener('keyup', this._bound.keyup);
    window.removeEventListener('mousemove', this._bound.mousemove);
    window.removeEventListener('mousedown', this._bound.mousedown);
    window.removeEventListener('mouseup', this._bound.mouseup);
    window.removeEventListener('wheel', this._bound.wheel);
    window.removeEventListener('blur', this._bound.blur);
    this.canvas.removeEventListener('contextmenu', this._bound.contextmenu);
    document.removeEventListener('pointerlockchange', this._bound.pointerlockchange);
    document.removeEventListener('pointerlockerror', this._bound.pointerlockerror);
  }

  // ------------------------------------------------------------ pointer lock

  requestLock() {
    if (this.locked) return;
    const promise = this.canvas.requestPointerLock?.({ unadjustedMovement: true });
    // `unadjustedMovement` is the raw-input request; Chrome rejects it on some
    // platforms, so fall back to a normal lock rather than failing outright.
    if (promise && promise.catch) promise.catch(() => this.canvas.requestPointerLock());
  }

  releaseLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  handleLockChange() {
    this.locked = document.pointerLockElement === this.canvas;
    if (!this.locked) this.clear();
    if (this.onLockChange) this.onLockChange(this.locked);
  }

  // ------------------------------------------------------------------ events

  handleKeyDown(e) {
    if (!this.enabled) return;
    if (CAPTURED.has(e.code)) e.preventDefault();
    // Escape is handled by the browser for pointer lock, but we still need the
    // keypress to open the pause menu.
    if (!this.keys.has(e.code)) {
      this.pressed.add(e.code);
      const action = this.actionFor(e.code);
      if (action && this.onAction) this.onAction(action, true);
    }
    this.keys.add(e.code);
  }

  handleKeyUp(e) {
    if (CAPTURED.has(e.code)) e.preventDefault();
    this.keys.delete(e.code);
    this.released.add(e.code);
  }

  handleMouseMove(e) {
    if (!this.locked || !this.enabled) return;
    // movementX/Y are already relative; summing them between frames preserves
    // fast flicks that would otherwise be dropped between rAF callbacks.
    this.mouse.dx += e.movementX || 0;
    this.mouse.dy += e.movementY || 0;
  }

  handleMouseDown(e) {
    if (!this.enabled) return;
    if (!this.locked) {
      this.requestLock();
      return;
    }
    if (e.button === 0) this.mouse.left = true;
    else if (e.button === 2) this.mouse.right = true;
    else if (e.button === 1) {
      this.mouse.middle = true;
      e.preventDefault();
    }
  }

  handleMouseUp(e) {
    if (e.button === 0) this.mouse.left = false;
    else if (e.button === 2) this.mouse.right = false;
    else if (e.button === 1) this.mouse.middle = false;
  }

  handleWheel(e) {
    if (!this.enabled || !this.locked) return;
    this.wheel += Math.sign(e.deltaY);
  }

  clear() {
    this.keys.clear();
    this.mouse.dx = 0;
    this.mouse.dy = 0;
    this.mouse.left = false;
    this.mouse.right = false;
    this.released.clear();
  }

  // ------------------------------------------------------------------ actions

  actionFor(code) {
    for (const [action, codes] of Object.entries(this.binds)) {
      if (codes.includes(code)) return action;
    }
    return null;
  }

  isDown(action) {
    const codes = this.binds[action];
    if (!codes) return false;
    for (const code of codes) if (this.keys.has(code)) return true;
    return false;
  }

  wasPressed(action) {
    const codes = this.binds[action];
    if (!codes) return false;
    for (const code of codes) if (this.pressed.has(code)) return true;
    return false;
  }

  /** Turn accumulated mouse movement into view angles. */
  applyLook(yaw, pitch, adsMult = 1) {
    const scale = this.sensitivity * 0.0022 * adsMult;
    const dx = this.mouse.dx * scale;
    const dy = this.mouse.dy * scale * (this.invertY ? -1 : 1);
    const limit = Math.PI / 2 - 0.02;
    return {
      yaw: yaw - dx,
      pitch: Math.max(-limit, Math.min(limit, pitch - dy)),
    };
  }

  /** The movement command consumed by the shared simulation. */
  moveCommand(yaw, pitch) {
    return {
      forward: (this.isDown('forward') ? 1 : 0) - (this.isDown('back') ? 1 : 0),
      right: (this.isDown('right') ? 1 : 0) - (this.isDown('left') ? 1 : 0),
      jump: this.isDown('jump'),
      crouch: this.isDown('crouch'),
      sprint: this.isDown('sprint'),
      walk: this.isDown('walk'),
      ads: this.ads,
      yaw,
      pitch,
    };
  }

  endFrame() {
    this.mouse.dx = 0;
    this.mouse.dy = 0;
    this.pressed.clear();
    this.released.clear();
    this.wheel = 0;
  }

  setSensitivity(value) {
    this.sensitivity = value;
  }

  setBinds(binds) {
    this.binds = { ...DEFAULT_BINDS, ...binds };
  }
}
