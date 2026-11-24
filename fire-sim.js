/**
 * TheFire — Real-time GPU Eulerian Fluid & 1/f Pink-Noise Bonfire Simulation
 *
 * Physics & visual features:
 *   - Human-scale campfire convection with fast, nimble flame turnover
 *   - True 7-octave 1/f pink noise (1/fゆらぎ) driving fuel jets, breeze, & brightness
 *   - Wide-range dynamic Time Scale (0.05x slow-mo to 8.0x rapid crackle) with adaptive substepping
 *   - Smooth 3D-like Camera Distance dolly (0.25m close-up to 4.0m distant hearth)
 *   - WebGL2 / WebGL1 Navier-Stokes fluid solver (buoyancy, entrainment, vorticity confinement,
 *     warm-started Jacobi pressure projection, Clamped MacCormack advection, combustion & T^3 cooling)
 *     with automatic procedural fallback for legacy mobile GPUs
 */
(function (global) {
  'use strict';

  /**
   * Multi-octave smooth 1/f (pink) noise generator.
   * Combines 7 octave bands (0.25 Hz .. 16 Hz) weighted by 1 / sqrt(f)
   * so power spectral density follows S(f) ~ 1/f.
   */
  class PinkNoise1D {
    constructor(baseFreq = 0.28, octaves = 7) {
      this.octaves = octaves;
      this.freqs = [];
      this.amps = [];
      this.phases = [];
      this.prev = [];
      this.next = [];
      let totalAmp = 0;

      for (let i = 0; i < octaves; i++) {
        const f = baseFreq * Math.pow(2, i);
        const a = 1.0 / Math.sqrt(Math.pow(2, i)); // S(f) ~ a^2 / df ~ 1/f
        this.freqs.push(f);
        this.amps.push(a);
        this.phases.push(Math.random());
        this.prev.push(Math.random());
        this.next.push(Math.random());
        totalAmp += a;
      }
      this.invNorm = 1.0 / totalAmp;
      this.value = 0.5;
    }

    step(dt) {
      let sum = 0;
      for (let i = 0; i < this.octaves; i++) {
        let p = this.phases[i] + dt * this.freqs[i];
        if (p >= 1.0) {
          const wraps = Math.floor(p);
          p -= wraps;
          this.prev[i] = wraps === 1 ? this.next[i] : Math.random();
          this.next[i] = Math.random();
        }
        this.phases[i] = p;
        // Smooth Hermite interpolation between random octave knots
        const u = p * p * (3.0 - 2.0 * p);
        sum += (this.prev[i] + (this.next[i] - this.prev[i]) * u) * this.amps[i];
      }
      this.value = sum * this.invNorm;
      return this.value;
    }
  }

  const FULLSCREEN_VERT = `
    attribute vec2 aPos;
    varying vec2 vUv;
    void main() {
      vUv = aPos * 0.5 + 0.5;
      gl_Position = vec4(aPos, 0.0, 1.0);
    }
  `;

  const NOISE_GLSL = `
    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    float vnoise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      float a = hash12(i);
      float b = hash12(i + vec2(1.0, 0.0));
      float c = hash12(i + vec2(0.0, 1.0));
      float d = hash12(i + vec2(1.0, 1.0));
      return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
    }

    float fbm(vec2 p) {
      float v = 0.0;
      float a = 0.5;
      mat2 rot = mat2(0.80, 0.60, -0.60, 0.80);
      for (int i = 0; i < 4; i++) {
        v += a * vnoise(p);
        p = rot * p * 2.03 + vec2(17.1, 31.7);
        a *= 0.5;
      }
      return v;
    }
  `;

  // 1. Human-scale campfire multi-jet fuel & heat emission driven by live 1/f pink noise
  const EMIT_STATE_FRAG = `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uState;
    uniform float uTime;
    uniform float uDt;
    uniform float uIntensity;
    uniform float uFireHalfW;
    uniform float uBaseY;
    uniform vec4 uJetNoise;
    uniform float uJetCenter;
    uniform vec2 uTouchPos;
    uniform vec2 uTouchVel;
    uniform float uTouchActive;
    uniform float uAspect;
    ${NOISE_GLSL}

    void main() {
      vec4 st = texture2D(uState, vUv);

      float nx = (vUv.x - 0.5) / uFireHalfW;
      float ax = abs(nx);

      if (uIntensity > 0.002 && ax < 1.25 && vUv.y < uBaseY + 0.18) {
        // Campfire footprint scales naturally from tiny ember core (0.32) to roaring hearth (1.08)
        float widthScale = mix(0.32, 1.05, clamp(uIntensity, 0.0, 1.35) / 1.35);
        float sx = nx / widthScale;

        // Compact human-scale firewood mound profile
        float moundTop = uBaseY + 0.038 * exp(-sx * sx * 1.9) * mix(0.55, 1.25, min(uIntensity, 1.4));
        float moundBot = uBaseY - 0.015;

        float vertMask = smoothstep(moundBot - 0.012, moundBot + 0.018, vUv.y)
                       * smoothstep(moundTop + 0.026, moundTop - 0.008, vUv.y);

        // Five lively, nimble wood-gap flame tongues modulated by 1/f pink noise
        float s1 = sx + 0.66 + (uJetNoise.x - 0.5) * 0.16;
        float s2 = sx + 0.31 + (uJetNoise.y - 0.5) * 0.18;
        float s3 = sx + 0.00 + (uJetCenter  - 0.5) * 0.16;
        float s4 = sx - 0.30 + (uJetNoise.z - 0.5) * 0.18;
        float s5 = sx - 0.64 + (uJetNoise.w - 0.5) * 0.16;

        // Sharp, distinct flame-lick widths so tongues dance independently instead of merging into a huge pillar
        float f1 = smoothstep(0.18, 0.85, uJetNoise.x);
        float f2 = smoothstep(0.14, 0.86, uJetNoise.y);
        float f3 = smoothstep(0.12, 0.84, uJetCenter);
        float f4 = smoothstep(0.14, 0.86, uJetNoise.z);
        float f5 = smoothstep(0.18, 0.85, uJetNoise.w);

        float j1 = exp(-s1 * s1 * 26.0) * (0.20 + 1.05 * f1);
        float j2 = exp(-s2 * s2 * 22.0) * (0.30 + 1.15 * f2);
        float j3 = exp(-s3 * s3 * 19.0) * (0.42 + 1.20 * f3);
        float j4 = exp(-s4 * s4 * 22.0) * (0.30 + 1.15 * f4);
        float j5 = exp(-s5 * s5 * 26.0) * (0.20 + 1.05 * f5);

        float baseHearth = exp(-sx * sx * 3.4) * 0.24;
        float jets = baseHearth + j1 * 0.68 + j2 * 1.02 + j3 * 1.15 + j4 * 1.00 + j5 * 0.68;

        // Fine quick pyrolysis pockets from burning bark & wood grain
        float n1 = fbm(vec2(sx * 6.0, vUv.y * 18.0 - uTime * 5.2));
        float n2 = vnoise(vec2(sx * 13.0 + uTime * 2.1, vUv.y * 26.0 - uTime * 8.4));
        float turb = clamp((n1 * 0.60 + n2 * 0.55) * 1.45, 0.08, 1.55);

        float emit = vertMask * jets * turb * smoothstep(1.15, 0.78, abs(sx));
        float power = pow(clamp(uIntensity, 0.0, 1.5), 0.86);

        float fuelAdd = emit * power * 5.2 * uDt;
        float tempAdd = emit * mix(0.32, 1.18, clamp(power, 0.0, 1.25)) * 4.6 * uDt;

        st.r = min(1.85, st.r + tempAdd);
        st.g = min(1.55, st.g + fuelAdd);
      }

      // Gentle spark of heat when user stirs the fire
      if (uTouchActive > 0.5 && uIntensity > 0.02) {
        vec2 diff = vUv - uTouchPos;
        diff.x *= uAspect;
        float d2 = dot(diff, diff);
        float splash = exp(-d2 * 220.0);
        float speed = clamp(length(uTouchVel) * 0.012, 0.0, 1.0);
        st.r = min(1.8, st.r + splash * speed * 0.28 * min(uIntensity, 1.2));
        st.g = min(1.5, st.g + splash * speed * 0.22 * min(uIntensity, 1.2));
      }

      gl_FragColor = st;
    }
  `;

  // 2. Buoyancy, nimble micro-drafts, 1/f breeze gusts, and touch momentum
  const BUOYANCY_FRAG = `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uVelocity;
    uniform sampler2D uState;
    uniform float uTime;
    uniform float uDt;
    uniform float uBuoyancy;
    uniform float uIntensity;
    uniform float uFireHalfW;
    uniform float uBaseY;
    uniform float uBreeze;
    uniform vec2 uTouchPos;
    uniform vec2 uTouchVel;
    uniform float uTouchActive;
    uniform float uAspect;
    ${NOISE_GLSL}

    void main() {
      vec2 vel = texture2D(uVelocity, vUv).xy;
      vec4 st = texture2D(uState, vUv);

      float temp = st.r;
      float fuel = st.g;
      float smoke = st.b;

      // Brisk small-scale thermal buoyancy
      float lift = (temp * 1.15 + fuel * 0.58 - smoke * 0.05) * uBuoyancy;
      vel.y += lift * uDt;

      // Gentle campfire entrainment pulls outer flame smoothly inward to pointed dancing tips
      float nx = (vUv.x - 0.5) / uFireHalfW;
      float pinchZone = smoothstep(0.50, 0.04, vUv.y) * smoothstep(2.0, 0.28, abs(nx));
      vel.x -= sign(nx) * min(abs(nx), 1.0) * pinchZone * uBuoyancy * 0.14 * (0.30 + 0.70 * min(uIntensity, 1.3)) * uDt;

      // Live 1/f pink-noise evening breeze + nimble local air eddies
      float heightFactor = smoothstep(uBaseY, 0.65, vUv.y);
      float lateralNoise = (vnoise(vec2(vUv.x * 8.5, vUv.y * 9.5 - uTime * 4.2)) - 0.5) * 2.0;
      vel.x += (uBreeze * 0.52 * heightFactor + lateralNoise * 0.68 * (0.16 + temp)) * uBuoyancy * uDt;

      // Local updraft inside log crevices
      float corePush = exp(-nx * nx * 3.0) * smoothstep(uBaseY + 0.10, uBaseY, vUv.y) * smoothstep(uBaseY - 0.025, uBaseY + 0.01, vUv.y);
      vel.y += corePush * uBuoyancy * 0.48 * min(uIntensity, 1.35) * uDt;

      // User touch / swipe interaction
      if (uTouchActive > 0.5) {
        vec2 diff = vUv - uTouchPos;
        diff.x *= uAspect;
        float d2 = dot(diff, diff);
        float w = exp(-d2 * 110.0);
        vel += uTouchVel * w;
      }

      // Slightly higher viscous air drag keeps campfire nimble instead of giant inertial plumes
      vel *= exp(-0.85 * uDt);
      float maxSpd = uBuoyancy * 2.0;
      float spd = length(vel);
      if (spd > maxSpd) {
        vel = vel * (maxSpd / spd);
      }

      if (vUv.y < 0.012) {
        vel.y = max(0.0, vel.y);
      }

      gl_FragColor = vec4(vel, 0.0, 1.0);
    }
  `;

  // 3. Curl (vorticity)
  const CURL_FRAG = `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uVelocity;
    uniform vec2 uTexel;

    void main() {
      float vR = texture2D(uVelocity, vUv + vec2(uTexel.x, 0.0)).y;
      float vL = texture2D(uVelocity, vUv - vec2(uTexel.x, 0.0)).y;
      float uT = texture2D(uVelocity, vUv + vec2(0.0, uTexel.y)).x;
      float uB = texture2D(uVelocity, vUv - vec2(0.0, uTexel.y)).x;
      float w = 0.5 * ((vR - vL) - (uT - uB));
      gl_FragColor = vec4(w, 0.0, 0.0, 1.0);
    }
  `;

  // 4. Vorticity confinement (carves quick, nimble licking flame tips)
  const VORTICITY_FRAG = `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uVelocity;
    uniform sampler2D uCurl;
    uniform sampler2D uState;
    uniform vec2 uTexel;
    uniform float uCurlStrength;
    uniform float uDt;

    void main() {
      float cL = abs(texture2D(uCurl, vUv - vec2(uTexel.x, 0.0)).x);
      float cR = abs(texture2D(uCurl, vUv + vec2(uTexel.x, 0.0)).x);
      float cB = abs(texture2D(uCurl, vUv - vec2(0.0, uTexel.y)).x);
      float cT = abs(texture2D(uCurl, vUv + vec2(0.0, uTexel.y)).x);
      float cC = texture2D(uCurl, vUv).x;

      vec2 force = 0.5 * vec2(cT - cB, cL - cR);
      float len = length(force) + 1e-5;
      force = (force / len) * cC * uCurlStrength;

      vec4 st = texture2D(uState, vUv);
      float mask = smoothstep(0.04, 0.34, st.r + st.g + st.b * 0.35);
      mask *= smoothstep(1.0, 0.86, vUv.y);

      vec2 vel = texture2D(uVelocity, vUv).xy;
      vel += force * mask * uDt;
      gl_FragColor = vec4(vel, 0.0, 1.0);
    }
  `;

  // 5. Divergence
  const DIVERGENCE_FRAG = `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uVelocity;
    uniform vec2 uTexel;

    void main() {
      float uL = texture2D(uVelocity, vUv - vec2(uTexel.x, 0.0)).x;
      float uR = texture2D(uVelocity, vUv + vec2(uTexel.x, 0.0)).x;
      float vB = texture2D(uVelocity, vUv - vec2(0.0, uTexel.y)).y;
      float vT = texture2D(uVelocity, vUv + vec2(0.0, uTexel.y)).y;

      vec2 vC = texture2D(uVelocity, vUv).xy;
      if (vUv.x - uTexel.x < 0.0) uL = -vC.x;
      if (vUv.x + uTexel.x > 1.0) uR = -vC.x;
      if (vUv.y - uTexel.y < 0.0) vB = -vC.y;

      float div = 0.5 * (uR - uL + vT - vB);
      gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
    }
  `;

  // 6. Pressure warm-start scale
  const CLEAR_SCALE_FRAG = `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uTex;
    uniform float uScale;

    void main() {
      gl_FragColor = texture2D(uTex, vUv) * uScale;
    }
  `;

  // 7. Jacobi Pressure Solve
  const PRESSURE_FRAG = `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uPressure;
    uniform sampler2D uDivergence;
    uniform vec2 uTexel;

    void main() {
      if (vUv.y > 1.0 - uTexel.y * 1.5) {
        gl_FragColor = vec4(0.0);
        return;
      }
      float pL = texture2D(uPressure, vUv - vec2(uTexel.x, 0.0)).x;
      float pR = texture2D(uPressure, vUv + vec2(uTexel.x, 0.0)).x;
      float pB = texture2D(uPressure, vUv - vec2(0.0, uTexel.y)).x;
      float pT = texture2D(uPressure, vUv + vec2(0.0, uTexel.y)).x;
      float div = texture2D(uDivergence, vUv).x;
      float p = (pL + pR + pB + pT - div) * 0.25;
      gl_FragColor = vec4(p, 0.0, 0.0, 1.0);
    }
  `;

  // 8. Subtract Pressure Gradient
  const GRAD_SUB_FRAG = `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uPressure;
    uniform sampler2D uVelocity;
    uniform vec2 uTexel;

    void main() {
      float pL = texture2D(uPressure, vUv - vec2(uTexel.x, 0.0)).x;
      float pR = texture2D(uPressure, vUv + vec2(uTexel.x, 0.0)).x;
      float pB = texture2D(uPressure, vUv - vec2(0.0, uTexel.y)).x;
      float pT = texture2D(uPressure, vUv + vec2(0.0, uTexel.y)).x;
      vec2 vel = texture2D(uVelocity, vUv).xy;
      vel -= 0.5 * vec2(pR - pL, pT - pB);

      if (vUv.x < uTexel.x * 1.5 || vUv.x > 1.0 - uTexel.x * 1.5) {
        vel.x *= 0.2;
      }
      if (vUv.y < uTexel.y * 1.5) {
        vel.y = max(0.0, vel.y);
      }

      gl_FragColor = vec4(vel, 0.0, 1.0);
    }
  `;

  // 9a. Semi-Lagrangian Advection
  const ADVECT_FRAG = `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uVelocity;
    uniform sampler2D uSource;
    uniform vec2 uTexel;
    uniform float uDt;
    uniform float uDissipation;

    void main() {
      vec2 vel = texture2D(uVelocity, vUv).xy;
      vec2 backUv = vUv - vel * uDt * uTexel;
      if (backUv.x < 0.0 || backUv.x > 1.0 || backUv.y < 0.0 || backUv.y > 1.0) {
        gl_FragColor = vec4(0.0);
        return;
      }
      gl_FragColor = texture2D(uSource, backUv) * uDissipation;
    }
  `;

  // 9b. Clamped MacCormack Advection
  const MACCORMACK_FRAG = `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uVelocity;
    uniform sampler2D uPhiN;
    uniform sampler2D uPhiHat;
    uniform vec2 uTexel;
    uniform float uDt;

    void main() {
      vec2 vel = texture2D(uVelocity, vUv).xy;
      vec2 backUv = vUv - vel * uDt * uTexel;
      vec2 fwdUv  = vUv + vel * uDt * uTexel;

      if (backUv.x < 0.0 || backUv.x > 1.0 || backUv.y < 0.0 || backUv.y > 1.0) {
        gl_FragColor = vec4(0.0);
        return;
      }

      vec4 phiN = texture2D(uPhiN, vUv);
      vec4 phiHat = texture2D(uPhiHat, vUv);
      vec4 phiBack = texture2D(uPhiHat, clamp(fwdUv, vec2(0.0), vec2(1.0)));

      vec4 res = phiHat + 0.5 * (phiN - phiBack);

      vec2 center = (floor(backUv / uTexel - 0.5) + 0.5) * uTexel;
      vec4 n00 = texture2D(uPhiN, clamp(center, vec2(0.0), vec2(1.0)));
      vec4 n10 = texture2D(uPhiN, clamp(center + vec2(uTexel.x, 0.0), vec2(0.0), vec2(1.0)));
      vec4 n01 = texture2D(uPhiN, clamp(center + vec2(0.0, uTexel.y), vec2(0.0), vec2(1.0)));
      vec4 n11 = texture2D(uPhiN, clamp(center + uTexel, vec2(0.0), vec2(1.0)));

      vec4 lo = min(min(n00, n10), min(n01, n11));
      vec4 hi = max(max(n00, n10), max(n01, n11));

      res = clamp(res, lo, hi);
      gl_FragColor = max(vec4(0.0), res);
    }
  `;

  // 10. Crisp Campfire Combustion & Short-Timescale Radiative Cooling
  const COMBUSTION_FRAG = `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uState;
    uniform float uDt;
    uniform float uCooling;

    void main() {
      vec4 st = texture2D(uState, vUv);
      float temp = st.r;
      float fuel = st.g;
      float smoke = st.b;

      // Rapid wood-gas combustion creates lively, short-lived campfire licks
      float ignition = smoothstep(0.04, 0.28, temp + 0.14);
      float burn = min(fuel, fuel * 5.6 * uDt) * ignition;
      fuel -= burn;
      temp += burn * 1.42;
      smoke = min(0.85, smoke + burn * 0.18);

      // Faster convective + radiative cooling keeps flames human-scaled & sharply pointed
      float coolRate = uCooling * (0.95 * temp + 2.25 * temp * temp * temp);
      temp = max(0.0, temp - coolRate * uDt);

      float topFade = smoothstep(1.0, 0.86, vUv.y);
      temp *= mix(0.82, 1.0, topFade);
      fuel *= exp(-1.65 * uDt) * mix(0.82, 1.0, topFade);
      smoke *= exp(-1.95 * uDt) * mix(0.80, 1.0, topFade);

      gl_FragColor = vec4(temp, fuel, smoke, 1.0);
    }
  `;

  // Shared rendering helpers
  const RENDER_HELPERS_GLSL = `
    vec3 acesToneMap(vec3 x) {
      return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
    }

    // Crisp wood-campfire blackbody radiance (clean golden-orange licks, minimal murky brown)
    vec3 naturalFireRamp(float t) {
      vec3 c0 = vec3(0.0);
      vec3 c1 = vec3(0.62, 0.025, 0.001); // translucent crimson tip
      vec3 c2 = vec3(1.85, 0.28, 0.006);  // vivid wood-flame orange-red
      vec3 c3 = vec3(3.15, 1.08, 0.07);   // warm campfire amber-orange
      vec3 c4 = vec3(4.55, 2.72, 0.50);   // bright golden flame
      vec3 c5 = vec3(6.40, 5.35, 3.05);   // incandescent cream-white core

      vec3 col = mix(c0, c1, smoothstep(0.11, 0.24, t));
      col = mix(col, c2, smoothstep(0.22, 0.44, t));
      col = mix(col, c3, smoothstep(0.42, 0.72, t));
      col = mix(col, c4, smoothstep(0.70, 1.05, t));
      col = mix(col, c5, smoothstep(1.02, 1.46, t));
      return col;
    }

    // Vivid thermal ramp for arbitrary user colors
    vec3 customFireRamp(float t, vec3 base) {
      vec3 b = max(base, vec3(0.01));
      float maxC = max(b.r, max(b.g, b.b));
      vec3 normB = b / max(maxC, 0.001);

      vec3 c0 = vec3(0.0);
      vec3 c1 = pow(normB, vec3(2.4)) * 0.70;
      vec3 c2 = pow(normB, vec3(1.42)) * 2.00;
      vec3 c3 = mix(normB, vec3(1.0, 0.97, 0.90), 0.24) * 3.30;
      vec3 c4 = mix(normB, vec3(1.0, 0.99, 0.95), 0.62) * 4.70;
      vec3 c5 = mix(vec3(1.0), normB, 0.14) * 6.40;

      vec3 col = mix(c0, c1, smoothstep(0.11, 0.24, t));
      col = mix(col, c2, smoothstep(0.22, 0.44, t));
      col = mix(col, c3, smoothstep(0.42, 0.72, t));
      col = mix(col, c4, smoothstep(0.70, 1.05, t));
      col = mix(col, c5, smoothstep(1.02, 1.46, t));
      return col;
    }

    vec3 fireColor(float t, vec3 baseColor, float isNatural) {
      vec3 nat = naturalFireRamp(t);
      vec3 cus = customFireRamp(t, baseColor);
      return mix(cus, nat, isNatural);
    }

    // Exposure-based brightness scaling supporting 0% .. 150%
    vec3 exposeAndToneMap(vec3 hdrCol, float brightness) {
      float b = clamp(brightness, 0.0, 1.5);
      if (b <= 0.0005) return vec3(0.0);
      float preExposure = mix(0.22, 1.25, pow(min(b, 1.0), 0.72)) * (b > 1.0 ? (1.0 + (b - 1.0) * 1.45) : 1.0);
      vec3 mapped = acesToneMap(hdrCol * preExposure);
      float postCeiling = pow(min(b, 1.0), 0.68) * (b > 1.0 ? (1.0 + (b - 1.0) * 0.25) : 1.0);
      return clamp(mapped * postCeiling, 0.0, 1.0);
    }

    float sdSegment(vec2 p, vec2 a, vec2 b, out float along) {
      vec2 pa = p - a;
      vec2 ba = b - a;
      along = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
      return length(pa - ba * along);
    }

    // Sculpted campfire firewood logs & pulsing ember bed (evaluated in simulation UV space)
    vec3 evalCampfireLogs(vec2 simUv, float fireHalfW, float baseY, float aspect, float time, float emberHeat) {
      vec2 p = vec2((simUv.x - 0.5) / fireHalfW, (simUv.y - baseY) / (fireHalfW * aspect));

      if (abs(p.x) > 1.32 || p.y < -0.52 || p.y > 0.52) {
        return vec3(0.0);
      }

      float grain = fbm(p * vec2(12.0, 24.0) + vec2(3.1, 1.7));
      float cracks = vnoise(p * vec2(28.0, 36.0) + vec2(0.0, -time * 0.05));
      float rough = (grain - 0.5) * 0.020;

      float h1, h2, h3, h4;
      float d1 = sdSegment(p, vec2(-0.86, -0.14), vec2(0.25, 0.13), h1) - 0.064 + rough;
      float d2 = sdSegment(p, vec2(0.88, -0.13), vec2(-0.23, 0.12), h2) - 0.062 + rough;
      float d3 = sdSegment(p, vec2(-0.74, -0.21), vec2(0.40, -0.05), h3) - 0.068 + rough;
      float d4 = sdSegment(p, vec2(0.76, -0.20), vec2(-0.38, -0.03), h4) - 0.066 + rough;

      float d = min(min(d1, d2), min(d3, d4));
      float logAlpha = smoothstep(0.014, -0.008, d);

      // Glowing oak coal bed nestled between and beneath logs
      float bedDist = length(vec2(p.x * 0.98, (p.y + 0.16) * 3.1));
      float bedNoise = fbm(vec2(p.x * 12.0, p.y * 19.0) + vec2(time * 0.04, -time * 0.03));
      float pulse = 0.78 + 0.22 * sin(time * 1.4 + p.x * 4.5 + bedNoise * 5.0);
      float coalBed = smoothstep(0.90, 0.16, bedDist) * smoothstep(0.32, 0.78, bedNoise) * pulse;

      float innerHeat = exp(-p.x * p.x * 2.4) * smoothstep(-0.32, 0.14, p.y);
      float crackGlow = logAlpha * innerHeat * smoothstep(0.48, 0.85, cracks * 0.65 + grain * 0.48) * pulse;
      float rimGlow = smoothstep(0.022, 0.0, abs(d)) * innerHeat * 0.78 * pulse;

      float totalEmber = (coalBed * 0.76 + crackGlow * 0.98 + rimGlow * 0.68) * emberHeat;
      float shade = 0.4 + 0.6 * grain;
      return vec3(logAlpha, totalEmber, shade);
    }
  `;

  // 11. High-DPI Final Volumetric Fire Display Shader with Camera Distance Projection
  const DISPLAY_FRAG = `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uState;
    uniform sampler2D uVelocity;
    uniform vec2 uSimTexel;
    uniform float uTime;
    uniform float uAspect;
    uniform float uFireHalfW;
    uniform float uBaseY;
    uniform float uCameraDist;
    uniform float uAnchorY;
    uniform vec3 uBaseColor;
    uniform float uIsNatural;
    uniform float uBrightness;
    uniform float uEmberHeat;
    uniform float uIntensity;
    ${NOISE_GLSL}
    ${RENDER_HELPERS_GLSL}

    // 4-tap Catmull-Rom smooth bicubic sampler (silky even at 0.25m close-up!)
    vec4 sampleBicubic(sampler2D tex, vec2 uv, vec2 texel) {
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
        return vec4(0.0);
      }
      vec2 pos = uv / texel - 0.5;
      vec2 f = fract(pos);
      vec2 i = floor(pos);

      vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
      vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
      vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
      vec2 w3 = f * f * (-0.5 + 0.5 * f);

      vec2 s0 = w0 + w1;
      vec2 s1 = w2 + w3;
      vec2 o0 = (i - 0.5 + w1 / s0) * texel;
      vec2 o1 = (i + 1.5 + w3 / s1) * texel;

      vec4 t00 = texture2D(tex, clamp(vec2(o0.x, o0.y), vec2(0.0), vec2(1.0)));
      vec4 t10 = texture2D(tex, clamp(vec2(o1.x, o0.y), vec2(0.0), vec2(1.0)));
      vec4 t01 = texture2D(tex, clamp(vec2(o0.x, o1.y), vec2(0.0), vec2(1.0)));
      vec4 t11 = texture2D(tex, clamp(vec2(o1.x, o1.y), vec2(0.0), vec2(1.0)));

      // Smooth fade at simulation domain borders so distant camera never sees a hard box edge
      float edge = smoothstep(0.0, 0.03, uv.x) * smoothstep(1.0, 0.97, uv.x)
                 * smoothstep(0.0, 0.02, uv.y) * smoothstep(1.0, 0.95, uv.y);

      return max(vec4(0.0),
        ((t00 * s0.x + t10 * s1.x) * s0.y +
         (t01 * s0.x + t11 * s1.x) * s1.y) * edge
      );
    }

    void main() {
      // Camera projection: map screen UV -> local campfire simulation UV
      vec2 simUv = vec2(
        (vUv.x - 0.5) * uCameraDist + 0.5,
        (vUv.y - uAnchorY) * uCameraDist + uBaseY
      );

      vec4 coarseSt = sampleBicubic(uState, simUv, uSimTexel);
      vec2 vel = (simUv.x >= 0.0 && simUv.x <= 1.0 && simUv.y >= 0.0 && simUv.y <= 1.0)
               ? texture2D(uVelocity, simUv).xy
               : vec2(0.0);

      // High-frequency advected micro-shimmer keeps close-ups razor-sharp and lively
      float heatMask = smoothstep(0.05, 0.45, coarseSt.r + coarseSt.g * 0.4);
      vec2 shimmerUv = vec2(simUv.x * uAspect * 6.5, simUv.y * 6.5 - uTime * 5.0);
      vec2 microOffset = vec2(
        fbm(shimmerUv) - 0.5,
        fbm(shimmerUv + vec2(13.7, 5.3)) - 0.5
      ) * 0.0080 * heatMask;

      vec4 st = sampleBicubic(uState, simUv + microOffset, uSimTexel);
      float temp = st.r;
      float fuel = st.g;
      float smoke = st.b;

      // Crisp micro-flicker tongues along outer edges
      float detail = fbm(vec2(simUv.x * uAspect * 10.0, simUv.y * 9.5 - uTime * 6.2) - vel * 0.0014);
      float edgeSculpt = (detail - 0.49) * 0.24 * smoothstep(0.05, 0.50, temp);
      float effectiveTemp = max(0.0, temp + edgeSculpt);
      effectiveTemp += fuel * 0.15 * smoothstep(0.18, 0.65, temp);

      // Ambient night firelight radiating seamlessly across the full viewport (attenuates gently with distance)
      float fireCenterY = uAnchorY + (0.14 * (0.4 + 0.6 * min(uIntensity, 1.3))) / uCameraDist;
      vec2 glowDelta = vec2((vUv.x - 0.5) * uAspect, (vUv.y - fireCenterY) * 0.88) * pow(uCameraDist, 0.55);
      float glowDist = length(glowDelta);
      float ambientGlow = exp(-glowDist * 3.0) * (0.08 + 0.13 * min(uIntensity, 1.4)) * (0.30 + 0.70 * uEmberHeat);
      vec3 glowCol = fireColor(0.42, uBaseColor, uIsNatural) * ambientGlow;

      // Light wispy smoke catching warm underlight
      float smokeVis = smoothstep(0.08, 0.85, smoke) * (1.0 - smoothstep(0.20, 0.58, effectiveTemp));
      vec3 smokeCol = fireColor(0.24, uBaseColor, uIsNatural) * smokeVis * 0.06 * exp(-glowDist * 1.6);

      // Warm ground reflection beneath the firewood logs
      vec2 floorDelta = vec2((simUv.x - 0.5) / (uFireHalfW * 1.45), (simUv.y - (uBaseY - 0.032)) / 0.068);
      float floorGlow = exp(-dot(floorDelta, floorDelta) * 1.50) * 0.24 * uEmberHeat;
      vec3 floorCol = fireColor(0.35, uBaseColor, uIsNatural) * floorGlow;

      // Sculpted firewood logs & glowing coal embers
      vec3 logInfo = evalCampfireLogs(simUv, uFireHalfW, uBaseY, uAspect, uTime, uEmberHeat);
      float logAlpha = logInfo.x;
      float emberTemp = logInfo.y;
      float logShade = logInfo.z;

      // Crisp luminous campfire flame emission
      vec3 flameCol = fireColor(effectiveTemp, uBaseColor, uIsNatural);
      float flameOpacity = smoothstep(0.11, 0.42, effectiveTemp);

      vec3 col = glowCol + smokeCol + floorCol;

      vec3 charcoalCol = vec3(0.014, 0.010, 0.008) * logShade
                       + fireColor(0.32, uBaseColor, uIsNatural) * 0.035 * logShade * uEmberHeat;
      vec3 emberCol = fireColor(emberTemp * 0.94, uBaseColor, uIsNatural) * 0.76;

      col = mix(col, charcoalCol, logAlpha * (1.0 - flameOpacity * 0.88));
      col += emberCol;
      col += flameCol;

      col = exposeAndToneMap(col, uBrightness);

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  // Fallback Procedural Volumetric Fire Shader (supports camera distance & 1/f flicker too!)
  const FALLBACK_FIRE_FRAG = `
    precision highp float;
    varying vec2 vUv;
    uniform float uTime;
    uniform float uAspect;
    uniform float uFireHalfW;
    uniform float uBaseY;
    uniform float uCameraDist;
    uniform float uAnchorY;
    uniform vec3 uBaseColor;
    uniform float uIsNatural;
    uniform float uBrightness;
    uniform float uEmberHeat;
    uniform float uIntensity;
    uniform float uBreeze;
    uniform vec2 uTouchPos;
    uniform vec2 uTouchVel;
    uniform float uTouchActive;
    ${NOISE_GLSL}
    ${RENDER_HELPERS_GLSL}

    void main() {
      vec2 simUv = vec2(
        (vUv.x - 0.5) * uCameraDist + 0.5,
        (vUv.y - uAnchorY) * uCameraDist + uBaseY
      );

      float nx = (simUv.x - 0.5) / uFireHalfW;
      float ny = max(0.0, simUv.y - uBaseY);

      float sway = (uBreeze * 0.22 + sin(uTime * 2.4 + 1.2) * 0.04) * ny * 2.2;
      if (uTouchActive > 0.5) {
        vec2 td = simUv - uTouchPos;
        td.x *= uAspect;
        sway += clamp(uTouchVel.x * 0.0012, -0.35, 0.35) * exp(-dot(td, td) * 28.0);
      }

      vec2 q = vec2(nx - sway, ny);
      float fireH = mix(0.16, 0.72, clamp(uIntensity, 0.0, 1.4) / 1.4);

      float t = uTime * mix(2.2, 3.8, min(uIntensity, 1.3));
      vec2 w1 = vec2(
        fbm(vec2(q.x * 3.0, q.y * 4.2 - t * 1.15)),
        fbm(vec2(q.x * 3.0 + 5.2, q.y * 4.2 - t * 1.35))
      ) - 0.5;

      vec2 warped = q + w1 * vec2(0.58, 0.30) * smoothstep(0.0, 0.28, ny);
      float nFine = fbm(vec2(warped.x * 5.8, warped.y * 7.2 - t * 1.95));

      float widthAtY = mix(0.86, 0.14, clamp(ny / max(fireH, 0.08), 0.0, 1.0));
      float radial = abs(warped.x) / max(widthAtY, 0.09);
      float heightDecay = 1.0 - smoothstep(0.0, fireH * (0.78 + 0.50 * nFine), ny);

      float temp = heightDecay * exp(-radial * radial * 1.65) * (0.72 + 0.92 * nFine) * (0.48 + 0.92 * min(uIntensity, 1.4));
      temp *= smoothstep(uBaseY - 0.02, uBaseY + 0.035, simUv.y);
      temp = max(0.0, temp - 0.12);

      float fireCenterY = uAnchorY + (0.14 * min(uIntensity, 1.3)) / uCameraDist;
      vec2 glowDelta = vec2((vUv.x - 0.5) * uAspect, (vUv.y - fireCenterY) * 0.88) * pow(uCameraDist, 0.55);
      float glowDist = length(glowDelta);
      vec3 glowCol = fireColor(0.42, uBaseColor, uIsNatural) * exp(-glowDist * 3.0) * (0.08 + 0.13 * min(uIntensity, 1.4)) * uEmberHeat;

      vec3 logInfo = evalCampfireLogs(simUv, uFireHalfW, uBaseY, uAspect, uTime, uEmberHeat);
      vec3 flameCol = fireColor(temp, uBaseColor, uIsNatural);
      float flameOpacity = smoothstep(0.11, 0.42, temp);

      vec3 col = glowCol;
      vec3 charcoalCol = vec3(0.014, 0.010, 0.008) * logInfo.z
                       + fireColor(0.32, uBaseColor, uIsNatural) * 0.035 * logInfo.z * uEmberHeat;
      col = mix(col, charcoalCol, logInfo.x * (1.0 - flameOpacity * 0.88));
      col += fireColor(logInfo.y * 0.94, uBaseColor, uIsNatural) * 0.76;
      col += flameCol;

      col = exposeAndToneMap(col, uBrightness);

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  // 12. Additive Glowing Sparks / Embers Particle Shaders (with camera distance projection!)
  const SPARK_VERT = `
    attribute vec2 aPos;
    attribute float aSize;
    attribute float aHeat;
    attribute float aAlpha;
    varying float vHeat;
    varying float vAlpha;
    uniform float uDpr;
    uniform float uCameraDist;
    uniform float uAnchorY;
    uniform float uBaseY;

    void main() {
      vHeat = aHeat;
      vAlpha = aAlpha;
      vec2 screenPos = vec2(
        (aPos.x - 0.5) / uCameraDist + 0.5,
        (aPos.y - uBaseY) / uCameraDist + uAnchorY
      );
      gl_Position = vec4(screenPos * 2.0 - 1.0, 0.0, 1.0);
      gl_PointSize = max(1.5, (aSize / pow(uCameraDist, 0.65)) * uDpr);
    }
  `;

  const SPARK_FRAG = `
    precision highp float;
    varying float vHeat;
    varying float vAlpha;
    uniform vec3 uBaseColor;
    uniform float uIsNatural;
    uniform float uBrightness;

    void main() {
      vec2 d = gl_PointCoord - 0.5;
      float r2 = dot(d, d);
      if (r2 > 0.25) discard;

      float core = exp(-r2 * 24.0);
      float halo = exp(-r2 * 7.0) * 0.52;
      float shape = core + halo;

      vec3 natCol = mix(vec3(1.0, 0.28, 0.02), vec3(1.0, 0.92, 0.55), clamp(vHeat, 0.0, 1.0));
      vec3 b = max(uBaseColor, vec3(0.05));
      b /= max(b.r, max(b.g, b.b));
      vec3 cusCol = mix(b, vec3(1.0, 0.96, 0.88), clamp(vHeat * 0.78, 0.0, 1.0));
      vec3 col = mix(cusCol, natCol, uIsNatural);

      float bClamped = clamp(uBrightness, 0.0, 1.5);
      float lumScale = pow(min(bClamped, 1.0), 0.72) * (bClamped > 1.0 ? (1.0 + (bClamped - 1.0) * 0.4) : 1.0);
      float a = shape * vAlpha * lumScale;
      gl_FragColor = vec4(col * a * 1.65, a);
    }
  `;

  function hexToRgb(hex) {
    const clean = (hex || '#ff6a14').replace('#', '');
    const num = parseInt(clean.length === 3
      ? clean.split('').map(c => c + c).join('')
      : clean, 16);
    if (Number.isNaN(num)) return [1.0, 0.415, 0.078];
    return [
      ((num >> 16) & 255) / 255,
      ((num >> 8) & 255) / 255,
      (num & 255) / 255,
    ];
  }

  class FireSimulation {
    constructor(canvas) {
      this.canvas = canvas;
      this.gl = null;
      this.isWebGL2 = false;
      this.useFluidSim = false;
      this.contextLost = false;

      // User parameters (defaults calibrated to a cozy human-scale campfire!)
      this.baseColor = [1.0, 0.415, 0.078]; // #ff6a14
      this.isNaturalColor = 1.0;
      this.intensity = 0.55;         // 0.01 .. 1.50
      this.timeScale = 1.0;          // 0.05 .. 8.00 (1.0 = snappy human campfire)
      this.targetCameraDist = 1.25;  // 0.25 .. 4.00 (meters-like zoom factor)
      this.cameraDist = 1.25;
      this.minBrightness = 0.35;     // 0.00 .. 1.50
      this.maxBrightness = 0.95;     // 0.01 .. 1.50
      this.fadeIntensityMul = 1.0;
      this.fadeEmberMul = 1.0;
      this.fadeBrightnessMul = 1.0;

      // Internal state
      this.time = 10.0 + Math.random() * 40.0;
      this.width = 1;
      this.height = 1;
      this.dpr = 1;
      this.aspect = 1;
      this.simW = 148;
      this.simH = 296;
      this.fireHalfW = 0.32;
      this.baseY = 0.075;
      this.anchorY = 0.14;
      this.currentBrightness = 0.72;

      // Live 1/f pink noise generators (all advance proportionally to timeScale!)
      this.brightnessPink = new PinkNoise1D(0.32, 7);
      this.breezePink = new PinkNoise1D(0.24, 6);
      this.jetPinks = [
        new PinkNoise1D(0.42, 7),
        new PinkNoise1D(0.46, 7),
        new PinkNoise1D(0.40, 7),
        new PinkNoise1D(0.45, 7),
        new PinkNoise1D(0.43, 7),
      ];
      this.jetVals = [0.5, 0.5, 0.5, 0.5, 0.5];
      this.breezeVal = 0.0;

      // Touch interaction state
      this.touchActive = false;
      this.touchPos = [0.5, 0.25];
      this.touchVel = [0.0, 0.0];

      // Spark particle pool
      this.sparkCount = 160;
      this.sparks = [];
      this.sparkData = new Float32Array(this.sparkCount * 5);

      this._initSparks();
      this._initWebGL();
      this._bindContextEvents();
    }

    _bindContextEvents() {
      this.canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        this.contextLost = true;
      }, false);

      this.canvas.addEventListener('webglcontextrestored', () => {
        this.contextLost = false;
        this._initWebGL();
        this.resize();
      }, false);
    }

    _initWebGL() {
      const attrs = {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        powerPreference: 'high-performance',
        preserveDrawingBuffer: false,
      };

      let gl = this.canvas.getContext('webgl2', attrs);
      this.isWebGL2 = Boolean(gl);
      if (!gl) {
        gl = this.canvas.getContext('webgl', attrs) || this.canvas.getContext('experimental-webgl', attrs);
      }
      if (!gl) {
        console.error('WebGL is not supported in this browser.');
        return;
      }
      this.gl = gl;

      this.texFormat = this._detectFloatFormat(gl);
      this.useFluidSim = Boolean(this.texFormat);

      this.quadVbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

      this.sparkVbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.sparkVbo);
      gl.bufferData(gl.ARRAY_BUFFER, this.sparkData.byteLength, gl.DYNAMIC_DRAW);

      if (this.useFluidSim) {
        this.programs = {
          emitState: this._createProgram(FULLSCREEN_VERT, EMIT_STATE_FRAG),
          buoyancy: this._createProgram(FULLSCREEN_VERT, BUOYANCY_FRAG),
          curl: this._createProgram(FULLSCREEN_VERT, CURL_FRAG),
          vorticity: this._createProgram(FULLSCREEN_VERT, VORTICITY_FRAG),
          divergence: this._createProgram(FULLSCREEN_VERT, DIVERGENCE_FRAG),
          clearScale: this._createProgram(FULLSCREEN_VERT, CLEAR_SCALE_FRAG),
          pressure: this._createProgram(FULLSCREEN_VERT, PRESSURE_FRAG),
          gradSub: this._createProgram(FULLSCREEN_VERT, GRAD_SUB_FRAG),
          advect: this._createProgram(FULLSCREEN_VERT, ADVECT_FRAG),
          maccormack: this._createProgram(FULLSCREEN_VERT, MACCORMACK_FRAG),
          combustion: this._createProgram(FULLSCREEN_VERT, COMBUSTION_FRAG),
          display: this._createProgram(FULLSCREEN_VERT, DISPLAY_FRAG),
          sparks: this._createProgram(SPARK_VERT, SPARK_FRAG),
        };
      } else {
        this.programs = {
          fallback: this._createProgram(FULLSCREEN_VERT, FALLBACK_FIRE_FRAG),
          sparks: this._createProgram(SPARK_VERT, SPARK_FRAG),
        };
      }

      this.resize();
    }

    _detectFloatFormat(gl) {
      const candidates = [];
      if (this.isWebGL2) {
        const extFloat = gl.getExtension('EXT_color_buffer_float');
        const extHalf = gl.getExtension('EXT_color_buffer_half_float');
        gl.getExtension('OES_texture_float_linear');
        if (extFloat || extHalf) {
          candidates.push({
            internalFormat: gl.RGBA16F,
            format: gl.RGBA,
            type: gl.HALF_FLOAT,
            filter: gl.LINEAR,
          });
        }
        if (extFloat) {
          candidates.push({
            internalFormat: gl.RGBA32F,
            format: gl.RGBA,
            type: gl.FLOAT,
            filter: gl.LINEAR,
          });
        }
      } else {
        const extHalf = gl.getExtension('OES_texture_half_float');
        const extHalfLin = gl.getExtension('OES_texture_half_float_linear');
        if (extHalf) {
          candidates.push({
            internalFormat: gl.RGBA,
            format: gl.RGBA,
            type: extHalf.HALF_FLOAT_OES,
            filter: extHalfLin ? gl.LINEAR : gl.NEAREST,
          });
        }
      }

      for (const cfg of candidates) {
        if (this._testRenderTarget(gl, cfg)) {
          return cfg;
        }
      }
      return null;
    }

    _testRenderTarget(gl, cfg) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, cfg.filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, cfg.filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, cfg.internalFormat, 4, 4, 0, cfg.format, cfg.type, null);

      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(tex);
      return status === gl.FRAMEBUFFER_COMPLETE;
    }

    _compileShader(type, source) {
      const gl = this.gl;
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error('Shader compile error:', gl.getShaderInfoLog(shader));
      }
      return shader;
    }

    _createProgram(vsSrc, fsSrc) {
      const gl = this.gl;
      const vs = this._compileShader(gl.VERTEX_SHADER, vsSrc);
      const fs = this._compileShader(gl.FRAGMENT_SHADER, fsSrc);
      const program = gl.createProgram();
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error('Program link error:', gl.getProgramInfoLog(program));
      }
      gl.deleteShader(vs);
      gl.deleteShader(fs);

      const uniforms = {};
      const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < count; i++) {
        const info = gl.getActiveUniform(program, i);
        if (info) uniforms[info.name] = gl.getUniformLocation(program, info.name);
      }
      const attribs = {};
      const aCount = gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES);
      for (let i = 0; i < aCount; i++) {
        const info = gl.getActiveAttrib(program, i);
        if (info) attribs[info.name] = gl.getAttribLocation(program, info.name);
      }
      return { program, uniforms, attribs };
    }

    _createFBO(w, h) {
      const gl = this.gl;
      const cfg = this.texFormat;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, cfg.filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, cfg.filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, cfg.internalFormat, w, h, 0, cfg.format, cfg.type, null);

      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.viewport(0, 0, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      return { tex, fbo, width: w, height: h };
    }

    _createDoubleFBO(w, h) {
      let a = this._createFBO(w, h);
      let b = this._createFBO(w, h);
      return {
        get read() { return a; },
        get write() { return b; },
        swap() { const tmp = a; a = b; b = tmp; },
        destroy(gl) {
          gl.deleteFramebuffer(a.fbo);
          gl.deleteTexture(a.tex);
          gl.deleteFramebuffer(b.fbo);
          gl.deleteTexture(b.tex);
        },
      };
    }

    _destroyFBOs() {
      const gl = this.gl;
      if (!gl || !this.fbos) return;
      this.fbos.velocity.destroy(gl);
      this.fbos.state.destroy(gl);
      this.fbos.pressure.destroy(gl);
      for (const single of [this.fbos.curl, this.fbos.divergence, this.fbos.phiHat]) {
        gl.deleteFramebuffer(single.fbo);
        gl.deleteTexture(single.tex);
      }
      this.fbos = null;
    }

    _initFBOs() {
      this._destroyFBOs();
      if (!this.useFluidSim || !this.gl) return;
      const w = this.simW;
      const h = this.simH;
      this.fbos = {
        velocity: this._createDoubleFBO(w, h),
        state: this._createDoubleFBO(w, h),
        pressure: this._createDoubleFBO(w, h),
        curl: this._createFBO(w, h),
        divergence: this._createFBO(w, h),
        phiHat: this._createFBO(w, h),
      };
      this._warmupFluid();
    }

    _stepPinkNoises(simDt) {
      for (let i = 0; i < 5; i++) {
        this.jetVals[i] = this.jetPinks[i].step(simDt);
      }
      this.breezeVal = (this.breezePink.step(simDt) - 0.5) * 2.0;
      this.brightnessPink.step(simDt);
    }

    _warmupFluid() {
      if (!this.useFluidSim || !this.fbos) return;
      const gl = this.gl;
      gl.disable(gl.BLEND);
      const effInt = this.intensity * this.fadeIntensityMul;
      const stepDt = 0.022;
      for (let i = 0; i < 110; i++) {
        this.time += stepDt;
        this._stepPinkNoises(stepDt);
        this._stepFluid(stepDt, effInt, 12);
      }
    }

    _computeAnchorY(dist) {
      // Smooth framing: close-up fills from very bottom, distant hearth sits calmly in lower-middle night
      const t = Math.max(0.0, Math.min(1.0, (dist - 0.30) / 3.40));
      return 0.045 + 0.245 * Math.pow(t, 0.72);
    }

    resize() {
      if (!this.gl) return;
      const rect = this.canvas.getBoundingClientRect();
      const cssW = Math.max(1, rect.width || window.innerWidth);
      const cssH = Math.max(1, rect.height || window.innerHeight);

      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.width = Math.round(cssW * this.dpr);
      this.height = Math.round(cssH * this.dpr);
      this.aspect = cssW / cssH;

      this.canvas.width = this.width;
      this.canvas.height = this.height;

      // Human-scale campfire width in simulation domain
      this.fireHalfW = Math.min(0.35, 0.30 / Math.max(this.aspect, 0.45));
      this.baseY = 0.085;
      this.anchorY = this._computeAnchorY(this.cameraDist);

      let nextW, nextH;
      if (this.aspect < 1) {
        nextH = 304;
        nextW = Math.max(112, Math.round(nextH * this.aspect));
      } else {
        nextW = 312;
        nextH = Math.max(128, Math.round(nextW / this.aspect));
      }

      if (!this.fbos || Math.abs(nextW - this.simW) > 6 || Math.abs(nextH - this.simH) > 6) {
        this.simW = nextW;
        this.simH = nextH;
        this._initFBOs();
      }
    }

    // --- Public Configuration API ---

    setColor(hex) {
      this.baseColor = hexToRgb(hex);
      const dr = this.baseColor[0] - 1.0;
      const dg = this.baseColor[1] - 0.415;
      const db = this.baseColor[2] - 0.078;
      const dist = Math.sqrt(dr * dr + dg * dg + db * db);
      this.isNaturalColor = Math.max(0.0, 1.0 - dist * 5.0);
    }

    setIntensity(value) {
      this.intensity = Math.max(0.01, Math.min(1.5, value));
    }

    setTimeScale(scale) {
      this.timeScale = Math.max(0.05, Math.min(8.0, scale));
    }

    setCameraDistance(dist) {
      this.targetCameraDist = Math.max(0.25, Math.min(4.0, dist));
    }

    setBrightnessRange(minVal, maxVal) {
      this.minBrightness = Math.max(0.0, Math.min(1.5, minVal));
      this.maxBrightness = Math.max(this.minBrightness, Math.min(1.5, maxVal));
    }

    setFadeProgress(progress01) {
      const p = Math.max(0.0, Math.min(1.0, progress01));
      const remain = 1.0 - p;
      this.fadeIntensityMul = Math.pow(remain, 0.92);
      this.fadeEmberMul = Math.pow(remain, 0.45);
      this.fadeBrightnessMul = remain <= 0.0001 ? 0.0 : Math.pow(remain, 1.15);
    }

    // Convert viewport normalized coords (0..1, bottom-up) into campfire simulation coords
    screenToSimUv(screenX, screenY) {
      return [
        (screenX - 0.5) * this.cameraDist + 0.5,
        (screenY - this.anchorY) * this.cameraDist + this.baseY,
      ];
    }

    setTouch(active, screenX, screenY, velScreenX, velScreenY) {
      this.touchActive = active;
      if (active) {
        const [sx, sy] = this.screenToSimUv(screenX, screenY);
        this.touchPos[0] = sx;
        this.touchPos[1] = sy;
        this.touchVel[0] = velScreenX * this.cameraDist;
        this.touchVel[1] = velScreenY * this.cameraDist;
      } else {
        this.touchVel[0] *= 0.5;
        this.touchVel[1] *= 0.5;
      }
    }

    // --- Sparks / Embers Particle Physics ---

    _initSparks() {
      this.sparks = [];
      for (let i = 0; i < this.sparkCount; i++) {
        const s = this._spawnSpark(true);
        s.y += s.life * 0.45;
        this.sparks.push(s);
      }
    }

    _spawnSpark(randomLife) {
      const spread = (Math.random() - 0.5) * 1.45 * this.fireHalfW;
      const effInt = Math.min(1.5, this.intensity * this.fadeIntensityMul);
      return {
        x: 0.5 + spread * (0.30 + 0.70 * Math.random()),
        y: this.baseY + Math.random() * 0.06,
        vx: (Math.random() - 0.5) * 0.10,
        vy: (0.20 + Math.random() * 0.30) * (0.42 + 0.75 * effInt),
        life: randomLife ? Math.random() : 0.0,
        maxLife: 1.0 + Math.random() * 2.0,
        size: 1.8 + Math.random() * 2.9,
        phase: Math.random() * Math.PI * 2,
        wobble: 2.4 + Math.random() * 4.6,
      };
    }

    _updateSparks(simDt, effInt) {
      const normInt = Math.min(1.0, effInt / 1.1);
      const activeTarget = Math.floor(this.sparkCount * (0.14 + 0.86 * normInt));
      const breeze = this.breezeVal * 0.11;

      for (let i = 0; i < this.sparkCount; i++) {
        const s = this.sparks[i];
        s.life += simDt / s.maxLife;

        if (s.life >= 1.0 || s.y > 1.8 || s.x < -0.6 || s.x > 1.6) {
          if (i < activeTarget && effInt > 0.02 && Math.random() < 0.32 + 0.68 * normInt) {
            this.sparks[i] = this._spawnSpark(false);
          } else {
            s.life = 1.0;
          }
        } else {
          const turbX = Math.sin(this.time * s.wobble + s.phase + s.y * 14.0) * 0.12;
          s.vx += (breeze + turbX - s.vx * 1.7) * simDt;
          s.vy += ((0.20 + 0.24 * Math.min(effInt, 1.3)) - s.vy * 0.9) * simDt;

          if (this.touchActive) {
            const dx = (s.x - this.touchPos[0]) * this.aspect;
            const dy = s.y - this.touchPos[1];
            const w = Math.exp(-(dx * dx + dy * dy) * 55.0);
            s.vx += this.touchVel[0] * 0.0007 * w;
            s.vy += this.touchVel[1] * 0.0007 * w;
          }

          s.x += s.vx * simDt;
          s.y += s.vy * simDt;
        }

        const alive = s.life < 1.0 && i < activeTarget;
        const fadeIn = Math.min(1.0, s.life * 7.0);
        const fadeOut = Math.max(0.0, 1.0 - s.life);
        const flicker = 0.62 + 0.38 * Math.sin(this.time * 22.0 + s.phase * 5.0);
        const alpha = alive ? fadeIn * Math.pow(fadeOut, 1.2) * flicker * (0.45 + 0.55 * normInt) : 0.0;
        const heat = Math.max(0.0, 1.0 - s.life * 1.15);

        const off = i * 5;
        this.sparkData[off] = s.x;
        this.sparkData[off + 1] = s.y;
        this.sparkData[off + 2] = s.size * (0.65 + 0.5 * fadeOut);
        this.sparkData[off + 3] = heat;
        this.sparkData[off + 4] = alpha;
      }
    }

    // --- 1/f Pink-Noise Brightness Envelope bounded by [minBrightness, maxBrightness] ---

    _computeBrightnessEnvelope(effInt) {
      // Stretch 1/f pink noise smoothly across [0, 1] so natural campfire breathing uses the full range
      const p = this.brightnessPink.value;
      const expanded = Math.max(0.0, Math.min(1.0, (p - 0.24) / 0.52));
      const smooth = expanded * expanded * (3.0 - 2.0 * expanded);
      const organic = Math.max(0.0, Math.min(1.0, smooth * 0.92 + 0.08 * Math.min(effInt, 1.0)));
      const ranged = this.minBrightness + (this.maxBrightness - this.minBrightness) * organic;
      return ranged * this.fadeBrightnessMul;
    }

    // --- GPU Draw Helpers ---

    _bindQuad(prog) {
      const gl = this.gl;
      gl.useProgram(prog.program);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
      const loc = prog.attribs.aPos;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    }

    _bindTex(unit, tex, uniformLoc) {
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(uniformLoc, unit);
    }

    _blit(targetFbo) {
      const gl = this.gl;
      if (targetFbo) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, targetFbo.fbo);
        gl.viewport(0, 0, targetFbo.width, targetFbo.height);
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, this.width, this.height);
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // --- Main Frame Step & Render ---

    stepAndRender(rawDt) {
      const gl = this.gl;
      if (!gl || this.contextLost) return;

      const realDt = Math.min(Math.max(rawDt, 0.001), 0.033);

      // Smooth cinematic camera dolly interpolation
      this.cameraDist += (this.targetCameraDist - this.cameraDist) * Math.min(1.0, realDt * 12.0);
      this.anchorY = this._computeAnchorY(this.cameraDist);

      // Base physical clock tuned 1.65x brisker for human-scale campfire dynamics, scaled by user timeScale
      const totalSimDt = realDt * 1.65 * this.timeScale;

      const effInt = this.intensity * this.fadeIntensityMul;
      const emberHeat = (0.30 + 0.70 * Math.min(this.intensity, 1.25)) * this.fadeEmberMul;

      // Advance 1/f pink noise & compute brightness
      this._stepPinkNoises(totalSimDt);
      const targetBright = this._computeBrightnessEnvelope(effInt);
      const brightLerp = Math.min(1.0, realDt * (10.0 + 12.0 * Math.min(this.timeScale, 3.0)));
      this.currentBrightness += (targetBright - this.currentBrightness) * brightLerp;

      if (this.fadeBrightnessMul <= 0.0001 && this.currentBrightness < 0.001) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, this.width, this.height);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        return;
      }

      gl.disable(gl.BLEND);

      if (this.useFluidSim && this.fbos) {
        // Adaptive substepping keeps PDE solver rock-solid from 0.05x slow-mo up to 8.0x speed!
        const maxSubDt = 0.028;
        const substeps = Math.min(6, Math.max(1, Math.ceil(totalSimDt / maxSubDt)));
        const subDt = Math.min(maxSubDt, totalSimDt / substeps);
        const jacobiIters = substeps >= 4 ? 8 : (substeps >= 2 ? 11 : 14);

        for (let s = 0; s < substeps; s++) {
          this.time += subDt;
          if (s > 0) this._stepPinkNoises(subDt);
          this._stepFluid(subDt, effInt, jacobiIters);
        }
        this._renderFluidDisplay(effInt, emberHeat);
      } else {
        this.time += totalSimDt;
        this._renderFallback(effInt, emberHeat);
      }

      this._updateSparks(totalSimDt, effInt);
      this._renderSparks();

      this.touchVel[0] *= 0.82;
      this.touchVel[1] *= 0.82;
    }

    _stepFluid(dt, effInt, jacobiIters) {
      const gl = this.gl;
      const p = this.programs;
      const f = this.fbos;
      const tx = 1.0 / this.simW;
      const ty = 1.0 / this.simH;

      const clampedInt = Math.min(effInt, 1.5);
      // Human-scale campfire balance: brisk lift, agile small eddies, crisp cooling
      const buoyancy = this.simH * (0.48 + 0.56 * clampedInt);
      const curlStrength = 22.0 + 24.0 * Math.min(clampedInt, 1.3);
      const cooling = Math.max(0.72, 2.18 - 0.86 * clampedInt);

      // 1. Emit fuel & heat into state (modulated by 5 live 1/f pink-noise streams!)
      this._bindQuad(p.emitState);
      this._bindTex(0, f.state.read.tex, p.emitState.uniforms.uState);
      gl.uniform1f(p.emitState.uniforms.uTime, this.time);
      gl.uniform1f(p.emitState.uniforms.uDt, dt);
      gl.uniform1f(p.emitState.uniforms.uIntensity, effInt);
      gl.uniform1f(p.emitState.uniforms.uFireHalfW, this.fireHalfW);
      gl.uniform1f(p.emitState.uniforms.uBaseY, this.baseY);
      gl.uniform4f(
        p.emitState.uniforms.uJetNoise,
        this.jetVals[0],
        this.jetVals[1],
        this.jetVals[3],
        this.jetVals[4]
      );
      gl.uniform1f(p.emitState.uniforms.uJetCenter, this.jetVals[2]);
      gl.uniform2f(p.emitState.uniforms.uTouchPos, this.touchPos[0], this.touchPos[1]);
      gl.uniform2f(p.emitState.uniforms.uTouchVel, this.touchVel[0], this.touchVel[1]);
      gl.uniform1f(p.emitState.uniforms.uTouchActive, this.touchActive ? 1.0 : 0.0);
      gl.uniform1f(p.emitState.uniforms.uAspect, this.aspect);
      this._blit(f.state.write);
      f.state.swap();

      // 2. Buoyancy, entrainment, 1/f breeze & touch momentum
      this._bindQuad(p.buoyancy);
      this._bindTex(0, f.velocity.read.tex, p.buoyancy.uniforms.uVelocity);
      this._bindTex(1, f.state.read.tex, p.buoyancy.uniforms.uState);
      gl.uniform1f(p.buoyancy.uniforms.uTime, this.time);
      gl.uniform1f(p.buoyancy.uniforms.uDt, dt);
      gl.uniform1f(p.buoyancy.uniforms.uBuoyancy, buoyancy);
      gl.uniform1f(p.buoyancy.uniforms.uIntensity, effInt);
      gl.uniform1f(p.buoyancy.uniforms.uFireHalfW, this.fireHalfW);
      gl.uniform1f(p.buoyancy.uniforms.uBaseY, this.baseY);
      gl.uniform1f(p.buoyancy.uniforms.uBreeze, this.breezeVal);
      gl.uniform2f(p.buoyancy.uniforms.uTouchPos, this.touchPos[0], this.touchPos[1]);
      gl.uniform2f(p.buoyancy.uniforms.uTouchVel, this.touchVel[0], this.touchVel[1]);
      gl.uniform1f(p.buoyancy.uniforms.uTouchActive, this.touchActive ? 1.0 : 0.0);
      gl.uniform1f(p.buoyancy.uniforms.uAspect, this.aspect);
      this._blit(f.velocity.write);
      f.velocity.swap();

      // 3. Curl
      this._bindQuad(p.curl);
      this._bindTex(0, f.velocity.read.tex, p.curl.uniforms.uVelocity);
      gl.uniform2f(p.curl.uniforms.uTexel, tx, ty);
      this._blit(f.curl);

      // 4. Vorticity confinement
      this._bindQuad(p.vorticity);
      this._bindTex(0, f.velocity.read.tex, p.vorticity.uniforms.uVelocity);
      this._bindTex(1, f.curl.tex, p.vorticity.uniforms.uCurl);
      this._bindTex(2, f.state.read.tex, p.vorticity.uniforms.uState);
      gl.uniform2f(p.vorticity.uniforms.uTexel, tx, ty);
      gl.uniform1f(p.vorticity.uniforms.uCurlStrength, curlStrength);
      gl.uniform1f(p.vorticity.uniforms.uDt, dt);
      this._blit(f.velocity.write);
      f.velocity.swap();

      // 5. Divergence
      this._bindQuad(p.divergence);
      this._bindTex(0, f.velocity.read.tex, p.divergence.uniforms.uVelocity);
      gl.uniform2f(p.divergence.uniforms.uTexel, tx, ty);
      this._blit(f.divergence);

      // 6. Warm-start pressure
      this._bindQuad(p.clearScale);
      this._bindTex(0, f.pressure.read.tex, p.clearScale.uniforms.uTex);
      gl.uniform1f(p.clearScale.uniforms.uScale, 0.80);
      this._blit(f.pressure.write);
      f.pressure.swap();

      // 7. Jacobi pressure solver
      this._bindQuad(p.pressure);
      this._bindTex(1, f.divergence.tex, p.pressure.uniforms.uDivergence);
      gl.uniform2f(p.pressure.uniforms.uTexel, tx, ty);
      for (let i = 0; i < jacobiIters; i++) {
        this._bindTex(0, f.pressure.read.tex, p.pressure.uniforms.uPressure);
        this._blit(f.pressure.write);
        f.pressure.swap();
      }

      // 8. Subtract pressure gradient
      this._bindQuad(p.gradSub);
      this._bindTex(0, f.pressure.read.tex, p.gradSub.uniforms.uPressure);
      this._bindTex(1, f.velocity.read.tex, p.gradSub.uniforms.uVelocity);
      gl.uniform2f(p.gradSub.uniforms.uTexel, tx, ty);
      this._blit(f.velocity.write);
      f.velocity.swap();

      // 9a. Advect velocity
      this._bindQuad(p.advect);
      this._bindTex(0, f.velocity.read.tex, p.advect.uniforms.uVelocity);
      this._bindTex(1, f.velocity.read.tex, p.advect.uniforms.uSource);
      gl.uniform2f(p.advect.uniforms.uTexel, tx, ty);
      gl.uniform1f(p.advect.uniforms.uDt, dt);
      gl.uniform1f(p.advect.uniforms.uDissipation, 0.990);
      this._blit(f.velocity.write);
      f.velocity.swap();

      // 9b. Advect state (Clamped MacCormack)
      this._bindQuad(p.advect);
      this._bindTex(0, f.velocity.read.tex, p.advect.uniforms.uVelocity);
      this._bindTex(1, f.state.read.tex, p.advect.uniforms.uSource);
      gl.uniform2f(p.advect.uniforms.uTexel, tx, ty);
      gl.uniform1f(p.advect.uniforms.uDt, dt);
      gl.uniform1f(p.advect.uniforms.uDissipation, 1.0);
      this._blit(f.phiHat);

      this._bindQuad(p.maccormack);
      this._bindTex(0, f.velocity.read.tex, p.maccormack.uniforms.uVelocity);
      this._bindTex(1, f.state.read.tex, p.maccormack.uniforms.uPhiN);
      this._bindTex(2, f.phiHat.tex, p.maccormack.uniforms.uPhiHat);
      gl.uniform2f(p.maccormack.uniforms.uTexel, tx, ty);
      gl.uniform1f(p.maccormack.uniforms.uDt, dt);
      this._blit(f.state.write);
      f.state.swap();

      // 10. Combustion & Short-Timescale Radiative Cooling
      this._bindQuad(p.combustion);
      this._bindTex(0, f.state.read.tex, p.combustion.uniforms.uState);
      gl.uniform1f(p.combustion.uniforms.uDt, dt);
      gl.uniform1f(p.combustion.uniforms.uCooling, cooling);
      this._blit(f.state.write);
      f.state.swap();
    }

    _renderFluidDisplay(effInt, emberHeat) {
      const gl = this.gl;
      const p = this.programs.display;
      const f = this.fbos;

      this._bindQuad(p);
      this._bindTex(0, f.state.read.tex, p.uniforms.uState);
      this._bindTex(1, f.velocity.read.tex, p.uniforms.uVelocity);
      gl.uniform2f(p.uniforms.uSimTexel, 1.0 / this.simW, 1.0 / this.simH);
      gl.uniform1f(p.uniforms.uTime, this.time);
      gl.uniform1f(p.uniforms.uAspect, this.aspect);
      gl.uniform1f(p.uniforms.uFireHalfW, this.fireHalfW);
      gl.uniform1f(p.uniforms.uBaseY, this.baseY);
      gl.uniform1f(p.uniforms.uCameraDist, this.cameraDist);
      gl.uniform1f(p.uniforms.uAnchorY, this.anchorY);
      gl.uniform3f(p.uniforms.uBaseColor, this.baseColor[0], this.baseColor[1], this.baseColor[2]);
      gl.uniform1f(p.uniforms.uIsNatural, this.isNaturalColor);
      gl.uniform1f(p.uniforms.uBrightness, this.currentBrightness);
      gl.uniform1f(p.uniforms.uEmberHeat, emberHeat);
      gl.uniform1f(p.uniforms.uIntensity, effInt);
      this._blit(null);
    }

    _renderFallback(effInt, emberHeat) {
      const gl = this.gl;
      const p = this.programs.fallback;

      this._bindQuad(p);
      gl.uniform1f(p.uniforms.uTime, this.time);
      gl.uniform1f(p.uniforms.uAspect, this.aspect);
      gl.uniform1f(p.uniforms.uFireHalfW, this.fireHalfW);
      gl.uniform1f(p.uniforms.uBaseY, this.baseY);
      gl.uniform1f(p.uniforms.uCameraDist, this.cameraDist);
      gl.uniform1f(p.uniforms.uAnchorY, this.anchorY);
      gl.uniform3f(p.uniforms.uBaseColor, this.baseColor[0], this.baseColor[1], this.baseColor[2]);
      gl.uniform1f(p.uniforms.uIsNatural, this.isNaturalColor);
      gl.uniform1f(p.uniforms.uBrightness, this.currentBrightness);
      gl.uniform1f(p.uniforms.uEmberHeat, emberHeat);
      gl.uniform1f(p.uniforms.uIntensity, effInt);
      gl.uniform1f(p.uniforms.uBreeze, this.breezeVal);
      gl.uniform2f(p.uniforms.uTouchPos, this.touchPos[0], this.touchPos[1]);
      gl.uniform2f(p.uniforms.uTouchVel, this.touchVel[0], this.touchVel[1]);
      gl.uniform1f(p.uniforms.uTouchActive, this.touchActive ? 1.0 : 0.0);
      this._blit(null);
    }

    _renderSparks() {
      const gl = this.gl;
      const p = this.programs.sparks;
      if (!p) return;

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.width, this.height);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);

      gl.useProgram(p.program);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.sparkVbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.sparkData);

      const stride = 5 * 4;
      gl.enableVertexAttribArray(p.attribs.aPos);
      gl.vertexAttribPointer(p.attribs.aPos, 2, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(p.attribs.aSize);
      gl.vertexAttribPointer(p.attribs.aSize, 1, gl.FLOAT, false, stride, 8);
      gl.enableVertexAttribArray(p.attribs.aHeat);
      gl.vertexAttribPointer(p.attribs.aHeat, 1, gl.FLOAT, false, stride, 12);
      gl.enableVertexAttribArray(p.attribs.aAlpha);
      gl.vertexAttribPointer(p.attribs.aAlpha, 1, gl.FLOAT, false, stride, 16);

      gl.uniform1f(p.uniforms.uDpr, this.dpr);
      gl.uniform1f(p.uniforms.uCameraDist, this.cameraDist);
      gl.uniform1f(p.uniforms.uAnchorY, this.anchorY);
      gl.uniform1f(p.uniforms.uBaseY, this.baseY);
      gl.uniform3f(p.uniforms.uBaseColor, this.baseColor[0], this.baseColor[1], this.baseColor[2]);
      gl.uniform1f(p.uniforms.uIsNatural, this.isNaturalColor);
      gl.uniform1f(p.uniforms.uBrightness, this.currentBrightness);

      gl.drawArrays(gl.POINTS, 0, this.sparkCount);
      gl.disableVertexAttribArray(p.attribs.aSize);
      gl.disableVertexAttribArray(p.attribs.aHeat);
      gl.disableVertexAttribArray(p.attribs.aAlpha);
      gl.disable(gl.BLEND);
    }
  }

  global.FireSimulation = FireSimulation;
})(window);
