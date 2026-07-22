/**
 * HUD: the broadcast-style scoreboard, stamina, charge meter, speed readouts and
 * announcements.
 *
 * Laid out like a real tennis broadcast because that is the visual language players
 * already know: server indicator on the left, set scores in a row, the current game
 * score highlighted at the right.
 */

import { RULES } from '../sim/constants.js';
import { toKmh, toMph } from '../sim/constants.js';

const FONT = '"SF Pro Display", -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
const MONO = '"SF Mono", ui-monospace, Menlo, monospace';

export class HUD {
  constructor() {
    this.announcements = [];
    this.speedPopup = null;
    this.timingPopup = null;
    this.rallyCount = 0;
    this.showRally = false;
    this.units = 'kmh';
    this.compact = false;
  }

  update(dt) {
    for (let i = this.announcements.length - 1; i >= 0; i--) {
      const a = this.announcements[i];
      a.life -= dt;
      if (a.life <= 0) this.announcements.splice(i, 1);
    }
    if (this.speedPopup) {
      this.speedPopup.life -= dt;
      if (this.speedPopup.life <= 0) this.speedPopup = null;
    }
    if (this.timingPopup) {
      this.timingPopup.life -= dt;
      if (this.timingPopup.life <= 0) this.timingPopup = null;
    }
  }

  announce(text, opts = {}) {
    this.announcements.push({
      text,
      sub: opts.sub || null,
      life: opts.life ?? 2.0,
      maxLife: opts.life ?? 2.0,
      color: opts.color || '#ffffff',
      big: opts.big !== false,
    });
  }

  showSpeed(mps, label) {
    this.speedPopup = { mps, label, life: 2.4, maxLife: 2.4 };
  }

  showTiming(label, quality) {
    this.timingPopup = { label, quality, life: 0.9, maxLife: 0.9 };
  }

  // ── Main draw ──────────────────────────────────────────────────────────────

  draw(ctx, W, H, match, opts = {}) {
    const score = match.score;

    this._drawScoreboard(ctx, W, H, match, opts);
    this._drawStamina(ctx, W, H, match, opts);

    if (opts.localPlayer !== undefined && opts.localPlayer >= 0) {
      this._drawChargeMeter(ctx, W, H, match.players[opts.localPlayer]);
    }

    if (this.speedPopup) this._drawSpeed(ctx, W, H);
    if (this.timingPopup) this._drawTiming(ctx, W, H);
    if (this.showRally && this.rallyCount > 3) this._drawRally(ctx, W, H);

    this._drawAnnouncements(ctx, W, H);

    if (opts.wind && opts.wind.speed > 0.4) this._drawWind(ctx, W, H, opts.wind);
  }

  _drawScoreboard(ctx, W, H, match, opts) {
    const score = match.score;
    const x = 24;
    const y = 24;
    const rowH = 30;
    const width = 328;

    ctx.save();
    ctx.font = `600 14px ${FONT}`;

    // Panel
    roundRect(ctx, x, y, width, rowH * 2 + 8, 8);
    ctx.fillStyle = 'rgba(10, 14, 20, 0.82)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 1;
    ctx.stroke();

    const setsCount = Math.max(score.setHistory.length + (score.finished ? 0 : 1), 1);
    const gameColX = x + width - 56;
    const setColW = 26;
    const setsStartX = gameColX - setsCount * setColW - 10;

    for (let team = 0; team < 2; team++) {
      const ry = y + 4 + team * rowH;
      const isServing = score.servingTeam === team && !score.finished;

      // Server indicator: the little ball that tells you who is serving.
      if (isServing) {
        ctx.fillStyle = '#d8ec3a';
        ctx.beginPath();
        ctx.arc(x + 15, ry + rowH / 2, 4.5, 0, Math.PI * 2);
        ctx.fill();
      }

      // Name
      ctx.fillStyle = score.winner === team ? '#00e07a' : '#ffffff';
      ctx.font = `600 14px ${FONT}`;
      ctx.textAlign = 'left';
      const name = truncate(match.players[team].avatar?.name || score.teamNames[team], 16);
      ctx.fillText(name, x + 28, ry + rowH / 2 + 5);

      // Completed sets
      ctx.font = `600 14px ${MONO}`;
      ctx.textAlign = 'center';
      for (let s = 0; s < score.setHistory.length; s++) {
        const games = score.setHistory[s][team];
        const won = score.setHistory[s][team] > score.setHistory[s][1 - team];
        ctx.fillStyle = won ? '#ffffff' : 'rgba(255,255,255,0.42)';
        ctx.fillText(String(games), setsStartX + s * setColW + setColW / 2, ry + rowH / 2 + 5);
      }

      // Current set
      if (!score.finished) {
        const cx = setsStartX + score.setHistory.length * setColW + setColW / 2;
        ctx.fillStyle = '#ffffff';
        ctx.fillText(String(score.games[team]), cx, ry + rowH / 2 + 5);
      }

      // Current game score, in a highlighted cell.
      if (!score.finished) {
        const cellX = gameColX;
        roundRect(ctx, cellX, ry + 3, 46, rowH - 6, 4);
        ctx.fillStyle = isServing ? 'rgba(216,236,58,0.16)' : 'rgba(255,255,255,0.06)';
        ctx.fill();

        let ptText;
        if (score.inTiebreak) ptText = String(score.points[team]);
        else if (score.advantage === team) ptText = 'AD';
        else if (score.advantage === 1 - team) ptText = '—';
        else ptText = RULES.POINT_NAMES[score.points[team]];

        ctx.fillStyle = '#ffffff';
        ctx.font = `700 15px ${MONO}`;
        ctx.fillText(ptText, cellX + 23, ry + rowH / 2 + 5);
      }
    }

    // Context strip under the panel: tiebreak, break point, serving for the match.
    const ctxLabel = this._contextLabel(score);
    if (ctxLabel) {
      ctx.font = `700 11px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.fillStyle = ctxLabel.color;
      ctx.fillText(ctxLabel.text.toUpperCase(), x + 2, y + rowH * 2 + 26);
    }

    ctx.restore();
  }

  _contextLabel(score) {
    if (score.finished) return null;
    const crit = score.criticalPoint();
    if (crit) {
      return {
        text: `${crit.kind} point — ${score.teamNames[crit.team]}`,
        color: '#ff5a5a',
      };
    }
    const bp = score.breakPoint();
    if (bp >= 0) return { text: `break point — ${score.teamNames[bp]}`, color: '#ffd23f' };
    if (score.inTiebreak) return { text: `tiebreak to ${score.tiebreakTarget}`, color: '#00e07a' };
    return null;
  }

  _drawStamina(ctx, W, H, match, opts) {
    // A slim bar per human-relevant player, bottom corners.
    const players = match.players;
    ctx.save();

    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      const isLeft = p.team === 0;
      const idx = Math.floor(i / 2);
      const bw = 132, bh = 6;
      const bx = isLeft ? 24 : W - 24 - bw;
      const by = H - 34 - idx * 22;

      const frac = p.staminaFrac;

      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      roundRect(ctx, bx, by, bw, bh, 3);
      ctx.fill();

      // Colour shifts as fatigue bites, which is the cue to start shortening points.
      const col = frac > 0.55 ? '#00e07a' : frac > 0.28 ? '#ffd23f' : '#ff5a5a';
      ctx.fillStyle = col;
      roundRect(ctx, bx, by, bw * frac, bh, 3);
      ctx.fill();

      ctx.font = `600 10px ${FONT}`;
      ctx.textAlign = isLeft ? 'left' : 'right';
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillText(truncate(p.avatar?.name || `P${i + 1}`, 14), isLeft ? bx : bx + bw, by - 4);
    }
    ctx.restore();
  }

  /** The charge meter: how much power is loaded into the shot being held. */
  _drawChargeMeter(ctx, W, H, player) {
    if (!player) return;
    if (player.swing !== 'windup' || player.charge <= 0.01) return;

    const w = 180, h = 10;
    const x = W / 2 - w / 2;
    const y = H - 56;

    ctx.save();
    roundRect(ctx, x, y, w, h, 5);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fill();

    const c = player.charge;
    // Green through amber to red: past ~85 % you are swinging out of your shoes.
    const col = c < 0.55 ? '#00e07a' : c < 0.85 ? '#ffd23f' : '#ff5a5a';
    roundRect(ctx, x, y, w * c, h, 5);
    ctx.fillStyle = col;
    ctx.fill();

    ctx.font = `700 10px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillText(player.swingType.toUpperCase(), W / 2, y - 6);
    ctx.restore();
  }

  _drawSpeed(ctx, W, H) {
    const p = this.speedPopup;
    const a = Math.min(1, p.life / 0.4);
    const val = this.units === 'mph' ? toMph(p.mps) : toKmh(p.mps);
    const unit = this.units === 'mph' ? 'MPH' : 'KM/H';

    ctx.save();
    ctx.globalAlpha = a;
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ffffff';
    ctx.font = `800 34px ${MONO}`;
    ctx.fillText(String(Math.round(val)), W - 28, 62);
    ctx.font = `600 12px ${FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText(unit, W - 28, 80);
    if (p.label) {
      ctx.fillStyle = '#d8ec3a';
      ctx.font = `700 11px ${FONT}`;
      ctx.fillText(p.label.toUpperCase(), W - 28, 34);
    }
    ctx.restore();
  }

  _drawTiming(ctx, W, H) {
    const t = this.timingPopup;
    const f = t.life / t.maxLife;
    const colors = {
      PERFECT: '#00e07a', GOOD: '#8ee85a', OK: '#ffd23f', MISHIT: '#ff5a5a',
    };
    ctx.save();
    ctx.globalAlpha = Math.min(1, f * 2);
    ctx.textAlign = 'center';
    ctx.font = `800 ${20 + (1 - f) * 6}px ${FONT}`;
    ctx.fillStyle = colors[t.label] || '#ffffff';
    ctx.fillText(t.label, W / 2, H - 78 - (1 - f) * 14);
    ctx.restore();
  }

  _drawRally(ctx, W, H) {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = `800 26px ${MONO}`;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText(String(this.rallyCount), W / 2, 52);
    ctx.font = `600 10px ${FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillText('SHOT RALLY', W / 2, 68);
    ctx.restore();
  }

  _drawAnnouncements(ctx, W, H) {
    let offset = 0;
    for (const a of this.announcements) {
      const f = a.life / a.maxLife;
      // Pop in fast, hold, fade out.
      const alpha = f > 0.8 ? (1 - f) * 5 : Math.min(1, f * 3);
      const scale = f > 0.85 ? 0.9 + (1 - f) * 0.7 : 1;

      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
      ctx.textAlign = 'center';
      ctx.translate(W / 2, H * 0.34 + offset);
      ctx.scale(scale, scale);

      const size = a.big ? 52 : 30;
      ctx.font = `800 ${size}px ${FONT}`;
      ctx.lineWidth = size * 0.12;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.strokeText(a.text, 0, 0);
      ctx.fillStyle = a.color;
      ctx.fillText(a.text, 0, 0);

      if (a.sub) {
        ctx.font = `600 16px ${FONT}`;
        ctx.strokeText(a.sub, 0, size * 0.72);
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillText(a.sub, 0, size * 0.72);
      }
      ctx.restore();
      offset += 70;
    }
  }

  _drawWind(ctx, W, H, wind) {
    const cx = W - 52;
    const cy = H - 52;
    const r = 18;

    ctx.save();
    ctx.globalAlpha = 0.7;
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();

    // Wind direction 0 = blowing toward the far end, which is up the screen.
    const ang = wind.direction;
    const dx = Math.sin(ang), dy = -Math.cos(ang);
    const len = Math.min(r - 3, 5 + wind.speed * 3.5);

    ctx.strokeStyle = wind.speed > 2.5 ? '#ffd23f' : 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - dx * len * 0.5, cy - dy * len * 0.5);
    ctx.lineTo(cx + dx * len * 0.5, cy + dy * len * 0.5);
    ctx.stroke();
    // Arrowhead
    ctx.beginPath();
    ctx.moveTo(cx + dx * len * 0.5, cy + dy * len * 0.5);
    ctx.lineTo(cx + dx * len * 0.5 - dx * 5 - dy * 3.5, cy + dy * len * 0.5 - dy * 5 + dx * 3.5);
    ctx.lineTo(cx + dx * len * 0.5 - dx * 5 + dy * 3.5, cy + dy * len * 0.5 - dy * 5 - dx * 3.5);
    ctx.closePath();
    ctx.fillStyle = wind.speed > 2.5 ? '#ffd23f' : 'rgba(255,255,255,0.75)';
    ctx.fill();

    ctx.font = `600 9px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillText(`${wind.speed.toFixed(1)} m/s`, cx, cy + r + 12);
    ctx.restore();
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
