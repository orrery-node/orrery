'use client';

// The hero object: an orrery of fine lines. Your router is the core, the rehearsal's three providers sit on its orbits,
// the hollow points are open slots. Requests leave the core as light and come back green as payment. It replays the
// rehearsal's real trips and turns only when dragged; nothing follows the pointer.
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { emit, on, reducedMotion } from '@/lib/bus';
import { perM, rehearsal, ROUTE_WORD, type RTrip } from '@/lib/rehearsal';

const WHITE = new THREE.Color('#f4f4f1');
const GREEN = new THREE.Color('#14f195');
const DIM = new THREE.Color('#9b9b97');

type RingDef = { r: number; rx: number; rz: number; alpha: number; double?: number; ticks?: [number, number, number, number] };

const RINGS: RingDef[] = [
  { r: 4.35, rx: 0, rz: 0, alpha: 0.9, double: 0.09, ticks: [2, 0.07, 10, 0.2] },
  { r: 4.35, rx: Math.PI / 2, rz: 0.12, alpha: 0.5, ticks: [5, 0.08, 30, 0.2] },
  { r: 3.6, rx: 0.41, rz: -0.22, alpha: 0.72 },
  { r: 3.05, rx: -0.56, rz: 0.38, alpha: 0.62 },
  { r: 2.5, rx: 0.98, rz: 0.62, alpha: 0.62 },
  { r: 1.95, rx: -0.26, rz: -0.86, alpha: 0.66 },
  { r: 1.4, rx: 1.24, rz: 0.16, alpha: 0.52 },
  { r: 0.86, rx: 0.3, rz: 0.5, alpha: 0.55, ticks: [10, 0.05, 30, 0.1] },
];

const NAMED: Record<string, [number, number]> = {
  'Kestrel GPU Co-op': [3, 2.25],
  'Ironbridge Compute': [2, 5.75],
  'Vault Nine': [4, 1.15],
};

const ROUTE_AT: [string, number][] = [
  ['price', 3.55],
  ['speed', 5.05],
  ['privacy', 0.55],
  ['auto', 2.15],
];

const LINE_VS = `
attribute float aT; attribute float aAlpha;
uniform float uDraw; uniform float uCenter; uniform float uDepth;
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float front = clamp(0.5 + (mv.z - uCenter) / uDepth, 0.0, 1.0);
  vAlpha = aAlpha * mix(0.3, 1.0, front) * clamp((uDraw - aT) * 18.0, 0.0, 1.0);
  gl_Position = projectionMatrix * mv;
}`;
const LINE_FS = `
uniform vec3 uColor; varying float vAlpha;
void main() { gl_FragColor = vec4(uColor * vAlpha, vAlpha); }`;

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
  vAlpha = aAlpha * mix(0.25, 1.0, front) * mix(0.0, 1.0, k);
}`;
const POINT_FS = `
varying vec3 vColor; varying float vAlpha; varying float vKind;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  float a;
  if (vKind > 2.5) { a = smoothstep(0.97, 0.9, d) * smoothstep(0.8, 0.87, d); }
  else if (vKind > 1.5) { a = smoothstep(0.62, 0.5, d) * smoothstep(0.32, 0.44, d) * 0.9; }
  else if (vKind > 0.5) { a = smoothstep(0.5, 0.0, d) * 0.55 + exp(-d * d * 7.0) * 0.5; }
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

const onRing = (d: RingDef, th: number, r = d.r) =>
  new THREE.Vector3(r * Math.cos(th), 0, r * Math.sin(th)).applyEuler(new THREE.Euler(d.rx, 0, d.rz));

type Pulse = { curve: THREE.QuadraticBezierCurve3; t: number; dur: number; back: boolean; sealed: boolean; done: () => void; fade?: boolean };
type Node = { pos: THREE.Vector3; size: number; color: THREE.Color; alpha: number; kind: number; flare: number; flareColor: THREE.Color; down: number; halo?: boolean };

export default function Orrery() {
  const host = useRef<HTMLDivElement>(null);
  const chipLayer = useRef<HTMLDivElement>(null);

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
    root.rotation.x = 0.36;
    scene.add(root);
    const shared = { uDraw: { value: reduce ? 2 : 0 }, uCenter: { value: -20 }, uDepth: { value: 9 } };

    const lineMat = (alphaScale = 1, color = WHITE) =>
      new THREE.ShaderMaterial({
        vertexShader: LINE_VS,
        fragmentShader: LINE_FS,
        uniforms: { ...shared, uColor: { value: color.clone() } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });

    const lines: number[] = [];
    const lineT: number[] = [];
    const lineA: number[] = [];
    const seg = (a: THREE.Vector3, b: THREE.Vector3, t: number, alpha: number) => {
      lines.push(a.x, a.y, a.z, b.x, b.y, b.z);
      lineT.push(t, t);
      lineA.push(alpha, alpha);
    };
    RINGS.forEach((d, i) => {
      const n = 360;
      const radii = d.double ? [d.r, d.r + d.double] : [d.r];
      radii.forEach((r, j) => {
        for (let k = 0; k < n; k++) {
          const a0 = (k / n) * Math.PI * 2, a1 = ((k + 1) / n) * Math.PI * 2;
          seg(onRing(d, a0, r), onRing(d, a1, r), (k / n) * 0.8 + i * 0.05, d.alpha * (j ? 0.55 : 1));
        }
      });
      if (d.ticks) {
        const [every, len, major, mlen] = d.ticks;
        for (let deg = 0; deg < 360; deg += every) {
          const th = (deg / 180) * Math.PI;
          const big = deg % major === 0;
          const r0 = d.r + (d.double ?? 0);
          seg(onRing(d, th, r0), onRing(d, th, r0 + (big ? mlen : len)), deg / 360 * 0.8 + 0.3, d.alpha * (big ? 0.95 : 0.6));
        }
      }
    });
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    lineGeo.setAttribute('aT', new THREE.Float32BufferAttribute(lineT, 1));
    lineGeo.setAttribute('aAlpha', new THREE.Float32BufferAttribute(lineA, 1));
    root.add(new THREE.LineSegments(lineGeo, lineMat()));

    const rand = rng(0x51d);
    const nodes: Node[] = [];
    const core: Node = { pos: new THREE.Vector3(), size: 46, color: WHITE.clone(), alpha: 1, kind: 1, flare: 0, flareColor: WHITE.clone(), down: 0 };
    nodes.push(core);
    const named = new Map<string, Node>();
    for (const p of rehearsal.providers) {
      const [ri, th] = NAMED[p.name] ?? [3, rand() * 6.28];
      const n: Node = { pos: onRing(RINGS[ri], th), size: 34, color: WHITE.clone(), alpha: 1, kind: 1, flare: 0, flareColor: WHITE.clone(), down: 0 };
      nodes.push(n);
      nodes.push({ pos: n.pos.clone(), size: 34, color: WHITE.clone(), alpha: 0.8, kind: 3, flare: 0, flareColor: WHITE.clone(), down: 0, halo: true });
      named.set(p.name, n);
    }
    let guard = 0;
    while (nodes.length < 1 + rehearsal.providers.length * 2 + 30 && guard++ < 3000) {
      const ri = 2 + Math.floor(rand() * 5);
      const v = onRing(RINGS[ri], rand() * Math.PI * 2);
      if (nodes.some((n) => n.pos.distanceTo(v) < 0.75)) continue;
      nodes.push({ pos: v, size: 15, color: DIM.clone(), alpha: 0.75, kind: 2, flare: 0, flareColor: WHITE.clone(), down: 0 });
    }

    const CORE_N = 1100;
    const DUST_N = 1100;
    const total = nodes.length + CORE_N + DUST_N;
    const pPos = new Float32Array(total * 3);
    const pFrom = new Float32Array(total * 3);
    const pSize = new Float32Array(total);
    const pAlpha = new Float32Array(total);
    const pColor = new Float32Array(total * 3);
    const pDelay = new Float32Array(total);
    const pKind = new Float32Array(total);
    const scatter = (i: number, spread: number) => {
      const v = new THREE.Vector3(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1).normalize().multiplyScalar(spread * (0.6 + rand() * 0.8));
      pFrom.set([v.x, v.y, v.z], i * 3);
    };
    nodes.forEach((n, i) => {
      pPos.set([n.pos.x, n.pos.y, n.pos.z], i * 3);
      scatter(i, 9);
      pDelay[i] = 0.55 + rand() * 0.4;
    });
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let k = 0; k < CORE_N; k++) {
      const i = nodes.length + k;
      const y = 1 - (k / (CORE_N - 1)) * 2;
      const rr = Math.sqrt(1 - y * y);
      const th = golden * k;
      const R = 0.5 * Math.pow(rand(), 1.25);
      pPos.set([Math.cos(th) * rr * R, y * R, Math.sin(th) * rr * R], i * 3);
      scatter(i, 7);
      pSize[i] = 1.8 + rand() * 1.2;
      pAlpha[i] = (0.62 - R) * 1.1 + 0.14;
      pColor.set([WHITE.r, WHITE.g, WHITE.b], i * 3);
      pDelay[i] = rand() * 0.5;
      pKind[i] = 0;
    }
    for (let k = 0; k < DUST_N; k++) {
      const i = nodes.length + CORE_N + k;
      const v = new THREE.Vector3(rand() * 2 - 1, (rand() * 2 - 1) * 0.55, rand() * 2 - 1).normalize().multiplyScalar(4.9 + rand() * 3.4);
      pPos.set([v.x, v.y, v.z], i * 3);
      scatter(i, 12);
      pSize[i] = 2 + rand() * 2.4;
      pAlpha[i] = 0.08 + rand() * 0.22;
      pColor.set([DIM.r, DIM.g, DIM.b], i * 3);
      pDelay[i] = rand() * 0.9;
      pKind[i] = 0;
    }
    if (reduce) pFrom.set(pPos);
    const pGeo = new THREE.BufferGeometry();
    pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
    pGeo.setAttribute('aFrom', new THREE.BufferAttribute(pFrom, 3));
    const sizeAttr = new THREE.BufferAttribute(pSize, 1);
    const alphaAttr = new THREE.BufferAttribute(pAlpha, 1);
    const colorAttr = new THREE.BufferAttribute(pColor, 3);
    pGeo.setAttribute('aSize', sizeAttr);
    pGeo.setAttribute('aAlpha', alphaAttr);
    pGeo.setAttribute('aColor', colorAttr);
    pGeo.setAttribute('aDelay', new THREE.BufferAttribute(pDelay, 1));
    pGeo.setAttribute('aKind', new THREE.BufferAttribute(pKind, 1));
    const pointUniforms = { uScale: { value: 40 }, uIntro: { value: reduce ? 3 : 0 }, uCenter: shared.uCenter, uDepth: shared.uDepth };
    const pMat = new THREE.ShaderMaterial({ vertexShader: POINT_VS, fragmentShader: POINT_FS, uniforms: pointUniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    root.add(new THREE.Points(pGeo, pMat));

    const arcs = new Map<string, { curve: THREE.QuadraticBezierCurve3; mat: THREE.ShaderMaterial; tint: number }>();
    for (const [name, n] of named) {
      const ctrl = n.pos.clone().multiplyScalar(0.5).add(new THREE.Vector3(0, 1.1, 0)).add(n.pos.clone().normalize().multiplyScalar(0.35));
      const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(), ctrl, n.pos.clone());
      const pts = curve.getPoints(80);
      const pos: number[] = [], t: number[] = [], a: number[] = [];
      for (let i = 0; i < pts.length - 1; i++) {
        pos.push(pts[i].x, pts[i].y, pts[i].z, pts[i + 1].x, pts[i + 1].y, pts[i + 1].z);
        t.push(0.9 + i / 160, 0.9 + i / 160);
        a.push(0.24, 0.24);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('aT', new THREE.Float32BufferAttribute(t, 1));
      g.setAttribute('aAlpha', new THREE.Float32BufferAttribute(a, 1));
      const mat = lineMat();
      root.add(new THREE.LineSegments(g, mat));
      arcs.set(name, { curve, mat, tint: 0 });
    }

    const TRAIL = 22;
    const MAXP = 6;
    const qPos = new Float32Array(MAXP * TRAIL * 3);
    const qSize = new Float32Array(MAXP * TRAIL);
    const qAlpha = new Float32Array(MAXP * TRAIL);
    const qColor = new Float32Array(MAXP * TRAIL * 3);
    const qKind = new Float32Array(MAXP * TRAIL);
    const qGeo = new THREE.BufferGeometry();
    const qPosAttr = new THREE.BufferAttribute(qPos, 3);
    const qSizeAttr = new THREE.BufferAttribute(qSize, 1);
    const qAlphaAttr = new THREE.BufferAttribute(qAlpha, 1);
    const qColorAttr = new THREE.BufferAttribute(qColor, 3);
    const qKindAttr = new THREE.BufferAttribute(qKind, 1);
    qGeo.setAttribute('position', qPosAttr);
    qGeo.setAttribute('aFrom', qPosAttr);
    qGeo.setAttribute('aSize', qSizeAttr);
    qGeo.setAttribute('aAlpha', qAlphaAttr);
    qGeo.setAttribute('aColor', qColorAttr);
    qGeo.setAttribute('aKind', qKindAttr);
    qGeo.setAttribute('aDelay', new THREE.BufferAttribute(new Float32Array(MAXP * TRAIL), 1));
    const qMat = new THREE.ShaderMaterial({ vertexShader: POINT_VS, fragmentShader: POINT_FS, uniforms: { ...pointUniforms, uIntro: { value: 3 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const qPoints = new THREE.Points(qGeo, qMat);
    qPoints.frustumCulled = false;
    root.add(qPoints);
    const pulses: Pulse[] = [];

    const fly = (name: string, back: boolean, sealed: boolean, dur: number, done: () => void, fade = false) => {
      const arc = arcs.get(name);
      if (!arc) return done();
      if (reduce) return void setTimeout(done, 300);
      if (pulses.length >= MAXP) pulses.shift()?.done();
      pulses.push({ curve: arc.curve, t: 0, dur, back, sealed, done, fade });
    };

    const run = (trip: RTrip) => {
      emit('yard:sent', { trip, at: performance.now() });
      core.flare = 1;
      core.flareColor.copy(WHITE);
      const go = () =>
        fly(trip.provider, false, trip.sealed, 1.05, () => {
          const n = named.get(trip.provider);
          if (n) {
            n.flare = 1;
            n.flareColor.copy(WHITE);
          }
          emit('yard:served', { trip });
          fly(trip.provider, true, false, 1.05, () => {
            core.flare = 1;
            core.flareColor.copy(GREEN);
            if (n) {
              n.flare = 0.8;
              n.flareColor.copy(GREEN);
            }
            const a = arcs.get(trip.provider);
            if (a) a.tint = 1;
            emit('yard:paid', { trip });
          });
        });
      if (trip.fellThrough) {
        const first = 'Kestrel GPU Co-op';
        fly(first, false, false, 0.9, () => {
          const n = named.get(first);
          if (n) n.down = 1;
          go();
        }, true);
      } else go();
    };

    let cursor = 0;
    let lastAuto = 0;
    let holdUntil = 0;
    const offFire = on('yard:fire', ({ route }) => {
      const trip = rehearsal.trips.find((t) => t.route === route && !t.fellThrough);
      if (!trip) return;
      holdUntil = performance.now() + 5200;
      run(trip);
    });

    type Chip = { el: HTMLElement; anchor: THREE.Vector3; prio: number; w: number; h: number; side: 1 | -1 };
    const chips: Chip[] = [];
    const anchorFor = (key: string): THREE.Vector3 | null => {
      if (key === 'you') return new THREE.Vector3(0, 0, 0);
      if (key.startsWith('p:')) return named.get(key.slice(2))?.pos.clone() ?? null;
      if (key.startsWith('r:')) {
        const at = ROUTE_AT.find(([r]) => r === key.slice(2));
        return at ? onRing(RINGS[0], at[1], RINGS[0].r + 0.42) : null;
      }
      return null;
    };
    layer.querySelectorAll<HTMLElement>('[data-anchor]').forEach((c) => {
      const a = anchorFor(c.dataset.anchor!);
      if (!a) return c.remove();
      chips.push({ el: c, anchor: a, prio: Number(c.dataset.prio ?? 9), w: 0, h: 0, side: 1 });
    });
    chips.sort((a, b) => a.prio - b.prio);
    const measure = () => chips.forEach((c) => ((c.w = c.el.offsetWidth), (c.h = c.el.offsetHeight)));

    let W = 1, H = 1, mobile = false, corePx = 40;
    const resize = () => {
      W = el.clientWidth;
      H = el.clientHeight;
      mobile = W < 760;
      renderer.setSize(W, H, false);
      camera.aspect = W / H;
      const halfV = Math.tan((camera.fov / 2) * (Math.PI / 180));
      const target = mobile ? Math.min(W * 0.47, H * 0.3) : Math.min(W * 0.33, H * 0.44);
      const dist = (4.35 * (H / 2)) / (target * halfV);
      camera.position.set(0, 0, dist);
      camera.lookAt(0, 0, 0);
      camera.setViewOffset(W, H, 0, H * (mobile ? 0.15 : 0.135), W, H);
      corePx = (0.95 / (dist * halfV)) * (H / 2);
      camera.updateProjectionMatrix();
      shared.uCenter.value = -dist;
      pointUniforms.uScale.value = (H / 900) * 46 * (mobile ? 0.9 : 1);
      layer.classList.toggle('is-mobile', mobile);
      measure();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    document.fonts?.ready.then(measure);

    let spin = 0, vel = 0, dragging = false, lastX = 0, lastDrag = -1e9;
    const down = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest('button,a')) return;
      dragging = true;
      lastX = e.clientX;
      el.setPointerCapture?.(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      lastX = e.clientX;
      vel = dx * 0.0042;
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

    const v3 = new THREE.Vector3();
    const mv = new THREE.Vector3();
    const t0 = performance.now();
    let prev = t0;
    let raf = 0;
    const exclude = () => el.parentElement?.querySelector<HTMLElement>('[data-orrery-clear]')?.getBoundingClientRect();

    const placeChips = () => {
      const hostRect = el.getBoundingClientRect();
      const ex = exclude();
      const taken: [number, number, number, number][] = [];
      if (ex) taken.push([ex.left - hostRect.left - 8, ex.top - hostRect.top - 8, ex.right - hostRect.left + 8, ex.bottom - hostRect.top + 8]);
      const nav = 76;
      v3.set(0, 0, 0).applyMatrix4(root.matrixWorld).project(camera);
      const cx = (v3.x * 0.5 + 0.5) * W, cy = (-v3.y * 0.5 + 0.5) * H;
      const coreBox: [number, number, number, number] = [cx - corePx, cy - corePx, cx + corePx, cy + corePx];
      taken.push(coreBox);
      for (const c of chips) {
        if (mobile && c.el.dataset.anchor!.startsWith('r:')) {
          c.el.style.opacity = '0';
          c.el.style.visibility = 'hidden';
          continue;
        }
        v3.copy(c.anchor).applyMatrix4(root.matrixWorld);
        mv.copy(v3).applyMatrix4(camera.matrixWorldInverse);
        const front = Math.min(1, Math.max(0, 0.5 + (mv.z - shared.uCenter.value) / shared.uDepth.value));
        v3.project(camera);
        const x = (v3.x * 0.5 + 0.5) * W;
        const y = (-v3.y * 0.5 + 0.5) * H;
        const isRoute = c.el.dataset.anchor!.startsWith('r:');
        const isYou = c.el.dataset.anchor === 'you';
        const gap = isRoute ? 0 : isYou ? corePx + 12 : 14;
        const tryAt = (side: 1 | -1) => {
          const left = isRoute ? x - c.w / 2 : side === 1 ? x + gap : x - gap - c.w;
          const top = isRoute ? y - c.h / 2 : y - c.h / 2;
          const box: [number, number, number, number] = [left, top, left + c.w, top + c.h];
          const fits = left >= 16 && left + c.w <= W - 16 && top >= nav && top + c.h <= H - 8 && !taken.some((b) => b !== coreBox || !isYou ? !(box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3]) : false);
          return fits ? box : null;
        };
        const box = tryAt(c.side) ?? tryAt((c.side * -1) as 1 | -1);
        const shown = !!box && (isRoute ? front > 0.35 : true) && pointUniforms.uIntro.value > 1.2;
        if (box) {
          c.side = box[0] >= x ? 1 : -1;
          taken.push(box);
          c.el.style.transform = `translate3d(${box[0].toFixed(1)}px, ${box[1].toFixed(1)}px, 0)`;
          c.el.classList.toggle('is-left', c.side === -1);
        }
        c.el.style.visibility = shown ? 'visible' : 'hidden';
        c.el.style.opacity = shown ? String(isRoute ? 0.45 + front * 0.55 : 0.55 + front * 0.45) : '0';
      }
    };

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
        shared.uDraw.value = Math.min(2, age * 0.62);
        pointUniforms.uIntro.value = Math.min(3, age * 0.75);
        if (!dragging) {
          vel *= 0.94;
          spin += vel;
          if (now - lastDrag > 2400) spin += dt * 0.055;
        }
      }
      root.rotation.y = spin + 0.6;

      if (!reduce && age > 2.6 && now > holdUntil && now - lastAuto > 2600) {
        lastAuto = now;
        run(rehearsal.trips[cursor % rehearsal.trips.length]);
        cursor += 1;
      }

      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        n.flare = Math.max(0, n.flare - dt * 1.4);
        n.down = Math.max(0, n.down - dt * 0.45);
        const f = n.flare;
        const base = n.kind === 2 && !n.halo ? DIM : WHITE;
        const c = base.clone().lerp(n.flareColor, Math.min(1, f * 1.2));
        pColor.set([c.r, c.g, c.b], i * 3);
        pSize[i] = n.size * (1 + f * (i === 0 ? 0.7 : 0.9));
        pAlpha[i] = n.alpha * (1 - n.down * 0.75) * (i === 0 ? 1 : 0.95);
        pKind[i] = n.kind;
      }
      colorAttr.needsUpdate = sizeAttr.needsUpdate = alphaAttr.needsUpdate = true;
      (pGeo.getAttribute('aKind') as THREE.BufferAttribute).needsUpdate = true;

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
          continue;
        }
      }
      pulses.forEach((q, p) => {
        const ease = q.t < 0.5 ? 2 * q.t * q.t : 1 - Math.pow(-2 * q.t + 2, 2) / 2;
        for (let k = 0; k < TRAIL; k++) {
          const s = Math.max(0, ease - k * 0.022);
          const u = q.back ? 1 - s : s;
          const pt = q.curve.getPoint(u);
          const idx = p * TRAIL + k;
          qPos.set([pt.x, pt.y, pt.z], idx * 3);
          const col = q.back ? GREEN : WHITE;
          qColor.set([col.r, col.g, col.b], idx * 3);
          const head = k === 0;
          qSize[idx] = head ? (q.sealed ? 26 : 20) : 9 * (1 - k / TRAIL) + 2;
          qKind[idx] = head && q.sealed ? 2 : head ? 1 : 0;
          const fadeOut = q.fade ? Math.max(0, 1 - Math.max(0, q.t - 0.55) * 2.2) : 1;
          qAlpha[idx] = (head ? 1 : 0.55 * Math.pow(1 - k / TRAIL, 1.6)) * fadeOut;
        }
      });
      qPosAttr.needsUpdate = qSizeAttr.needsUpdate = qAlphaAttr.needsUpdate = qColorAttr.needsUpdate = qKindAttr.needsUpdate = true;

      renderer.render(scene, camera);
      placeChips();
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
  }, []);

  const fromPrice = (name: string) => {
    const p = rehearsal.providers.find((x) => x.name === name)!;
    return perM(Math.min(...p.models.map((m) => m.input)));
  };

  return (
    <div className="orrery" ref={host} aria-hidden="false">
      <div className="orrery__chips" ref={chipLayer}>
        <div className="ochip ochip--you" data-anchor="you" data-prio="0">
          <b>Your router</b>
          <span>127.0.0.1:7171</span>
        </div>
        {rehearsal.providers.map((p, i) => (
          <div key={p.name} className="ochip" data-anchor={`p:${p.name}`} data-prio={1 + i}>
            <b>
              {p.name}
              {p.enclave && <em>Enclave</em>}
            </b>
            <span>
              {p.region} · from {fromPrice(p.name)}/M
            </span>
          </div>
        ))}
        {ROUTE_AT.map(([r], i) => (
          <button key={r} className="ochip ochip--route" data-anchor={`r:${r}`} data-prio={5 + i} onClick={() => emit('yard:fire', { route: r })}>
            {ROUTE_WORD[r]}
          </button>
        ))}
      </div>
    </div>
  );
}
