/**
 * Broadcast camera: a pinhole perspective projection tuned to sit where a real
 * TV camera sits — behind the near baseline, up in the stands, tilted down about
 * 21°. That angle is what makes the court read as a trapezoid and gives the game
 * its depth.
 *
 * The camera has no yaw or roll, only pitch. That is deliberate: keeping the
 * right-vector locked to world +x means horizontal screen movement always maps to
 * horizontal court movement, so the controls never feel like they rotate under you.
 */

import { COURT } from '../sim/constants.js';

export class Camera {
  constructor() {
    // Home position, behind the near baseline and elevated.
    this.baseX = 0;
    this.baseY = -(COURT.HALF_LENGTH + 9.2);
    this.baseZ = 8.6;

    // Live position (base + sway + shake).
    this.x = this.baseX;
    this.y = this.baseY;
    this.z = this.baseZ;

    this.pitch = 0.372;        // ~21.3° below horizontal
    this.fov = 0.86;           // ~49° vertical field of view

    this.width = 1280;
    this.height = 720;
    this.focal = 1;

    // Gentle horizontal drift that tracks play, like an operator panning.
    this.sway = 0;
    this.swayTarget = 0;
    this.zoom = 1;
    this.zoomTarget = 1;

    // Impact shake.
    this._shake = 0;
    this._shakeX = 0;
    this._shakeY = 0;

    this.resize(this.width, this.height);
  }

  resize(width, height) {
    this.width = width;
    this.height = height;
    // Focal length in pixels from the vertical FOV.
    this.focal = (height / 2) / Math.tan(this.fov / 2);
  }

  /**
   * Project a world point to screen space.
   * Returns { x, y, scale, depth, visible }.
   *   scale — pixels per world metre at that depth. Multiply object sizes by this.
   *   depth — distance along the view axis; use it to sort draws back-to-front.
   */
  project(wx, wy, wz) {
    const dx = wx - this.x;
    const dy = wy - this.y;
    const dz = wz - this.z;

    const cp = this._cosPitch;
    const sp = this._sinPitch;

    // Depth along the camera's forward axis (0, cos p, -sin p).
    const depth = dy * cp - dz * sp;
    // Vertical offset along the camera's up axis (0, sin p, cos p).
    const up = dy * sp + dz * cp;

    // Guard against points at or behind the lens.
    if (depth <= 0.05) {
      return { x: 0, y: 0, scale: 0, depth, visible: false };
    }

    const f = this.focal * this.zoom;
    const invDepth = 1 / depth;

    return {
      x: this.width / 2 + f * dx * invDepth + this._shakeX,
      y: this.height / 2 - f * up * invDepth + this._shakeY,
      scale: f * invDepth,
      depth,
      visible: true,
    };
  }

  /** Shorthand for ground-plane points, which is most of the court drawing. */
  projectGround(wx, wy) {
    return this.project(wx, wy, 0);
  }

  /**
   * Inverse projection onto the ground plane (z = 0). Used for the aiming reticle
   * and for translating a mouse position into a court target.
   */
  screenToGround(sx, sy) {
    const f = this.focal * this.zoom;
    const nx = (sx - this.width / 2 - this._shakeX) / f;
    const ny = -(sy - this.height / 2 - this._shakeY) / f;

    const cp = this._cosPitch;
    const sp = this._sinPitch;

    // Ray direction in world space: right*nx + up*ny + forward*1
    const rx = nx;
    const ry = ny * sp + cp;
    const rz = ny * cp - sp;

    // Intersect with z = 0.
    if (Math.abs(rz) < 1e-6) return null;
    const t = -this.z / rz;
    if (t <= 0) return null;

    return { x: this.x + rx * t, y: this.y + ry * t };
  }

  /**
   * Follow the action. Passing the ball position lets the camera drift a little
   * toward the play and tighten up during a rally, which reads as a real operator
   * rather than a locked-off security camera.
   */
  follow(ballX, ballY, dt, intensity = 1) {
    // Pan at roughly 18 % of the ball's lateral offset — enough to feel alive,
    // little enough that the court never appears to slide around.
    this.swayTarget = ballX * 0.18 * intensity;
    // Ease in as play moves to the far end.
    const depthFrac = (ballY + COURT.HALF_LENGTH) / COURT.LENGTH;
    this.zoomTarget = 1 + depthFrac * 0.06 * intensity;

    const k = 1 - Math.exp(-2.6 * dt);
    this.sway += (this.swayTarget - this.sway) * k;
    this.zoom += (this.zoomTarget - this.zoom) * k;
    this.x = this.baseX + this.sway;

    this._updateShake(dt);
  }

  /** Reset the camera between points so it does not drift over a long match. */
  recentre(dt) {
    const k = 1 - Math.exp(-3.5 * dt);
    this.sway += (0 - this.sway) * k;
    this.zoom += (1 - this.zoom) * k;
    this.x = this.baseX + this.sway;
    this._updateShake(dt);
  }

  /** Kick the camera on a big hit. amount is roughly pixels of displacement. */
  shake(amount) {
    this._shake = Math.min(this._shake + amount, 18);
  }

  _updateShake(dt) {
    if (this._shake > 0.01) {
      this._shake *= Math.exp(-11 * dt);
      this._shakeX = (Math.random() * 2 - 1) * this._shake;
      this._shakeY = (Math.random() * 2 - 1) * this._shake * 0.6;
    } else {
      this._shake = 0;
      this._shakeX = 0;
      this._shakeY = 0;
    }
  }

  get _cosPitch() { return Math.cos(this.pitch); }
  get _sinPitch() { return Math.sin(this.pitch); }

  /**
   * Switch camera preset. "broadcast" is the default; "low" sits nearer the court
   * for a more dramatic, harder-to-read angle; "high" is closer to a tactical view
   * that makes doubles positioning legible.
   */
  setPreset(preset) {
    const presets = {
      broadcast: { y: -(COURT.HALF_LENGTH + 9.2), z: 8.6,  pitch: 0.372, fov: 0.86 },
      low:       { y: -(COURT.HALF_LENGTH + 6.5), z: 5.2,  pitch: 0.268, fov: 0.92 },
      high:      { y: -(COURT.HALF_LENGTH + 11),  z: 14.5, pitch: 0.560, fov: 0.82 },
    };
    const p = presets[preset] || presets.broadcast;
    this.baseY = p.y;
    this.baseZ = p.z;
    this.y = p.y;
    this.z = p.z;
    this.pitch = p.pitch;
    this.fov = p.fov;
    this.resize(this.width, this.height);
  }
}
