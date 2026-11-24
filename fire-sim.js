/**
 * TheFire — Real-time GPU Eulerian Fluid & Combustion Bonfire Simulation
 *
 * Physics pipeline (WebGL2 / WebGL1 with float FBOs + verified procedural fallback):
 *   1. Pulsating multi-jet fuel & heat injection from crossed firewood crevices + touch impulse
 *   2. Thermal buoyancy, base air entrainment, & organic evening breeze
 *   3. Vorticity (curl) & Vorticity Confinement for sharp, curling flame tongues
 *   4. Divergence & warm-started Jacobi Pressure Projection (open-top boundary)
 *   5. Velocity advection + Clamped MacCormack advection for temperature/fuel/smoke
 *   6. Exothermic combustion & nonlinear radiative cooling (T^3) for crisp flame tips
 *   7. High-DPI bicubic volumetric rendering with exposure-correct filmic blackbody tone
 *      mapping, charred firewood logs, pulsing coal ember bed, and soaring luminous sparks
 */
(function (global) {
  'use strict';

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

  // 1. Multi-jet campfire fuel & heat emission + touch impulse
  const EMIT_STATE_FRAG = `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D uState;
    uniform float uTime;
    uniform float uDt;
    uniform float uIntensity;
    uniform float uFireHalfW;
    uniform float uBaseY;
    uniform vec2 uTouchPos;
    uniform vec2 uTouchVel;
    uniform float uTouchActive;
    uniform float uAspect;
    ${NOISE_GLSL}

    void main() {
      vec4 st = texture2D(uState, vUv);

      float nx = (vUv.x - 0.5) / uFireHalfW;
      float ax = abs(nx);

      if (uIntensity > 0.004 && ax < 1.15 && vUv.y < uBaseY + 0.20) {
        float widthScale = mix(0.55, 0.96, clamp(uIntensity, 0.0, 1.0));
        float sx = nx / widthScale;

        // Campfire log mound silhouette: taller in center, tapering gracefully at sides
        float moundTop = uBaseY + 0.052 * exp(-sx * sx * 1.6) * mix(0.65, 1.15, uIntensity);
        float moundBot = uBaseY - 0.018;

        float vertMask = smoothstep(moundBot - 0.015, moundBot + 0.022, vUv.y)
                       * smoothstep(moundTop + 0.032, moundTop - 0.012, vUv.y);

        // Five distinct dancing pyrolysis gas jets emerging from gaps between stacked logs
        float s1 = sx + 0.62 + 0.07 * sin(uTime * 2.7 + 0.4);
        float s2 = sx + 0.28 + 0.08 * sin(uTime * 3.3 + 1.9);
        float s3 = sx + 0.00 + 0.07 * sin(uTime * 2.1 + 3.5);
        float s4 = sx - 0.29 + 0.08 * sin(uTime * 3.1 + 5.1);
        float s5 = sx - 0.60 + 0.07 * sin(uTime * 2.5 + 2.2);

        float j1 = exp(-s1 * s1 * 18.0) * (0.40 + 0.60 * vnoise(vec2(uTime * 2.8, 1.3)));
        float j2 = exp(-s2 * s2 * 14.0) * (0.55 + 0.45 * vnoise(vec2(uTime * 3.4, 4.7)));
        float j3 = exp(-s3 * s3 * 12.0) * (0.65 + 0.35 * vnoise(vec2(uTime * 2.6, 8.1)));
        float j4 = exp(-s4 * s4 * 14.0) * (0.55 + 0.45 * vnoise(vec2(uTime * 3.2, 11.4)));
        float j5 = exp(-s5 * s5 * 18.0) * (0.38 + 0.62 * vnoise(vec2(uTime * 2.9, 15.2)));

        float baseHearth = exp(-sx * sx * 2.8) * 0.34;
        float jets = baseHearth + j1 * 0.72 + j2 * 1.05 + j3 * 1.20 + j4 * 1.02 + j5 * 0.70;

        // Turbulent gas pockets rising from wood
        float n1 = fbm(vec2(sx * 4.5, vUv.y * 14.0 - uTime * 3.2));
        float n2 = vnoise(vec2(sx * 9.5 + uTime * 1.2, vUv.y * 20.0 - uTime * 5.2));
        float turb = clamp((n1 * 0.65 + n2 * 0.55) * 1.45, 0.12, 1.55);

        float emit = vertMask * jets * turb * smoothstep(1.12, 0.78, abs(sx));
        float power = pow(uIntensity, 0.82);

        float fuelAdd = emit * power * 5.6 * uDt;
        float tempAdd = emit * mix(0.45, 1.22, power) * 4.8 * uDt;

        st.r = min(1.85, st.r + tempAdd);
        st.g = min(1.55, st.g + fuelAdd);
      }

      // Gentle burst of heat when user stirs the fire
      if (uTouchActive > 0.5 && uIntensity > 0.05) {
        vec2 diff = vUv - uTouchPos;
        diff.x *= uAspect;
        float d2 = dot(diff, diff);
        float splash = exp(-d2 * 180.0);
        float speed = clamp(length(uTouchVel) * 0.012, 0.0, 1.0);
        st.r = min(1.8, st.r + splash * speed * 0.32 * uIntensity);
        st.g = min(1.5, st.g + splash * speed * 0.24 * uIntensity);
      }

      gl_FragColor = st;
    }
  `;

  // 2. Buoyancy, inward flame pinching (entrainment), breeze, and touch momentum
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

      // Strong thermal buoyancy pulls hot flames upward into slender leaping tongues
      float lift = (temp * 1.18 + fuel * 0.62 - smoke * 0.08) * uBuoyancy;
      vel.y += lift * uDt;

      // Gentle campfire air entrainment: shapes a natural multi-tongued pyramid without over-pinching into a single needle
      float nx = (vUv.x - 0.5) / uFireHalfW;
      float pinchZone = smoothstep(0.55, 0.04, vUv.y) * smoothstep(2.0, 0.30, abs(nx));
      vel.x -= sign(nx) * min(abs(nx), 1.0) * pinchZone * uBuoyancy * 0.10 * (0.35 + 0.65 * uIntensity) * uDt;

      // Organic evening breeze + multi-scale convective turbulence so flames split into lively dancing tongues
      float breeze = sin(uTime * 0.62) * 0.48 + sin(uTime * 1.53 + 1.1) * 0.32 + sin(uTime * 2.9 + 2.4) * 0.20;
      float heightFactor = smoothstep(uBaseY, 0.78, vUv.y);
      float lateralNoise = (vnoise(vec2(vUv.x * 5.8, vUv.y * 6.5 - uTime * 2.4)) - 0.5) * 2.0;
      vel.x += (breeze * 0.24 * heightFactor + lateralNoise * 0.62 * (0.20 + temp)) * uBuoyancy * uDt;

      // Upward convective impulse inside the hot core
      float corePush = exp(-nx * nx * 2.5) * smoothstep(uBaseY + 0.12, uBaseY, vUv.y) * smoothstep(uBaseY - 0.03, uBaseY + 0.01, vUv.y);
      vel.y += corePush * uBuoyancy * 0.58 * uIntensity * uDt;

      // User touch / swipe interaction
      if (uTouchActive > 0.5) {
        vec2 diff = vUv - uTouchPos;
        diff.x *= uAspect;
        float d2 = dot(diff, diff);
        float w = exp(-d2 * 95.0);
        vel += uTouchVel * w;
      }

      // Viscous air drag & velocity cap
      vel *= exp(-0.48 * uDt);
      float maxSpd = uBuoyancy * 2.1;
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

  // 4. Vorticity confinement (carves dynamic licking flame curls & wisps)
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
      float mask = smoothstep(0.03, 0.32, st.r + st.g + st.b * 0.4);
      mask *= smoothstep(1.0, 0.88, vUv.y);

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

  // 9b. Clamped MacCormack Advection (sharp, crisp flame ribbons)
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

  // 10. Exothermic Combustion & Radiative Cooling (T^3 + edge crispness)
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

      // Fuel ignites rapidly into incandescent heat
      float ignition = smoothstep(0.05, 0.30, temp + 0.14);
      float burn = min(fuel, fuel * 4.4 * uDt) * ignition;
      fuel -= burn;
      temp += burn * 1.45;
      smoke = min(1.0, smoke + burn * 0.28);

      // Faster radiative cooling at high T + convective cooling at flanks gives sharp pointed flame tips
      float coolRate = uCooling * (0.58 * temp + 1.75 * temp * temp * temp);
      temp = max(0.0, temp - coolRate * uDt);

      float topFade = smoothstep(1.0, 0.88, vUv.y);
      temp *= mix(0.86, 1.0, topFade);
      fuel *= exp(-1.15 * uDt) * mix(0.85, 1.0, topFade);
      smoke *= exp(-1.35 * uDt) * mix(0.82, 1.0, topFade);

      gl_FragColor = vec4(temp, fuel, smoke, 1.0);
    }
  `;

  // Shared rendering helpers: Vivid Blackbody Ramp, Exposure-Correct ACES, Charred Logs
  const RENDER_HELPERS_GLSL = `
    vec3 acesToneMap(vec3 x) {
      return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
    }

    // Vivid HDR natural wood bonfire blackbody curve (linear HDR radiance)
    vec3 naturalFireRamp(float t) {
      vec3 c0 = vec3(0.0);
      vec3 c1 = vec3(0.55, 0.02, 0.001);  // deep luminous crimson edge
      vec3 c2 = vec3(1.65, 0.24, 0.005);  // blazing flame red-orange
      vec3 c3 = vec3(2.85, 0.92, 0.06);   // rich glowing bonfire orange
      vec3 c4 = vec3(4.20, 2.45, 0.42);   // brilliant golden yellow
      vec3 c5 = vec3(6.20, 5.10, 2.75);   // incandescent cream-white core

      vec3 col = mix(c0, c1, smoothstep(0.09, 0.22, t));
      col = mix(col, c2, smoothstep(0.20, 0.42, t));
      col = mix(col, c3, smoothstep(0.40, 0.70, t));
      col = mix(col, c4, smoothstep(0.68, 1.04, t));
      col = mix(col, c5, smoothstep(1.00, 1.45, t));
      return col;
    }

    // Vivid HDR thermal color ramp for arbitrary user colors
    vec3 customFireRamp(float t, vec3 base) {
      vec3 b = max(base, vec3(0.01));
      float maxC = max(b.r, max(b.g, b.b));
      vec3 normB = b / max(maxC, 0.001);

      vec3 c0 = vec3(0.0);
      vec3 c1 = pow(normB, vec3(2.4)) * 0.65;
      vec3 c2 = pow(normB, vec3(1.45)) * 1.85;
      vec3 c3 = mix(normB, vec3(1.0, 0.97, 0.90), 0.24) * 3.10;
      vec3 c4 = mix(normB, vec3(1.0, 0.99, 0.95), 0.62) * 4.50;
      vec3 c5 = mix(vec3(1.0), normB, 0.14) * 6.20;

      vec3 col = mix(c0, c1, smoothstep(0.09, 0.22, t));
      col = mix(col, c2, smoothstep(0.20, 0.42, t));
      col = mix(col, c3, smoothstep(0.40, 0.70, t));
      col = mix(col, c4, smoothstep(0.68, 1.04, t));
      col = mix(col, c5, smoothstep(1.00, 1.45, t));
      return col;
    }

    vec3 fireColor(float t, vec3 baseColor, float isNatural) {
      vec3 nat = naturalFireRamp(t);
      vec3 cus = customFireRamp(t, baseColor);
      return mix(cus, nat, isNatural);
    }

    // Apply brightness via exposure + gentle ceiling so dim flames stay vivid orange-gold, never muddy gray
    vec3 exposeAndToneMap(vec3 hdrCol, float brightness) {
      float b = clamp(brightness, 0.0, 1.0);
      if (b <= 0.0005) return vec3(0.0);
      // Pre-tonemap exposure keeps bright highlights warm & colorful instead of desaturated gray
      float preExposure = mix(0.28, 1.25, pow(b, 0.72));
      vec3 mapped = acesToneMap(hdrCol * preExposure);
      // Post-tonemap ceiling guarantees maxBrightness genuinely dims the phone screen in a dark bedroom
      float postCeiling = pow(b, 0.68);
      return mapped * postCeiling;
    }

    // Distance to a 2D line segment (for organic charred wood logs)
    float sdSegment(vec2 p, vec2 a, vec2 b, out float along) {
      vec2 pa = p - a;
      vec2 ba = b - a;
      along = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
      return length(pa - ba * along);
    }

    // Evaluate charred campfire log stack + glowing coal embers
    // Returns vec3(logAlpha, emberGlowTemp, charcoalShade)
    vec3 evalCampfireLogs(vec2 uv, float fireHalfW, float baseY, float aspect, float time, float emberHeat) {
      vec2 p = vec2((uv.x - 0.5) / fireHalfW, (uv.y - baseY) / (fireHalfW * aspect));

      if (abs(p.x) > 1.30 || p.y < -0.52 || p.y > 0.55) {
        return vec3(0.0);
      }

      float grain = fbm(p * vec2(11.0, 22.0) + vec2(3.1, 1.7));
      float cracks = vnoise(p * vec2(26.0, 34.0) + vec2(0.0, -time * 0.05));
      float rough = (grain - 0.5) * 0.022;

      float h1, h2, h3, h4;
      float d1 = sdSegment(p, vec2(-0.88, -0.15), vec2(0.26, 0.14), h1) - 0.068 + rough;
      float d2 = sdSegment(p, vec2(0.90, -0.14), vec2(-0.24, 0.13), h2) - 0.066 + rough;
      float d3 = sdSegment(p, vec2(-0.76, -0.22), vec2(0.42, -0.05), h3) - 0.072 + rough;
      float d4 = sdSegment(p, vec2(0.78, -0.21), vec2(-0.40, -0.03), h4) - 0.070 + rough;

      float d = min(min(d1, d2), min(d3, d4));
      float logAlpha = smoothstep(0.014, -0.008, d);

      // Glowing ember bed nestled under and between the logs
      float bedDist = length(vec2(p.x * 0.96, (p.y + 0.17) * 3.1));
      float bedNoise = fbm(vec2(p.x * 11.0, p.y * 18.0) + vec2(time * 0.04, -time * 0.03));
      float pulse = 0.78 + 0.22 * sin(time * 1.35 + p.x * 4.5 + bedNoise * 5.0);
      float coalBed = smoothstep(0.92, 0.18, bedDist) * smoothstep(0.32, 0.78, bedNoise) * pulse;

      // Incandescent fissures & glowing undersides on the inner charred wood
      float innerHeat = exp(-p.x * p.x * 2.3) * smoothstep(-0.32, 0.14, p.y);
      float crackGlow = logAlpha * innerHeat * smoothstep(0.50, 0.86, cracks * 0.65 + grain * 0.48) * pulse;
      float rimGlow = smoothstep(0.022, 0.0, abs(d)) * innerHeat * 0.75 * pulse;

      float totalEmber = (coalBed * 0.72 + crackGlow * 0.95 + rimGlow * 0.65) * emberHeat;
      float shade = 0.4 + 0.6 * grain;
      return vec3(logAlpha, totalEmber, shade);
    }
  `;

  // 11. High-DPI Final Volumetric Fire Display Shader (uses GPU fluid state)
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
    uniform vec3 uBaseColor;
    uniform float uIsNatural;
    uniform float uBrightness;
    uniform float uEmberHeat;
    uniform float uIntensity;
    ${NOISE_GLSL}
    ${RENDER_HELPERS_GLSL}

    // 4-tap Catmull-Rom-inspired smooth bicubic sampling (zero blocky grid artifacts!)
    vec4 sampleBicubic(sampler2D tex, vec2 uv, vec2 texel) {
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

      return max(vec4(0.0),
        (t00 * s0.x + t10 * s1.x) * s0.y +
        (t01 * s0.x + t11 * s1.x) * s1.y
      );
    }

    void main() {
      vec4 coarseSt = sampleBicubic(uState, vUv, uSimTexel);
      vec2 vel = texture2D(uVelocity, vUv).xy;

      // Delicate fluid-advected micro-shimmer for silky Retina flame ribbons
      float heatMask = smoothstep(0.05, 0.45, coarseSt.r + coarseSt.g * 0.4);
      vec2 shimmerUv = vec2(vUv.x * uAspect * 5.2, vUv.y * 5.2 - uTime * 3.4);
      vec2 microOffset = vec2(
        fbm(shimmerUv) - 0.5,
        fbm(shimmerUv + vec2(13.7, 5.3)) - 0.5
      ) * 0.0085 * heatMask;

      vec4 st = sampleBicubic(uState, vUv + microOffset, uSimTexel);
      float temp = st.r;
      float fuel = st.g;
      float smoke = st.b;

      // Carve crisp flickering micro-tongues along outer flame edges
      float detail = fbm(vec2(vUv.x * uAspect * 8.0, vUv.y * 7.5 - uTime * 4.2) - vel * 0.0018);
      float edgeSculpt = (detail - 0.48) * 0.22 * smoothstep(0.05, 0.52, temp);
      float effectiveTemp = max(0.0, temp + edgeSculpt);
      // Slight hot core boost where unburned wood gas ignites cleanly
      effectiveTemp += fuel * 0.16 * smoothstep(0.18, 0.65, temp);

      // Wide, subtle ambient night firelight glow
      vec2 glowDelta = vec2((vUv.x - 0.5) * uAspect, (vUv.y - (uBaseY + 0.18 * (0.4 + 0.6 * uIntensity))) * 0.85);
      float glowDist = length(glowDelta);
      float ambientGlow = exp(-glowDist * 2.8) * (0.09 + 0.14 * uIntensity) * (0.30 + 0.70 * uEmberHeat);
      vec3 glowCol = fireColor(0.40, uBaseColor, uIsNatural) * ambientGlow;

      // Subtle fire-lit warm smoke wisps rising above flames
      float smokeVis = smoothstep(0.06, 0.85, smoke) * (1.0 - smoothstep(0.22, 0.65, effectiveTemp));
      vec3 smokeCol = fireColor(0.24, uBaseColor, uIsNatural) * smokeVis * 0.09 * exp(-glowDist * 1.5);

      // Warm hearth ground reflection directly beneath the logs
      vec2 floorDelta = vec2((vUv.x - 0.5) / (uFireHalfW * 1.32), (vUv.y - (uBaseY - 0.032)) / 0.065);
      float floorGlow = exp(-dot(floorDelta, floorDelta) * 1.55) * 0.22 * uEmberHeat;
      vec3 floorCol = fireColor(0.34, uBaseColor, uIsNatural) * floorGlow;

      // Charred firewood logs & glowing coal embers
      vec3 logInfo = evalCampfireLogs(vUv, uFireHalfW, uBaseY, uAspect, uTime, uEmberHeat);
      float logAlpha = logInfo.x;
      float emberTemp = logInfo.y;
      float logShade = logInfo.z;

      // Crisp luminous flame emission
      vec3 flameCol = fireColor(effectiveTemp, uBaseColor, uIsNatural);
      float flameOpacity = smoothstep(0.10, 0.40, effectiveTemp);

      vec3 col = glowCol + smokeCol + floorCol;

      // Dark charred wood silhouettes with warm inner firelight reflection
      vec3 charcoalCol = vec3(0.014, 0.010, 0.008) * logShade
                       + fireColor(0.32, uBaseColor, uIsNatural) * 0.032 * logShade * uEmberHeat;
      vec3 emberCol = fireColor(emberTemp * 0.92, uBaseColor, uIsNatural) * 0.72;

      col = mix(col, charcoalCol, logAlpha * (1.0 - flameOpacity * 0.88));
      col += emberCol;
      col += flameCol;

      col = exposeAndToneMap(col, uBrightness);

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  // Fallback Procedural Volumetric Fluid-Turbulence Fire Shader (zero float FBOs needed!)
  const FALLBACK_FIRE_FRAG = `
    precision highp float;
    varying vec2 vUv;
    uniform float uTime;
    uniform float uAspect;
    uniform float uFireHalfW;
    uniform float uBaseY;
    uniform vec3 uBaseColor;
    uniform float uIsNatural;
    uniform float uBrightness;
    uniform float uEmberHeat;
    uniform float uIntensity;
    uniform vec2 uTouchPos;
    uniform vec2 uTouchVel;
    uniform float uTouchActive;
    ${NOISE_GLSL}
    ${RENDER_HELPERS_GLSL}

    void main() {
      float nx = (vUv.x - 0.5) / uFireHalfW;
      float ny = max(0.0, vUv.y - uBaseY);

      float sway = (sin(uTime * 0.85) * 0.09 + sin(uTime * 1.9 + 1.2) * 0.04) * ny * 2.2;
      if (uTouchActive > 0.5) {
        vec2 td = vUv - uTouchPos;
        td.x *= uAspect;
        sway += clamp(uTouchVel.x * 0.0012, -0.35, 0.35) * exp(-dot(td, td) * 24.0);
      }

      vec2 q = vec2(nx - sway, ny);
      float fireH = mix(0.24, 0.82, uIntensity);

      float t = uTime * mix(1.4, 2.5, uIntensity);
      vec2 w1 = vec2(
        fbm(vec2(q.x * 2.4, q.y * 3.4 - t * 1.05)),
        fbm(vec2(q.x * 2.4 + 5.2, q.y * 3.4 - t * 1.25))
      ) - 0.5;

      vec2 warped = q + w1 * vec2(0.55, 0.30) * smoothstep(0.0, 0.32, ny);
      float nFine = fbm(vec2(warped.x * 4.6, warped.y * 6.0 - t * 1.75));

      float widthAtY = mix(0.92, 0.18, clamp(ny / max(fireH, 0.1), 0.0, 1.0));
      float radial = abs(warped.x) / max(widthAtY, 0.10);
      float heightDecay = 1.0 - smoothstep(0.0, fireH * (0.82 + 0.48 * nFine), ny);

      float temp = heightDecay * exp(-radial * radial * 1.55) * (0.72 + 0.92 * nFine) * (0.58 + 0.88 * uIntensity);
      temp *= smoothstep(uBaseY - 0.025, uBaseY + 0.04, vUv.y);
      temp = max(0.0, temp - 0.10);

      vec2 glowDelta = vec2((vUv.x - 0.5) * uAspect, (vUv.y - (uBaseY + 0.18 * uIntensity)) * 0.85);
      float glowDist = length(glowDelta);
      vec3 glowCol = fireColor(0.40, uBaseColor, uIsNatural) * exp(-glowDist * 2.8) * (0.09 + 0.14 * uIntensity) * uEmberHeat;

      vec3 logInfo = evalCampfireLogs(vUv, uFireHalfW, uBaseY, uAspect, uTime, uEmberHeat);
      vec3 flameCol = fireColor(temp, uBaseColor, uIsNatural);
      float flameOpacity = smoothstep(0.10, 0.40, temp);

      vec3 col = glowCol;
      vec3 charcoalCol = vec3(0.014, 0.010, 0.008) * logInfo.z
                       + fireColor(0.32, uBaseColor, uIsNatural) * 0.032 * logInfo.z * uEmberHeat;
      col = mix(col, charcoalCol, logInfo.x * (1.0 - flameOpacity * 0.88));
      col += fireColor(logInfo.y * 0.92, uBaseColor, uIsNatural) * 0.72;
      col += flameCol;

      col = exposeAndToneMap(col, uBrightness);

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  // 12. Additive Glowing Sparks / Embers Particle Shaders
  const SPARK_VERT = `
    attribute vec2 aPos;
    attribute float aSize;
    attribute float aHeat;
    attribute float aAlpha;
    varying float vHeat;
    varying float vAlpha;
    uniform float uDpr;

    void main() {
      vHeat = aHeat;
      vAlpha = aAlpha;
      gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0);
      gl_PointSize = max(2.0, aSize * uDpr);
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

      float lumScale = pow(clamp(uBrightness, 0.0, 1.0), 0.72);
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

      // Simulation parameters
      this.baseColor = [1.0, 0.415, 0.078]; // #ff6a14
      this.isNaturalColor = 1.0;
      this.intensity = 0.68;
      this.minBrightness = 0.35;
      this.maxBrightness = 0.95;
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
      this.fireHalfW = 0.34;
      this.baseY = 0.075;
      this.currentBrightness = 0.75;

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

    // Pre-warm the fluid convection column so frame 1 is already a natural roaring bonfire (no startup mushroom!)
    _warmupFluid() {
      if (!this.useFluidSim || !this.fbos) return;
      const gl = this.gl;
      gl.disable(gl.BLEND);
      const effInt = this.intensity * this.fadeIntensityMul;
      const stepDt = 0.028;
      for (let i = 0; i < 115; i++) {
        this.time += stepDt;
        this._stepFluid(stepDt, effInt);
      }
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

      this.fireHalfW = Math.min(0.41, 0.34 / Math.max(this.aspect, 0.45));
      this.baseY = this.aspect < 0.85 ? 0.085 : 0.075;

      // Crisp square-cell simulation grid optimized for mobile 60fps
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

    setIntensity(value01) {
      this.intensity = Math.max(0.05, Math.min(1.0, value01));
    }

    setBrightnessRange(min01, max01) {
      this.minBrightness = Math.max(0.0, Math.min(1.0, min01));
      this.maxBrightness = Math.max(this.minBrightness, Math.min(1.0, max01));
    }

    setFadeProgress(progress01) {
      const p = Math.max(0.0, Math.min(1.0, progress01));
      const remain = 1.0 - p;
      this.fadeIntensityMul = Math.pow(remain, 0.92);
      this.fadeEmberMul = Math.pow(remain, 0.45);
      this.fadeBrightnessMul = remain <= 0.0001 ? 0.0 : Math.pow(remain, 1.15);
    }

    setTouch(active, normX, normY, velX, velY) {
      this.touchActive = active;
      if (active) {
        this.touchPos[0] = normX;
        this.touchPos[1] = normY;
        this.touchVel[0] = velX;
        this.touchVel[1] = velY;
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
        // Scatter initial rising sparks smoothly up the plume
        s.y += s.life * 0.52;
        this.sparks.push(s);
      }
    }

    _spawnSpark(randomLife) {
      const spread = (Math.random() - 0.5) * 1.45 * this.fireHalfW;
      const effInt = this.intensity * this.fadeIntensityMul;
      return {
        x: 0.5 + spread * (0.35 + 0.65 * Math.random()),
        y: this.baseY + Math.random() * 0.08,
        vx: (Math.random() - 0.5) * 0.08,
        vy: (0.18 + Math.random() * 0.28) * (0.45 + 0.85 * effInt),
        life: randomLife ? Math.random() : 0.0,
        maxLife: 1.5 + Math.random() * 2.6,
        size: 1.8 + Math.random() * 3.1,
        phase: Math.random() * Math.PI * 2,
        wobble: 1.8 + Math.random() * 3.8,
      };
    }

    _updateSparks(dt, effInt) {
      const activeTarget = Math.floor(this.sparkCount * (0.20 + 0.80 * effInt));
      const breeze = Math.sin(this.time * 0.62) * 0.048 + Math.sin(this.time * 1.53 + 1.1) * 0.022;

      for (let i = 0; i < this.sparkCount; i++) {
        const s = this.sparks[i];
        s.life += dt / s.maxLife;

        if (s.life >= 1.0 || s.y > 1.05 || s.x < -0.05 || s.x > 1.05) {
          if (i < activeTarget && effInt > 0.04 && Math.random() < 0.35 + 0.65 * effInt) {
            this.sparks[i] = this._spawnSpark(false);
          } else {
            s.life = 1.0;
          }
        } else {
          const turbX = Math.sin(this.time * s.wobble + s.phase + s.y * 12.0) * 0.095;
          s.vx += (breeze + turbX - s.vx * 1.5) * dt;
          s.vy += ((0.18 + 0.24 * effInt) - s.vy * 0.82) * dt;

          if (this.touchActive) {
            const dx = (s.x - this.touchPos[0]) * this.aspect;
            const dy = s.y - this.touchPos[1];
            const w = Math.exp(-(dx * dx + dy * dy) * 55.0);
            s.vx += this.touchVel[0] * 0.0007 * w;
            s.vy += this.touchVel[1] * 0.0007 * w;
          }

          s.x += s.vx * dt;
          s.y += s.vy * dt;
        }

        const alive = s.life < 1.0 && i < activeTarget;
        const fadeIn = Math.min(1.0, s.life * 6.0);
        const fadeOut = Math.max(0.0, 1.0 - s.life);
        const flicker = 0.65 + 0.35 * Math.sin(this.time * 18.0 + s.phase * 5.0);
        const alpha = alive ? fadeIn * Math.pow(fadeOut, 1.2) * flicker * (0.50 + 0.50 * effInt) : 0.0;
        const heat = Math.max(0.0, 1.0 - s.life * 1.1);

        const off = i * 5;
        this.sparkData[off] = s.x;
        this.sparkData[off + 1] = s.y;
        this.sparkData[off + 2] = s.size * (0.65 + 0.5 * fadeOut);
        this.sparkData[off + 3] = heat;
        this.sparkData[off + 4] = alpha;
      }
    }

    // --- Organic Flicker / Breathing Envelope bounded by [minBrightness, maxBrightness] ---

    _computeBrightnessEnvelope(t, effInt) {
      const w1 = Math.sin(t * 0.63) * 0.34;
      const w2 = Math.sin(t * 1.47 + 1.1) * 0.25;
      const w3 = Math.sin(t * 2.91 + 2.7) * 0.19;
      const w4 = Math.sin(t * 5.23 + 0.4) * 0.13;
      const w5 = Math.sin(t * 8.17 + 3.9) * 0.09;
      const raw = 0.5 + 0.5 * (w1 + w2 + w3 + w4 + w5);
      const organic = Math.max(0.0, Math.min(1.0, raw * 0.90 + 0.10 * effInt));
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

      const dt = Math.min(Math.max(rawDt, 0.001), 0.033);
      this.time += dt;

      const effInt = this.intensity * this.fadeIntensityMul;
      const emberHeat = (0.35 + 0.65 * this.intensity) * this.fadeEmberMul;
      const targetBright = this._computeBrightnessEnvelope(this.time, effInt);
      this.currentBrightness += (targetBright - this.currentBrightness) * Math.min(1.0, dt * 14.0);

      if (this.fadeBrightnessMul <= 0.0001 && this.currentBrightness < 0.001) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, this.width, this.height);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        return;
      }

      gl.disable(gl.BLEND);

      if (this.useFluidSim && this.fbos) {
        this._stepFluid(dt, effInt);
        this._renderFluidDisplay(effInt, emberHeat);
      } else {
        this._renderFallback(effInt, emberHeat);
      }

      this._updateSparks(dt, effInt);
      this._renderSparks();

      this.touchVel[0] *= 0.82;
      this.touchVel[1] *= 0.82;
    }

    _stepFluid(dt, effInt) {
      const gl = this.gl;
      const p = this.programs;
      const f = this.fbos;
      const tx = 1.0 / this.simW;
      const ty = 1.0 / this.simH;

      // Balanced convective lift + rich vorticity confinement for broad, multi-tongued campfire flames
      const buoyancy = this.simH * (0.52 + 0.62 * effInt);
      const curlStrength = 20.0 + 22.0 * effInt;
      const cooling = 1.65 - 0.62 * effInt;

      // 1. Emit fuel & heat into state
      this._bindQuad(p.emitState);
      this._bindTex(0, f.state.read.tex, p.emitState.uniforms.uState);
      gl.uniform1f(p.emitState.uniforms.uTime, this.time);
      gl.uniform1f(p.emitState.uniforms.uDt, dt);
      gl.uniform1f(p.emitState.uniforms.uIntensity, effInt);
      gl.uniform1f(p.emitState.uniforms.uFireHalfW, this.fireHalfW);
      gl.uniform1f(p.emitState.uniforms.uBaseY, this.baseY);
      gl.uniform2f(p.emitState.uniforms.uTouchPos, this.touchPos[0], this.touchPos[1]);
      gl.uniform2f(p.emitState.uniforms.uTouchVel, this.touchVel[0], this.touchVel[1]);
      gl.uniform1f(p.emitState.uniforms.uTouchActive, this.touchActive ? 1.0 : 0.0);
      gl.uniform1f(p.emitState.uniforms.uAspect, this.aspect);
      this._blit(f.state.write);
      f.state.swap();

      // 2. Buoyancy, entrainment, breeze & touch momentum
      this._bindQuad(p.buoyancy);
      this._bindTex(0, f.velocity.read.tex, p.buoyancy.uniforms.uVelocity);
      this._bindTex(1, f.state.read.tex, p.buoyancy.uniforms.uState);
      gl.uniform1f(p.buoyancy.uniforms.uTime, this.time);
      gl.uniform1f(p.buoyancy.uniforms.uDt, dt);
      gl.uniform1f(p.buoyancy.uniforms.uBuoyancy, buoyancy);
      gl.uniform1f(p.buoyancy.uniforms.uIntensity, effInt);
      gl.uniform1f(p.buoyancy.uniforms.uFireHalfW, this.fireHalfW);
      gl.uniform1f(p.buoyancy.uniforms.uBaseY, this.baseY);
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
      gl.uniform1f(p.clearScale.uniforms.uScale, 0.82);
      this._blit(f.pressure.write);
      f.pressure.swap();

      // 7. Jacobi pressure solver (16 iterations)
      this._bindQuad(p.pressure);
      this._bindTex(1, f.divergence.tex, p.pressure.uniforms.uDivergence);
      gl.uniform2f(p.pressure.uniforms.uTexel, tx, ty);
      for (let i = 0; i < 16; i++) {
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
      gl.uniform1f(p.advect.uniforms.uDissipation, 0.992);
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

      // 10. Combustion & Radiative Cooling
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
      gl.uniform3f(p.uniforms.uBaseColor, this.baseColor[0], this.baseColor[1], this.baseColor[2]);
      gl.uniform1f(p.uniforms.uIsNatural, this.isNaturalColor);
      gl.uniform1f(p.uniforms.uBrightness, this.currentBrightness);
      gl.uniform1f(p.uniforms.uEmberHeat, emberHeat);
      gl.uniform1f(p.uniforms.uIntensity, effInt);
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
