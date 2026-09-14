// ─────────────────────────────────────────────
//  Flappy Kiro – game.js
//  Controls: Space / tap to flap
//            Speed buttons (HUD or overlay) to change pace
// ─────────────────────────────────────────────

(function () {
  "use strict";

  // ── roundRect polyfill (Safari < 15.4) ────────
  if (!CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, radii) {
      const arr = Array.isArray(radii) ? radii : [radii, radii, radii, radii];
      const [tl, tr, br, bl] = arr.map(v => v || 0);
      this.moveTo(x + tl, y);
      this.lineTo(x + w - tr, y);
      this.quadraticCurveTo(x + w, y,     x + w,      y + tr);
      this.lineTo(x + w, y + h - br);
      this.quadraticCurveTo(x + w, y + h, x + w - br, y + h);
      this.lineTo(x + bl, y + h);
      this.quadraticCurveTo(x,     y + h, x,          y + h - bl);
      this.lineTo(x, y + tl);
      this.quadraticCurveTo(x,     y,     x + tl,     y);
      this.closePath();
    };
  }

  // ── Canvas ────────────────────────────────────
  const canvas = document.getElementById("gameCanvas");
  const ctx    = canvas.getContext("2d");
  const W      = canvas.width;   // 480
  const H      = canvas.height;  // 640

  // ── DOM refs ──────────────────────────────────
  const overlay        = document.getElementById("overlay");
  const overlayTitle   = document.getElementById("overlay-title");
  const overlaySub     = document.getElementById("overlay-subtitle");
  const finalScoreEl   = document.getElementById("final-score");
  const startBtn       = document.getElementById("start-btn");
  const speedHud       = document.getElementById("speed-hud");
  const allSpeedBtns   = document.querySelectorAll(".spd-btn");

  // ── Speed presets (pixels per second at 60fps equiv) ──
  const SPEED_PRESETS = {
    slow:   { wallSpeed: 120, label: "slow"   },
    normal: { wallSpeed: 180, label: "normal" },
    fast:   { wallSpeed: 260, label: "fast"   },
  };
  // Speed ramps up every N points (progressive difficulty)
  const SPEED_RAMP_INTERVAL = 5;   // every 5 points
  const SPEED_RAMP_AMOUNT   = 8;   // px/s added per ramp step

  // ── Physics constants (px/s or px/s²) ─────────
  const GRAVITY       = 1400;  // px/s²
  const FLAP_IMPULSE  = -510;  // px/s (upward)
  const COYOTE_MS     = 100;   // ms grace window after leaving ground

  // ── Layout constants ──────────────────────────
  const WALL_WIDTH     = 62;
  const GAP_SIZE       = 158;
  const WALL_INTERVAL  = 230;  // horizontal gap between pairs (px)
  const GROUND_H       = 50;
  const GHOSTY_X       = 100;
  const GW             = 44;   // Ghosty width
  const GH             = 52;   // Ghosty height
  const HIT_MARGIN     = 6;    // fairness shrink on hitbox

  // ── Colours ───────────────────────────────────
  const C = {
    sky0: "#110626", sky1: "#261050",
    gnd0: "#3b1a6e", gnd1: "#110626",
    wall0: "#a855f7", wall1: "#4c1d95", wall2: "#2e1065",
    cap:  "#c084fc",
    scoreText: "#f3e8ff",
    ghost0: "#f3e8ff", ghost1: "#c084fc",
    eyePupil: "#5b21b6",
    smile: "#6d28d9",
    particle: "#c084fc",
  };

  // ── Stars (two layers for parallax) ───────────
  function makeStar(layer) {
    return {
      x: Math.random() * W,
      y: Math.random() * (H - GROUND_H - 40),
      r: layer === 0 ? Math.random() * 1.0 + 0.2 : Math.random() * 1.8 + 0.5,
      a: Math.random() * 0.5 + (layer === 0 ? 0.2 : 0.5),
      speed: layer === 0 ? 15 : 35,  // px/s (parallax)
    };
  }
  const stars = [
    ...Array.from({ length: 60 }, () => makeStar(0)),
    ...Array.from({ length: 25 }, () => makeStar(1)),
  ];

  // ── Game state ────────────────────────────────
  let state;         // "idle" | "playing" | "dead"
  let ghosty;
  let walls;
  let particles;
  let score;
  let bestScore = 0;
  let frameCount;
  let canRestart = false;
  let flashAlpha = 0;          // screen-flash on death
  let scorePopups = [];        // floating +1 text
  let chosenSpeedKey = "normal";
  let currentWallSpeed;        // px/s, mutable during play
  let lastTime = null;         // for delta-time
  let animId;
  let paused = false;

  // ── Speed button wiring ────────────────────────
  allSpeedBtns.forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const key = btn.dataset.speed;
      setSpeed(key);
    });
  });

  function setSpeed(key) {
    if (!SPEED_PRESETS[key]) return;
    chosenSpeedKey = key;
    // Update all speed buttons in both HUD and overlay
    allSpeedBtns.forEach(b => {
      b.classList.toggle("active", b.dataset.speed === key);
    });
    // If playing, apply immediately (keep ramp offset)
    if (state === "playing") {
      const ramp = Math.floor(score / SPEED_RAMP_INTERVAL) * SPEED_RAMP_AMOUNT;
      currentWallSpeed = SPEED_PRESETS[key].wallSpeed + ramp;
    }
  }

  // ── Input ─────────────────────────────────────
  function handleInput() {
    if (state === "idle")                     startGame();
    else if (state === "playing")             flap();
    else if (state === "dead" && canRestart)  startGame();
  }

  document.addEventListener("keydown", e => {
    if (e.code === "Space") { e.preventDefault(); handleInput(); }
    if (e.code === "KeyP" || e.code === "Escape") togglePause();
  });
  canvas.addEventListener("pointerdown",  () => handleInput());
  startBtn.addEventListener("click",      () => handleInput());

  // Pause when tab is hidden
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && state === "playing") paused = true;
    else if (!document.hidden && paused) { lastTime = null; paused = false; }
  });

  function togglePause() {
    if (state !== "playing") return;
    paused = !paused;
    if (!paused) { lastTime = null; requestAnimationFrame(loop); }
  }

  // ── Game control ──────────────────────────────
  function resetState() {
    state      = "idle";
    ghosty     = { x: GHOSTY_X, y: H / 2 - GH / 2, vy: 0, angle: 0, wobble: 0, coyoteMs: 0 };
    walls      = [];
    particles  = [];
    scorePopups = [];
    score      = 0;
    frameCount = 0;
    flashAlpha = 0;
    paused     = false;
    lastTime   = null;
  }

  function startGame() {
    resetState();
    state            = "playing";
    currentWallSpeed = SPEED_PRESETS[chosenSpeedKey].wallSpeed;

    // Seed first walls off-screen
    for (let i = 0; i < 4; i++) {
      spawnWall(W + 100 + i * WALL_INTERVAL);
    }

    hideOverlay();
    speedHud.classList.remove("hidden");
    flap();
  }

  function flap() {
    ghosty.vy = FLAP_IMPULSE;
    ghosty.coyoteMs = 0;
  }

  function die() {
    state      = "dead";
    canRestart = false;
    flashAlpha = 1;
    if (score > bestScore) bestScore = score;

    speedHud.classList.add("hidden");

    // Burst particles
    for (let i = 0; i < 32; i++) {
      const a = (Math.PI * 2 * i) / 32 + Math.random() * 0.25;
      const s = Math.random() * 220 + 80;
      particles.push({
        x: ghosty.x + GW / 2, y: ghosty.y + GH / 2,
        vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: 1,
        decay: Math.random() * 0.9 + 0.6,
        r: Math.random() * 7 + 2,
      });
    }

    setTimeout(showGameOver, 800);
  }

  // ── Wall factory ──────────────────────────────
  function spawnWall(x) {
    const minTop = 70;
    const maxTop = H - GROUND_H - GAP_SIZE - 70;
    const topH   = Math.floor(Math.random() * (maxTop - minTop + 1)) + minTop;
    walls.push({ x, topH, botY: topH + GAP_SIZE, scored: false });
  }

  // ── Overlay helpers ───────────────────────────
  function hideOverlay() { overlay.classList.add("hidden"); }

  function showGameOver() {
    overlayTitle.textContent = "Game Over";
    overlaySub.innerHTML     = "Press <kbd>Space</kbd> or tap to retry";
    finalScoreEl.classList.remove("hidden");
    finalScoreEl.innerHTML   =
      `Score: <strong>${score}</strong><br>Best: <strong>${bestScore}</strong>`;
    startBtn.textContent     = "Play Again";
    overlay.classList.remove("hidden");
    canRestart = true;
  }

  // ── Update (delta in seconds) ──────────────────
  function update(dt) {
    frameCount++;

    // Clamp dt to avoid spiral of death on tab resume
    dt = Math.min(dt, 0.05);

    // Screen flash decay
    if (flashAlpha > 0) flashAlpha = Math.max(0, flashAlpha - dt * 4);

    // Scroll stars (parallax)
    if (state === "playing" || state === "idle") {
      const scrollSpeed = state === "playing" ? currentWallSpeed : 40;
      for (const s of stars) {
        s.x -= s.speed * (scrollSpeed / 180) * dt;
        if (s.x < -2) s.x = W + 2;
      }
    }

    if (state === "idle") {
      ghosty.wobble += dt * 3.5;
      ghosty.y = H / 2 - GH / 2 + Math.sin(ghosty.wobble) * 9;
      return;
    }

    // Update particles (both playing and dead)
    for (const p of particles) {
      p.x    += p.vx * dt;
      p.y    += p.vy * dt;
      p.vy   += 400 * dt;  // gravity on particles
      p.life -= p.decay * dt;
    }
    particles = particles.filter(p => p.life > 0);

    // Update score popups
    for (const sp of scorePopups) {
      sp.y    -= 60 * dt;
      sp.life -= dt * 1.8;
    }
    scorePopups = scorePopups.filter(sp => sp.life > 0);

    if (state === "dead") return;

    // ── Playing ───────────────────────────────────

    // Progressive speed ramp
    const ramp = Math.floor(score / SPEED_RAMP_INTERVAL) * SPEED_RAMP_AMOUNT;
    currentWallSpeed = SPEED_PRESETS[chosenSpeedKey].wallSpeed + ramp;

    // Ghosty physics
    ghosty.vy += GRAVITY * dt;
    ghosty.y  += ghosty.vy * dt;

    // Smooth tilt
    const targetAngle = Math.max(-0.45, Math.min(0.55, ghosty.vy / 900));
    ghosty.angle += (targetAngle - ghosty.angle) * Math.min(1, dt * 12);

    // Spawn walls
    const last = walls[walls.length - 1];
    if (!last || last.x < W) {
      spawnWall((last ? last.x : W) + WALL_INTERVAL);
    }

    // Move walls & score
    const wallDx = currentWallSpeed * dt;
    for (const w of walls) {
      w.x -= wallDx;
      if (!w.scored && w.x + WALL_WIDTH < ghosty.x) {
        score++;
        w.scored = true;
        // Spawn score popup near the gap centre
        scorePopups.push({
          x: ghosty.x + GW / 2,
          y: ghosty.y - 10,
          life: 1,
        });
      }
    }
    walls = walls.filter(w => w.x + WALL_WIDTH > -10);

    // ── Collision ──────────────────────────────────

    // Ground
    if (ghosty.y + GH >= H - GROUND_H) {
      ghosty.y = H - GROUND_H - GH;
      die();
      return;
    }

    // Ceiling – soft bounce
    if (ghosty.y <= 0) {
      ghosty.y  = 0;
      ghosty.vy = Math.abs(ghosty.vy) * 0.3;
    }

    // Wall AABB
    const gx1 = ghosty.x + HIT_MARGIN;
    const gy1 = ghosty.y + HIT_MARGIN;
    const gx2 = ghosty.x + GW - HIT_MARGIN;
    const gy2 = ghosty.y + GH - HIT_MARGIN;

    for (const w of walls) {
      if (gx2 <= w.x || gx1 >= w.x + WALL_WIDTH) continue;
      if (gy1 < w.topH || gy2 > w.botY) { die(); return; }
    }
  }

  // ── Draw ──────────────────────────────────────

  function drawBg() {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, C.sky0);
    g.addColorStop(1, C.sky1);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  function drawStars() {
    for (const s of stars) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${s.a})`;
      ctx.fill();
    }
  }

  function drawGround() {
    const y = H - GROUND_H;
    const g = ctx.createLinearGradient(0, y, 0, H);
    g.addColorStop(0, C.gnd0);
    g.addColorStop(1, C.gnd1);
    ctx.fillStyle = g;
    ctx.fillRect(0, y, W, GROUND_H);

    ctx.strokeStyle = C.wall0;
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }

  function drawWallPair(w) {
    const botH = H - GROUND_H - w.botY;

    // helper: draw one segment
    function seg(sx, sy, sw, sh) {
      if (sh <= 0) return;
      const g = ctx.createLinearGradient(sx, 0, sx + sw, 0);
      g.addColorStop(0,   C.wall0);
      g.addColorStop(0.4, C.wall1);
      g.addColorStop(1,   C.wall2);
      ctx.fillStyle = g;
      ctx.fillRect(sx, sy, sw, sh);
      // inner highlight
      ctx.fillStyle = "rgba(255,255,255,0.07)";
      ctx.fillRect(sx, sy, 5, sh);
      ctx.fillStyle = "rgba(0,0,0,0.2)";
      ctx.fillRect(sx + sw - 5, sy, 5, sh);
    }

    seg(w.x, 0,     WALL_WIDTH, w.topH);
    seg(w.x, w.botY, WALL_WIDTH, botH);

    // Caps
    drawCap(w.x, w.topH, true);
    drawCap(w.x, w.botY, false);
  }

  function drawCap(wx, wy, isTop) {
    const cw = WALL_WIDTH + 10;
    const ch = 18;
    const cx = wx - 5;
    const cy = isTop ? wy - ch : wy;
    const r  = 5;

    ctx.fillStyle = C.cap;
    ctx.beginPath();
    ctx.roundRect(cx, cy, cw, ch, isTop ? [0, 0, r, r] : [r, r, 0, 0]);
    ctx.fill();

    // shine line
    ctx.strokeStyle = "rgba(255,255,255,0.28)";
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    const lineY = isTop ? cy + ch - 1 : cy + 1;
    ctx.moveTo(cx + 3, lineY);
    ctx.lineTo(cx + cw - 3, lineY);
    ctx.stroke();
  }

  function drawWalls() {
    for (const w of walls) drawWallPair(w);
  }

  // ── Ghosty ────────────────────────────────────
  function drawGhosty(x, y, angle) {
    ctx.save();
    ctx.translate(x + GW / 2, y + GH / 2);
    ctx.rotate(angle);
    ctx.translate(-GW / 2, -GH / 2);

    // Glow
    const glow = ctx.createRadialGradient(GW/2, GH/2, 2, GW/2, GH/2, GW * 1.2);
    glow.addColorStop(0, "rgba(192,132,252,0.3)");
    glow.addColorStop(1, "rgba(192,132,252,0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.ellipse(GW/2, GH/2, GW * 1.2, GH * 1.1, 0, 0, Math.PI * 2);
    ctx.fill();

    // Body
    ctx.beginPath();
    ctx.arc(GW / 2, GW / 2, GW / 2, Math.PI, 0, false);  // top half-circle
    ctx.lineTo(GW, GH - 12);

    // Wavy bottom (3 bumps)
    const b = GW / 3;
    ctx.quadraticCurveTo(GW - b * 0.5,  GH + 12, GW - b,   GH - 8);
    ctx.quadraticCurveTo(GW - b * 1.5,  GH - 22, GW / 2,   GH - 8);
    ctx.quadraticCurveTo(b * 0.5,       GH + 12, b,         GH - 8);
    ctx.quadraticCurveTo(b * 0.5,       GH - 22, 0,         GH - 12);
    ctx.closePath();

    const bodyG = ctx.createLinearGradient(0, 0, 0, GH);
    bodyG.addColorStop(0, C.ghost0);
    bodyG.addColorStop(1, C.ghost1);
    ctx.fillStyle = bodyG;
    ctx.fill();

    ctx.strokeStyle = "rgba(109,40,217,0.55)";
    ctx.lineWidth   = 1.5;
    ctx.stroke();

    // Eyes
    drawEye(GW * 0.30, GW * 0.38);
    drawEye(GW * 0.70, GW * 0.38);

    // Smile
    ctx.beginPath();
    ctx.arc(GW / 2, GW * 0.62, GW * 0.14, 0.25, Math.PI - 0.25, false);
    ctx.strokeStyle = C.smile;
    ctx.lineWidth   = 2;
    ctx.stroke();

    ctx.restore();
  }

  function drawEye(ex, ey) {
    const rx = 5.5, ry = 6.5;
    ctx.beginPath();
    ctx.ellipse(ex, ey, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = "#fff";
    ctx.fill();

    ctx.beginPath();
    ctx.ellipse(ex + 1, ey + 2, rx * 0.48, ry * 0.52, 0, 0, Math.PI * 2);
    ctx.fillStyle = C.eyePupil;
    ctx.fill();

    ctx.beginPath();
    ctx.ellipse(ex - 1.2, ey - 1.5, 1.6, 2.2, 0, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.fill();
  }

  function drawScore() {
    ctx.save();
    ctx.textAlign = "center";
    ctx.font      = "bold 38px 'Segoe UI', system-ui, sans-serif";
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillText(score, W / 2 + 2, 56);
    ctx.fillStyle = C.scoreText;
    ctx.fillText(score, W / 2, 54);
    ctx.restore();
  }

  function drawScorePopups() {
    for (const sp of scorePopups) {
      ctx.save();
      ctx.globalAlpha = sp.life;
      ctx.font        = "bold 22px 'Segoe UI', system-ui, sans-serif";
      ctx.textAlign   = "center";
      ctx.fillStyle   = "#fde68a";
      ctx.fillText("+1", sp.x, sp.y);
      ctx.restore();
    }
  }

  function drawParticles() {
    for (const p of particles) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = C.particle;
      ctx.fill();
      ctx.restore();
    }
  }

  function drawFlash() {
    if (flashAlpha <= 0) return;
    ctx.save();
    ctx.globalAlpha = flashAlpha * 0.55;
    ctx.fillStyle   = "#ff4444";
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  function drawPauseOverlay() {
    ctx.save();
    ctx.fillStyle = "rgba(8,4,22,0.6)";
    ctx.fillRect(0, 0, W, H);
    ctx.font      = "bold 42px 'Segoe UI', system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = "#c084fc";
    ctx.fillText("PAUSED", W / 2, H / 2 - 10);
    ctx.font      = "18px 'Segoe UI', system-ui, sans-serif";
    ctx.fillStyle = "#d8b4fe";
    ctx.fillText("Press P or Esc to resume", W / 2, H / 2 + 30);
    ctx.restore();
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    drawBg();
    drawStars();
    drawWalls();
    drawGround();
    drawGhosty(ghosty.x, ghosty.y, ghosty.angle);
    if (state === "playing") { drawScore(); drawScorePopups(); }
    drawParticles();
    drawFlash();
    if (paused) drawPauseOverlay();
  }

  // ── Game loop (delta-time) ─────────────────────
  function loop(ts) {
    if (paused) return;  // frozen until unpaused

    const dt = lastTime === null ? 0 : (ts - lastTime) / 1000;
    lastTime = ts;

    update(dt);
    draw();
    animId = requestAnimationFrame(loop);
  }

  // ── Boot ──────────────────────────────────────
  function init() {
    resetState();
    overlayTitle.textContent = "Flappy Kiro";
    overlaySub.innerHTML     = "Press <kbd>Space</kbd> or tap to start";
    finalScoreEl.classList.add("hidden");
    startBtn.textContent     = "Start Game";
    overlay.classList.remove("hidden");
    speedHud.classList.add("hidden");
    setSpeed("normal");
    animId = requestAnimationFrame(loop);
  }

  init();
})();
