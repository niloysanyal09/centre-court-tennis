/**
 * Court, net and stadium rendering.
 *
 * Everything is drawn as projected polygons rather than stroked lines, because a
 * stroke has constant screen width and a real court line does not — it narrows with
 * distance. Projecting the four corners of each line and filling the quad is what
 * sells the perspective.
 *
 * The stadium and crowd are expensive (thousands of speckles) and almost static, so
 * they render once into an offscreen canvas and are only redrawn when the camera has
 * actually moved enough to matter.
 */

import { COURT } from '../sim/constants.js';
import { netHeightAt } from '../sim/physics.js';

/**
 * Representative distance to the stands, in metres. Used to convert the camera's
 * lateral sway into the equivalent screen-space shift of the cached backdrop.
 */
const STAND_DEPTH = 38;

export class CourtRenderer {
  constructor() {
    this.bg = document.createElement('canvas');
    this.bgCtx = this.bg.getContext('2d');
    this._bgKey = null;
    this._crowd = null;
    this._crowdVenue = null;
  }

  /**
   * Draw sky, stands and crowd.
   *
   * The crowd is roughly four thousand spectators, each costing two fills, so
   * re-rendering it per frame is about eight thousand draw calls and it will happily
   * drag the game down to single-digit FPS. It therefore renders ONCE per venue and
   * viewport into an offscreen canvas.
   *
   * The camera still sways and zooms every frame, though, so the cache cannot be keyed
   * on those or it would miss constantly and we would be back where we started.
   * Instead the cached bitmap is blitted with a matching screen-space shift and scale.
   * The stands sit 30–45 m away, where parallax across the camera's ~1 m of drift is
   * nearly uniform, so a flat translation is visually indistinguishable from
   * reprojecting all four thousand points — and it costs one drawImage.
   */
  drawBackground(ctx, camera, venue) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const key = `${venue.id}|${camera.width}x${camera.height}|${dpr}|${camera.pitch.toFixed(4)}|${camera.baseZ}`;

    if (this._bgKey !== key) {
      this.bg.width = Math.round(camera.width * dpr);
      this.bg.height = Math.round(camera.height * dpr);
      this.bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Render from the neutral camera pose so the cache is pose-independent.
      const savedX = camera.x;
      const savedZoom = camera.zoom;
      camera.x = camera.baseX;
      camera.zoom = 1;
      this._renderBackground(this.bgCtx, camera, venue);
      camera.x = savedX;
      camera.zoom = savedZoom;

      this._bgKey = key;
    }

    const W = camera.width;
    const H = camera.height;
    const sway = camera.x - camera.baseX;
    // Screen-space shift equivalent to the camera's lateral drift, evaluated at the
    // representative depth of the stands.
    const dx = -(camera.focal * sway) / STAND_DEPTH;
    const z = camera.zoom;

    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.scale(z, z);
    ctx.translate(-W / 2 + dx, -H / 2);
    ctx.drawImage(this.bg, 0, 0, W, H);
    ctx.restore();
  }

  _renderBackground(ctx, camera, venue) {
    const W = camera.width, H = camera.height;
    ctx.clearRect(0, 0, W, H);

    // ── Sky ────────────────────────────────────────────────────────────────
    const sky = ctx.createLinearGradient(0, 0, 0, H * 0.62);
    const cols = venue.sky;
    sky.addColorStop(0, cols[0]);
    sky.addColorStop(0.55, cols[1]);
    sky.addColorStop(1, cols[2]);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    // Floodlight bloom for night sessions.
    if (venue.floodlit) {
      for (const fx of [-0.32, 0.32]) {
        const g = ctx.createRadialGradient(W / 2 + W * fx, H * 0.06, 0, W / 2 + W * fx, H * 0.06, H * 0.42);
        g.addColorStop(0, 'rgba(255,250,225,0.28)');
        g.addColorStop(1, 'rgba(255,250,225,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
      }
    }

    this._ensureCrowd(venue);

    const st = venue.stadium;
    const innerX = COURT.DOUBLES_HALF_WIDTH + COURT.RUNOFF_SIDE;
    const innerY = COURT.HALF_LENGTH + COURT.RUNOFF_BACK;
    const outerX = innerX + 15;
    const outerY = innerY + 17;
    const topZ = 13.5;

    // ── Far stand ──────────────────────────────────────────────────────────
    this._drawStand(ctx, camera, st, {
      // A raked bank running across the far end.
      p1: [-outerX, innerY, 0.8], p2: [outerX, innerY, 0.8],
      p3: [outerX, outerY, topZ], p4: [-outerX, outerY, topZ],
    });

    // ── Side stands ────────────────────────────────────────────────────────
    for (const s of [-1, 1]) {
      this._drawStand(ctx, camera, st, {
        p1: [s * innerX, -innerY, 0.8], p2: [s * innerX, innerY, 0.8],
        p3: [s * outerX, innerY, topZ], p4: [s * outerX, -outerY, topZ],
      });
    }

    // ── Crowd ──────────────────────────────────────────────────────────────
    this._drawCrowd(ctx, camera, venue);

    // ── Roof / upper rim ───────────────────────────────────────────────────
    if (st.hasRoof && st.roof) {
      ctx.fillStyle = st.roof;
      this._quad(ctx, camera,
        [-outerX, outerY, topZ], [outerX, outerY, topZ],
        [outerX, outerY, topZ + 2.2], [-outerX, outerY, topZ + 2.2]);
    }

    // ── Sponsor band / back wall at court level ────────────────────────────
    ctx.fillStyle = st.wall;
    this._quad(ctx, camera,
      [-outerX, innerY, 0], [outerX, innerY, 0],
      [outerX, innerY, 1.05], [-outerX, innerY, 1.05]);

    ctx.fillStyle = st.wallTrim;
    this._quad(ctx, camera,
      [-outerX, innerY, 1.05], [outerX, innerY, 1.05],
      [outerX, innerY, 1.22], [-outerX, innerY, 1.22]);

    // Side walls.
    for (const s of [-1, 1]) {
      ctx.fillStyle = st.wall;
      this._quad(ctx, camera,
        [s * innerX, -innerY, 0], [s * innerX, innerY, 0],
        [s * innerX, innerY, 1.05], [s * innerX, -innerY, 1.05]);
    }
  }

  _drawStand(ctx, camera, st, q) {
    const g = ctx.createLinearGradient(0, 0, 0, camera.height);
    g.addColorStop(0, st.seats[0]);
    g.addColorStop(1, st.seats[1]);
    ctx.fillStyle = g;
    this._quad(ctx, camera, q.p1, q.p2, q.p3, q.p4);
  }

  /**
   * Crowd speckles. Generated once per venue in world space, then projected. Each
   * spectator is two marks (torso and a lighter head) so the bank reads as people
   * rather than noise.
   */
  _ensureCrowd(venue) {
    if (this._crowdVenue === venue.id && this._crowd) return;

    const rng = mulberry32(hashString(venue.id));
    const pts = [];
    const density = venue.crowdDensity;
    const palette = venue.crowdPalette;

    const innerX = COURT.DOUBLES_HALF_WIDTH + COURT.RUNOFF_SIDE;
    const innerY = COURT.HALF_LENGTH + COURT.RUNOFF_BACK;
    const outerX = innerX + 15;
    const outerY = innerY + 17;
    const topZ = 13.5;

    // Far bank: rows rising away from the court.
    const rows = 26;
    for (let r = 0; r < rows; r++) {
      const f = r / (rows - 1);
      const y = innerY + f * (outerY - innerY);
      const z = 1.2 + f * (topZ - 1.2);
      const cols = 74;
      for (let c = 0; c < cols; c++) {
        if (rng() > density) continue;
        const x = -outerX + ((c + rng() * 0.7) / cols) * outerX * 2;
        pts.push(x, y, z, palette[(rng() * palette.length) | 0]);
      }
    }

    // Side banks.
    for (const s of [-1, 1]) {
      for (let r = 0; r < rows; r++) {
        const f = r / (rows - 1);
        const x = s * (innerX + f * (outerX - innerX));
        const z = 1.2 + f * (topZ - 1.2);
        const cols = 60;
        for (let c = 0; c < cols; c++) {
          if (rng() > density * 0.92) continue;
          const y = -outerY + ((c + rng() * 0.7) / cols) * (outerY + innerY);
          pts.push(x, y, z, palette[(rng() * palette.length) | 0]);
        }
      }
    }

    this._crowd = pts;
    this._crowdVenue = venue.id;
  }

  _drawCrowd(ctx, camera, venue) {
    const pts = this._crowd;
    if (!pts) return;

    for (let i = 0; i < pts.length; i += 4) {
      const p = camera.project(pts[i], pts[i + 1], pts[i + 2]);
      if (!p.visible || p.x < -20 || p.x > camera.width + 20 || p.y < -20 || p.y > camera.height) continue;

      const s = Math.max(1.2, p.scale * 0.42);
      ctx.fillStyle = pts[i + 3];
      ctx.fillRect(p.x - s / 2, p.y - s, s, s * 1.5);
      // A paler mark above the torso reads as a head at any distance.
      ctx.fillStyle = 'rgba(220,200,180,0.55)';
      ctx.fillRect(p.x - s * 0.3, p.y - s * 1.55, s * 0.6, s * 0.6);
    }
  }

  // ── Court surface and lines ────────────────────────────────────────────────

  drawCourt(ctx, camera, surface, venue, doubles) {
    const outX = COURT.DOUBLES_HALF_WIDTH + COURT.RUNOFF_SIDE;
    const outY = COURT.HALF_LENGTH + COURT.RUNOFF_BACK;

    // Surround (the run-off area beyond the lines).
    ctx.fillStyle = surface.outerColor;
    this._quad(ctx, camera, [-outX, -outY, 0], [outX, -outY, 0], [outX, outY, 0], [-outX, outY, 0]);

    // Playing surface.
    const pw = COURT.DOUBLES_HALF_WIDTH;
    const pl = COURT.HALF_LENGTH;

    if (surface.stripes) {
      // Mown stripes, alternating bands running across the court.
      const bands = 10;
      for (let i = 0; i < bands; i++) {
        const y0 = -pl + (i / bands) * pl * 2;
        const y1 = -pl + ((i + 1) / bands) * pl * 2;
        ctx.fillStyle = i % 2 === 0 ? surface.courtColor : surface.courtColorAlt;
        this._quad(ctx, camera, [-pw, y0, 0], [pw, y0, 0], [pw, y1, 0], [-pw, y1, 0]);
      }
    } else {
      ctx.fillStyle = surface.courtColor;
      this._quad(ctx, camera, [-pw, -pl, 0], [pw, -pl, 0], [pw, pl, 0], [-pw, pl, 0]);
    }

    // ── Lines ────────────────────────────────────────────────────────────────
    ctx.fillStyle = surface.lineColor;
    const LW = COURT.LINE_WIDTH;
    const BW = COURT.BASELINE_WIDTH;
    const sw = COURT.SINGLES_HALF_WIDTH;
    const dw = COURT.DOUBLES_HALF_WIDTH;

    // Baselines.
    this._lineY(ctx, camera, -pl, -dw, dw, BW);
    this._lineY(ctx, camera, pl, -dw, dw, BW);
    // Doubles sidelines.
    this._lineX(ctx, camera, -dw, -pl, pl, LW);
    this._lineX(ctx, camera, dw, -pl, pl, LW);
    // Singles sidelines.
    this._lineX(ctx, camera, -sw, -pl, pl, LW);
    this._lineX(ctx, camera, sw, -pl, pl, LW);
    // Service lines.
    this._lineY(ctx, camera, -COURT.SERVICE_LINE, -sw, sw, LW);
    this._lineY(ctx, camera, COURT.SERVICE_LINE, -sw, sw, LW);
    // Centre service line.
    this._lineX(ctx, camera, 0, -COURT.SERVICE_LINE, COURT.SERVICE_LINE, LW);
    // Centre marks on the baselines.
    this._lineX(ctx, camera, 0, -pl, -pl + 0.3, LW);
    this._lineX(ctx, camera, 0, pl - 0.3, pl, LW);
  }

  /** A line running across the court (constant y). */
  _lineY(ctx, camera, y, x0, x1, w) {
    const h = w / 2;
    this._quad(ctx, camera, [x0, y - h, 0], [x1, y - h, 0], [x1, y + h, 0], [x0, y + h, 0]);
  }

  /** A line running the length of the court (constant x). */
  _lineX(ctx, camera, x, y0, y1, w) {
    const h = w / 2;
    this._quad(ctx, camera, [x - h, y0, 0], [x + h, y0, 0], [x + h, y1, 0], [x - h, y1, 0]);
  }

  // ── Net ────────────────────────────────────────────────────────────────────

  drawNet(ctx, camera) {
    const postX = COURT.NET_POST_X;
    const segments = 28;

    // The mesh: a translucent dark band whose top edge follows the cord's sag.
    ctx.save();

    // Fill the net body first so the mesh lines read against it.
    ctx.beginPath();
    let started = false;
    for (let i = 0; i <= segments; i++) {
      const x = -postX + (i / segments) * postX * 2;
      const p = camera.project(x, 0, netHeightAt(x));
      if (!p.visible) continue;
      if (!started) { ctx.moveTo(p.x, p.y); started = true; }
      else ctx.lineTo(p.x, p.y);
    }
    for (let i = segments; i >= 0; i--) {
      const x = -postX + (i / segments) * postX * 2;
      const p = camera.project(x, 0, 0);
      if (p.visible) ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(18, 22, 26, 0.44)';
    ctx.fill();

    // Vertical mesh strings.
    ctx.strokeStyle = 'rgba(235, 240, 245, 0.16)';
    ctx.lineWidth = 1;
    const verticals = 60;
    for (let i = 0; i <= verticals; i++) {
      const x = -postX + (i / verticals) * postX * 2;
      const top = camera.project(x, 0, netHeightAt(x));
      const bot = camera.project(x, 0, 0);
      if (!top.visible || !bot.visible) continue;
      ctx.beginPath();
      ctx.moveTo(top.x, top.y);
      ctx.lineTo(bot.x, bot.y);
      ctx.stroke();
    }

    // Horizontal mesh strings, following the sag at each height fraction.
    const horizontals = 16;
    for (let j = 1; j < horizontals; j++) {
      const f = j / horizontals;
      ctx.beginPath();
      let begun = false;
      for (let i = 0; i <= segments; i++) {
        const x = -postX + (i / segments) * postX * 2;
        const p = camera.project(x, 0, netHeightAt(x) * f);
        if (!p.visible) continue;
        if (!begun) { ctx.moveTo(p.x, p.y); begun = true; }
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }

    // The white tape along the top — the thing you actually aim over.
    ctx.beginPath();
    let begun = false;
    for (let i = 0; i <= segments; i++) {
      const x = -postX + (i / segments) * postX * 2;
      const p = camera.project(x, 0, netHeightAt(x));
      if (!p.visible) continue;
      if (!begun) { ctx.moveTo(p.x, p.y); begun = true; }
      else ctx.lineTo(p.x, p.y);
    }
    for (let i = segments; i >= 0; i--) {
      const x = -postX + (i / segments) * postX * 2;
      const p = camera.project(x, 0, netHeightAt(x) - COURT.NET_BAND);
      if (p.visible) ctx.lineTo(p.x, p.y);
    }
    ctx.closePath();
    ctx.fillStyle = '#f2f4f6';
    ctx.fill();

    // Centre strap.
    const st = camera.project(0, 0, COURT.NET_HEIGHT_CENTRE);
    const sb = camera.project(0, 0, 0);
    if (st.visible && sb.visible) {
      ctx.strokeStyle = '#e8eaec';
      ctx.lineWidth = Math.max(1.5, st.scale * 0.05);
      ctx.beginPath();
      ctx.moveTo(st.x, st.y);
      ctx.lineTo(sb.x, sb.y);
      ctx.stroke();
    }

    // Posts.
    for (const s of [-1, 1]) {
      const top = camera.project(s * postX, 0, COURT.NET_HEIGHT_POST);
      const bot = camera.project(s * postX, 0, 0);
      if (!top.visible || !bot.visible) continue;
      ctx.strokeStyle = '#20262c';
      ctx.lineWidth = Math.max(2, top.scale * 0.1);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(top.x, top.y);
      ctx.lineTo(bot.x, bot.y);
      ctx.stroke();
    }

    ctx.restore();
  }

  /** Project four world points and fill the resulting polygon. */
  _quad(ctx, camera, a, b, c, d) {
    const pa = camera.project(a[0], a[1], a[2]);
    const pb = camera.project(b[0], b[1], b[2]);
    const pc = camera.project(c[0], c[1], c[2]);
    const pd = camera.project(d[0], d[1], d[2]);
    if (!pa.visible || !pb.visible || !pc.visible || !pd.visible) return;

    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.lineTo(pc.x, pc.y);
    ctx.lineTo(pd.x, pd.y);
    ctx.closePath();
    ctx.fill();
  }
}

// ── deterministic noise, so a venue's crowd looks the same every time ─────────

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
