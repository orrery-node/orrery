'use client';

// The hero object: a wide orrery wound from hundreds of fine filaments. Your router is the single bright core; the
// rehearsal's three providers ride its orbits. Requests leave the core as light carrying their model, and come back
// green carrying what they cost. It replays the rehearsal's real trips and turns only when dragged.
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { emit, on, reducedMotion } from '@/lib/bus';
import { perM, rehearsal, ROUTE_WORD, type RTrip } from '@/lib/rehearsal';

const WHITE = new THREE.Color('#f4f4f1');
const GREEN = new THREE.Color('#14f195');
const DIM = new THREE.Color('#8f8f8a');

type Orbit = { r: number; rx: number; rz: number };
const HORIZON = 4.6;
const ORBITS: Orbit[] = [
  { r: 1.55, rx: 0.18, rz: -0.1 },
  { r: 2.2, rx: -0.14, rz: 0.14 },
  { r: 2.85, rx: 0.11, rz: 0.2 },
  { r: 3.5, rx: -0.17, rz: -0.07 },
  { r: 4.1, rx: 0.2, rz: 0.08 },
];
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

const LINE_VS = `
attribute float aT; attribute float aAlpha;
uniform float uDraw; uniform float uCenter; uniform float uDepth;
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float front = clamp(0.5 + (mv.z - uCenter) / uDepth, 0.0, 1.0);
  vAlpha = aAlpha * mix(0.1, 1.15, front * front) * clamp((uDraw - aT) * 14.0, 0.0, 1.0);
  gl_Position = projectionMatrix * mv;
}`;
const LINE_FS = `
uniform vec3 uColor; uniform float uBoost; varying float vAlpha;
void main() { float a = min(1.0, vAlpha * uBoost); gl_FragColor = vec4(uColor * a, a); }`;

const POINT_VS = `
attribute float aSize; attribute float aAlpha; attribute vec3 aColor; attribute vec3 aFrom; attribute float aDelay; attribute float aKind;
uniform float uScale; uniform float uIntro; uniform float uCenter; uniform float uDepth;
varying vec3 vColor; varying float vAlpha; varying float vKind;
void main() {
  float k = clamp((uIntro - aDelay) / 0.55, 0.0, 1.0);
  k = 1.0 - pow(1.0 - k, 3.0);
  vec3 p = mix(aFrom, position, k);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float front = clamp(0.5 + (mv.z - uCenter) / uDepth, 0.0, 1.0);
  gl_PointSize = aSize * uScale / -mv.z;
  gl_Position = projectionMatrix * mv;
  vColor = aColor; vKind = aKind;
  vAlpha = aAlpha * mix(0.22, 1.0, front) * k;
}`;
const POINT_FS = `
varying vec3 vColor; varying float vAlpha; varying float vKind;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  float a;
  if (vKind > 3.5) { a = exp(-d * d * 4.5) * 0.55; }
  else if (vKind > 2.5) { a = smoothstep(0.97, 0.9, d) * smoothstep(0.8, 0.87, d); }
  else if (vKind > 0.5) { a = smoothstep(0.5, 0.0, d) * 0.6 + exp(-d * d * 7.0) * 0.5; }
  else { a = smoothstep(0.9, 0.2, d); }
  a *= vAlpha;
  gl_FragColor = vec4(vColor * a, a);
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
const onOrbit = (o: Orbit, th: number) => ringPoint(o.r, o.rx, o.rz, th);

type Pulse = { curve: THREE.QuadraticBezierCurve3; t: number; dur: number; back: boolean; sealed: boolean; done: () => void; fade?: boolean; label: string };
type Node = { pos: THREE.Vector3; size: number; alpha: number; kind: number; flare: number; flareColor: THREE.Color; down: number };

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
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    } catch {
      el.classList.add('orrery--off');
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    el.prepend(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 200);
    const root = new THREE.Group();
    scene.add(root);
    const shared = { uDraw: { value: reduce || !hero ? 3 : 0 }, uCenter: { value: -20 }, uDepth: { value: 8.5 }, uBoost: { value: 1.2 } };
    const rand = rng(hero ? 0x51d : 0x77a1);
    const gauss = () => (rand() + rand() + rand() - 1.5) / 1.5;

    const pos: number[] = [], ts: number[] = [], as: number[] = [];
    const seg = (a: THREE.Vector3, b: THREE.Vector3, t: number, alpha: number) => {
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
      ts.push(t, t);
      as.push(alpha, alpha);
    };
    const ring = (r: number, rx: number, rz: number, alpha: number, n: number, t0: number, sx = 1, sz = 1, from = 0, span = Math.PI * 2) => {
      for (let k = 0; k < n; k++) {
        const a0 = from + (k / n) * span, a1 = from + ((k + 1) / n) * span;
        seg(ringPoint(r, rx, rz, a0, sx, sz), ringPoint(r, rx, rz, a1, sx, sz), t0 + (k / n) * 0.9, alpha);
      }
    };

    ring(HORIZON, 0, 0, 0.9, 420, 0.05);
    ring(HORIZON + 0.1, 0, 0, 0.45, 420, 0.1);
    for (let deg = 0; deg < 360; deg += 2) {
      const th = (deg / 180) * Math.PI;
      const big = deg % 10 === 0;
      seg(ringPoint(HORIZON + 0.1, 0, 0, th), ringPoint(HORIZON + 0.1 + (big ? 0.24 : 0.09), 0, 0, th), 0.3 + (deg / 360) * 0.8, big ? 0.85 : 0.45);
    }
    for (let deg = 0; deg < 360; deg += 15) {
      const th = (deg / 180) * Math.PI;
      seg(ringPoint(HORIZON - 0.06, 0, 0, th), ringPoint(HORIZON - 0.2, 0, 0, th), 0.4 + (deg / 360) * 0.8, 0.5);
    }
    ORBITS.forEach((o, i) => {
      ring(o.r, o.rx, o.rz, 0.8, 300, 0.15 + i * 0.06);
      const strands = 56;
      for (let s = 0; s < strands; s++) {
        const dr = gauss() * 0.085 * o.r;
        const sx = 1 + gauss() * 0.014, sz = 1 + gauss() * 0.014;
        const from = rand() * Math.PI * 2;
        const span = Math.PI * (1.3 + rand() * 0.7);
        ring(o.r + dr, o.rx + gauss() * 0.025, o.rz + gauss() * 0.025, 0.12 + rand() * 0.2, 180, 0.2 + i * 0.06 + rand() * 0.2, sx, sz, from, span);
      }
    });
    ring(0.72, 0.3, 0.5, 0.6, 120, 0.05);
    for (let deg = 0; deg < 360; deg += 10) {
      const th = (deg / 180) * Math.PI;
      seg(ringPoint(0.72, 0.3, 0.5, th), ringPoint(0.8, 0.3, 0.5, th), 0.1, 0.5);
    }

    const named = new Map<string, Node>();
    const arcs = new Map<string, { curve: THREE.QuadraticBezierCurve3; mat: THREE.ShaderMaterial; tint: number }>();
    const traffic: number[] = [], trafficT: number[] = [], trafficA: number[] = [];
    for (const p of rehearsal.providers) {
      const [oi, th] = NAMED[p.name] ?? [3, rand() * 6.28];
      const at = onOrbit(ORBITS[oi], th);
      named.set(p.name, { pos: at, size: 15, alpha: 1, kind: 1, flare: 0, flareColor: WHITE.clone(), down: 0 });
      const trips = rehearsal.trips.filter((t) => t.provider === p.name).length;
      const n = hero ? 8 + trips * 2 : 14 + trips * 4;
      for (let s = 0; s < n; s++) {
        const lift = 0.7 + rand() * 0.9;
        const ctrl = at.clone().multiplyScalar(0.5 + gauss() * 0.06).add(new THREE.Vector3(gauss() * 0.25, lift, gauss() * 0.25));
        const c = new THREE.QuadraticBezierCurve3(new THREE.Vector3(), ctrl, at);
        const pts = c.getPoints(60);
        const alpha = (hero ? 0.05 : 0.1) + rand() * (hero ? 0.06 : 0.1);
        for (let i = 0; i < pts.length - 1; i++) {
          traffic.push(pts[i].x, pts[i].y, pts[i].z, pts[i + 1].x, pts[i + 1].y, pts[i + 1].z);
          trafficT.push(0.9 + i / 120, 0.9 + i / 120);
          trafficA.push(alpha, alpha);
        }
      }
      const ctrl = at.clone().multiplyScalar(0.5).add(new THREE.Vector3(0, 1.15, 0));
      const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(), ctrl, at.clone());
      const pts = curve.getPoints(80);
      const ap: number[] = [], at2: number[] = [], aa: number[] = [];
      for (let i = 0; i < pts.length - 1; i++) {
        ap.push(pts[i].x, pts[i].y, pts[i].z, pts[i + 1].x, pts[i + 1].y, pts[i + 1].z);
        at2.push(0.9 + i / 160, 0.9 + i / 160);
        aa.push(0.32, 0.32);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(ap, 3));
      g.setAttribute('aT', new THREE.Float32BufferAttribute(at2, 1));
      g.setAttribute('aAlpha', new THREE.Float32BufferAttribute(aa, 1));
      const mat = lineMat();
      root.add(new THREE.LineSegments(g, mat));
      arcs.set(p.name, { curve, mat, tint: 0 });
    }

    function lineMat(color = WHITE) {
      return new THREE.ShaderMaterial({
        vertexShader: LINE_VS,
        fragmentShader: LINE_FS,
        uniforms: { ...shared, uColor: { value: color.clone() } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
    }
    const mk = (p: number[], t: number[], a: number[], color = WHITE) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
      g.setAttribute('aT', new THREE.Float32BufferAttribute(t, 1));
      g.setAttribute('aAlpha', new THREE.Float32BufferAttribute(a, 1));
      root.add(new THREE.LineSegments(g, lineMat(color)));
    };
    mk(pos, ts, as);
    mk(traffic, trafficT, trafficA, hero ? WHITE : GREEN.clone().lerp(WHITE, 0.35));

    const nodes: Node[] = [];
    const core: Node = { pos: new THREE.Vector3(), size: 40, alpha: 1, kind: 1, flare: 0, flareColor: WHITE.clone(), down: 0 };
    nodes.push(core);
    nodes.push({ pos: new THREE.Vector3(), size: 300, alpha: 0.95, kind: 4, flare: 0, flareColor: WHITE.clone(), down: 0 });
    for (const n of named.values()) {
      nodes.push(n);
      nodes.push({ pos: n.pos.clone(), size: 22, alpha: 0.85, kind: 3, flare: 0, flareColor: WHITE.clone(), down: 0 });
    }
    const CLOUD = 700, DUST = 900;
    const total = nodes.length + CLOUD + DUST;
    const pPos = new Float32Array(total * 3), pFrom = new Float32Array(total * 3);
    const pSize = new Float32Array(total), pAlpha = new Float32Array(total), pColor = new Float32Array(total * 3);
    const pDelay = new Float32Array(total), pKind = new Float32Array(total);
    const scatter = (i: number, spread: number) => {
      const v = new THREE.Vector3(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1).normalize().multiplyScalar(spread * (0.6 + rand() * 0.8));
      pFrom.set([v.x, v.y, v.z], i * 3);
    };
    nodes.forEach((n, i) => {
      pPos.set([n.pos.x, n.pos.y, n.pos.z], i * 3);
      scatter(i, 9);
      pDelay[i] = 0.6 + rand() * 0.3;
      pKind[i] = n.kind;
    });
    for (let k = 0; k < CLOUD; k++) {
      const i = nodes.length + k;
      const v = new THREE.Vector3(gauss(), gauss(), gauss()).multiplyScalar(0.28);
      pPos.set([v.x, v.y, v.z], i * 3);
      scatter(i, 7);
      pSize[i] = 1.6 + rand() * 1.2;
      pAlpha[i] = Math.max(0.08, 0.7 - v.length() * 1.2);
      pColor.set([WHITE.r, WHITE.g, WHITE.b], i * 3);
      pDelay[i] = rand() * 0.5;
    }
    for (let k = 0; k < DUST; k++) {
      const i = nodes.length + CLOUD + k;
      const a = rand() * Math.PI * 2, r = 4.9 + Math.pow(rand(), 0.7) * 3.2;
      pPos.set([r * Math.cos(a), gauss() * 0.35, r * Math.sin(a)], i * 3);
      scatter(i, 12);
      pSize[i] = 1.6 + rand() * 2;
      pAlpha[i] = 0.06 + rand() * 0.2;
      pColor.set([DIM.r, DIM.g, DIM.b], i * 3);
      pDelay[i] = rand() * 0.9;
    }
    if (reduce || !hero) pFrom.set(pPos);
    const pGeo = new THREE.BufferGeometry();
    pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
    pGeo.setAttribute('aFrom', new THREE.BufferAttribute(pFrom, 3));
    const sizeAttr = new THREE.BufferAttribute(pSize, 1), alphaAttr = new THREE.BufferAttribute(pAlpha, 1), colorAttr = new THREE.BufferAttribute(pColor, 3);
    pGeo.setAttribute('aSize', sizeAttr);
    pGeo.setAttribute('aAlpha', alphaAttr);
    pGeo.setAttribute('aColor', colorAttr);
    pGeo.setAttribute('aDelay', new THREE.BufferAttribute(pDelay, 1));
    pGeo.setAttribute('aKind', new THREE.BufferAttribute(pKind, 1));
    const pointUniforms = { uScale: { value: 40 }, uIntro: { value: reduce || !hero ? 3 : 0 }, uCenter: shared.uCenter, uDepth: shared.uDepth };
    root.add(new THREE.Points(pGeo, new THREE.ShaderMaterial({ vertexShader: POINT_VS, fragmentShader: POINT_FS, uniforms: pointUniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })));

    const TRAIL = 24, MAXP = 10;
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
    qGeo.setAttribute('aFrom', qa.pos);
    qGeo.setAttribute('aSize', qa.size);
    qGeo.setAttribute('aAlpha', qa.alpha);
    qGeo.setAttribute('aColor', qa.color);
    qGeo.setAttribute('aKind', qa.kind);
    qGeo.setAttribute('aDelay', new THREE.BufferAttribute(new Float32Array(MAXP * TRAIL), 1));
    const qPoints = new THREE.Points(qGeo, new THREE.ShaderMaterial({ vertexShader: POINT_VS, fragmentShader: POINT_FS, uniforms: { ...pointUniforms, uIntro: { value: 3 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    qPoints.frustumCulled = false;
    root.add(qPoints);
    const pulses: Pulse[] = [];

    const fly = (name: string, back: boolean, sealed: boolean, dur: number, label: string, done: () => void, fade = false) => {
      const arc = arcs.get(name);
      if (!arc) return done();
      if (reduce) return void setTimeout(done, 300);
      if (pulses.length >= MAXP) pulses.shift()?.done();
      pulses.push({ curve: arc.curve, t: 0, dur, back, sealed, done, fade, label });
    };
    const send = hero ? emit : () => {};
    const run = (trip: RTrip) => {
      send('yard:sent', { trip, at: performance.now() });
      core.flare = 1;
      core.flareColor.copy(WHITE);
      const n = named.get(trip.provider);
      const go = () =>
        fly(trip.provider, false, trip.sealed, 2.4, `${trip.model}${trip.route === 'auto' ? '' : ROUTE_WORD[trip.route]}`, () => {
          if (n) outLinger = { label: `${trip.model}${trip.route === 'auto' ? '' : ROUTE_WORD[trip.route]}`, until: performance.now() + 1100, at: n.pos };
          if (n) {
            n.flare = 1;
            n.flareColor.copy(WHITE);
          }
          send('yard:served', { trip });
          fly(trip.provider, true, false, 2.2, `$${trip.cost} paid`, () => {
            linger = { label: `$${trip.cost} paid`, until: performance.now() + 2200 };
            core.flare = 1;
            core.flareColor.copy(GREEN);
            if (n) {
              n.flare = 0.8;
              n.flareColor.copy(GREEN);
            }
            const a = arcs.get(trip.provider);
            if (a) a.tint = 1;
            send('yard:paid', { trip });
          });
        });
      if (trip.fellThrough) {
        const first = 'Kestrel GPU Co-op';
        fly(first, false, false, 1.8, 'no answer', () => {
          const k = named.get(first);
          if (k) k.down = 1;
          go();
        }, true);
      } else go();
    };

    let cursor = 0, lastAuto = 0, holdUntil = 0;
    let linger: { label: string; until: number } | null = null;
    let outLinger: { label: string; until: number; at: THREE.Vector3 } | null = null;
    const followAt = new Map<HTMLElement, { x: number; y: number; on: boolean }>();
    const offFire = hero
      ? on('yard:fire', ({ route }) => {
          const trip = rehearsal.trips.find((t) => t.route === route && !t.fellThrough);
          if (!trip) return;
          holdUntil = performance.now() + 7000;
          run(trip);
        })
      : () => {};

    type Chip = { el: HTMLElement; anchor: THREE.Vector3 | null; key: string; w: number; h: number; side: 1 | -1 };
    const chips: Chip[] = [];
    const anchorFor = (key: string): THREE.Vector3 | null => {
      if (key === 'you') return new THREE.Vector3();
      if (key.startsWith('p:')) return named.get(key.slice(2))?.pos.clone() ?? null;
      if (key.startsWith('r:')) {
        const at = ROUTE_AT.find(([r]) => r === key.slice(2));
        return at ? ringPoint(HORIZON + 0.55, 0, 0, at[1]) : null;
      }
      return null;
    };
    layer.querySelectorAll<HTMLElement>('[data-anchor]').forEach((c) => {
      const key = c.dataset.anchor!;
      chips.push({ el: c, anchor: anchorFor(key), key, w: 0, h: 0, side: 1 });
    });
    const follow = { out: layer.querySelector<HTMLElement>('[data-follow="out"]'), back: layer.querySelector<HTMLElement>('[data-follow="back"]') };
    const measure = () => chips.forEach((c) => ((c.w = c.el.offsetWidth), (c.h = c.el.offsetHeight)));

    let W = 1, H = 1, mobile = false, corePx = 30;
    const resize = () => {
      W = el.clientWidth;
      H = el.clientHeight;
      mobile = W < 760;
      renderer.setSize(W, H, false);
      camera.aspect = W / H;
      root.rotation.x = mobile ? 0.5 : 0.3;
      const halfV = Math.tan((camera.fov / 2) * (Math.PI / 180));
      const target = hero ? (mobile ? W * 0.47 : Math.min(W * 0.42, H * 0.6)) : mobile ? W * 0.5 : Math.min(W * 0.4, H * 0.6);
      shared.uBoost.value = Math.min(1.9, 0.95 + (window.devicePixelRatio || 1) * 0.28);
      const dist = (HORIZON * (H / 2)) / (target * halfV);
      camera.position.set(0, 0, dist);
      camera.lookAt(0, 0, 0);
      camera.setViewOffset(W, H, 0, hero ? H * (mobile ? 0.19 : 0.185) : H * (mobile ? 0.1 : 0.06), W, H);
      camera.updateProjectionMatrix();
      shared.uCenter.value = -dist;
      corePx = (0.85 / (dist * halfV)) * (H / 2);
      pointUniforms.uScale.value = (H / 900) * 44 * (mobile ? 0.85 : 1);
      layer.classList.toggle('is-mobile', mobile);
      measure();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    document.fonts?.ready.then(measure);

    let spin = hero ? 0.4 : 1.6, vel = 0, dragging = false, lastX = 0, lastDrag = -1e9;
    const down = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest('button,a')) return;
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

    const v3 = new THREE.Vector3(), mv = new THREE.Vector3();
    const project = (p: THREE.Vector3) => {
      v3.copy(p).applyMatrix4(root.matrixWorld);
      mv.copy(v3).applyMatrix4(camera.matrixWorldInverse);
      const front = Math.min(1, Math.max(0, 0.5 + (mv.z - shared.uCenter.value) / shared.uDepth.value));
      v3.project(camera);
      return { x: (v3.x * 0.5 + 0.5) * W, y: (-v3.y * 0.5 + 0.5) * H, front };
    };
    const clear = () => el.parentElement?.querySelector<HTMLElement>('[data-orrery-clear]')?.getBoundingClientRect();

    const placeChips = () => {
      const host = el.getBoundingClientRect();
      const taken: [number, number, number, number][] = [];
      const ex = clear();
      if (ex) taken.push([ex.left - host.left - 6, ex.top - host.top - 10, ex.right - host.left + 6, ex.bottom - host.top + 6]);
      const c0 = project(new THREE.Vector3());
      const coreBox: [number, number, number, number] = [c0.x - corePx, c0.y - corePx, c0.x + corePx, c0.y + corePx];
      taken.push(coreBox);
      const top = 72;
      const hit = (b: [number, number, number, number]) => taken.some((t) => !(b[2] < t[0] || b[0] > t[2] || b[3] < t[1] || b[1] > t[3]));
      const ready = shared.uDraw.value > 2.1;
      for (const c of chips) {
        const route = c.key.startsWith('r:');
        if (!c.anchor || (mobile && route)) {
          c.el.style.visibility = 'hidden';
          continue;
        }
        const p = project(c.anchor);
        const gap = route ? 0 : c.key === 'you' ? corePx + 10 : 16;
        const at = (side: 1 | -1): [number, number, number, number] | null => {
          const left = route ? p.x - c.w / 2 : side === 1 ? p.x + gap : p.x - gap - c.w;
          const tp = p.y - c.h / 2;
          const b: [number, number, number, number] = [left, tp, left + c.w, tp + c.h];
          const inside = left >= 16 && b[2] <= W - 16 && tp >= top && b[3] <= H - 8;
          return inside && !hit(b) ? b : null;
        };
        const box = at(c.side) ?? at((-c.side) as 1 | -1);
        const shown = ready && !!box && (!route || p.front > 0.45);
        if (box && shown) {
          c.side = box[0] >= p.x ? 1 : -1;
          taken.push(box);
          c.el.style.transform = `translate3d(${box[0].toFixed(1)}px, ${box[1].toFixed(1)}px, 0)`;
          c.el.classList.toggle('is-left', c.side === -1);
        }
        c.el.style.visibility = shown ? 'visible' : 'hidden';
        c.el.style.opacity = shown ? '1' : '0';
      }
      const nowMs = performance.now();
      for (const [k, elx] of Object.entries(follow)) {
        if (!elx) continue;
        const back = k === 'back';
        const q = [...pulses].reverse().find((x) => x.back === back && !x.fade);
        let at: { x: number; y: number } | null = null;
        let label = '';
        let atCore = false;
        if (q && q.t > 0.04) {
          const ease = q.t < 0.5 ? 2 * q.t * q.t : 1 - Math.pow(-2 * q.t + 2, 2) / 2;
          const h = project(q.curve.getPoint(back ? 1 - ease : ease));
          if (Math.hypot(h.x - c0.x, h.y - c0.y) > corePx + 26) {
            at = h;
            label = q.label;
          } else if (back) {
            at = { x: c0.x, y: c0.y };
            label = q.label;
            atCore = true;
          }
        }
        if (!at && back && linger && nowMs < linger.until) {
          at = { x: c0.x, y: c0.y };
          label = linger.label;
          atCore = true;
        } else if (!at && !back && outLinger && nowMs < outLinger.until) {
          at = project(outLinger.at);
          label = outLinger.label;
        }
        const prevAt = followAt.get(elx);
        if (!at || at.y < 150) {
          elx.style.opacity = '0';
          if (prevAt) prevAt.on = false;
          continue;
        }
        if (elx.textContent !== label) elx.textContent = label;
        const fw = elx.offsetWidth, fh = elx.offsetHeight;
        const box = (x: number, y: number): [number, number, number, number] => [x, y, x + fw, y + fh];
        let fx = atCore ? at.x - fw / 2 : at.x + 14;
        let fy = atCore ? at.y - corePx - fh - 8 : at.y - 34;
        if (hit(box(fx, fy))) fy = atCore ? at.y + corePx + 8 : at.y + 14;
        if (!atCore && hit(box(fx, fy))) fx = at.x - 14 - fw;
        if (hit(box(fx, fy)) || fx < 16 || fx + fw > W - 16) {
          elx.style.opacity = '0';
          if (prevAt) prevAt.on = false;
          continue;
        }
        taken.push(box(fx, fy));
        const cur = prevAt && prevAt.on ? prevAt : { x: fx, y: fy, on: true };
        cur.x += (fx - cur.x) * 0.18;
        cur.y += (fy - cur.y) * 0.18;
        cur.on = true;
        followAt.set(elx, cur);
        elx.style.transform = `translate3d(${cur.x.toFixed(1)}px, ${cur.y.toFixed(1)}px, 0)`;
        elx.style.opacity = '1';
      }
    };

    const t0 = performance.now();
    let prev = t0, raf = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (!visible || document.hidden) {
        prev = now;
        return;
      }
      const dt = Math.min(0.05, (now - prev) / 1000);
      prev = now;
      const age = (now - t0) / 1000;
      if (!reduce) {
        if (hero) {
          shared.uDraw.value = Math.min(3, age * 0.7);
          pointUniforms.uIntro.value = Math.min(3, age * 0.8);
        }
        if (!dragging) {
          vel *= 0.94;
          spin += vel;
          if (now - lastDrag > 2400) spin += dt * (hero ? 0.035 : 0.03);
        }
      }
      root.rotation.y = spin;
      if (!reduce && age > (hero ? 2.4 : 0.6) && now > holdUntil && now - lastAuto > (hero ? 5200 : 3000)) {
        lastAuto = now;
        run(rehearsal.trips[cursor % rehearsal.trips.length]);
        cursor += 1;
      }
      nodes.forEach((n, i) => {
        n.flare = Math.max(0, n.flare - dt * 1.4);
        n.down = Math.max(0, n.down - dt * 0.45);
        const c = WHITE.clone().lerp(n.flareColor, Math.min(1, n.flare * 1.2));
        pColor.set([c.r, c.g, c.b], i * 3);
        pSize[i] = n.size * (1 + n.flare * (n.kind === 4 ? 0.25 : 0.8));
        pAlpha[i] = n.alpha * (1 - n.down * 0.8);
      });
      colorAttr.needsUpdate = sizeAttr.needsUpdate = alphaAttr.needsUpdate = true;
      for (const a of arcs.values()) {
        a.tint = Math.max(0, a.tint - dt * 0.35);
        (a.mat.uniforms.uColor.value as THREE.Color).copy(WHITE).lerp(GREEN, a.tint);
      }
      qAlpha.fill(0);
      for (let p = pulses.length - 1; p >= 0; p--) {
        const q = pulses[p];
        q.t += dt / q.dur;
        if (q.t >= 1) {
          pulses.splice(p, 1);
          q.done();
        }
      }
      pulses.forEach((q, p) => {
        const ease = q.t < 0.5 ? 2 * q.t * q.t : 1 - Math.pow(-2 * q.t + 2, 2) / 2;
        const fadeOut = q.fade ? Math.max(0, 1 - Math.max(0, q.t - 0.55) * 2.2) : 1;
        for (let k = 0; k < TRAIL; k++) {
          const s = Math.max(0, ease - k * 0.02);
          const pt = q.curve.getPoint(q.back ? 1 - s : s);
          const idx = p * TRAIL + k;
          qPos.set([pt.x, pt.y, pt.z], idx * 3);
          const col = q.back ? GREEN : WHITE;
          qColor.set([col.r, col.g, col.b], idx * 3);
          const head = k === 0;
          qSize[idx] = head ? (q.sealed ? 24 : 18) : 8 * (1 - k / TRAIL) + 2;
          qKind[idx] = head && q.sealed ? 2 : head ? 1 : 0;
          qAlpha[idx] = (head ? 1 : 0.6 * Math.pow(1 - k / TRAIL, 1.5)) * fadeOut;
        }
      });
      qa.pos.needsUpdate = qa.size.needsUpdate = qa.alpha.needsUpdate = qa.color.needsUpdate = qa.kind.needsUpdate = true;
      renderer.render(scene, camera);
      if (hero) placeChips();
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      offFire();
      ro.disconnect();
      io.disconnect();
      el.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
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
              <button key={r} className="ochip ochip--route" data-anchor={`r:${r}`} onClick={() => emit('yard:fire', { route: r })}>
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
