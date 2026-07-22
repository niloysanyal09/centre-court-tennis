/**
 * Scene renderer.
 *
 * Draw order matters more than anything else here. The net sits at y = 0 and cuts the
 * world in two: everything at the far end must be drawn BEFORE the net, everything at
 * the near end AFTER it, or players will appear to stand through the mesh. Within
 * each half, entities sort far-to-near.
 */

import { CourtRenderer } from './courtdraw.js';
import { Effects, drawBall, drawBallShadow, drawLandingMarker, drawAimGuide, drawTargetZone } from './fx.js';
import { drawPlayer, drawShadow } from './playerdraw.js';
import { HUD } from './hud.js';
import { COURT } from '../sim/constants.js';

/** Shared empty array so the per-frame line-dash reset allocates nothing. */
const EMPTY_DASH = [];

export class Renderer {
  constructor(canvas, camera) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.camera = camera;
    this.court = new CourtRenderer();
    this.fx = new Effects();
    this.hud = new HUD();

    this.showLandingMarker = true;
    this.showAimGuide = true;
    this.showTrail = true;
    this.targetZones = null;

    this._dpr = 1;
    this.time = 0;
  }

  resize(cssWidth, cssHeight) {
    // Cap the device pixel ratio: a 3× Retina buffer on a 15-inch display costs a lot
    // of fill rate for very little visible gain in a scene like this.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this._dpr = dpr;
    this.canvas.width = Math.round(cssWidth * dpr);
    this.canvas.height = Math.round(cssHeight * dpr);
    this.canvas.style.width = cssWidth + 'px';
    this.canvas.style.height = cssHeight + 'px';
    this.camera.resize(cssWidth, cssHeight);
    this._resetContext();
  }

  /**
   * Put the context back into a known-good state.
   *
   * This MUST run at the top of every frame, not just on resize. The canvas
   * transform persists across frames, so a single unbalanced save()/rotate()
   * anywhere in the draw tree does not merely glitch one frame — it compounds every
   * frame until the whole scene, HUD included, is spinning. Resetting per frame
   * turns that class of bug from catastrophic into invisible.
   */
  _resetContext() {
    const ctx = this.ctx;
    const dpr = this._dpr;
    // Unwind any save() levels a draw call failed to pop.
    for (let i = 0; i < 8; i++) ctx.restore();
    // Draw in CSS pixels; the transform handles the device scaling.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';
    ctx.setLineDash(EMPTY_DASH);
  }

  /**
   * @param {MatchEngine} match
   * @param {object} opts { localPlayer, prediction, aimPreview, dt }
   */
  render(match, opts = {}) {
    const ctx = this.ctx;
    const cam = this.camera;
    const W = cam.width, H = cam.height;
    const venue = match.venue;
    const surface = match.surface;

    this.time += opts.dt || 0;

    this._resetContext();
    ctx.save();

    // ── Static scene ─────────────────────────────────────────────────────────
    this.court.drawBackground(ctx, cam, venue);
    this.court.drawCourt(ctx, cam, surface, venue, match.doubles);

    // ── Ground decals ────────────────────────────────────────────────────────
    this.fx.drawMarks(ctx, cam);

    if (this.targetZones) {
      for (const z of this.targetZones) drawTargetZone(ctx, cam, z);
    }

    if (this.showLandingMarker && opts.prediction && match.isLive) {
      drawLandingMarker(ctx, cam, opts.prediction, { time: this.time });
    }

    // ── Shadows (all on the ground plane, so they draw as one layer) ─────────
    for (const p of match.players) drawShadow(ctx, cam, p, venue);
    if (match.ball.inPlay || match.ball.z > 0.01) {
      drawBallShadow(ctx, cam, match.ball, venue);
    }

    // ── Entities, split by the net ───────────────────────────────────────────
    const entities = [];
    for (const p of match.players) {
      entities.push({ y: p.y, kind: 'player', ref: p });
    }
    entities.push({ y: match.ball.y, kind: 'ball', ref: match.ball });

    // Far side first (largest y down to 0), then the net, then the near side.
    const far = entities.filter((e) => e.y >= 0).sort((a, b) => b.y - a.y);
    const near = entities.filter((e) => e.y < 0).sort((a, b) => b.y - a.y);

    for (const e of far) this._drawEntity(ctx, cam, e, venue, match);
    this.court.drawNet(ctx, cam);
    for (const e of near) this._drawEntity(ctx, cam, e, venue, match);

    // ── Overlays ─────────────────────────────────────────────────────────────
    if (this.showAimGuide && opts.aimPreview) {
      drawAimGuide(ctx, cam, opts.aimPreview.from, opts.aimPreview.to, opts.aimPreview.power);
    }

    this.fx.drawParticles(ctx, cam);
    this.fx.drawRings(ctx, cam);
    this.fx.drawTexts(ctx, cam);

    ctx.restore();

    // ── HUD ──────────────────────────────────────────────────────────────────
    this.hud.draw(ctx, W, H, match, {
      localPlayer: opts.localPlayer,
      wind: match.wind,
    });

    if (opts.overlay) opts.overlay(ctx, W, H);
  }

  _drawEntity(ctx, cam, e, venue, match) {
    if (e.kind === 'player') {
      // Shadows were already drawn as a single ground-plane batch above, so the
      // figure must not draw its own or every player gets a doubled shadow.
      drawPlayer(ctx, cam, e.ref, e.ref.avatar, { venue, shadow: false });
    } else {
      const b = e.ref;
      if (b.inPlay || b.z > 0.01 || b.speed > 0.05) {
        drawBall(ctx, cam, b, venue);
      }
    }
  }

  /** Full-screen tint, used for pause and transitions. */
  dim(alpha = 0.55) {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = `rgba(4, 8, 14, ${alpha})`;
    ctx.fillRect(0, 0, this.camera.width, this.camera.height);
    ctx.restore();
  }
}
