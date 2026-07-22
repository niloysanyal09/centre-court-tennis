# Centre Court

A browser tennis simulation. Real ball physics, five venues on four surface types,
online peer-to-peer play for two or four players, custom avatars, and a fourteen-lesson
practice academy.

No build step, no dependencies to install, no server to run. It is static files, so it
deploys to GitHub Pages as-is and runs on any modern Mac in Safari or Chrome.

---

## Controls

**Arrows move. Numbers hit. That is the whole game.**

| | |
|---|---|
| Move | `↑` `↓` `←` `→` |
| Hit the ball | `1` `2` `3` `4` `5` |
| Serve | `Space` (once to toss, once to hit) |
| Sprint | `Shift` (optional, costs stamina) |
| Pause | `Esc` |

The five shots: **1** topspin (your default), **2** flat drive, **3** slice, **4** lob,
**5** drop shot. The numeric keypad works too, as does a gamepad.

- **Tap** a number for a normal shot. **Hold** it to hit harder.
- **Steer** by holding an arrow as you hit — hold left and the ball goes left, hold up
  for depth.
- Every player uses these same controls on their own machine.

If the timing feels hard at first, turn on **Swing for me** in Settings and you only
have to steer. Turn it off when you stop needing it.

---

## Playing online

GitHub Pages only serves static files, so online play is genuinely peer-to-peer over
WebRTC. One player hosts, gets a five-character room code, and shares it. All gameplay
traffic goes directly browser to browser; only the initial handshake passes through a
public signalling broker.

1. **Play Online → Create room.** You get a code like `KP7QM`.
2. Everyone else picks **Join** and enters it.
3. The host starts the match once the slots are full.

The host's machine runs the authoritative simulation, so **host on the best connection**.
Empty slots are filled by AI, so a doubles match still runs with three humans.

Tennis tolerates latency unusually well — the ball is airborne for most of a point, and
you commit to a swing about 145 ms before contact — so anything under ~130 ms plays
fine. A connection indicator sits in the top-right corner during play.

If a firewall or corporate VPN blocks WebRTC, the game says so rather than hanging.
Local play against the AI never depends on any of this.

---

## Deploying to GitHub Pages

This repository is already initialised and committed. To publish it:

```bash
# 1. Create an empty repository on github.com (public, no README/licence/gitignore).

# 2. Point this repo at it and push.
cd "/Users/niloysanyal/Tennis Game"
git remote add origin https://github.com/<your-username>/<repo-name>.git
git branch -M main
git push -u origin main
```

Then on GitHub: **Settings → Pages → Source: Deploy from a branch → `main` / `(root)` → Save.**

Your game will be live at `https://<your-username>.github.io/<repo-name>/` within a
minute or two.

> **HTTPS matters.** WebRTC requires a secure context, and GitHub Pages serves HTTPS by
> default, so online play works there. It will *not* work if you open `index.html`
> directly from disk — see below.

### Running it locally

ES modules will not load over `file://`, so you need a local server:

```bash
cd "/Users/niloysanyal/Tennis Game"
python3 -m http.server 8777
# then open http://localhost:8777
```

---

## What is actually simulated

This is a simulation rather than an arcade game, and most of the behaviour falls out of
the physics rather than being scripted.

**Ball flight** integrates three forces at a fixed 120 Hz: gravity, quadratic drag, and
Magnus lift. Drag at 200 km/h is roughly 3 g, which is why a flat serve loses so much
pace crossing the court. Topspin pushes the ball down so you can swing hard and still
land it; slice pushes it up so it floats and hangs; sidespin curves it. Wind is real and
is applied to the air-relative velocity, so a gusty night in New York genuinely pushes
your lob long.

**The bounce** is a rigid-sphere impulse model with Coulomb friction, acting on the
velocity of the ball's *contact point* rather than its centre. Nothing is special-cased
per surface — the friction and restitution numbers do all the work:

| Surface | Pace off the bounce | ITF pace rating |
|---|---|---|
| Grass | 22.4 m/s | Fast (47) |
| Indoor hard | 21.6 m/s | Fast (44) |
| DecoTurf hard | 20.7 m/s | Medium-fast (38) |
| Clay | 19.5 m/s | Slow (24) |

That ordering is emergent, not hardcoded. A topspinning ball's contact point is already
moving backwards relative to its centre, so friction has less to fight and can fling the
ball up and forward — the clay-court kick. A slicing ball's contact point races forward,
friction bites, and it skids low.

**Court geometry** is the real thing: 23.77 m long, 8.23 m singles width, service line at
6.40 m, net 0.914 m at centre sagging up to 1.07 m at the posts. A ball is in if any part
of it touches any part of a line, which is exactly why the close calls are close.

**Shots** are solved, not scripted. Given a contact point and a target, the game bisects
on launch angle — running the real integrator to evaluate each candidate — subject to the
net clearance that stroke intends. Then timing quality, your accuracy attribute, fatigue
and shot difficulty spray the result. That error model is the entire skill curve.

**Scoring** is full ATP rules: 15/30/40, deuce and advantage, games to six by two, a
seven-point tiebreak at 6–6, and the ten-point match tiebreak all four majors now use in
the deciding set, plus correct serve rotation and change-of-ends scheduling.

**The AI does not cheat.** It drives exactly the same charge-and-release swing API a
human does, through the same error model. Difficulty is expressed only as human
limitations: reaction time, noise corrupting its read of the bounce, release jitter, and
how much of its top speed it actually uses. A rookie genuinely mistimes shots and
genuinely nets balls.

**Sound is synthesised at runtime** — there is not a single audio file in the repository.
Ball impacts are built from short broadband transients whose character changes with how
cleanly you struck it, so a flushed forehand, a dead mishit, a framed shank, a net cord
and a buried net ball are all identifiable with your eyes shut. Line calls and score
announcements use the browser's speech synthesis, picked to match the venue.

---

## Practice

**Academy** is fourteen lessons in order, each teaching one mechanic and unlocking the
next: footwork, the groundstroke, timing, placement, spin, first and second serves,
volleys, the overhead, defence, drop shots and lobs, return of serve, point construction,
and handling pace.

**Drills** are eight repeatable challenges scored out of three stars, unlocked from the
start, for grinding whatever is letting you down.

Both run on the real match engine, so the physics in practice are identical to the
physics in a match. What you learn transfers.

---

## Project layout

```
index.html              entry point
css/style.css           all front-end styling
vendor/peerjs.min.js    vendored WebRTC signalling client (no runtime CDN)
js/
  main.js               application controller: loop, screens, event routing
  core/                 game loop, input, persisted settings
  sim/                  constants, physics, shots, player, ai, rules, match
  render/               camera, court, players, effects, HUD, renderer
  audio/                runtime sound synthesis
  net/                  peer-to-peer netcode
  ui/                   menus, avatar creator, practice mode
  data/                 surfaces, venues
```

The coordinate system is used consistently everywhere: `x` across the court (0 at the
centre line), `y` along it (0 at the net, negative toward the near baseline), `z` up.
All units are SI.

---

## Browser support

Built and tested on macOS in Safari and Chrome. Needs a browser with ES modules, Canvas
2D and Web Audio — anything from the last several years. Online play additionally needs
WebRTC and a secure context (HTTPS or localhost).
