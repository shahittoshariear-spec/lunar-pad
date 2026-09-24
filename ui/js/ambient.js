/**
 * The ambient starfield.
 *
 * A slow drifting field of stars, echoing the app icon's night sky. It runs on
 * a canvas rather than as DOM elements so a few hundred stars cost one draw
 * pass instead of hundreds of composited layers.
 *
 * Three things keep it from being a battery drain:
 *
 *  * it renders at ~30fps, which is plenty for something this slow-moving;
 *  * it stops entirely when the window is hidden or the setting is off;
 *  * the star count scales with the viewport area, so a maximised window on a
 *    4K display does not get four times the work of a small one.
 */

const MAX_STARS = 260;
const TARGET_FPS = 30;

export function createAmbient(canvas) {
  const ctx = canvas.getContext('2d', { alpha: true });

  let stars = [];
  let width = 0;
  let height = 0;
  let dpr = 1;
  let frameHandle = null;
  let lastDraw = 0;
  let elapsed = 0;
  let running = false;
  let enabled = true;
  let still = false;

  // Star tints, refreshed whenever the theme changes.
  let tints = ['#ffffff'];

  function readTints() {
    const styles = getComputedStyle(document.documentElement);
    const text = styles.getPropertyValue('--text').trim() || '#ffffff';
    const accent = styles.getPropertyValue('--accent').trim() || '#8899ff';
    const accent2 = styles.getPropertyValue('--accent-2').trim() || accent;
    tints = [text, accent, accent2];
  }

  /** Lay out a fresh field sized to the current viewport. */
  function seed() {
    const count = Math.min(MAX_STARS, Math.round((width * height) / 13_000));
    stars = Array.from({ length: count }, () => {
      // Most stars are tiny; a few are large enough to read as foreground.
      const roll = Math.random();
      const radius = roll > 0.94 ? 1.5 + Math.random() * 1.2 : roll > 0.7 ? 0.8 + Math.random() * 0.5 : 0.35 + Math.random() * 0.35;

      return {
        x: Math.random() * width,
        y: Math.random() * height,
        radius,
        // Bigger stars are brighter, which reads as depth.
        base: 0.1 + Math.random() * (radius > 1.4 ? 0.6 : 0.34),
        tint: tints[Math.floor(Math.random() * tints.length)],
        // Drift is biased down-right so the whole field feels like one system.
        vx: 0.6 + Math.random() * 1.4,
        vy: 0.25 + Math.random() * 0.7,
        phase: Math.random() * Math.PI * 2,
        // Period of the reveal/fade cycle, in seconds.
        period: 3 + Math.random() * 6,
        bright: radius > 1.4,
      };
    });
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);

    width = Math.max(1, rect.width);
    height = Math.max(1, rect.height);

    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    readTints();
    seed();
    draw(true);
  }

  /** Paint one frame. `force` ignores the frame limiter, for static redraws. */
  function draw(force = false) {
    const now = performance.now();
    if (!force && now - lastDraw < 1000 / TARGET_FPS) return;

    const delta = lastDraw ? Math.min(now - lastDraw, 100) / 1000 : 0;
    lastDraw = now;
    if (!still) elapsed += delta;

    ctx.clearRect(0, 0, width, height);

    for (const star of stars) {
      if (!still) {
        star.x += star.vx * delta;
        star.y += star.vy * delta;

        // Wrap rather than respawn, so density stays even and there is no
        // visible pop when a star is replaced.
        if (star.x > width + 4) star.x = -4;
        if (star.y > height + 4) star.y = -4;
      }

      // Each star breathes on its own cycle.
      const twinkle = still
        ? 1
        : 0.55 + 0.45 * Math.sin((elapsed / star.period) * Math.PI * 2 + star.phase);

      ctx.globalAlpha = Math.max(0, Math.min(1, star.base * twinkle));
      ctx.fillStyle = star.tint;

      if (star.bright) {
        // The brightest stars get a soft halo, which is what sells the depth.
        ctx.shadowBlur = 7;
        ctx.shadowColor = star.tint;
      } else {
        ctx.shadowBlur = 0;
      }

      ctx.beginPath();
      ctx.arc(star.x, star.y, star.radius, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  }

  function loop() {
    draw();
    frameHandle = requestAnimationFrame(loop);
  }

  function start() {
    if (running || !enabled) return;
    running = true;
    lastDraw = 0;
    frameHandle = requestAnimationFrame(loop);
  }

  function stop() {
    running = false;
    if (frameHandle !== null) cancelAnimationFrame(frameHandle);
    frameHandle = null;
  }

  /**
   * Show or hide the field.
   *
   * Disabling stops the render loop entirely rather than just hiding the
   * canvas, so turning the starfield off actually saves the work.
   */
  function setEnabled(next) {
    enabled = Boolean(next);
    canvas.style.opacity = enabled ? '1' : '0';
    if (enabled) start();
    else {
      stop();
      ctx.clearRect(0, 0, width, height);
    }
  }

  /**
   * Render one static, fully-lit field.
   *
   * Used when the user prefers reduced motion: the texture is still there, it
   * just does not move.
   */
  function setStill(next) {
    still = Boolean(next);
    if (still) {
      stop();
      draw(true);
    } else if (enabled) {
      start();
    }
  }

  function handleVisibility() {
    if (document.hidden) stop();
    else if (enabled && !still) start();
  }

  const onResize = () => {
    resize();
  };

  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', handleVisibility);

  resize();

  return {
    setEnabled,
    setStill,
    start,
    stop,
    /** Re-read theme colours and repaint, without reseeding the layout. */
    refresh() {
      readTints();
      const next = tints;
      for (const star of stars) {
        star.tint = next[Math.floor(Math.random() * next.length)];
      }
      draw(true);
    },
    destroy() {
      stop();
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', handleVisibility);
    },
  };
}
