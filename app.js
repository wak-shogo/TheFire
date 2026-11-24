(function () {
  'use strict';

  const STORAGE_KEY = 'thefire.settings.v1';

  const DEFAULTS = {
    color: '#ff6a14',
    colorName: '焚き火',
    intensity: 68,
    maxBrightness: 95,
    minBrightness: 35,
    fadeoutMinutes: 0,
  };

  // DOM Elements
  const canvas = document.getElementById('fireCanvas');
  const menuBtn = document.getElementById('menuBtn');
  const closeBtn = document.getElementById('closeBtn');
  const drawer = document.getElementById('menuDrawer');
  const backdrop = document.getElementById('drawerBackdrop');

  const swatches = Array.from(document.querySelectorAll('.swatch[data-color]'));
  const customColorLabel = document.querySelector('.swatch-custom');
  const customColorInput = document.getElementById('customColor');
  const colorNameEl = document.getElementById('colorName');

  const intensityRange = document.getElementById('intensityRange');
  const intensityValue = document.getElementById('intensityValue');
  const maxBrightnessRange = document.getElementById('maxBrightnessRange');
  const maxBrightnessValue = document.getElementById('maxBrightnessValue');
  const minBrightnessRange = document.getElementById('minBrightnessRange');
  const minBrightnessValue = document.getElementById('minBrightnessValue');

  const fadeoutRange = document.getElementById('fadeoutRange');
  const fadeoutValue = document.getElementById('fadeoutValue');
  const presetChips = Array.from(document.querySelectorAll('.preset-chip[data-minutes]'));
  const fadeStatus = document.getElementById('fadeStatus');
  const fadeRemaining = document.getElementById('fadeRemaining');
  const relightBtn = document.getElementById('relightBtn');
  const resetBtn = document.getElementById('resetBtn');

  // State
  let settings = loadSettings();
  let menuOpen = false;
  let idleTimer = null;
  let wakeLock = null;

  // Fade-out timer state
  let fadeStartMs = null;
  let fadeProgress = 0;
  let isExtinguished = false;
  let lastCountdownLabel = '';

  // Initialize WebGL Simulation
  const sim = new window.FireSimulation(canvas);

  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...DEFAULTS };
      const parsed = JSON.parse(raw);
      return {
        color: typeof parsed.color === 'string' ? parsed.color : DEFAULTS.color,
        colorName: typeof parsed.colorName === 'string' ? parsed.colorName : DEFAULTS.colorName,
        intensity: clampNum(parsed.intensity, 10, 100, DEFAULTS.intensity),
        maxBrightness: clampNum(parsed.maxBrightness, 5, 100, DEFAULTS.maxBrightness),
        minBrightness: clampNum(parsed.minBrightness, 0, 100, DEFAULTS.minBrightness),
        fadeoutMinutes: clampNum(parsed.fadeoutMinutes, 0, 60, DEFAULTS.fadeoutMinutes),
      };
    } catch {
      return { ...DEFAULTS };
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Ignore storage errors (private browsing, etc.)
    }
  }

  function clampNum(v, min, max, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  }

  function hexToRgba(hex, alpha) {
    const clean = (hex || '#ff6a14').replace('#', '');
    const full = clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean;
    const num = parseInt(full, 16);
    if (Number.isNaN(num)) return `rgba(255, 106, 20, ${alpha})`;
    const r = (num >> 16) & 255;
    const g = (num >> 8) & 255;
    const b = num & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function updateSliderFill(input) {
    const min = Number(input.min);
    const max = Number(input.max);
    const val = Number(input.value);
    const pct = max > min ? ((val - min) / (max - min)) * 100 : 0;
    input.style.setProperty('--fill', `${pct}%`);
  }

  function formatRemaining(ms) {
    const totalSec = Math.max(0, Math.ceil(ms / 1000));
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `残り ${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  // Apply settings to UI + Simulation
  function applySettings(options = {}) {
    const { restartFade = false } = options;

    if (settings.minBrightness > settings.maxBrightness) {
      settings.minBrightness = settings.maxBrightness;
    }

    // Accent theme follows chosen flame color
    document.documentElement.style.setProperty('--accent', settings.color);
    document.documentElement.style.setProperty('--accent-soft', hexToRgba(settings.color, 0.28));

    // Color swatches
    let matchedPreset = false;
    for (const btn of swatches) {
      const isMatch = btn.dataset.color.toLowerCase() === settings.color.toLowerCase();
      btn.classList.toggle('active', isMatch);
      if (isMatch) {
        matchedPreset = true;
        settings.colorName = btn.dataset.name;
      }
    }
    customColorInput.value = settings.color;
    customColorLabel.classList.toggle('active', !matchedPreset);
    customColorLabel.style.setProperty('--custom-color', matchedPreset ? 'rgba(12, 10, 10, 0.82)' : settings.color);
    colorNameEl.textContent = matchedPreset ? settings.colorName : settings.color.toUpperCase();

    // Sliders & readouts
    intensityRange.value = String(settings.intensity);
    intensityValue.textContent = `${settings.intensity}%`;
    updateSliderFill(intensityRange);

    maxBrightnessRange.value = String(settings.maxBrightness);
    maxBrightnessValue.textContent = `${settings.maxBrightness}%`;
    updateSliderFill(maxBrightnessRange);

    minBrightnessRange.value = String(settings.minBrightness);
    minBrightnessValue.textContent = `${settings.minBrightness}%`;
    updateSliderFill(minBrightnessRange);

    fadeoutRange.value = String(settings.fadeoutMinutes);
    fadeoutValue.textContent = settings.fadeoutMinutes === 0 ? 'なし' : `${settings.fadeoutMinutes}分`;
    updateSliderFill(fadeoutRange);

    for (const chip of presetChips) {
      chip.classList.toggle('active', Number(chip.dataset.minutes) === settings.fadeoutMinutes);
    }

    // Update simulation parameters
    sim.setColor(settings.color);
    sim.setIntensity(settings.intensity / 100);
    sim.setBrightnessRange(settings.minBrightness / 100, settings.maxBrightness / 100);

    // Fade-out timer management
    if (settings.fadeoutMinutes === 0) {
      fadeStartMs = null;
      fadeProgress = 0;
      isExtinguished = false;
      sim.setFadeProgress(0);
      fadeStatus.hidden = true;
      requestWakeLock();
    } else if (restartFade || fadeStartMs === null) {
      startFadeTimer();
    }

    saveSettings();
  }

  function startFadeTimer() {
    fadeStartMs = performance.now();
    fadeProgress = 0;
    isExtinguished = false;
    sim.setFadeProgress(0);
    fadeStatus.hidden = false;
    lastCountdownLabel = '';
    updateFadeTimer(fadeStartMs);
    requestWakeLock();
  }

  function updateFadeTimer(nowMs) {
    if (settings.fadeoutMinutes <= 0 || fadeStartMs === null) return;

    const durationMs = settings.fadeoutMinutes * 60 * 1000;
    const elapsedMs = Math.max(0, nowMs - fadeStartMs);
    fadeProgress = Math.min(1, elapsedMs / durationMs);
    sim.setFadeProgress(fadeProgress);

    const remainingMs = Math.max(0, durationMs - elapsedMs);
    const label = fadeProgress >= 1 ? '消火しました（タップで再点火）' : formatRemaining(remainingMs);
    if (label !== lastCountdownLabel) {
      lastCountdownLabel = label;
      fadeRemaining.textContent = label;
    }

    if (fadeProgress >= 1 && !isExtinguished) {
      isExtinguished = true;
      releaseWakeLock();
    }
  }

  // --- Drawer open/close & idle button dimming ---

  function setMenuOpen(open) {
    menuOpen = open;
    drawer.classList.toggle('is-open', open);
    backdrop.classList.toggle('is-open', open);
    menuBtn.classList.toggle('is-hidden', open);
    menuBtn.setAttribute('aria-expanded', String(open));
    drawer.setAttribute('aria-hidden', String(!open));
    backdrop.setAttribute('aria-hidden', String(!open));

    if (open) {
      clearTimeout(idleTimer);
      menuBtn.classList.remove('is-idle');
    } else {
      scheduleIdleButton();
    }
  }

  function wakeMenuButton() {
    if (menuOpen) return;
    menuBtn.classList.remove('is-idle');
    scheduleIdleButton();
  }

  function scheduleIdleButton() {
    clearTimeout(idleTimer);
    if (menuOpen) return;
    idleTimer = setTimeout(() => {
      if (!menuOpen) menuBtn.classList.add('is-idle');
    }, 3500);
  }

  // --- Screen Wake Lock (keeps phone screen awake while enjoying the fire) ---

  async function requestWakeLock() {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible' || isExtinguished) {
      return;
    }
    if (wakeLock) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });
    } catch {
      // Ignore if battery saver or browser policy blocks wake lock
    }
  }

  async function releaseWakeLock() {
    if (!wakeLock) return;
    try {
      await wakeLock.release();
    } catch {
      // Ignore
    }
    wakeLock = null;
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (!isExtinguished) requestWakeLock();
    } else {
      releaseWakeLock();
    }
  });

  // --- UI Event Listeners ---

  menuBtn.addEventListener('click', () => setMenuOpen(true));
  closeBtn.addEventListener('click', () => setMenuOpen(false));
  backdrop.addEventListener('click', () => setMenuOpen(false));

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menuOpen) {
      setMenuOpen(false);
    }
  });

  // Swipe right on drawer to close smoothly on mobile
  let drawerTouchStartX = null;
  let drawerTouchStartY = null;
  drawer.addEventListener('touchstart', (e) => {
    if (e.target.closest('input[type="range"]')) return;
    const t = e.touches[0];
    drawerTouchStartX = t.clientX;
    drawerTouchStartY = t.clientY;
  }, { passive: true });

  drawer.addEventListener('touchend', (e) => {
    if (drawerTouchStartX === null) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - drawerTouchStartX;
    const dy = Math.abs(t.clientY - drawerTouchStartY);
    drawerTouchStartX = null;
    drawerTouchStartY = null;
    if (dx > 64 && dy < 60) {
      setMenuOpen(false);
    }
  }, { passive: true });

  // Color swatches
  for (const btn of swatches) {
    btn.addEventListener('click', () => {
      settings.color = btn.dataset.color;
      settings.colorName = btn.dataset.name;
      applySettings();
    });
  }

  customColorInput.addEventListener('input', (e) => {
    settings.color = e.target.value;
    settings.colorName = e.target.value.toUpperCase();
    applySettings();
  });

  // Intensity
  intensityRange.addEventListener('input', (e) => {
    settings.intensity = Number(e.target.value);
    applySettings();
  });

  // Max & Min Brightness (smoothly coupled so min <= max always holds)
  maxBrightnessRange.addEventListener('input', (e) => {
    settings.maxBrightness = Number(e.target.value);
    if (settings.minBrightness > settings.maxBrightness) {
      settings.minBrightness = settings.maxBrightness;
    }
    applySettings();
  });

  minBrightnessRange.addEventListener('input', (e) => {
    settings.minBrightness = Number(e.target.value);
    if (settings.maxBrightness < settings.minBrightness) {
      settings.maxBrightness = Math.max(5, settings.minBrightness);
    }
    applySettings();
  });

  // Fade-out time
  for (const chip of presetChips) {
    chip.addEventListener('click', () => {
      settings.fadeoutMinutes = Number(chip.dataset.minutes);
      applySettings({ restartFade: true });
    });
  }

  fadeoutRange.addEventListener('input', (e) => {
    settings.fadeoutMinutes = Number(e.target.value);
    applySettings({ restartFade: true });
  });

  relightBtn.addEventListener('click', () => {
    if (settings.fadeoutMinutes > 0) {
      startFadeTimer();
    }
  });

  resetBtn.addEventListener('click', () => {
    settings = { ...DEFAULTS };
    applySettings({ restartFade: true });
  });

  // --- Interactive Touch / Mouse Stirring on the Bonfire Canvas ---

  let activePointerId = null;
  let lastPtrX = 0;
  let lastPtrY = 0;
  let lastPtrTime = 0;

  function toSimUv(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const x = (clientX - rect.left) / Math.max(1, rect.width);
    const y = 1.0 - (clientY - rect.top) / Math.max(1, rect.height);
    return [x, y];
  }

  canvas.addEventListener('pointerdown', (e) => {
    wakeMenuButton();

    // If extinguished after fade-out, tapping the dark screen gently rekindles the fire
    if (isExtinguished) {
      startFadeTimer();
      return;
    }

    activePointerId = e.pointerId;
    canvas.setPointerCapture(e.pointerId);
    const [u, v] = toSimUv(e.clientX, e.clientY);
    lastPtrX = u;
    lastPtrY = v;
    lastPtrTime = performance.now();
    sim.setTouch(true, u, v, 0, 12);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse' && activePointerId === null) {
      wakeMenuButton();
      return;
    }
    if (e.pointerId !== activePointerId) return;

    const now = performance.now();
    const dt = Math.max(0.008, (now - lastPtrTime) / 1000);
    const [u, v] = toSimUv(e.clientX, e.clientY);
    const vx = ((u - lastPtrX) / dt) * sim.simW * 0.42;
    const vy = ((v - lastPtrY) / dt) * sim.simH * 0.42;

    sim.setTouch(true, u, v, vx, vy);
    lastPtrX = u;
    lastPtrY = v;
    lastPtrTime = now;
  });

  function endPointer(e) {
    if (e.pointerId !== activePointerId) return;
    activePointerId = null;
    sim.setTouch(false, 0, 0, 0, 0);
  }

  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  // Resize & Orientation Change
  let resizeRaf = 0;
  function scheduleResize() {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0;
      sim.resize();
    });
  }

  window.addEventListener('resize', scheduleResize);
  window.addEventListener('orientationchange', scheduleResize);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', scheduleResize);
  }

  // Main Animation Loop
  let lastFrameMs = performance.now();

  function loop(nowMs) {
    const dt = (nowMs - lastFrameMs) / 1000;
    lastFrameMs = nowMs;

    updateFadeTimer(nowMs);
    sim.stepAndRender(dt);

    requestAnimationFrame(loop);
  }

  // Boot
  applySettings({ restartFade: settings.fadeoutMinutes > 0 });
  scheduleIdleButton();
  requestWakeLock();
  requestAnimationFrame(loop);
})();
