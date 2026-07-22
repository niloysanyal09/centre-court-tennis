/**
 * Fixed-timestep game loop.
 *
 * Physics runs at a constant SIM.DT regardless of display refresh rate. This matters
 * for three reasons: a 120 Hz MacBook and a 60 Hz external monitor must simulate the
 * same tennis; fast serves would tunnel through the net at variable large steps; and
 * the host's authoritative simulation has to be reproducible for the netcode.
 *
 * Rendering runs once per animation frame with an interpolation factor, so the visual
 * smoothness follows the display while the simulation stays locked.
 */

import { SIM } from '../sim/constants.js';

export class GameLoop {
  /**
   * @param {(dt:number)=>void} onFixedUpdate  called at exactly SIM.DT intervals
   * @param {(dt:number, alpha:number)=>void} onRender  called once per frame
   */
  constructor(onFixedUpdate, onRender) {
    this.onFixedUpdate = onFixedUpdate;
    this.onRender = onRender;

    this.running = false;
    this.paused = false;
    this._accumulator = 0;
    this._lastTime = 0;
    this._rafId = null;
    this._frame = this._frame.bind(this);

    // Diagnostics.
    this.fps = 0;
    this._fpsAccum = 0;
    this._fpsFrames = 0;
    this.stepsLastFrame = 0;
    this.timeScale = 1;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._lastTime = performance.now();
    this._accumulator = 0;
    this._rafId = requestAnimationFrame(this._frame);
  }

  stop() {
    this.running = false;
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  pause() { this.paused = true; }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    // Discard the time spent paused, or the loop would try to catch up on it.
    this._lastTime = performance.now();
    this._accumulator = 0;
  }

  _frame(now) {
    if (!this.running) return;
    this._rafId = requestAnimationFrame(this._frame);

    let frameTime = (now - this._lastTime) / 1000;
    this._lastTime = now;

    // Guard against a tab returning from the background with a huge delta.
    if (frameTime > 0.25) frameTime = 0.25;

    this._fpsAccum += frameTime;
    this._fpsFrames++;
    if (this._fpsAccum >= 0.5) {
      this.fps = Math.round(this._fpsFrames / this._fpsAccum);
      this._fpsAccum = 0;
      this._fpsFrames = 0;
    }

    if (this.paused) {
      this.onRender(0, 0);
      return;
    }

    this._accumulator += frameTime * this.timeScale;

    let steps = 0;
    while (this._accumulator >= SIM.DT && steps < SIM.MAX_STEPS_PER_FRAME) {
      this.onFixedUpdate(SIM.DT);
      this._accumulator -= SIM.DT;
      steps++;
    }
    this.stepsLastFrame = steps;

    // If we hit the step cap the machine cannot keep up; drop the backlog rather
    // than spiral into an ever-growing catch-up debt.
    if (steps >= SIM.MAX_STEPS_PER_FRAME) this._accumulator = 0;

    const alpha = this._accumulator / SIM.DT;
    this.onRender(frameTime, alpha);
  }
}
