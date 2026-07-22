/**
 * Input. Keyboard and gamepad are normalised into one shape that the match engine
 * consumes, identical to what the AI produces:
 *
 *   { moveX, moveY, sprint, shotDown, shotUp, shotType, aimX, aimY, serveAction, splitStep }
 *
 * Movement is SCREEN-RELATIVE, always. Pressing "up" moves your player up the screen
 * whether you are at the near end or the far end. Anything else is disorienting once
 * the players change ends.
 *
 * Aiming reuses the movement stick/keys at the moment of contact: hold left as you
 * strike and the ball goes to the left of the screen. It takes about thirty seconds
 * to internalise and it means you never take your hand off the movement controls.
 */

export const SHOT_BUTTONS = ['topspin', 'flat', 'slice', 'lob', 'drop'];

/**
 * ONE control scheme, used by every player.
 *
 * Because this is an online game, each player sits at their own Mac — so there is no
 * reason to split the keyboard into cramped halves and every reason for everyone to
 * learn the same layout. Arrow keys move, the number row hits.
 *
 * Both the number row and the numeric keypad are accepted for the shot keys, so it
 * works the same on a MacBook and on a full-size desktop keyboard.
 */
export const DEFAULT_BINDINGS = [
  {
    label: 'Player',
    up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'],
    sprint: ['ShiftLeft', 'ShiftRight'],
    topspin: ['Digit1', 'Numpad1'],
    flat:    ['Digit2', 'Numpad2'],
    slice:   ['Digit3', 'Numpad3'],
    lob:     ['Digit4', 'Numpad4'],
    drop:    ['Digit5', 'Numpad5'],
    serve: ['Space'], splitStep: ['Space'],
  },
];

/**
 * Optional second local player, for two people sharing one machine offline. Kept off
 * by default — enable it by pointing InputManager.localSlots at index 1.
 */
export const LOCAL_COOP_BINDING = {
  label: 'Local player 2',
  up: ['KeyW'], down: ['KeyS'], left: ['KeyA'], right: ['KeyD'],
  sprint: ['ShiftLeft'],
  topspin: ['KeyZ'], flat: ['KeyX'], slice: ['KeyC'], lob: ['KeyV'], drop: ['KeyB'],
  serve: ['Tab'], splitStep: ['Tab'],
};

export class InputManager {
  constructor() {
    this.keys = new Set();
    this.pressedThisFrame = new Set();
    this.releasedThisFrame = new Set();
    this.bindings = [{ ...DEFAULT_BINDINGS[0] }, { ...LOCAL_COOP_BINDING }];

    // Which player index each binding set drives. Online, everyone uses binding 0 and
    // it is simply pointed at whichever slot the host assigned them. Slot -1 disables
    // that binding set, which is the default for the local co-op layout.
    this.localSlots = [0, -1];

    this.gamepadEnabled = true;
    this._gamepadPrev = [];

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onBlur = this._onBlur.bind(this);

    this.enabled = true;
    this._listeners = new Map();
  }

  attach(target = window) {
    target.addEventListener('keydown', this._onKeyDown);
    target.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    this._target = target;
  }

  detach() {
    if (!this._target) return;
    this._target.removeEventListener('keydown', this._onKeyDown);
    this._target.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    this._target = null;
  }

  _onKeyDown(e) {
    if (!this.enabled) return;
    // Do not swallow keys while the player is typing in a menu field.
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;

    if (!this.keys.has(e.code)) this.pressedThisFrame.add(e.code);
    this.keys.add(e.code);

    // Stop the browser scrolling the page under the canvas.
    if (SCROLL_KEYS.has(e.code)) e.preventDefault();

    this._fire('keydown', e.code);
  }

  _onKeyUp(e) {
    this.keys.delete(e.code);
    this.releasedThisFrame.add(e.code);
    this._fire('keyup', e.code);
  }

  /** Dropping focus must release every key, or the player runs off court forever. */
  _onBlur() {
    for (const k of this.keys) this.releasedThisFrame.add(k);
    this.keys.clear();
  }

  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this._listeners.get(event)?.delete(fn);
  }

  _fire(event, data) {
    const set = this._listeners.get(event);
    if (set) for (const fn of set) fn(data);
  }

  isDown(code) { return this.keys.has(code); }
  wasPressed(code) { return this.pressedThisFrame.has(code); }

  anyDown(codes) {
    if (!codes) return false;
    for (const c of codes) if (this.keys.has(c)) return true;
    return false;
  }

  anyPressed(codes) {
    if (!codes) return false;
    for (const c of codes) if (this.pressedThisFrame.has(c)) return true;
    return false;
  }

  anyReleased(codes) {
    if (!codes) return false;
    for (const c of codes) if (this.releasedThisFrame.has(c)) return true;
    return false;
  }

  /**
   * Build the input object for one local player.
   * @param {number} slot  index into this.bindings (0 or 1)
   */
  poll(slot) {
    const b = this.bindings[slot];
    if (!b) return neutralInput();

    let moveX = 0, moveY = 0;
    if (this.anyDown(b.left)) moveX -= 1;
    if (this.anyDown(b.right)) moveX += 1;
    // Screen "up" is toward the far end of the court, which is +y in world space.
    if (this.anyDown(b.up)) moveY += 1;
    if (this.anyDown(b.down)) moveY -= 1;

    let shotDown = false;
    let shotUp = false;
    let shotType = null;

    for (const name of SHOT_BUTTONS) {
      if (this.anyPressed(b[name])) { shotDown = true; shotType = name; }
      if (this.anyReleased(b[name])) { shotUp = true; if (!shotType) shotType = name; }
    }

    const input = {
      moveX, moveY,
      sprint: this.anyDown(b.sprint),
      shotDown, shotUp, shotType,
      // Aim mirrors movement at the moment of contact.
      aimX: moveX, aimY: moveY,
      serveAction: this.anyPressed(b.serve),
      splitStep: this.anyPressed(b.splitStep) || this.anyPressed(b.serve),
    };

    // A connected gamepad overrides the keyboard for this slot when it is being used.
    const pad = this._pollGamepad(slot);
    if (pad) mergePad(input, pad);

    return input;
  }

  /** Poll all local slots into a map keyed by player index. */
  pollAll() {
    const out = {};
    for (let s = 0; s < this.localSlots.length; s++) {
      const playerIndex = this.localSlots[s];
      if (playerIndex < 0) continue;
      out[playerIndex] = this.poll(s);
    }
    return out;
  }

  /**
   * Gamepad support. Left stick moves, face buttons hit, triggers sprint.
   * Mapping follows the standard layout, which is what a PS/Xbox pad reports on macOS.
   */
  _pollGamepad(slot) {
    if (!this.gamepadEnabled || !navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    const pad = pads && pads[slot];
    if (!pad || !pad.connected) return null;

    const prev = this._gamepadPrev[slot] || { buttons: [] };
    const dead = 0.18;

    const ax = applyDeadzone(pad.axes[0] || 0, dead);
    // Pad "up" is negative Y, and screen-up is +y in world space.
    const ay = -applyDeadzone(pad.axes[1] || 0, dead);

    const btn = (i) => !!(pad.buttons[i] && pad.buttons[i].pressed);
    const wasBtn = (i) => !!prev.buttons[i];

    // A/Cross = topspin, B/Circle = flat, X/Square = slice, Y/Triangle = lob,
    // L1 = drop, R1 = sprint, R2 = serve/split-step.
    const MAP = { topspin: 0, flat: 1, slice: 2, lob: 3, drop: 4 };

    let shotDown = false, shotUp = false, shotType = null;
    for (const [name, idx] of Object.entries(MAP)) {
      if (btn(idx) && !wasBtn(idx)) { shotDown = true; shotType = name; }
      if (!btn(idx) && wasBtn(idx)) { shotUp = true; if (!shotType) shotType = name; }
    }

    this._gamepadPrev[slot] = { buttons: pad.buttons.map((x) => x.pressed) };

    const active = Math.abs(ax) > 0 || Math.abs(ay) > 0 || shotDown || shotUp;
    if (!active && !btn(7)) return null;

    return {
      moveX: ax, moveY: ay,
      sprint: btn(5) || btn(7),
      shotDown, shotUp, shotType,
      aimX: ax, aimY: ay,
      serveAction: (btn(0) && !wasBtn(0)) || (btn(7) && !prev.buttons[7]),
      splitStep: btn(5) && !prev.buttons[5],
    };
  }

  /** Call once at the end of every frame, after all polling. */
  endFrame() {
    this.pressedThisFrame.clear();
    this.releasedThisFrame.clear();
  }

  /** Human-readable key name for the controls screen. */
  static keyLabel(code) {
    if (!code) return '—';
    return KEY_LABELS[code] || code
      .replace(/^Key/, '')
      .replace(/^Digit/, '')
      .replace(/^Arrow/, '')
      .replace(/Left$/, ' L')
      .replace(/Right$/, ' R');
  }
}

function neutralInput() {
  return {
    moveX: 0, moveY: 0, sprint: false,
    shotDown: false, shotUp: false, shotType: null,
    aimX: 0, aimY: 0, serveAction: false, splitStep: false,
  };
}

function mergePad(input, pad) {
  if (Math.abs(pad.moveX) > Math.abs(input.moveX)) { input.moveX = pad.moveX; input.aimX = pad.aimX; }
  if (Math.abs(pad.moveY) > Math.abs(input.moveY)) { input.moveY = pad.moveY; input.aimY = pad.aimY; }
  input.sprint = input.sprint || pad.sprint;
  input.shotDown = input.shotDown || pad.shotDown;
  input.shotUp = input.shotUp || pad.shotUp;
  input.shotType = input.shotType || pad.shotType;
  input.serveAction = input.serveAction || pad.serveAction;
  input.splitStep = input.splitStep || pad.splitStep;
}

function applyDeadzone(v, dead) {
  if (Math.abs(v) < dead) return 0;
  // Rescale so the stick still reaches full range past the deadzone.
  return Math.sign(v) * ((Math.abs(v) - dead) / (1 - dead));
}

const SCROLL_KEYS = new Set([
  'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'PageUp', 'PageDown', 'Home', 'End', 'Tab',
]);

const KEY_LABELS = {
  Space: 'Space', ShiftLeft: 'Shift', ShiftRight: 'Shift',
  ControlLeft: 'Ctrl', ControlRight: 'Ctrl',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Digit1: '1', Digit2: '2', Digit3: '3', Digit4: '4', Digit5: '5',
  Numpad1: '1', Numpad2: '2', Numpad3: '3', Numpad4: '4', Numpad5: '5',
  Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'",
  Enter: 'Enter', Escape: 'Esc', Tab: 'Tab',
};

/**
 * The canonical control list, rendered by the menus and the pause screen.
 *
 * Deliberately short. Arrows move, numbers hit, space serves — that is the whole
 * game. Everything below the first two rows is optional depth a player can ignore
 * for as long as they like.
 */
export const CONTROL_REFERENCE = [
  ['Move', ['↑', '↓', '←', '→'], 'Arrow keys. Always relative to the screen.'],
  ['Hit the ball', ['1', '2', '3', '4', '5'], 'Any number hits. 1 is your normal rally shot.'],
  ['Serve', ['Space'], 'Once to toss, once to hit.'],
  ['—', [], ''],
  ['1 · Topspin', ['1'], 'Your default. Safe, dips into the court.'],
  ['2 · Flat drive', ['2'], 'Faster and flatter. Riskier.'],
  ['3 · Slice', ['3'], 'Stays low, buys you time.'],
  ['4 · Lob', ['4'], 'Over an opponent at the net.'],
  ['5 · Drop shot', ['5'], 'Short, against an opponent standing deep.'],
  ['Sprint', ['Shift'], 'Optional. Costs stamina.'],
  ['Pause', ['Esc'], ''],
];
