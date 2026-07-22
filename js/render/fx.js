/**
 * Ball rendering and visual effects: trails, shadows, bounce marks, dust, impact
 * bursts, and the floating call-outs that tell you how you struck the ball.
 *
 * The ball is a small object moving fast in a big scene, so readability matters more
 * than fidelity: it gets a motion trail scaled to its speed, a hard ground shadow
 * that tells you its height, and a subtle rim light so it never disappears against
 * the court.
 */

import { BALL, COURT } from '../sim/constants.js';

export class Effects {
  constructor() {
    this.particles = [];
    this.marks = [];        // bounce marks left on the court
    this.texts = [];        // floating call-outs
    this.rings = [];        // impact rings at contact
    this._maxParticles = 260;
  }

  clear() {
    this.particles.length = 0;
    this.marks.length = 0;
    this.texts.length = 0;
    this.rings.length = 0;
  }

  update(dt) {
    // Particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) { this.particles.splice(i, 1); continue; }
      p.vz -= 9.81 * dt * p.gravity;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (p.z < 0) { p.z = 0; p.vz *= -0.25; p.vx *= 0.7; p.vy *= 0.7; }
      p.vx *= 1 - p.drag * dt;
      p.vy *= 1 - p.drag * dt;
    }

    for (let i = this.marks.length - 1; i >= 0; i--) {
      this.marks[i].life -= dt;
      if (this.marks[i].life <= 0) this.marks.splice(i, 1);
    }

    for (let i = this.texts.length - 1; i >= 0; i--) {
      const t = this.texts[i];
      t.life -= dt;
      t.z += t.rise * dt;
      if (t.life <= 0) this.texts.splice(i, 1);
    }

    for (let i = this.rings.length - 1; i >= 0; i--) {
      this.rings[i].life -= dt;
      if (this.rings[i].life <= 0) this.rings.splice(i, 1);
    }
  }

  // ── Spawners ───────────────────────────────────────────────────────────────

  /** Dust or scuff at a bounce. Clay puffs; hard courts and grass do not. */
  bounceDust(x, y, speed, surface) {
    this.marks.push({
      x, y,
      r: 0.05 + Math.min(0.09, speed * 0.004),
      life: surface.id === 'clay' ? 9 : 3.5,
      maxLife: surface.id === 'clay' ? 9 : 3.5,
      color: surface.id === 'clay' ? 'rgba(90,45,25,0.5)' : 'rgba(0,0,0,0.16)',
    });

    if (!surface.dustColor || speed < 6) return;
    const n = Math.min(14, 3 + Math.floor(speed * 0.45));
    for (let i = 0; i < n; i++) {
      if (this.particles.length >= this._maxParticles) break;
      const a = Math.random() * Math.PI * 2;
      const sp = 0.6 + Math.random() * speed * 0.09;
      this.particles.push({
        x, y, z: 0.02,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, vz: 0.4 + Math.random() * 1.4,
        size: 0.03 + Math.random() * 0.07,
        life: 0.5 + Math.random() * 0.7, maxLife: 1.2,
        color: surface.dustColor, gravity: 0.35, drag: 2.2,
      });
    }
  }

  /** A burst at the moment of contact, sized by how hard the ball was struck. */
  impact(x, y, z, power, quality) {
    this.rings.push({
      x, y, z,
      r0: 0.08, r1: 0.35 + power * 0.5,
      life: 0.22, maxLife: 0.22,
      color: quality > 0.85 ? 'rgba(255,240,180,0.9)' : 'rgba(255,255,255,0.55)',
    });

    if (power < 0.5) return;
    const n = Math.floor(4 + power * 8);
    for (let i = 0; i < n; i++) {
      if (this.particles.length >= this._maxParticles) break;
      const a = Math.random() * Math.PI * 2;
      const el = Math.random() * Math.PI - Math.PI / 2;
      const sp = 1.5 + Math.random() * 3.5 * power;
      this.particles.push({
        x, y, z,
        vx: Math.cos(a) * Math.cos(el) * sp,
        vy: Math.sin(a) * Math.cos(el) * sp,
        vz: Math.sin(el) * sp,
        size: 0.015 + Math.random() * 0.025,
        life: 0.16 + Math.random() * 0.2, maxLife: 0.36,
        color: 'rgba(255,248,215,0.9)', gravity: 0.6, drag: 4,
      });
    }
  }

  /** Sweat and scuff kicked up by hard footwork. */
  footScuff(x, y, surface, intensity) {
    if (!surface.dustColor || intensity < 0.4) return;
    const n = Math.floor(intensity * 5);
    for (let i = 0; i < n; i++) {
      if (this.particles.length >= this._maxParticles) break;
      const a = Math.random() * Math.PI * 2;
      this.particles.push({
        x, y, z: 0.02,
        vx: Math.cos(a) * 0.9, vy: Math.sin(a) * 0.9, vz: 0.3 + Math.random() * 0.6,
        size: 0.025 + Math.random() * 0.04,
        life: 0.3 + Math.random() * 0.4, maxLife: 0.7,
        color: surface.dustColor, gravity: 0.5, drag: 3,
      });
    }
  }

  /** Floating text above a world point: "PERFECT", "ACE", "OUT". */
  text(str, x, y, z, opts = {}) {
    this.texts.push({
      str, x, y, z,
      life: opts.life ?? 1.1, maxLife: opts.life ?? 1.1,
      rise: opts.rise ?? 1.3,
      color: opts.color ?? '#ffffff',
      size: opts.size ?? 1,
      weight: opts.weight ?? 800,
    });
  }

  // ── Drawing ────────────────────────────────────────────────────────────────

  /** Bounce marks sit on the court, so they draw before players and the ball. */
  drawMarks(ctx, camera) {
    for (const m of this.marks) {
      const p = camera.projectGround(m.x, m.y);
      if (!p.visible) continue;
      const a = m.life / m.maxLife;
      const rx = m.r * p.scale;
      // A bounce mark is an ellipse because we are looking at the ground obliquely.
      ctx.save();
      ctx.globalAlpha = a * 0.8;
      ctx.fillStyle = m.color;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, rx * 1.15, rx * 0.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  drawParticles(ctx, camera) {
    for (const p of this.particles) {
      const pr = camera.project(p.x, p.y, p.z);
      if (!pr.visible) continue;
      const a = Math.min(1, p.life / p.maxLife);
      const s = Math.max(0.6, p.size * pr.scale);
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(pr.x, pr.y, s, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  drawRings(ctx, camera) {
    for (const r of this.rings) {
      const p = camera.project(r.x, r.y, r.z);
      if (!p.visible) continue;
      const f = 1 - r.life / r.maxLife;
      const rad = (r.r0 + (r.r1 - r.r0) * f) * p.scale;
      ctx.save();
      ctx.globalAlpha = (1 - f) * 0.85;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = Math.max(1, p.scale * 0.02);
      ctx.beginPath();
      ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  drawTexts(ctx, camera) {
    for (const t of this.texts) {
      const p = camera.project(t.x, t.y, t.z);
      if (!p.visible) continue;
      const f = t.life / t.maxLife;
      const size = Math.max(11, p.scale * 0.16 * t.size);
      ctx.save();
      ctx.globalAlpha = Math.min(1, f * 1.8);
      ctx.font = `${t.weight} ${size}px "SF Pro Display", -apple-system, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.lineWidth = size * 0.16;
      ctx.strokeStyle = 'rgba(0,0,0,0.65)';
      ctx.strokeText(t.str, p.x, p.y);
      ctx.fillStyle = t.color;
      ctx.fillText(t.str, p.x, p.y);
      ctx.restore();
    }
  }
}

/**
 * The ball. Drawn with a speed-scaled motion trail, a ground shadow whose separation
 * communicates height, and a bright rim so it stays legible against any surface.
 */
export function drawBall(ctx, camera, ball, venue) {
  if (!ball.inPlay && ball.z <= BALL.RADIUS + 0.001 && ball.speed < 0.2) {
    // Dead ball still sitting on court — draw it, but without trail or highlight.
  }

  const p = camera.project(ball.x, ball.y, ball.z);
  if (!p.visible) return;

  const r = Math.max(2, BALL.RADIUS * p.scale);
  const speed = ball.speed;

  // ── Motion trail ─────────────────────────────────────────────────────────
  if (speed > 8 && ball.trail.length >= 6) {
    ctx.save();
    ctx.lineCap = 'round';
    const pts = ball.trail;
    const count = pts.length / 3;
    // Only the most recent samples, scaled by speed, so a soft drop shot has no comet tail.
    const show = Math.min(count, Math.floor(4 + speed * 0.55));
    for (let i = count - show; i < count - 1; i++) {
      if (i < 0) continue;
      const a = camera.project(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
      const b = camera.project(pts[(i + 1) * 3], pts[(i + 1) * 3 + 1], pts[(i + 1) * 3 + 2]);
      if (!a.visible || !b.visible) continue;
      const f = (i - (count - show)) / show;
      ctx.globalAlpha = f * 0.4;
      ctx.strokeStyle = '#e8ff5a';
      ctx.lineWidth = Math.max(0.6, r * 1.5 * f);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // ── Ball ─────────────────────────────────────────────────────────────────
  // Slight vertical squash at very high speed reads as motion blur.
  const stretch = Math.min(1.5, 1 + speed * 0.008);

  ctx.save();
  ctx.translate(p.x, p.y);
  if (speed > 15) {
    ctx.rotate(Math.atan2(-(ball.vz), Math.hypot(ball.vx, ball.vy)) * 0.4);
  }

  const g = ctx.createRadialGradient(-r * 0.32, -r * 0.36, r * 0.1, 0, 0, r * 1.05);
  g.addColorStop(0, '#f4ff9a');
  g.addColorStop(0.55, '#d8ec3a');
  g.addColorStop(1, '#9cb520');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(0, 0, r * stretch, r, 0, 0, Math.PI * 2);
  ctx.fill();

  // The seam, only worth drawing when the ball is large enough on screen.
  if (r > 4) {
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = Math.max(0.7, r * 0.14);
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.92, Math.PI * 0.15, Math.PI * 0.72);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.92, Math.PI * 1.15, Math.PI * 1.72);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * The ball's ground shadow. Its offset from the ball is the primary depth cue for
 * judging how high a lob really is.
 */
export function drawBallShadow(ctx, camera, ball, venue) {
  const p = camera.projectGround(ball.x, ball.y);
  if (!p.visible) return;

  const height = Math.max(0, ball.z);
  // Shadows spread and fade with height, exactly as a real one does.
  const spread = 1 + height * 0.22;
  const alpha = (venue.shadowAlpha ?? 0.3) * Math.max(0.12, 1 - height * 0.11);
  const r = BALL.RADIUS * p.scale * spread;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.ellipse(p.x, p.y, r * 1.3, r * 0.55, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * The landing marker: a ring on the court showing where the ball is predicted to
 * bounce. This is the single most useful assist for a new player, and it is worth
 * turning off as they improve.
 */
export function drawLandingMarker(ctx, camera, prediction, opts = {}) {
  if (!prediction || prediction.landX === null || prediction.landX === undefined) return;
  const p = camera.projectGround(prediction.landX, prediction.landY);
  if (!p.visible) return;

  const t = opts.time ?? 0;
  const pulse = 0.85 + Math.sin(t * 9) * 0.15;
  const r = 0.42 * p.scale * pulse;

  ctx.save();
  ctx.strokeStyle = opts.color || 'rgba(255,255,255,0.8)';
  ctx.lineWidth = Math.max(1.2, p.scale * 0.022);
  ctx.beginPath();
  ctx.ellipse(p.x, p.y, r * 1.25, r * 0.55, 0, 0, Math.PI * 2);
  ctx.stroke();

  // A crosshair makes the exact spot readable at distance.
  ctx.globalAlpha = 0.55;
  ctx.beginPath();
  ctx.moveTo(p.x - r * 1.45, p.y);
  ctx.lineTo(p.x - r * 0.75, p.y);
  ctx.moveTo(p.x + r * 0.75, p.y);
  ctx.lineTo(p.x + r * 1.45, p.y);
  ctx.stroke();
  ctx.restore();
}

/**
 * Aiming guide: a faint arc from the striker to their intended target, shown while
 * the shot is charging. Teaches placement without dictating it.
 */
export function drawAimGuide(ctx, camera, from, to, power) {
  const steps = 14;
  ctx.save();
  ctx.strokeStyle = `rgba(0, 224, 122, ${0.18 + power * 0.3})`;
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const x = from.x + (to.x - from.x) * f;
    const y = from.y + (to.y - from.y) * f;
    // A simple arc, purely indicative — the real trajectory is solved at contact.
    const z = Math.sin(f * Math.PI) * 1.4 + 0.1;
    const p = camera.project(x, y, z);
    if (!p.visible) continue;
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();

  const target = camera.projectGround(to.x, to.y);
  if (target.visible) {
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(0, 224, 122, 0.75)';
    ctx.lineWidth = Math.max(1.5, target.scale * 0.02);
    const r = 0.35 * target.scale;
    ctx.beginPath();
    ctx.ellipse(target.x, target.y, r * 1.25, r * 0.55, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Target zones for practice drills — highlighted patches of court the player is
 * being asked to hit.
 */
export function drawTargetZone(ctx, camera, zone, opts = {}) {
  const { x, y, w, h } = zone;
  const corners = [
    [x - w / 2, y - h / 2], [x + w / 2, y - h / 2],
    [x + w / 2, y + h / 2], [x - w / 2, y + h / 2],
  ].map(([cx, cy]) => camera.projectGround(cx, cy));

  if (corners.some((c) => !c.visible)) return;

  ctx.save();
  ctx.globalAlpha = opts.alpha ?? (zone.hit ? 0.55 : 0.3);
  ctx.fillStyle = zone.hit ? '#00e07a' : (opts.color || '#ffd23f');
  ctx.beginPath();
  ctx.moveTo(corners[0].x, corners[0].y);
  for (let i = 1; i < 4; i++) ctx.lineTo(corners[i].x, corners[i].y);
  ctx.closePath();
  ctx.fill();

  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = zone.hit ? '#00ff8c' : '#ffffff';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}
