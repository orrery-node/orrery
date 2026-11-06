'use client';

// The hero object: an orrery made of light on true black, inside a sky of other people's routers. On load the page is a sky of loose stars; they fall into
// place from the inside out (the router's dotted core first, then each orbit, then the engraved horizon) and every
// point flares as it lands. Orbits are dense streams of points with fine filaments around them, and light runs
// along them; two orbits carry the Solana gradient. The rehearsal's three providers ride the orbits. A column of
// light falls from the core into the request line below: a request climbs it, leaves the core as purple light
// carrying its model and comes back green carrying what it cost. Labels ride the light and settle where it lands.
// Around it, other routers float as small orreries of their own, and requests cross between them and the providers
// directly, with no server anywhere in the middle: the providers flare for them too. The close variant assembles as it
// scrolls into view and flares when the page's wire reaches its core.
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { emit, on, reducedMotion } from '@/lib/bus';
import { perM, rehearsal, ROUTE_WORD, type RTrip } from '@/lib/rehearsal';

const WHITE = new THREE.Color('#ffffff');
const PURPLE = new THREE.Color('#a463ff');
const GREEN = new THREE.Color('#14f195');
const SOL = [new THREE.Color('#9945ff'), new THREE.Color('#5f8ff2'), new THREE.Color('#14f195')];
const solAt = (u: number, out = new THREE.Color()) => {
  const y = Math.abs((((u % 1) + 1) % 1) * 2 - 1);
  return y < 0.5 ? out.copy(SOL[0]).lerp(SOL[1], y * 2) : out.copy(SOL[1]).lerp(SOL[2], y * 2 - 1);
};

type Orbit = { r: number; rx: number; rz: number; sol: boolean };
const HORIZON = 4.6;
const ORBITS: Orbit[] = [
  { r: 1.5, rx: 0.42, rz: -0.26, sol: false },
  { r: 2.15, rx: -0.3, rz: 0.34, sol: true },
  { r: 2.8, rx: 0.16, rz: 0.22, sol: false },
  { r: 3.5, rx: -0.2, rz: -0.1, sol: true },
  { r: 4.1, rx: 0.22, rz: 0.09, sol: false },
];
const ORBIT_SPEED = ORBITS.map((o) => 0.11 * Math.pow(1.5 / o.r, 1.5));
const NAMED: Record<string, [number, number]> = {
  'Kestrel GPU Co-op': [2, 2.6],
  'Ironbridge Compute': [3, 0.55],
  'Vault Nine': [4, 4.6],
};
const ROUTE_AT: [string, number][] = [
  ['price', 3.6],
  ['speed', 4.75],
  ['privacy', 0.25],
  ['auto', 1.75],
];

const STAR_VS = `
attribute vec3 aFrom; attribute float aDelay; attribute float aSize; attribute float aAlpha; attribute vec3 aColor;
attribute float aU; attribute float aGlint; attribute float aTwinkle;
uniform float uIntro; uniform float uTime; uniform float uScale; uniform float uCenter; uniform float uDepth; uniform float uFlow;
varying vec3 vColor; varying float vAlpha;
void main() {
  float raw = (uIntro - aDelay) / 0.95;
  float k = clamp(raw, 0.0, 1.0);
  float e = 1.0 - pow(1.0 - k, 3.0);
  vec3 p = mix(aFrom, position, e);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float front = clamp(0.5 + (mv.z - uCenter) / uDepth, 0.0, 1.0);
  float wave = pow(0.5 + 0.5 * sin(6.2831853 * aU * 3.0 - uTime * uFlow), 14.0);
  float flash = smoothstep(0.55, 1.0, raw) * (1.0 - smoothstep(1.0, 1.7, raw));
  float tw = 0.75 + 0.25 * sin(uTime * aTwinkle + aU * 40.0);
  float travel = mix(0.45, 1.0, e);
  gl_PointSize = aSize * uScale / -mv.z * (1.0 + flash * 0.7 + aGlint * wave * 0.6);
  gl_Position = projectionMatrix * mv;
  vColor = mix(aColor, vec3(1.0), flash * 0.6 + aGlint * wave * 0.5);
  vAlpha = aAlpha * mix(0.2, 1.0, front * front) * travel * tw + flash * 0.9 * aAlpha + aGlint * wave * 0.85 * front;
}`;
const STAR_FS = `
varying vec3 vColor; varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  float a = 1.0 - d; a *= a;
  gl_FragColor = vec4(vColor * vAlpha * a, 1.0);
}`;

const LINE_VS = `
attribute float aT; attribute float aAlpha;
uniform float uDraw; uniform float uCenter; uniform float uDepth;
uniform float uTime; uniform float uFlow; uniform float uFreq; uniform float uSpeed;
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float front = clamp(0.5 + (mv.z - uCenter) / uDepth, 0.0, 1.0);
  float wave = pow(0.5 + 0.5 * sin(aT * uFreq - uTime * uSpeed), 4.0);
  float glint = 1.0 + uFlow * (wave * 1.6 - 0.3);
  vAlpha = aAlpha * glint * mix(0.12, 1.1, front * front) * clamp((uDraw - aT) * 10.0, 0.0, 1.0);
  gl_Position = projectionMatrix * mv;
}`;
const LINE_FS = `
uniform vec3 uColor; varying float vAlpha;
void main() { gl_FragColor = vec4(uColor * vAlpha, 1.0); }`;

const NODE_VS = `
attribute float aSize; attribute float aAlpha; attribute vec3 aColor; attribute float aKind;
uniform float uScale; uniform float uCenter; uniform float uDepth;
varying vec3 vColor; varying float vAlpha; varying float vKind;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float front = clamp(0.5 + (mv.z - uCenter) / uDepth, 0.0, 1.0);
  gl_PointSize = aSize * uScale / -mv.z;
  gl_Position = projectionMatrix * mv;
  vColor = aColor; vKind = aKind;
  vAlpha = aAlpha * mix(0.3, 1.0, front);
}`;
const NODE_FS = `
varying vec3 vColor; varying float vAlpha; varying float vKind;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  float a;
  if (vKind > 3.5) { a = exp(-d * d * 4.0) * 0.5; }
  else if (vKind > 2.5) { a = smoothstep(0.97, 0.9, d) * smoothstep(0.8, 0.87, d); }
  else if (vKind > 0.5) { a = smoothstep(0.55, 0.0, d) * 0.7 + exp(-d * d * 9.0) * 0.8; }
  else { a = smoothstep(0.9, 0.2, d); }
  gl_FragColor = vec4(vColor * a * vAlpha, 1.0);
}`;

const BEAM_VS = `
attribute float aSeed; attribute vec2 aJit; attribute float aBright;
uniform float uTime; uniform float uLen; uniform float uIntro; uniform float uPulse; uniform float uScale;
varying float vAlpha; varying float vHot;
void main() {
  float s = fract(aSeed + uTime * 0.16);
  float w = 0.018 + s * s * s * 0.9;
  vec3 p = vec3(aJit.x * w, -s * uLen, aJit.y * w * 0.4);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float hot = uPulse >= 0.0 ? exp(-pow((s - uPulse) * 9.0, 2.0)) : 0.0;
  gl_PointSize = (1.6 + aBright * 1.4 + hot * 3.0) * uScale / -mv.z;
  gl_Position = projectionMatrix * mv;
  float grow = clamp((uIntro - 1.6 - (1.0 - s) * 0.6) * 1.5, 0.0, 1.0);
  vAlpha = grow * (0.25 + aBright * 0.5) * smoothstep(0.0, 0.06, s) * (0.55 + 0.45 * (1.0 - s)) + hot * 1.6 * grow;
  vHot = hot;
}`;
const BEAM_FS = `
uniform vec3 uColor; varying float vAlpha; varying float vHot;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  float a = 1.0 - d; a *= a;
  gl_FragColor = vec4(mix(vec3(1.0), uColor, vHot * 0.8) * vAlpha * a, 1.0);
}`;

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ringPoint = (r: number, rx: number, rz: number, th: number, sx = 1, sz = 1) =>
  new THREE.Vector3(r * sx * Math.cos(th), 0, r * sz * Math.sin(th)).applyEuler(new THREE.Euler(rx, 0, rz));
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

type Node = { pos: THREE.Vector3; size: number; alpha: number; kind: number; flare: number; flareColor: THREE.Color; down: number };
type Rig = { tilt: THREE.Group; spin: THREE.Group; speed: number; m: THREE.Matrix4 };
type Prov = { node: Node; local: THREE.Vector3; rig: Rig; curve: THREE.QuadraticBezierCurve3; mat: THREE.ShaderMaterial; tint: number };
type Pulse = {
  prov: Prov;
  t: number;
  dur: number;
  back: boolean;
  sealed: boolean;
  done: () => void;
  fade: boolean;
  label: string;
  chose: boolean;
  alt: boolean;
  wait: number;
  side: number;
};
type Buf = { pos: number[]; ts: number[]; as: number[] };
type Mesh = { from: () => THREE.Vector3; to: () => THREE.Vector3; t: number; dur: number; back: boolean; lift: number; prov: Prov | null; done: boolean };
type Star = { p: number[]; from: number[]; delay: number[]; size: number[]; alpha: number[]; color: number[]; u: number[]; glint: number[]; tw: number[] };

export default function Orrery({ variant = 'hero' }: { variant?: 'hero' | 'close' }) {
  const host = useRef<HTMLDivElement>(null);
  const chipLayer = useRef<HTMLDivElement>(null);
  const hero = variant === 'hero';

  useEffect(() => {
    const el = host.current!;
    const layer = chipLayer.current!;
    const reduce = reducedMotion();
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance' });
    } catch {
      el.classList.add('orrery--off');
      return;
    }
    const lite = window.innerWidth < 760 || (navigator.hardwareConcurrency || 8) <= 4;
    const dpr = Math.min(window.devicePixelRatio || 1, lite ? 1.5 : 1.75);
    renderer.setPixelRatio(dpr);
    renderer.setClearColor(0x000000, 1);
    el.prepend(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 200);
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), lite ? 0.5 : 0.62, 0.32, 0.3);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());

    const root = new THREE.Group();
    scene.add(root);
    const disposables: { dispose(): void }[] = [composer];
    const shared = {
      uDraw: { value: reduce ? 3 : 0 },
      uCenter: { value: -20 },
      uDepth: { value: 8.5 },
      uTime: { value: 0 },
    };
    const starUniforms = { uIntro: { value: reduce ? 9 : 0 }, uTime: shared.uTime, uScale: { value: 40 }, uCenter: shared.uCenter, uDepth: shared.uDepth, uFlow: { value: reduce ? 0 : 0.9 } };
    const starMat = new THREE.ShaderMaterial({
      vertexShader: STAR_VS, fragmentShader: STAR_FS, uniforms: starUniforms, transparent: true, depthWrite: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    });
    disposables.push(starMat);
    const rand = rng(hero ? 0x51d : 0x77a1);
    const gauss = () => (rand() + rand() + rand() - 1.5) / 1.5;
    const density = lite ? 0.55 : 1;

    const stars = (): Star => ({ p: [], from: [], delay: [], size: [], alpha: [], color: [], u: [], glint: [], tw: [] });
    const scatter = () => {
      const v = new THREE.Vector3(gauss(), gauss() * 0.7, gauss()).normalize().multiplyScalar(5.5 + rand() * 9);
      return [v.x, v.y, v.z];
    };
    const put = (s: Star, x: number, y: number, z: number, o: { delay: number; size: number; alpha: number; color: THREE.Color; u?: number; glint?: number; tw?: number; from?: number[] }) => {
      s.p.push(x, y, z);
      s.from.push(...(o.from ?? scatter()));
      s.delay.push(o.delay);
      s.size.push(o.size);
      s.alpha.push(o.alpha);
      s.color.push(o.color.r, o.color.g, o.color.b);
      s.u.push(o.u ?? rand());
      s.glint.push(o.glint ?? 0);
      s.tw.push(o.tw ?? 0);
    };
    const pointsOf = (s: Star, parent: THREE.Object3D) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(s.p, 3));
      g.setAttribute('aFrom', new THREE.Float32BufferAttribute(reduce ? s.p : s.from, 3));
      g.setAttribute('aDelay', new THREE.Float32BufferAttribute(s.delay, 1));
      g.setAttribute('aSize', new THREE.Float32BufferAttribute(s.size, 1));
      g.setAttribute('aAlpha', new THREE.Float32BufferAttribute(s.alpha, 1));
      g.setAttribute('aColor', new THREE.Float32BufferAttribute(s.color, 3));
      g.setAttribute('aU', new THREE.Float32BufferAttribute(s.u, 1));
      g.setAttribute('aGlint', new THREE.Float32BufferAttribute(s.glint, 1));
      g.setAttribute('aTwinkle', new THREE.Float32BufferAttribute(s.tw, 1));
      disposables.push(g);
      const pts = new THREE.Points(g, starMat);
      pts.frustumCulled = false;
      parent.add(pts);
      return pts;
    };

    const buf = (): Buf => ({ pos: [], ts: [], as: [] });
    const seg = (b: Buf, a: THREE.Vector3, c: THREE.Vector3, t: number, alpha: number) => {
      b.pos.push(a.x, a.y, a.z, c.x, c.y, c.z);
      b.ts.push(t, t);
      b.as.push(alpha, alpha);
    };
    const ring = (b: Buf, r: number, rx: number, rz: number, alpha: number, n: number, t0: number, sx = 1, sz = 1, from = 0, span = Math.PI * 2) => {
      for (let k = 0; k < n; k++) {
        const a0 = from + (k / n) * span, a1 = from + ((k + 1) / n) * span;
        seg(b, ringPoint(r, rx, rz, a0, sx, sz), ringPoint(r, rx, rz, a1, sx, sz), t0 + (k / n) * 0.9, alpha);
      }
    };
    const lineMat = (color = WHITE, flow = 0, freq = 60, speed = 0.6) => {
      const m = new THREE.ShaderMaterial({
        vertexShader: LINE_VS, fragmentShader: LINE_FS,
        uniforms: { ...shared, uColor: { value: color.clone() }, uFlow: { value: reduce ? 0 : flow }, uFreq: { value: freq }, uSpeed: { value: speed } },
        transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      });
      disposables.push(m);
      return m;
    };
    const lines = (b: Buf, parent: THREE.Object3D, mat: THREE.ShaderMaterial) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      g.setAttribute('aT', new THREE.Float32BufferAttribute(b.ts, 1));
      g.setAttribute('aAlpha', new THREE.Float32BufferAttribute(b.as, 1));
      disposables.push(g);
      parent.add(new THREE.LineSegments(g, mat));
    };

    const sky = stars();
    const SKY = Math.round(5200 * density);
    for (let i = 0; i < SKY; i++) {
      const v = new THREE.Vector3(gauss(), gauss() * 0.6, gauss()).normalize().multiplyScalar(7 + Math.pow(rand(), 0.6) * 16);
      put(sky, v.x, v.y, v.z, { delay: -9, size: 1.0 + rand() * 1.4, alpha: 0.08 + rand() * 0.36, color: WHITE, tw: 0.6 + rand() * 2.4, from: [v.x, v.y, v.z] });
    }
    const skyGroup = new THREE.Group();
    scene.add(skyGroup);
    pointsOf(sky, skyGroup);

    const coreG = new THREE.Group();
    root.add(coreG);
    const core = stars();
    const LAT = 22;
    for (let i = 1; i < LAT; i++) {
      const phi = (i / LAT) * Math.PI;
      const n = Math.max(6, Math.round(Math.sin(phi) * 58 * density));
      for (let j = 0; j < n; j++) {
        const th = (j / n) * Math.PI * 2;
        const r = 0.56;
        put(core, r * Math.sin(phi) * Math.cos(th), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(th), { delay: 0.25 + rand() * 0.35, size: 1.5, alpha: 0.34, color: WHITE, u: j / n, glint: 0.25 });
      }
    }
    for (let i = 0; i < Math.round(650 * density); i++) {
      const v = new THREE.Vector3(gauss(), gauss(), gauss()).multiplyScalar(0.16);
      put(core, v.x, v.y, v.z, { delay: 0.15 + rand() * 0.3, size: 1.5 + rand() * 1.1, alpha: Math.max(0.1, 0.5 - v.length() * 1.6), color: WHITE });
    }
    for (let k = 0; k < 6; k++) {
      const e = new THREE.Euler(rand() * Math.PI, rand() * Math.PI, rand() * Math.PI);
      const r = 0.72 + k * 0.05;
      const n = Math.round(260 * density);
      for (let j = 0; j < n; j++) {
        const th = (j / n) * Math.PI * 2;
        const v = new THREE.Vector3(r * Math.cos(th), 0, r * Math.sin(th)).applyEuler(e);
        put(core, v.x, v.y, v.z, { delay: 0.35 + k * 0.06 + (j / n) * 0.3, size: 1.15, alpha: 0.2, color: WHITE, u: j / n, glint: 0.6 });
      }
    }
    pointsOf(core, coreG);

    const rigs: Rig[] = ORBITS.map((o, i) => {
      const tilt = new THREE.Group();
      tilt.rotation.set(o.rx, 0, o.rz);
      root.add(tilt);
      const spin = new THREE.Group();
      tilt.add(spin);
      const s = stars();
      const base = 0.55 + i * 0.32;
      const n = Math.round((1300 + o.r * 430) * density);
      const c = new THREE.Color();
      for (let j = 0; j < n; j++) {
        const u = j / n;
        const th = u * Math.PI * 2;
        const rr = o.r + gauss() * 0.006 * o.r;
        if (o.sol) solAt(u, c).lerp(WHITE, 0.18);
        else c.copy(WHITE);
        put(s, rr * Math.cos(th), gauss() * 0.006, rr * Math.sin(th), { delay: base + u * 0.55 + rand() * 0.12, size: o.sol ? 1.65 : 1.4, alpha: o.sol ? 0.5 : 0.34, color: c, u, glint: o.sol ? 1 : 0.55 });
      }
      for (let j = 0; j < Math.round(900 * density); j++) {
        const u = rand();
        const th = u * Math.PI * 2;
        const rr = o.r + gauss() * 0.055 * o.r;
        if (o.sol) solAt(u, c).lerp(WHITE, 0.4);
        else c.copy(WHITE);
        put(s, rr * Math.cos(th), gauss() * 0.03 * o.r, rr * Math.sin(th), { delay: base + 0.2 + rand() * 0.7, size: 1.05 + rand() * 0.8, alpha: 0.05 + rand() * 0.09, color: c, u, glint: 0.15 });
      }
      pointsOf(s, spin);
      const b = buf();
      for (let f = 0; f < 26; f++) {
        const dr = gauss() * 0.08 * o.r;
        const sx = 1 + gauss() * 0.014, sz = 1 + gauss() * 0.014;
        const from = rand() * Math.PI * 2;
        const span = Math.PI * (1.2 + rand() * 0.8);
        ring(b, o.r + dr, gauss() * 0.025, gauss() * 0.025, 0.035 + rand() * 0.09, 160, 0.4 + i * 0.12 + rand() * 0.25, sx, sz, from, span);
      }
      lines(b, spin, lineMat(o.sol ? SOL[1].clone().lerp(WHITE, 0.55) : WHITE, 0.7, 52 + i * 9, 0.45 + i * 0.05));
      return { tilt, spin, speed: ORBIT_SPEED[i], m: new THREE.Matrix4() };
    });
    const syncRigs = (age: number) => {
      for (const r of rigs) {
        r.spin.rotation.y = reduce ? 0 : age * r.speed;
        r.tilt.updateMatrix();
        r.spin.updateMatrix();
        r.m.multiplyMatrices(r.tilt.matrix, r.spin.matrix);
      }
    };
    syncRigs(0);

    const frame = stars();
    const fr = Math.round(2600 * density);
    for (let j = 0; j < fr; j++) {
      const u = j / fr;
      const th = u * Math.PI * 2;
      put(frame, HORIZON * Math.cos(th), 0, HORIZON * Math.sin(th), { delay: 2.0 + u * 0.7, size: 1.3, alpha: 0.3, color: WHITE, u, glint: 0.35 });
    }
    for (let deg = 0; deg < 360; deg += 2) {
      const th = (deg / 180) * Math.PI;
      const big = deg % 10 === 0;
      const len = big ? 0.26 : 0.1;
      const steps = big ? 7 : 3;
      for (let q = 0; q < steps; q++) {
        const r = HORIZON + 0.12 + (q / (steps - 1)) * len;
        put(frame, r * Math.cos(th), 0, r * Math.sin(th), { delay: 2.2 + (deg / 360) * 0.7, size: 1.2, alpha: big ? 0.42 : 0.22, color: WHITE, u: deg / 360 });
      }
    }
    for (let j = 0; j < Math.round(2400 * density); j++) {
      const a = rand() * Math.PI * 2, r = 4.95 + Math.pow(rand(), 0.7) * 3.4;
      const c = solAt(a / (Math.PI * 2)).lerp(WHITE, 0.55);
      put(frame, r * Math.cos(a), gauss() * 0.3, r * Math.sin(a), { delay: 2.3 + rand() * 0.9, size: 1.2 + rand() * 1.3, alpha: 0.06 + rand() * 0.2, color: c, tw: 0.5 + rand() * 1.5 });
    }
    pointsOf(frame, root);

    const provs = new Map<string, Prov>();
    for (const p of rehearsal.providers) {
      const [oi, th] = NAMED[p.name] ?? [3, rand() * 6.28];
      const rig = rigs[oi];
      const local = ringPoint(ORBITS[oi].r, 0, 0, th);
      const node: Node = { pos: local.clone().applyMatrix4(rig.m), size: 13, alpha: 0.9, kind: 1, flare: 0, flareColor: WHITE.clone(), down: 0 };
      const shell = stars();
      for (let i = 1; i < 10; i++) {
        const phi = (i / 10) * Math.PI;
        const n = Math.max(5, Math.round(Math.sin(phi) * 22));
        for (let j = 0; j < n; j++) {
          const a = (j / n) * Math.PI * 2;
          const r = 0.15;
          put(shell, local.x + r * Math.sin(phi) * Math.cos(a), local.y + r * Math.cos(phi), local.z + r * Math.sin(phi) * Math.sin(a), { delay: 1.4 + oi * 0.18 + rand() * 0.3, size: 1.2, alpha: 0.42, color: WHITE });
        }
      }
      pointsOf(shell, rig.spin);
      const trips = rehearsal.trips.filter((t) => t.provider === p.name).length;
      const traffic = buf();
      const n = hero ? 8 + trips * 2 : 14 + trips * 4;
      for (let s = 0; s < n; s++) {
        const lift = 0.7 + rand() * 0.9;
        const ctrl = local.clone().multiplyScalar(0.5 + gauss() * 0.06).add(new THREE.Vector3(gauss() * 0.25, lift, gauss() * 0.25));
        const pts = new THREE.QuadraticBezierCurve3(new THREE.Vector3(), ctrl, local).getPoints(60);
        const alpha = (hero ? 0.04 : 0.08) + rand() * (hero ? 0.05 : 0.08);
        for (let i = 0; i < pts.length - 1; i++) seg(traffic, pts[i], pts[i + 1], 1.6 + i / 120, alpha);
      }
      lines(traffic, rig.spin, lineMat(hero ? WHITE : GREEN.clone().lerp(WHITE, 0.35), 0.9, 46, 2.4 + rand()));
      const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(), local.clone().multiplyScalar(0.5).add(new THREE.Vector3(0, 1.15, 0)), local.clone());
      const arcBuf = buf();
      const pts = curve.getPoints(80);
      for (let i = 0; i < pts.length - 1; i++) seg(arcBuf, pts[i], pts[i + 1], 1.6 + i / 160, 0.26);
      const mat = lineMat(WHITE, 0.5, 70, 3.2);
      lines(arcBuf, rig.spin, mat);
      provs.set(p.name, { node, local, rig, curve, mat, tint: 0 });
    }

    const peers: THREE.Vector3[] = [];
    const peerStars = stars();
    const threads = buf();
    const PEERS = hero ? 18 : 22;
    for (let i = 0; i < PEERS; i++) {
      const a = (i / PEERS) * Math.PI * 2 + (rand() - 0.5) * 0.3;
      const r = 5.5 + rand() * 4.4;
      const p = new THREE.Vector3(r * Math.cos(a), (rand() - 0.42) * 2.8, r * Math.sin(a));
      peers.push(p);
      const d0 = 2.5 + rand() * 0.9;
      for (let k = 0; k < 64; k++) {
        const v = new THREE.Vector3(gauss(), gauss(), gauss()).normalize().multiplyScalar(0.085);
        put(peerStars, p.x + v.x, p.y + v.y, p.z + v.z, { delay: d0, size: 1.25, alpha: 0.5, color: WHITE });
      }
      const e = new THREE.Euler((rand() - 0.5) * 0.9, 0, (rand() - 0.5) * 0.9);
      for (let k = 0; k < 72; k++) {
        const th = (k / 72) * Math.PI * 2;
        const v = new THREE.Vector3(0.21 * Math.cos(th), 0, 0.21 * Math.sin(th)).applyEuler(e).add(p);
        put(peerStars, v.x, v.y, v.z, { delay: d0 + 0.15 + (k / 72) * 0.35, size: 1, alpha: 0.26, color: WHITE, u: k / 72, glint: 0.5 });
      }
    }
    pointsOf(peerStars, root);
    for (let i = 0; i < PEERS; i++) {
      const j = (i + 1 + Math.floor(rand() * 3)) % PEERS;
      const A = peers[i], B = peers[j];
      const ctrl = A.clone().add(B).multiplyScalar(0.5).add(new THREE.Vector3(0, 0.5 + A.distanceTo(B) * 0.08, 0));
      const pts = new THREE.QuadraticBezierCurve3(A, ctrl, B).getPoints(48);
      for (let k = 0; k < pts.length - 1; k++) seg(threads, pts[k], pts[k + 1], 2.6 + k / 96, 0.045);
    }
    lines(threads, root, lineMat(WHITE, 0.8, 40, 1.4));

    const nodes: Node[] = [];
    const coreNode: Node = { pos: new THREE.Vector3(), size: 24, alpha: 0.85, kind: 1, flare: 0, flareColor: WHITE.clone(), down: 0 };
    nodes.push(coreNode);
    nodes.push({ pos: coreNode.pos, size: 220, alpha: 0.7, kind: 4, flare: 0, flareColor: WHITE.clone(), down: 0 });
    for (const pv of provs.values()) {
      nodes.push(pv.node);
      nodes.push({ pos: pv.node.pos, size: 24, alpha: 0.7, kind: 3, flare: 0, flareColor: WHITE.clone(), down: 0 });
    }
    const nPos = new Float32Array(nodes.length * 3), nSize = new Float32Array(nodes.length), nAlpha = new Float32Array(nodes.length);
    const nColor = new Float32Array(nodes.length * 3), nKind = new Float32Array(nodes.length);
    nodes.forEach((n, i) => (nKind[i] = n.kind));
    const nGeo = new THREE.BufferGeometry();
    const nPosA = new THREE.BufferAttribute(nPos, 3), nSizeA = new THREE.BufferAttribute(nSize, 1), nAlphaA = new THREE.BufferAttribute(nAlpha, 1), nColorA = new THREE.BufferAttribute(nColor, 3);
    nGeo.setAttribute('position', nPosA);
    nGeo.setAttribute('aSize', nSizeA);
    nGeo.setAttribute('aAlpha', nAlphaA);
    nGeo.setAttribute('aColor', nColorA);
    nGeo.setAttribute('aKind', new THREE.BufferAttribute(nKind, 1));
    disposables.push(nGeo);
    const nodeUniforms = { uScale: starUniforms.uScale, uCenter: shared.uCenter, uDepth: shared.uDepth };
    const nodeMat = new THREE.ShaderMaterial({
      vertexShader: NODE_VS, fragmentShader: NODE_FS, uniforms: nodeUniforms, transparent: true, depthWrite: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    });
    disposables.push(nodeMat);
    const nodePts = new THREE.Points(nGeo, nodeMat);
    nodePts.frustumCulled = false;
    root.add(nodePts);

    const TRAIL = 46, MAXP = 10, STEP = 0.0085;
    const qPos = new Float32Array(MAXP * TRAIL * 3), qSize = new Float32Array(MAXP * TRAIL), qAlpha = new Float32Array(MAXP * TRAIL);
    const qColor = new Float32Array(MAXP * TRAIL * 3), qKind = new Float32Array(MAXP * TRAIL);
    const qGeo = new THREE.BufferGeometry();
    const qa = {
      pos: new THREE.BufferAttribute(qPos, 3),
      size: new THREE.BufferAttribute(qSize, 1),
      alpha: new THREE.BufferAttribute(qAlpha, 1),
      color: new THREE.BufferAttribute(qColor, 3),
      kind: new THREE.BufferAttribute(qKind, 1),
    };
    qGeo.setAttribute('position', qa.pos);
    qGeo.setAttribute('aSize', qa.size);
    qGeo.setAttribute('aAlpha', qa.alpha);
    qGeo.setAttribute('aColor', qa.color);
    qGeo.setAttribute('aKind', qa.kind);
    disposables.push(qGeo);
    const qPoints = new THREE.Points(qGeo, nodeMat);
    qPoints.frustumCulled = false;
    root.add(qPoints);

    const MT = 30, MAXM = 14;
    const mPos = new Float32Array(MAXM * MT * 3), mSize = new Float32Array(MAXM * MT), mAlpha = new Float32Array(MAXM * MT);
    const mColor = new Float32Array(MAXM * MT * 3), mKind = new Float32Array(MAXM * MT);
    const mGeo = new THREE.BufferGeometry();
    const ma = {
      pos: new THREE.BufferAttribute(mPos, 3),
      size: new THREE.BufferAttribute(mSize, 1),
      alpha: new THREE.BufferAttribute(mAlpha, 1),
      color: new THREE.BufferAttribute(mColor, 3),
      kind: new THREE.BufferAttribute(mKind, 1),
    };
    mGeo.setAttribute('position', ma.pos);
    mGeo.setAttribute('aSize', ma.size);
    mGeo.setAttribute('aAlpha', ma.alpha);
    mGeo.setAttribute('aColor', ma.color);
    mGeo.setAttribute('aKind', ma.kind);
    disposables.push(mGeo);
    const mPoints = new THREE.Points(mGeo, nodeMat);
    mPoints.frustumCulled = false;
    root.add(mPoints);
    const mesh: Mesh[] = [];
    const provList = [...provs.values()];
    let nextMesh = 0;
    const spawnMesh = () => {
      if (mesh.length >= MAXM - 1) return;
      const src = peers[Math.floor(rand() * peers.length)];
      const toProv = rand() < 0.62;
      const prov = toProv ? provList[Math.floor(rand() * provList.length)] : null;
      const dst = prov ? null : peers[Math.floor(rand() * peers.length)];
      if (dst === src) return;
      const from = () => src;
      const to = prov ? () => prov.node.pos : () => dst!;
      mesh.push({ from, to, t: 0, dur: 1.6 + rand() * 1.1, back: false, lift: 0.4 + rand() * 0.9, prov, done: false });
    };
    const mA = new THREE.Vector3(), mB = new THREE.Vector3(), mC = new THREE.Vector3(), mP = new THREE.Vector3();
    const meshAt = (m: Mesh, s: number, out: THREE.Vector3) => {
      mA.copy(m.back ? m.to() : m.from());
      mB.copy(m.back ? m.from() : m.to());
      mC.copy(mA).add(mB).multiplyScalar(0.5);
      mC.y += m.lift + mA.distanceTo(mB) * 0.1;
      const u = 1 - s;
      return out.set(u * u * mA.x + 2 * u * s * mC.x + s * s * mB.x, u * u * mA.y + 2 * u * s * mC.y + s * s * mB.y, u * u * mA.z + 2 * u * s * mC.z + s * s * mB.z);
    };

    const beamUniforms = { uTime: shared.uTime, uLen: { value: 3 }, uIntro: starUniforms.uIntro, uPulse: { value: -1 }, uScale: starUniforms.uScale, uColor: { value: PURPLE.clone() } };
    const BEAM = hero ? Math.round(1400 * density) : 0;
    const bSeed = new Float32Array(BEAM), bJit = new Float32Array(BEAM * 2), bBright = new Float32Array(BEAM);
    for (let i = 0; i < BEAM; i++) {
      bSeed[i] = rand();
      bJit[i * 2] = gauss();
      bJit[i * 2 + 1] = gauss();
      bBright[i] = Math.pow(rand(), 3);
    }
    const bGeo = new THREE.BufferGeometry();
    bGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(BEAM * 3), 3));
    bGeo.setAttribute('aSeed', new THREE.BufferAttribute(bSeed, 1));
    bGeo.setAttribute('aJit', new THREE.BufferAttribute(bJit, 2));
    bGeo.setAttribute('aBright', new THREE.BufferAttribute(bBright, 1));
    disposables.push(bGeo);
    const beamMat = new THREE.ShaderMaterial({
      vertexShader: BEAM_VS, fragmentShader: BEAM_FS, uniforms: beamUniforms, transparent: true, depthWrite: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    });
    disposables.push(beamMat);
    const beam = new THREE.Points(bGeo, beamMat);
    beam.frustumCulled = false;
    if (hero) scene.add(beam);
    let beamPulseAt = -1;

    const pulses: Pulse[] = [];
    const tmp = new THREE.Vector3();
    const along = (q: Pulse, s: number, out: THREE.Vector3) => q.prov.curve.getPoint(q.back ? 1 - s : s, out).applyMatrix4(q.prov.rig.m);

    let outRest: { prov: Prov; until: number; alt: boolean } | null = null;
    let paidRest: { start: number; until: number; alt: boolean } | null = null;

    const fly = (name: string, back: boolean, sealed: boolean, dur: number, label: string, done: () => void, fade = false, wait = 0) => {
      const prov = provs.get(name);
      if (!prov) return done();
      if (reduce) return void setTimeout(done, 300);
      if (pulses.length >= MAXP) pulses.shift()?.done();
      pulses.push({ prov, t: 0, dur, back, sealed, done, fade, label, chose: false, alt: false, wait, side: 0 });
    };
    const send = hero ? emit : () => {};
    const run = (trip: RTrip) => {
      send('orrery:sent', { trip, at: performance.now() });
      beamPulseAt = performance.now();
      const pv = provs.get(trip.provider);
      const word = `${trip.model}${trip.route === 'auto' ? '' : ROUTE_WORD[trip.route]}`;
      const go = () => {
        coreNode.flare = 1;
        coreNode.flareColor.copy(PURPLE);
        fly(trip.provider, false, trip.sealed, 2.4, word, () => {
          if (pv) {
            outRest = { prov: pv, until: performance.now() + 1150, alt: lastOut?.alt ?? false };
            pv.node.flare = 1;
            pv.node.flareColor.copy(PURPLE);
          }
          send('orrery:served', { trip });
          fly(trip.provider, true, false, 2.2, `$${trip.cost} paid`, () => {
            const now = performance.now();
            paidRest = { start: now, until: now + 2400, alt: lastBack?.alt ?? false };
            coreNode.flare = 1;
            coreNode.flareColor.copy(GREEN);
            if (pv) {
              pv.node.flare = 0.8;
              pv.node.flareColor.copy(GREEN);
              pv.tint = 1;
            }
            send('orrery:paid', { trip });
          }, false, 0.95);
        }, false, hero ? 0.55 : 0);
      };
      if (trip.fellThrough) {
        const first = 'Kestrel GPU Co-op';
        fly(first, false, false, 1.8, 'no answer', () => {
          const k = provs.get(first);
          if (k) k.node.down = 1;
          go();
        }, true, hero ? 0.55 : 0);
      } else go();
    };

    let cursor = 0, nextAuto = 0, holdUntil = 0;
    let lastOut: Pulse | null = null, lastBack: Pulse | null = null, outHold = 0, backHold = 0;
    const shownAt = new Map<HTMLElement, number>();
    const offFire = hero
      ? on('orrery:fire', ({ route }) => {
          const trip = rehearsal.trips.find((t) => t.route === route && !t.fellThrough);
          if (!trip) return;
          holdUntil = performance.now() + 7000;
          run(trip);
        })
      : () => {};
    const offArrive = hero
      ? () => {}
      : on('orrery:arrive', () => {
          coreNode.flare = 1;
          coreNode.flareColor.copy(GREEN);
        });

    type Chip = { el: HTMLElement; anchor: THREE.Vector3 | null; key: string; w: number; h: number; side: 1 | -1; on: boolean; swapAt: number };
    const chips: Chip[] = [];
    const anchorFor = (key: string): THREE.Vector3 | null => {
      if (key === 'you') return coreNode.pos;
      if (key.startsWith('p:')) return provs.get(key.slice(2))?.node.pos ?? null;
      if (key.startsWith('r:')) {
        const at = ROUTE_AT.find(([r]) => r === key.slice(2));
        return at ? ringPoint(HORIZON + 0.55, 0, 0, at[1]) : null;
      }
      return null;
    };
    layer.querySelectorAll<HTMLElement>('[data-anchor]').forEach((c) => {
      const key = c.dataset.anchor!;
      c.style.visibility = 'visible';
      chips.push({ el: c, anchor: anchorFor(key), key, w: 0, h: 0, side: 1, on: false, swapAt: 0 });
    });
    const follow = { out: layer.querySelector<HTMLElement>('[data-follow="out"]'), back: layer.querySelector<HTMLElement>('[data-follow="back"]') };
    const measure = () => chips.forEach((c) => ((c.w = c.el.offsetWidth), (c.h = c.el.offsetHeight)));

    let W = 1, H = 1, mobile = false, corePx = 30, baseTilt = 0.3;
    const v3 = new THREE.Vector3(), mv = new THREE.Vector3();
    const project = (p: THREE.Vector3, viaRoot = true) => {
      v3.copy(p);
      if (viaRoot) v3.applyMatrix4(root.matrixWorld);
      mv.copy(v3).applyMatrix4(camera.matrixWorldInverse);
      const front = clamp01(0.5 + (mv.z - shared.uCenter.value) / shared.uDepth.value);
      v3.project(camera);
      return { x: (v3.x * 0.5 + 0.5) * W, y: (-v3.y * 0.5 + 0.5) * H, front };
    };
    const fitBeam = () => {
      if (!hero) return;
      const bar = el.parentElement?.querySelector<HTMLElement>('.req__bar');
      if (!bar) return;
      const hr = el.getBoundingClientRect();
      const target = bar.getBoundingClientRect().top - hr.top + 6;
      camera.updateMatrixWorld();
      let lo = 0, hi = 30;
      for (let i = 0; i < 26; i++) {
        const mid = (lo + hi) / 2;
        const y = project(new THREE.Vector3(0, -mid, 0), false).y;
        if (y < target) lo = mid;
        else hi = mid;
      }
      beamUniforms.uLen.value = lo;
    };
    const resize = () => {
      W = el.clientWidth;
      H = el.clientHeight;
      mobile = W < 760;
      renderer.setSize(W, H, false);
      composer.setSize(W, H);
      bloom.resolution.set(W * (lite ? 0.5 : 0.75), H * (lite ? 0.5 : 0.75));
      camera.aspect = W / H;
      baseTilt = mobile ? 0.48 : 0.32;
      root.rotation.x = baseTilt;
      const halfV = Math.tan((camera.fov / 2) * (Math.PI / 180));
      const target = hero ? (mobile ? W * 0.47 : Math.min(W * 0.4, H * 0.43)) : mobile ? W * 0.5 : Math.min(W * 0.4, H * 0.6);
      const dist = (HORIZON * (H / 2)) / (target * halfV);
      camera.position.set(0, 0, dist);
      camera.lookAt(0, 0, 0);
      camera.setViewOffset(W, H, 0, hero ? H * (mobile ? 0.04 : 0.0) : H * (mobile ? 0.1 : 0.06), W, H);
      camera.updateProjectionMatrix();
      shared.uCenter.value = -dist;
      corePx = (0.85 / (dist * halfV)) * (H / 2);
      starUniforms.uScale.value = (H / 900) * 44 * (mobile ? 0.9 : 1) * (dpr / 1.5);
      layer.classList.toggle('is-mobile', mobile);
      measure();
      fitBeam();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    document.fonts?.ready.then(() => {
      measure();
      fitBeam();
    });

    let spin = hero ? 0.4 : 1.6, vel = 0, dragging = false, lastX = 0, lastDrag = -1e9;
    const down = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest('button,a,input,textarea,[data-orrery-clear]')) return;
      dragging = true;
      lastX = e.clientX;
    };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      lastX = e.clientX;
      vel = dx * 0.004;
      spin += vel;
      lastDrag = performance.now();
    };
    const up = () => (dragging = false);
    el.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);

    let visible = true;
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting), { threshold: 0.02 });
    io.observe(el);

    type Box = [number, number, number, number];
    const placeChips = (nowMs: number) => {
      const hostRect = el.getBoundingClientRect();
      const taken: Box[] = [];
      el.parentElement?.querySelectorAll<HTMLElement>('[data-orrery-clear]').forEach((x) => {
        const ex = x.getBoundingClientRect();
        taken.push([ex.left - hostRect.left - 10, ex.top - hostRect.top - 10, ex.right - hostRect.left + 10, ex.bottom - hostRect.top + 8]);
      });
      const c0 = project(coreNode.pos);
      const coreBox: Box = [c0.x - corePx, c0.y - corePx, c0.x + corePx, c0.y + corePx];
      taken.push(coreBox);
      const top = 72;
      const overlaps = (b: Box, t: Box) => !(b[2] < t[0] || b[0] > t[2] || b[3] < t[1] || b[1] > t[3]);
      const hit = (b: Box) => taken.some((t) => overlaps(b, t));
      const hitChips = (b: Box) => taken.some((t) => t !== coreBox && overlaps(b, t));
      const ready = starUniforms.uIntro.value > 3.2;
      for (const c of chips) {
        const route = c.key.startsWith('r:');
        if (!c.anchor || (mobile && route)) {
          c.el.style.opacity = '0';
          c.el.style.pointerEvents = 'none';
          c.on = false;
          continue;
        }
        const p = project(c.anchor);
        const gap = route ? 0 : c.key === 'you' ? corePx + 10 : 18;
        const at = (side: 1 | -1): Box | null => {
          const left = route ? p.x - c.w / 2 : side === 1 ? p.x + gap : p.x - gap - c.w;
          const tp = p.y - c.h / 2;
          const b: Box = [left, tp, left + c.w, tp + c.h];
          const inside = left >= 16 && b[2] <= W - 16 && tp >= top && b[3] <= H - 8;
          return inside && !hit(b) ? b : null;
        };
        let side = c.side;
        let box = at(side);
        if (!box) {
          const alt = at((-side) as 1 | -1);
          if (alt) {
            side = (-side) as 1 | -1;
            box = alt;
          }
        }
        const frontOk = !route || p.front > (c.on ? 0.42 : 0.48);
        if (!ready || !box || !frontOk) {
          c.el.style.opacity = '0';
          c.el.style.pointerEvents = 'none';
          c.on = false;
          c.swapAt = 0;
          continue;
        }
        if (c.on && side !== c.side && !c.swapAt) c.swapAt = nowMs + 230;
        if (c.swapAt && nowMs < c.swapAt) {
          c.el.style.opacity = '0';
          taken.push(box);
          continue;
        }
        c.swapAt = 0;
        c.side = side;
        taken.push(box);
        c.el.style.transform = `translate3d(${box[0].toFixed(1)}px, ${box[1].toFixed(1)}px, 0)`;
        c.el.classList.toggle('is-left', side === -1);
        c.el.style.opacity = '1';
        c.el.style.pointerEvents = route ? 'auto' : 'none';
        c.on = true;
      }

      const show = (elx: HTMLElement, x: number, y: number, fw: number) => {
        const cx = Math.min(W - 16 - fw, Math.max(16, x));
        elx.style.transform = `translate3d(${cx.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
        const on = y >= top - 8;
        elx.style.opacity = on ? '1' : '0';
        if (on) shownAt.set(elx, nowMs);
      };
      const hide = (elx: HTMLElement) => (elx.style.opacity = '0');
      const handoff = (elx: HTMLElement) => nowMs - (shownAt.get(elx) ?? -1e9) < 320;

      const you = chips.find((c) => c.key === 'you');
      const away = you && you.on && you.side === 1 ? -1 : 1;
      const travel = (q: Pulse, h: { x: number; y: number }, fw: number, fh: number) => {
        if (!q.side) q.side = away;
        return { x: q.side === 1 ? h.x + 12 : h.x - 12 - fw, y: h.y - fh - 10 };
      };
      const outEl = follow.out;
      if (outEl) {
        const q = [...pulses].reverse().find((x) => !x.back && !x.fade && x.wait <= 0) ?? null;
        if (q && q !== lastOut) {
          if (handoff(outEl)) outHold = nowMs + 300;
          lastOut = q;
        }
        if (nowMs < outHold) hide(outEl);
        else if (q) {
          if (outEl.textContent !== q.label) outEl.textContent = q.label;
          const fw = outEl.offsetWidth, fh = outEl.offsetHeight;
          const h = project(along(q, easeInOut(q.t), tmp));
          const pp = project(q.prov.node.pos);
          if (q.t > 0.7 && !q.chose) {
            q.chose = true;
            q.alt = hit([pp.x - fw / 2, pp.y + 22, pp.x + fw / 2, pp.y + 22 + fh]);
          }
          const rx = pp.x - fw / 2, ry = q.alt ? pp.y - 22 - fh : pp.y + 22;
          const b = smooth(0.7, 1, q.t);
          const tr = travel(q, h, fw, fh);
          const x = tr.x + (rx - tr.x) * b, y = tr.y + (ry - tr.y) * b;
          if (Math.hypot(h.x - c0.x, h.y - c0.y) > corePx + 16 || q.t > 0.35) show(outEl, x, y, fw);
          else hide(outEl);
        } else if (outRest && nowMs < outRest.until) {
          const fw = outEl.offsetWidth, fh = outEl.offsetHeight;
          const pp = project(outRest.prov.node.pos);
          show(outEl, pp.x - fw / 2, outRest.alt ? pp.y - 22 - fh : pp.y + 22, fw);
        } else hide(outEl);
      }

      const backEl = follow.back;
      if (backEl) {
        const q = [...pulses].reverse().find((x) => x.back && !x.fade && x.wait <= 0) ?? null;
        if (q && q !== lastBack) {
          if (handoff(backEl)) backHold = nowMs + 300;
          lastBack = q;
          paidRest = null;
        }
        const restAt = (alt: boolean, fw: number, fh: number) => ({ x: c0.x - fw / 2, y: alt ? c0.y + corePx * 0.6 + 6 : c0.y - corePx * 0.6 - fh - 6 });
        if (nowMs < backHold) hide(backEl);
        else if (q) {
          if (backEl.textContent !== q.label) backEl.textContent = q.label;
          const fw = backEl.offsetWidth, fh = backEl.offsetHeight;
          const h = project(along(q, easeInOut(q.t), tmp));
          if (q.t > 0.68 && !q.chose) {
            q.chose = true;
            const r = restAt(false, fw, fh);
            q.alt = hitChips([r.x, r.y, r.x + fw, r.y + fh]);
          }
          const r = restAt(q.alt, fw, fh);
          const b = smooth(0.68, 1, q.t);
          const { x: tx, y: ty } = travel(q, h, fw, fh);
          const from = project(q.prov.node.pos);
          if (Math.hypot(h.x - from.x, h.y - from.y) > 48 || q.t > 0.5) show(backEl, tx + (r.x - tx) * b, ty + (r.y - ty) * b, fw);
          else hide(backEl);
        } else if (paidRest && nowMs < paidRest.until) {
          const fw = backEl.offsetWidth, fh = backEl.offsetHeight;
          const r = restAt(paidRest.alt, fw, fh);
          const k = clamp01((nowMs - paidRest.start) / (paidRest.until - paidRest.start));
          show(backEl, r.x, r.y - 6 * (1 - Math.pow(1 - k, 3)), fw);
        } else hide(backEl);
      }
    };

    const tint = new THREE.Color();
    const t0 = performance.now();
    let prev = t0, raf = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (!visible || document.hidden) {
        prev = now;
        return;
      }
      const dt = Math.min(0.05, (now - prev) / 1000);
      prev = now;
      const age = (now - t0) / 1000;
      if (!reduce) {
        shared.uTime.value = age;
        if (hero) {
          starUniforms.uIntro.value = Math.min(9, 0.2 + age * 0.95);
          shared.uDraw.value = Math.min(3, Math.max(0, age * 0.95 - 0.6));
          const sp = clamp01(window.scrollY / Math.max(1, H));
          root.rotation.x = baseTilt + sp * sp * 0.36;
        } else {
          const r = el.getBoundingClientRect();
          const k = clamp01((window.innerHeight - r.top) / (window.innerHeight * 0.85));
          const e = 1 - Math.pow(1 - k, 2);
          starUniforms.uIntro.value = 4.2 * e;
          shared.uDraw.value = 3 * e;
        }
        if (!dragging) {
          vel *= 0.94;
          spin += vel;
          if (now - lastDrag > 2400) spin += dt * 0.012;
        }
        coreG.rotation.y = age * 0.12;
        skyGroup.rotation.y = age * 0.004;
      }
      root.rotation.y = spin;
      syncRigs(age);
      for (const pv of provs.values()) pv.node.pos.copy(pv.local).applyMatrix4(pv.rig.m);

      if (beamPulseAt > 0) {
        const k = (now - beamPulseAt) / 600;
        beamUniforms.uPulse.value = k >= 1 ? -1 : 1 - k;
        if (k >= 1) beamPulseAt = -1;
      }

      const ready = starUniforms.uIntro.value > (hero ? 3.4 : 3.8);
      if (!reduce && ready && now > holdUntil && now > nextAuto) {
        if (nextAuto) {
          run(rehearsal.trips[cursor++ % rehearsal.trips.length]);
          nextAuto = now + (hero ? 4800 + Math.random() * 2000 : 2600 + Math.random() * 1200);
        } else nextAuto = now + 400;
      }
      const shown = clamp01((starUniforms.uIntro.value - 1.0) / 1.2);
      nodes.forEach((n, i) => {
        n.flare = Math.max(0, n.flare - dt * 1.4);
        n.down = Math.max(0, n.down - dt * 0.45);
        tint.copy(WHITE).lerp(n.flareColor, Math.min(1, n.flare * 1.2));
        const boost = i === 1 ? 0.32 : 1;
        nColor[i * 3] = tint.r * boost;
        nColor[i * 3 + 1] = tint.g * boost;
        nColor[i * 3 + 2] = tint.b * boost;
        const breath = n.kind === 1 && i > 0 && !reduce ? 1 + 0.08 * Math.sin(age * 1.15 + i * 1.7) : 1;
        nSize[i] = n.size * breath * (1 + n.flare * (n.kind === 4 ? 0.3 : 0.9));
        nAlpha[i] = n.alpha * (1 - n.down * 0.8) * shown * (1 + n.flare * 0.8);
        nPos[i * 3] = n.pos.x;
        nPos[i * 3 + 1] = n.pos.y;
        nPos[i * 3 + 2] = n.pos.z;
      });
      nPosA.needsUpdate = nColorA.needsUpdate = nSizeA.needsUpdate = nAlphaA.needsUpdate = true;
      for (const pv of provs.values()) {
        pv.tint = Math.max(0, pv.tint - dt * 0.35);
        (pv.mat.uniforms.uColor.value as THREE.Color).copy(WHITE).lerp(GREEN, pv.tint);
      }
      qAlpha.fill(0);
      for (let p = pulses.length - 1; p >= 0; p--) {
        const q = pulses[p];
        if (q.wait > 0) {
          q.wait -= dt;
          continue;
        }
        q.t += dt / q.dur;
        if (q.t >= 1) {
          pulses.splice(p, 1);
          q.done();
        }
      }
      pulses.forEach((q, p) => {
        if (q.wait > 0) return;
        const ease = easeInOut(q.t);
        const fadeOut = q.fade ? Math.max(0, 1 - Math.max(0, q.t - 0.55) * 2.2) : 1;
        const col = q.back ? GREEN : PURPLE;
        for (let k = 0; k < TRAIL; k++) {
          const pt = along(q, Math.max(0, ease - k * STEP), tmp);
          const idx = p * TRAIL + k;
          qPos.set([pt.x, pt.y, pt.z], idx * 3);
          qColor.set([col.r * 1.6, col.g * 1.6, col.b * 1.6], idx * 3);
          const head = k === 0;
          const f = 1 - k / TRAIL;
          qSize[idx] = head ? (q.sealed ? 26 : 20) : 8 * f + 1.5;
          qKind[idx] = head && q.sealed ? 2 : head ? 1 : 0;
          qAlpha[idx] = (head ? 1.2 : 0.6 * Math.pow(f, 1.5)) * fadeOut;
        }
      });
      qa.pos.needsUpdate = qa.size.needsUpdate = qa.alpha.needsUpdate = qa.color.needsUpdate = qa.kind.needsUpdate = true;
      if (!reduce && starUniforms.uIntro.value > 3.6 && now > nextMesh) {
        spawnMesh();
        nextMesh = now + 380 + Math.random() * 520;
      }
      mAlpha.fill(0);
      for (let i = mesh.length - 1; i >= 0; i--) {
        const m = mesh[i];
        m.t += dt / m.dur;
        if (m.t >= 1) {
          if (!m.back) {
            if (m.prov) {
              m.prov.node.flare = Math.max(m.prov.node.flare, 0.55);
              m.prov.node.flareColor.copy(PURPLE);
            }
            mesh.push({ ...m, t: 0, back: true, dur: m.dur * 0.85 });
          }
          mesh.splice(i, 1);
        }
      }
      mesh.slice(0, MAXM).forEach((m, p) => {
        const ease = easeInOut(Math.min(1, m.t));
        const col = m.back ? GREEN : PURPLE;
        for (let k = 0; k < MT; k++) {
          meshAt(m, Math.max(0, ease - k * 0.011), mP);
          const idx = p * MT + k;
          mPos[idx * 3] = mP.x;
          mPos[idx * 3 + 1] = mP.y;
          mPos[idx * 3 + 2] = mP.z;
          mColor[idx * 3] = col.r * 1.3;
          mColor[idx * 3 + 1] = col.g * 1.3;
          mColor[idx * 3 + 2] = col.b * 1.3;
          const f = 1 - k / MT;
          mSize[idx] = k === 0 ? 13 : 5 * f + 1;
          mKind[idx] = k === 0 ? 1 : 0;
          mAlpha[idx] = k === 0 ? 0.75 : 0.34 * Math.pow(f, 1.6);
        }
      });
      ma.pos.needsUpdate = ma.size.needsUpdate = ma.alpha.needsUpdate = ma.color.needsUpdate = ma.kind.needsUpdate = true;
      composer.render();
      if (hero) placeChips(now);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      offFire();
      offArrive();
      ro.disconnect();
      io.disconnect();
      el.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      for (const d of disposables) d.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [hero]);

  const fromPrice = (name: string) => {
    const p = rehearsal.providers.find((x) => x.name === name)!;
    return perM(Math.min(...p.models.map((m) => m.input)));
  };

  return (
    <div className={`orrery orrery--${variant}`} ref={host}>
      <div className="orrery__chips" ref={chipLayer}>
        {hero && (
          <>
            <div className="ochip ochip--you" data-anchor="you">
              <b>Your router</b>
              <span>127.0.0.1:7171</span>
            </div>
            {rehearsal.providers.map((p) => (
              <div key={p.name} className="ochip" data-anchor={`p:${p.name}`}>
                <b>
                  {p.name}
                  {p.enclave && <em>enclave</em>}
                </b>
                <span>
                  {p.region} · from {fromPrice(p.name)}/M
                </span>
              </div>
            ))}
            {ROUTE_AT.map(([r]) => (
              <button key={r} className="ochip ochip--route" data-anchor={`r:${r}`} onClick={() => emit('orrery:fire', { route: r })}>
                {ROUTE_WORD[r]}
              </button>
            ))}
            <span className="ofollow" data-follow="out" aria-hidden="true" />
            <span className="ofollow ofollow--paid" data-follow="back" aria-hidden="true" />
          </>
        )}
      </div>
    </div>
  );
}
