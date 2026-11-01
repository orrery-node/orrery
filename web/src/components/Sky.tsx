'use client';

// The constellation: your machine at the center, the three providers from the local rehearsal lit and named, and the
// open slots anyone could light. Requests leave as white pulses (violet when sealed), come back green as payment.
// It replays the rehearsal's real trips; nothing here follows the pointer, it only turns when dragged.
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { emit, on, reducedMotion, type Stage } from '@/lib/bus';
import { perM, rehearsal, type RProvider, type RTrip } from '@/lib/rehearsal';

const SLOTS = 84;
const FIELD = 2400;
const WHITE = new THREE.Color('#f2f0ff');
const VIOLET = new THREE.Color('#b48cff');
const GREEN = new THREE.Color('#14f195');
const CORAL = new THREE.Color('#ff7a6b');
const NODE = new THREE.Color('#dcd9f0');
const SLOT = new THREE.Color('#8d88ab');
const EDGE = new THREE.Color('#8f88c8');

type SkyNode = {
  pos: THREE.Vector3; base: THREE.Color; size: number; lit: number; litTarget: number;
  flare: number; flareColor: THREE.Color; named?: RProvider; rank: number; detail: string; detailUntil: number; paid: boolean;
};

type Pulse = { active: boolean; a: THREE.Vector3; b: THREE.Vector3; c: THREE.Vector3; t: number; dur: number; color: THREE.Color; done?: () => void };

const STAGES: Record<Stage, { dist: number; offX: number; dim: number; spin: number; every: number }> = {
  hero: { dist: 13.2, offX: 0.2, dim: 1, spin: 0.045, every: 1700 },
  routes: { dist: 11.4, offX: 0.25, dim: 1, spin: 0.03, every: 0 },
  voucher: { dist: 11.8, offX: 0.25, dim: 1, spin: 0.03, every: 1300 },
  zero: { dist: 13.6, offX: 0.25, dim: 0.95, spin: 0.035, every: 1500 },
  sealed: { dist: 10.6, offX: 0.25, dim: 1, spin: 0.03, every: 1700 },
  provide: { dist: 15.8, offX: 0.25, dim: 1, spin: 0.04, every: 650 },
  quiet: { dist: 17.5, offX: 0, dim: 0.32, spin: 0.03, every: 2600 },
};

const POINT_VS = `
attribute float aSize; attribute float aAlpha; attribute vec3 aColor;
uniform float uScale; uniform float uDim;
varying vec3 vColor; varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uScale / -mv.z;
  gl_Position = projectionMatrix * mv;
  vColor = aColor; vAlpha = aAlpha * uDim;
}`;
const POINT_FS = `
varying vec3 vColor; varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  float core = smoothstep(0.2, 0.0, d);
  float halo = exp(-d * d * 10.0) * 0.38;
  float a = (core + halo) * vAlpha;
  gl_FragColor = vec4(vColor * a, a);
}`;
const RING_FS = `
varying vec3 vColor; varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float ring = smoothstep(0.07, 0.0, abs(d - 0.82));
  float a = ring * vAlpha;
  gl_FragColor = vec4(vColor * a, a);
}`;
const LINE_VS = `
attribute float aAlpha; attribute vec3 aColor; uniform float uDim;
varying vec3 vColor; varying float vAlpha;
void main() { vColor = aColor; vAlpha = aAlpha * uDim; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const LINE_FS = `
varying vec3 vColor; varying float vAlpha;
void main() { gl_FragColor = vec4(vColor * vAlpha, vAlpha); }`;

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function material(fs: string, uniforms: Record<string, THREE.IUniform>) {
  return new THREE.ShaderMaterial({ vertexShader: fs === LINE_FS ? LINE_VS : POINT_VS, fragmentShader: fs, uniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
}

const NAMED_AT: Record<string, [number, number, number]> = {
  'Kestrel GPU Co-op': [-3.0, 1.55, 1.2],
  'Ironbridge Compute': [3.25, 0.95, -0.55],
  'Vault Nine': [1.1, -2.55, 1.85],
};

export default function Sky() {
  const host = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current!;
    const labelLayer = labelsRef.current!;
    const reduce = reducedMotion();
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    } catch {
      el.classList.add('sky--off');
      return;
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    renderer.setPixelRatio(dpr);
    renderer.setClearColor(0x060609, 1);
    el.prepend(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 400);
    const root = new THREE.Group();
    const dustGroup = new THREE.Group();
    scene.add(dustGroup, root);

    // nodes
    const rand = rng(0x5a17);
    const nodes: SkyNode[] = [];
    const you: SkyNode = { pos: new THREE.Vector3(), base: WHITE.clone(), size: 21, lit: 1, litTarget: 1, flare: 0, flareColor: GREEN.clone(), rank: -1, detail: '', detailUntil: 0, paid: false };
    nodes.push(you);
    for (const p of rehearsal.providers) {
      const at = NAMED_AT[p.name] ?? [rand() * 6 - 3, rand() * 4 - 2, rand() * 4 - 2];
      nodes.push({ pos: new THREE.Vector3(...at), base: NODE.clone(), size: 13, lit: 1, litTarget: 1, flare: 0, flareColor: WHITE.clone(), named: p, rank: -1, detail: '', detailUntil: 0, paid: false });
    }
    let guard = 0;
    while (nodes.length < 1 + rehearsal.providers.length + SLOTS && guard++ < 5000) {
      const r = 3.3 + rand() * 2.9;
      const th = rand() * Math.PI * 2;
      const ph = Math.acos(2 * rand() - 1);
      const v = new THREE.Vector3(r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph) * 0.62, r * Math.sin(ph) * Math.sin(th));
      if (nodes.some((n) => n.pos.distanceTo(v) < 1.05)) continue;
      nodes.push({ pos: v, base: SLOT.clone(), size: 8 + rand() * 3, lit: 0.2, litTarget: 0.2, flare: 0, flareColor: WHITE.clone(), rank: 0, detail: '', detailUntil: 0, paid: false });
    }
    const slots = nodes.filter((n) => n.rank === 0);
    slots.sort((a, b) => a.pos.length() - b.pos.length());
    slots.forEach((n, i) => (n.rank = i));
    const byName = new Map(nodes.filter((n) => n.named).map((n) => [n.named!.name, n]));

    const N = nodes.length;
    const pGeo = new THREE.BufferGeometry();
    const pPos = new Float32Array(N * 3), pCol = new Float32Array(N * 3), pSize = new Float32Array(N), pAlpha = new Float32Array(N);
    nodes.forEach((n, i) => n.pos.toArray(pPos, i * 3));
    pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
    pGeo.setAttribute('aColor', new THREE.BufferAttribute(pCol, 3));
    pGeo.setAttribute('aSize', new THREE.BufferAttribute(pSize, 1));
    pGeo.setAttribute('aAlpha', new THREE.BufferAttribute(pAlpha, 1));
    const uni = { uScale: { value: 44 * dpr }, uDim: { value: 1 } };
    const points = new THREE.Points(pGeo, material(POINT_FS, uni));
    root.add(points);

    const ringGeo = new THREE.BufferGeometry();
    ringGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0]), 3));
    ringGeo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array([0.71, 0.55, 1]), 3));
    const ringSize = new THREE.BufferAttribute(new Float32Array([17]), 1);
    const ringAlpha = new THREE.BufferAttribute(new Float32Array([0.55]), 1);
    ringGeo.setAttribute('aSize', ringSize);
    ringGeo.setAttribute('aAlpha', ringAlpha);
    root.add(new THREE.Points(ringGeo, material(RING_FS, uni)));

    // edges: a sparse mesh between neighbours, and spokes from you to every node
    const pairs: [number, number][] = [];
    const seen = new Set<string>();
    for (let i = 1; i < N; i++) {
      const near = nodes.map((n, j) => [j, n.pos.distanceTo(nodes[i].pos)] as const).filter(([j]) => j !== i && j !== 0).sort((a, b) => a[1] - b[1]).slice(0, 2);
      for (const [j] of near) {
        const k = i < j ? `${i}-${j}` : `${j}-${i}`;
        if (!seen.has(k)) {
          seen.add(k);
          pairs.push([i, j]);
        }
      }
    }
    const spokes: [number, number][] = nodes.map((_, i) => [0, i] as [number, number]).slice(1);
    const allEdges = [...pairs, ...spokes];
    const eGeo = new THREE.BufferGeometry();
    const ePos = new Float32Array(allEdges.length * 6), eCol = new Float32Array(allEdges.length * 6), eAlpha = new Float32Array(allEdges.length * 2);
    allEdges.forEach(([a, b], k) => {
      nodes[a].pos.toArray(ePos, k * 6);
      nodes[b].pos.toArray(ePos, k * 6 + 3);
    });
    eGeo.setAttribute('position', new THREE.BufferAttribute(ePos, 3));
    eGeo.setAttribute('aColor', new THREE.BufferAttribute(eCol, 3));
    eGeo.setAttribute('aAlpha', new THREE.BufferAttribute(eAlpha, 1));
    root.add(new THREE.LineSegments(eGeo, material(LINE_FS, uni)));

    // dust far behind, turning slower than the network for depth
    const dust = 900;
    const dPos = new Float32Array(dust * 3), dCol = new Float32Array(dust * 3), dSize = new Float32Array(dust), dAlpha = new Float32Array(dust);
    for (let i = 0; i < dust; i++) {
      const r = 26 + rand() * 40, th = rand() * Math.PI * 2, ph = Math.acos(2 * rand() - 1);
      dPos.set([r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph), r * Math.sin(ph) * Math.sin(th)], i * 3);
      dCol.set([0.62, 0.6, 0.78], i * 3);
      dSize[i] = 3 + rand() * 5;
      dAlpha[i] = 0.12 + rand() * 0.35;
    }
    const dGeo = new THREE.BufferGeometry();
    dGeo.setAttribute('position', new THREE.BufferAttribute(dPos, 3));
    dGeo.setAttribute('aColor', new THREE.BufferAttribute(dCol, 3));
    dGeo.setAttribute('aSize', new THREE.BufferAttribute(dSize, 1));
    dGeo.setAttribute('aAlpha', new THREE.BufferAttribute(dAlpha, 1));
    dustGroup.add(new THREE.Points(dGeo, material(POINT_FS, uni)));

    // a field of faint particles in a flattened shell around the network, for volume
    const fPos = new Float32Array(FIELD * 3), fCol = new Float32Array(FIELD * 3), fSize = new Float32Array(FIELD), fAlpha = new Float32Array(FIELD);
    for (let i = 0; i < FIELD; i++) {
      const r = 1.6 + Math.pow(rand(), 0.7) * 6.4, th = rand() * Math.PI * 2, ph = Math.acos(2 * rand() - 1);
      fPos.set([r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph) * 0.42 + (rand() - 0.5) * 0.5, r * Math.sin(ph) * Math.sin(th)], i * 3);
      const warm = rand() < 0.18;
      fCol.set(warm ? [0.72, 0.58, 1] : [0.82, 0.8, 0.95], i * 3);
      fSize[i] = 1.6 + rand() * 1.8;
      fAlpha[i] = 0.12 + rand() * 0.3;
    }
    const fGeo = new THREE.BufferGeometry();
    fGeo.setAttribute('position', new THREE.BufferAttribute(fPos, 3));
    fGeo.setAttribute('aColor', new THREE.BufferAttribute(fCol, 3));
    fGeo.setAttribute('aSize', new THREE.BufferAttribute(fSize, 1));
    fGeo.setAttribute('aAlpha', new THREE.BufferAttribute(fAlpha, 1));
    root.add(new THREE.Points(fGeo, material(POINT_FS, uni)));

    // pulses: a bright head and a fading tail along a curved path
    const POOL = 28, TAIL = 18;
    const pulses: Pulse[] = Array.from({ length: POOL }, () => ({ active: false, a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), t: 0, dur: 1, color: WHITE.clone() }));
    const hGeo = new THREE.BufferGeometry();
    const hPos = new Float32Array(POOL * 3), hCol = new Float32Array(POOL * 3), hSize = new Float32Array(POOL).fill(9), hAlpha = new Float32Array(POOL);
    hGeo.setAttribute('position', new THREE.BufferAttribute(hPos, 3));
    hGeo.setAttribute('aColor', new THREE.BufferAttribute(hCol, 3));
    hGeo.setAttribute('aSize', new THREE.BufferAttribute(hSize, 1));
    hGeo.setAttribute('aAlpha', new THREE.BufferAttribute(hAlpha, 1));
    root.add(new THREE.Points(hGeo, material(POINT_FS, uni)));
    const tGeo = new THREE.BufferGeometry();
    const tPos = new Float32Array(POOL * TAIL * 6), tCol = new Float32Array(POOL * TAIL * 6), tAlpha = new Float32Array(POOL * TAIL * 2);
    tGeo.setAttribute('position', new THREE.BufferAttribute(tPos, 3));
    tGeo.setAttribute('aColor', new THREE.BufferAttribute(tCol, 3));
    tGeo.setAttribute('aAlpha', new THREE.BufferAttribute(tAlpha, 1));
    root.add(new THREE.LineSegments(tGeo, material(LINE_FS, uni)));

    const bez = (p: Pulse, t: number, out: THREE.Vector3) => {
      const u = 1 - t;
      return out.set(0, 0, 0).addScaledVector(p.a, u * u).addScaledVector(p.c, 2 * u * t).addScaledVector(p.b, t * t);
    };
    const launch = (from: SkyNode, to: SkyNode, color: THREE.Color, dur: number, done?: () => void) => {
      const p = pulses.find((x) => !x.active);
      if (!p) return done?.();
      p.active = true;
      p.a.copy(from.pos);
      p.b.copy(to.pos);
      const mid = from.pos.clone().add(to.pos).multiplyScalar(0.5);
      const bend = new THREE.Vector3().crossVectors(to.pos.clone().sub(from.pos), new THREE.Vector3(0, 1, 0)).normalize().multiplyScalar(0.55 + Math.random() * 0.35);
      if (from === you) bend.negate();
      p.c.copy(mid).add(bend).addScaledVector(mid.clone().normalize(), 0.4);
      p.t = 0;
      p.dur = reduce ? 0.001 : dur;
      p.color.copy(color);
      p.done = done;
    };

    const cheapestFor = (model: string) =>
      rehearsal.providers.filter((p) => p.models.some((m) => m.id === model)).sort((x, y) => {
        const a = x.models.find((m) => m.id === model)!, b = y.models.find((m) => m.id === model)!;
        return a.input + a.output - (b.input + b.output);
      })[0];

    const fire = (trip: RTrip) => {
      const target = byName.get(trip.provider);
      if (!target) return;
      emit('yard:sent', { trip, at: Date.now() });
      const go = () =>
        launch(you, target, trip.sealed ? VIOLET : WHITE, 0.55 + Math.min(trip.ttftMs, 300) / 450, () => {
          target.flare = 1;
          target.flareColor.copy(trip.sealed ? VIOLET : WHITE);
          target.detail = `${trip.model} · $${trip.cost} · ${trip.ttftMs} ms${trip.sealed ? ' · sealed' : ''}`;
          target.detailUntil = performance.now() + 2400;
          emit('yard:served', { trip });
          window.setTimeout(() => launch(target, you, GREEN, 0.75, () => {
            you.flare = 1;
            target.paid = true;
            emit('yard:paid', { trip });
          }), reduce ? 0 : 140);
        });
      const dark = trip.fellThrough ? byName.get(cheapestFor(trip.model)?.name ?? '') : undefined;
      if (dark && dark !== target) {
        launch(you, dark, CORAL, 0.6, () => {
          dark.flare = 1;
          dark.flareColor.copy(CORAL);
          dark.detail = 'offline · request falls through';
          dark.detailUntil = performance.now() + 2200;
          go();
        });
      } else go();
    };

    const synthetic = () => {
      const lit = slots.filter((n) => n.lit > 0.7);
      if (!lit.length) return;
      const n = lit[Math.floor(Math.random() * lit.length)];
      launch(you, n, WHITE, 0.9, () => {
        n.flare = 0.8;
        n.flareColor.copy(WHITE);
        window.setTimeout(() => launch(n, you, GREEN, 0.8, () => (you.flare = 0.6)), 120);
      });
    };

    // labels for you and the named providers, placed by projecting their positions every frame
    const labelNodes = [you, ...byName.values()];
    const labelEls = labelNodes.map((n) => {
      const d = document.createElement('div');
      d.className = 'sky-label' + (n === you ? ' sky-label--you' : '');
      d.innerHTML = n === you
        ? `<span class="sky-label__name">you</span><span class="sky-label__meta">127.0.0.1:7171</span>`
        : `<span class="sky-label__name">${n.named!.name}${n.named!.enclave ? ' <i>enclave</i>' : ''}</span><span class="sky-label__meta"></span>`;
      labelLayer.appendChild(d);
      return d;
    });
    const metaOf = (n: SkyNode) => {
      const p = n.named!;
      const cheapest = p.models.reduce((m, x) => (x.input < m.input ? x : m), p.models[0]);
      return `${p.models.length} models · from ${perM(cheapest.input)}/M · ${p.region}`;
    };

    // state
    let stage: Stage = 'hero';
    let provideP = 0;
    let width = 0, height = 0;
    let yaw = 0.35, pitch = 0.18, vel = 0, idleUntil = 0;
    let dist = STAGES.hero.dist, offX = STAGES.hero.offX, dim = 1;
    let tripIdx = 0, nextAt = performance.now() + 600;
    const mobile = () => width < 760;

    const resize = () => {
      const w = window.innerWidth, h = window.innerHeight;
      if (w === width && Math.abs(h - height) < 140) return;
      width = w;
      height = h;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = `${w}px`;
      renderer.domElement.style.height = `${h}px`;
      camera.aspect = w / h;
      uni.uScale.value = 140 * dpr * (h / 900);
    };
    resize();
    window.addEventListener('resize', resize);

    // drag to turn (horizontal intent only, so vertical swipes still scroll on phones)
    let dragging = false, lastX = 0, lastY = 0, decided = false, horizontal = false;
    const canvas = renderer.domElement;
    const down = (e: PointerEvent) => {
      dragging = true;
      decided = false;
      lastX = e.clientX;
      lastY = e.clientY;
    };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      if (!decided && Math.hypot(dx, dy) > 4) {
        decided = true;
        horizontal = Math.abs(dx) > Math.abs(dy) || e.pointerType === 'mouse';
        if (horizontal) canvas.setPointerCapture(e.pointerId);
      }
      if (!horizontal) return;
      yaw += dx * 0.006;
      pitch = Math.max(-0.55, Math.min(0.55, pitch + dy * 0.004));
      vel = dx * 0.006;
      lastX = e.clientX;
      lastY = e.clientY;
      idleUntil = performance.now() + 2500;
      el.classList.add('sky--grabbing');
    };
    const up = () => {
      dragging = false;
      el.classList.remove('sky--grabbing');
    };
    canvas.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);

    const offs = [
      on('yard:stage', (d) => {
        if (d.stage !== stage) {
          stage = d.stage;
          nextAt = performance.now() + 500;
        }
        provideP = d.provide;
      }),
      on('yard:fire', ({ route }) => {
        const trip = rehearsal.trips.find((t) => t.route === route && !t.fellThrough) ?? rehearsal.trips.find((t) => t.route === route);
        if (trip) fire(trip);
      }),
    ];

    const v = new THREE.Vector3();
    let last = performance.now();
    const frame = () => {
      const now = performance.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const S = STAGES[stage];
      const k = 1 - Math.exp(-dt * 2.2);
      dist += ((mobile() ? S.dist + 3.2 : S.dist) - dist) * k;
      offX += ((mobile() ? 0 : S.offX) - offX) * k;
      const dimTarget = mobile() && stage === 'hero' ? 0.62 : S.dim;
      dim += (dimTarget - dim) * k;
      uni.uDim.value = dim;

      if (!dragging) {
        yaw += vel;
        vel *= Math.pow(0.04, dt);
        if (now > idleUntil && !reduce) yaw += S.spin * dt;
      }
      root.rotation.set(pitch, yaw, 0);
      dustGroup.rotation.set(pitch * 0.4, yaw * 0.25, 0);
      camera.position.set(0, 0, dist);
      camera.lookAt(0, 0, 0);
      const oy = mobile() ? (stage === 'hero' ? 0.31 : -0.22) : 0;
      camera.setViewOffset(width, height, -offX * width, -oy * height, width, height);

      // the trip loop
      if (S.every && now >= nextAt) {
        nextAt = now + (reduce ? Math.max(4000, S.every) : S.every);
        if (stage === 'provide') synthetic();
        else if (stage === 'sealed') fire(rehearsal.trips.filter((t) => t.sealed)[tripIdx++ % 2]);
        else fire(rehearsal.trips[tripIdx++ % rehearsal.trips.length]);
      }

      // nodes
      const lightCount = Math.round(provideP * slots.length);
      for (const n of slots) n.litTarget = n.rank < lightCount ? 1 : 0.2;
      for (let i = 0; i < N; i++) {
        const n = nodes[i];
        n.lit += (n.litTarget - n.lit) * (1 - Math.exp(-dt * 6));
        n.flare *= Math.exp(-dt * 2.4);
        const c = new THREE.Color().copy(n.base);
        if (n.rank >= 0) c.lerp(NODE, Math.max(0, (n.lit - 0.2) / 0.8));
        c.lerp(n.flareColor, Math.min(1, n.flare));
        c.toArray(pCol, i * 3);
        pSize[i] = n.size * (n.rank >= 0 ? 0.75 + 0.45 * n.lit : 1) * (1 + 0.8 * n.flare);
        const tw = n.rank >= 0 && !reduce ? 0.86 + 0.14 * Math.sin(now * 0.0011 + i * 1.7) : 1;
        pAlpha[i] = Math.min(1.4, (n.rank >= 0 ? 0.32 + 0.68 * n.lit : 0.95) * tw + n.flare * 0.7);
      }
      you.flareColor.copy(GREEN);
      ringSize.array[0] = 17 + 6 * you.flare;
      ringAlpha.array[0] = 0.5 + 0.5 * you.flare;
      ringSize.needsUpdate = ringAlpha.needsUpdate = true;
      (pGeo.attributes.aColor as THREE.BufferAttribute).needsUpdate = true;
      (pGeo.attributes.aSize as THREE.BufferAttribute).needsUpdate = true;
      (pGeo.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true;

      // edges
      allEdges.forEach(([a, b], e) => {
        const na = nodes[a], nb = nodes[b];
        let alpha: number, col: THREE.Color;
        if (a === 0) {
          const named = !!nb.named;
          alpha = named ? (nb.paid ? 0.55 : 0.24) : 0.16 * Math.max(0, (nb.lit - 0.2) / 0.8);
          col = named && nb.paid ? GREEN : EDGE;
        } else {
          alpha = 0.2 + 0.3 * Math.min(na.lit, nb.lit);
          col = EDGE;
        }
        col.toArray(eCol, e * 6);
        col.toArray(eCol, e * 6 + 3);
        eAlpha[e * 2] = eAlpha[e * 2 + 1] = alpha;
      });
      (eGeo.attributes.aColor as THREE.BufferAttribute).needsUpdate = true;
      (eGeo.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true;

      // pulses
      pulses.forEach((p, i) => {
        if (!p.active) {
          hAlpha[i] = 0;
          for (let s = 0; s < TAIL; s++) tAlpha[(i * TAIL + s) * 2] = tAlpha[(i * TAIL + s) * 2 + 1] = 0;
          return;
        }
        p.t += dt / p.dur;
        const t = Math.min(1, p.t);
        const ease = 1 - Math.pow(1 - t, 2.2);
        bez(p, ease, v).toArray(hPos, i * 3);
        p.color.toArray(hCol, i * 3);
        hAlpha[i] = 1.2;
        for (let s = 0; s < TAIL; s++) {
          const t0 = Math.max(0, ease - ((s + 1) / TAIL) * 0.32), t1 = Math.max(0, ease - (s / TAIL) * 0.32);
          bez(p, t1, v).toArray(tPos, (i * TAIL + s) * 6);
          bez(p, t0, v).toArray(tPos, (i * TAIL + s) * 6 + 3);
          p.color.toArray(tCol, (i * TAIL + s) * 6);
          p.color.toArray(tCol, (i * TAIL + s) * 6 + 3);
          const fade = (1 - s / TAIL) * 0.85;
          tAlpha[(i * TAIL + s) * 2] = fade;
          tAlpha[(i * TAIL + s) * 2 + 1] = fade * 0.85;
        }
        if (p.t >= 1) {
          p.active = false;
          const done = p.done;
          p.done = undefined;
          done?.();
        }
      });
      for (const name of ['position', 'aColor', 'aAlpha'] as const) {
        (hGeo.attributes[name] as THREE.BufferAttribute).needsUpdate = true;
        (tGeo.attributes[name] as THREE.BufferAttribute).needsUpdate = true;
      }

      renderer.render(scene, camera);

      // labels: nearest first, and a label that would sit on one already placed waits its turn
      root.updateMatrixWorld();
      const placed: [number, number, number, number][] = [];
      const order = labelNodes
        .map((n, i) => [i, v.copy(n.pos).applyMatrix4(root.matrixWorld).project(camera).z - (n.named && now < n.detailUntil ? 10 : 0) - (n === you ? 20 : 0)] as const)
        .sort((a, b) => a[1] - b[1]);
      order.forEach(([i]) => {
        const n = labelNodes[i];
        const elx = labelEls[i];
        v.copy(n.pos).applyMatrix4(root.matrixWorld).project(camera);
        const x = (v.x * 0.5 + 0.5) * width, y = (-v.y * 0.5 + 0.5) * height;
        const visible = v.z < 1 && x > -40 && x < width + 40 && y > -40 && y < height + 40 && dim > 0.5 && !(mobile() && stage === 'hero' && n !== you);
        if (!visible) {
          elx.style.opacity = '0';
          return;
        }
        const depth = THREE.MathUtils.clamp(1.15 - (v.z - 0.96) * 18, 0.35, 1);
        elx.style.opacity = String(depth * Math.min(1, dim));
        const flip = x > width - 250;
        const hot = !!n.named && now < n.detailUntil;
        const showMeta = !mobile() || hot || n === you;
        const w = Math.max(80, (n.named ? n.named.name.length : 6) * 7.4 + (showMeta && n.named ? 60 : 0));
        const box: [number, number, number, number] = flip ? [x - 16 - w, y - 12, x - 16, y + (showMeta ? 26 : 12)] : [x + 16, y - 12, x + 16 + w, y + (showMeta ? 26 : 12)];
        if (placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) {
          elx.style.opacity = '0';
          return;
        }
        placed.push(box);
        elx.classList.toggle('is-flip', flip);
        elx.classList.toggle('no-meta', !showMeta);
        elx.style.transform = flip ? `translate3d(calc(${Math.round(x - 16)}px - 100%), ${Math.round(y - 10)}px, 0)` : `translate3d(${Math.round(x + 16)}px, ${Math.round(y - 10)}px, 0)`;
        if (n.named) {
          const meta = elx.lastElementChild as HTMLElement;
          const want = now < n.detailUntil ? n.detail : metaOf(n);
          if (meta.textContent !== want) meta.textContent = want;
          elx.classList.toggle('is-hot', now < n.detailUntil);
        }
      });
    };

    const visibility = () => renderer.setAnimationLoop(document.hidden ? null : frame);
    document.addEventListener('visibilitychange', visibility);
    renderer.setAnimationLoop(frame);

    return () => {
      offs.forEach((f) => f());
      renderer.setAnimationLoop(null);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      canvas.removeEventListener('pointerdown', down);
      labelEls.forEach((d) => d.remove());
      renderer.dispose();
      canvas.remove();
    };
  }, []);

  return (
    <div className="sky" ref={host} aria-hidden="true">
      <div className="sky-labels" ref={labelsRef} />
    </div>
  );
}
