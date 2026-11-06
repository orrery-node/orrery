'use client';

// The hero object: an orrery in daylight. Your router is the white core inside a cage of fine rings; polished
// chrome orbits and two orbits of flowing Solana light turn around it at their own pace, the inner ones faster, and the
// rehearsal's three providers ride them as coloured glass. Requests leave the core as purple light carrying their
// model and come back green carrying what they cost; each label rides its light and settles where it lands. A fine
// engraved horizon with degree ticks frames the instrument. The close variant assembles as it scrolls into view and
// flares when the page's wire reaches its core.
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { emit, on, reducedMotion } from '@/lib/bus';
import { perM, rehearsal, ROUTE_WORD, type RTrip } from '@/lib/rehearsal';

const ENGRAVE = new THREE.Color('#6d6690');
const FILAMENT = new THREE.Color('#8c84b4');
const ARC = new THREE.Color('#7350e0');
const HALO = new THREE.Color('#b7a6ff');
const PURPLE = new THREE.Color('#8b3dff');
const GREEN = new THREE.Color('#0fc47f');
const SOL = [new THREE.Color('#9945ff'), new THREE.Color('#5f8ff2'), new THREE.Color('#14f195')];
const TINTS: Record<string, THREE.Color> = {
  'Kestrel GPU Co-op': new THREE.Color('#9b52ff'),
  'Ironbridge Compute': new THREE.Color('#4f7bff'),
  'Vault Nine': new THREE.Color('#12d68a'),
};

type Orbit = { r: number; rx: number; rz: number; kind: 'chrome' | 'light'; tube: number };
const HORIZON = 4.6;
const ORBITS: Orbit[] = [
  { r: 1.5, rx: 0.46, rz: -0.3, kind: 'chrome', tube: 0.042 },
  { r: 2.15, rx: -0.32, rz: 0.38, kind: 'light', tube: 0.058 },
  { r: 2.8, rx: 0.17, rz: 0.24, kind: 'chrome', tube: 0.056 },
  { r: 3.5, rx: -0.21, rz: -0.11, kind: 'light', tube: 0.072 },
  { r: 4.1, rx: 0.24, rz: 0.1, kind: 'chrome', tube: 0.038 },
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

const LINE_VS = `
attribute float aT; attribute float aAlpha;
uniform float uDraw; uniform float uCenter; uniform float uDepth;
uniform float uTime; uniform float uFlow; uniform float uFreq; uniform float uSpeed;
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float front = clamp(0.5 + (mv.z - uCenter) / uDepth, 0.0, 1.0);
  float wave = pow(0.5 + 0.5 * sin(aT * uFreq - uTime * uSpeed), 4.0);
  float glint = 1.0 + uFlow * (wave * 1.25 - 0.28);
  vAlpha = aAlpha * glint * mix(0.18, 1.0, front * front) * clamp((uDraw - aT) * 14.0, 0.0, 1.0);
  gl_Position = projectionMatrix * mv;
}`;
const LINE_FS = `
uniform vec3 uColor; varying float vAlpha;
void main() {
  gl_FragColor = vec4(uColor, min(1.0, vAlpha));
  #include <colorspace_fragment>
}`;

const POINT_VS = `
attribute float aSize; attribute float aAlpha; attribute vec3 aColor; attribute vec3 aFrom; attribute float aDelay; attribute float aKind; attribute float aSwirl;
uniform float uScale; uniform float uIntro; uniform float uCenter; uniform float uDepth; uniform float uTime;
varying vec3 vColor; varying float vAlpha; varying float vKind;
void main() {
  float k = clamp((uIntro - aDelay) / 0.55, 0.0, 1.0);
  k = 1.0 - pow(1.0 - k, 3.0);
  vec3 p = mix(aFrom, position, k);
  float ang = uTime * aSwirl;
  float cs = cos(ang); float sn = sin(ang);
  p = vec3(cs * p.x + sn * p.z, p.y, -sn * p.x + cs * p.z);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float front = clamp(0.5 + (mv.z - uCenter) / uDepth, 0.0, 1.0);
  gl_PointSize = aSize * uScale / -mv.z;
  gl_Position = projectionMatrix * mv;
  vColor = aColor; vKind = aKind;
  vAlpha = aAlpha * mix(0.3, 1.0, front) * k;
}`;
const POINT_FS = `
varying vec3 vColor; varying float vAlpha; varying float vKind;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  float a;
  vec3 c = vColor;
  if (vKind > 3.5) { a = exp(-d * d * 3.2) * 0.62; }
  else if (vKind > 2.5) { a = smoothstep(0.97, 0.9, d) * smoothstep(0.8, 0.87, d); }
  else if (vKind > 0.5) { float core = exp(-d * d * 18.0); a = smoothstep(1.0, 0.15, d) * 0.55 + core * 0.6; c = mix(vColor, vec3(1.0), core * 0.75); }
  else { a = smoothstep(0.9, 0.2, d); }
  gl_FragColor = vec4(c, a * vAlpha);
  #include <colorspace_fragment>
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
const easeOut = (t: number) => 1 - Math.pow(1 - clamp01(t), 3);

class Circle extends THREE.Curve<THREE.Vector3> {
  constructor(private r: number) {
    super();
  }
  getPoint(t: number, out = new THREE.Vector3()) {
    const a = t * Math.PI * 2;
    return out.set(this.r * Math.cos(a), 0, this.r * Math.sin(a));
  }
}

function haloTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.16, 'rgba(255,255,255,0.95)');
  grad.addColorStop(0.32, 'rgba(214,204,255,0.55)');
  grad.addColorStop(0.62, 'rgba(160,190,255,0.16)');
  grad.addColorStop(1, 'rgba(160,190,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

type Node = { pos: THREE.Vector3; size: number; alpha: number; kind: number; flare: number; flareColor: THREE.Color; down: number; base: THREE.Color };
type Rig = { tilt: THREE.Group; spin: THREE.Group; speed: number; m: THREE.Matrix4 };
type Prov = { node: Node; local: THREE.Vector3; rig: Rig; curve: THREE.QuadraticBezierCurve3; mat: THREE.ShaderMaterial; tint: number; planet: THREE.Mesh<THREE.SphereGeometry, THREE.MeshPhysicalMaterial>; color: THREE.Color };
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
type Tube = { mesh: THREE.Mesh; t0: number; step: number; segs: number };

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
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1.05;
    el.prepend(renderer.domElement);

    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new THREE.Scene();
    room.add(
      new THREE.Mesh(
        new THREE.SphereGeometry(30, 64, 32),
        new THREE.ShaderMaterial({
          side: THREE.BackSide,
          vertexShader: 'varying vec3 vP; void main() { vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
          fragmentShader: `varying vec3 vP;
void main() {
  float y = vP.y;
  vec3 top = vec3(1.0, 1.0, 1.02);
  vec3 mid = vec3(0.7, 0.69, 0.76);
  vec3 low = vec3(0.035, 0.03, 0.07);
  vec3 c = y > 0.0 ? mix(mid, top, smoothstep(0.02, 0.55, y)) : mix(mid, low, smoothstep(-0.02, -0.3, y));
  gl_FragColor = vec4(c, 1.0);
}`,
        }),
      ),
    );
    const panel = (color: THREE.Color, x: number, y: number, z: number, sx: number, sy: number, sz: number, k: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(k) }));
      m.position.set(x, y, z);
      m.scale.set(sx, sy, sz);
      m.lookAt(0, 0, 0);
      room.add(m);
    };
    panel(SOL[0], -14, 2, 4, 6, 10, 0.4, 2.6);
    panel(SOL[2], 14, -1, 2, 6, 9, 0.4, 2.4);
    panel(SOL[1], 2, 6, -14, 9, 4, 0.4, 1.8);
    panel(new THREE.Color('#ffffff'), -3, 14, 6, 10, 2, 0.4, 4);
    panel(new THREE.Color('#ffffff'), 8, 9, 10, 2, 7, 0.4, 3);
    panel(new THREE.Color('#14131c'), 0, -6, 14, 22, 5, 0.4, 1);
    const envRT = pmrem.fromScene(room, 0.02);
    scene.environment = envRT.texture;
    room.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    });

    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(-4, 8, 6);
    scene.add(key);

    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 200);
    const root = new THREE.Group();
    scene.add(root);
    const shared = {
      uDraw: { value: reduce ? 3 : 0 },
      uCenter: { value: -20 },
      uDepth: { value: 8.5 },
      uTime: { value: 0 },
    };
    const rand = rng(hero ? 0x51d : 0x77a1);
    const gauss = () => (rand() + rand() + rand() - 1.5) / 1.5;
    const disposables: { dispose(): void }[] = [envRT, pmrem];

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
    const lineMat = (color: THREE.Color, flow = 0, freq = 60, speed = 0.6) => {
      const m = new THREE.ShaderMaterial({
        vertexShader: LINE_VS,
        fragmentShader: LINE_FS,
        uniforms: { ...shared, uColor: { value: color.clone() }, uFlow: { value: reduce ? 0 : flow }, uFreq: { value: freq }, uSpeed: { value: speed } },
        transparent: true,
        depthWrite: false,
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
      const l = new THREE.LineSegments(g, mat);
      l.renderOrder = 2;
      parent.add(l);
    };

    const chrome = (tone = '#ffffff', rough = 0.1) => {
      const m = new THREE.MeshPhysicalMaterial({ color: tone, metalness: 1, roughness: rough, envMapIntensity: 1.15 });
      disposables.push(m);
      return m;
    };
    const solUniforms = { uShift: { value: 0 }, uP: { value: SOL[0].clone() }, uB: { value: SOL[1].clone() }, uG: { value: SOL[2].clone() } };
    const lightMat = (() => {
      const m = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.16, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.06, envMapIntensity: 0.85 });
      m.onBeforeCompile = (s) => {
        Object.assign(s.uniforms, solUniforms);
        s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nvarying float vU;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvU = uv.x;');
        s.fragmentShader = s.fragmentShader
          .replace(
            '#include <common>',
            `#include <common>
varying float vU; uniform float uShift; uniform vec3 uP; uniform vec3 uB; uniform vec3 uG;
vec3 sol(float x) { float y = abs(fract(x) * 2.0 - 1.0); return y < 0.5 ? mix(uP, uB, y * 2.0) : mix(uB, uG, y * 2.0 - 1.0); }`,
          )
          .replace('#include <color_fragment>', '#include <color_fragment>\nvec3 solC = sol(vU + uShift);\ndiffuseColor.rgb *= solC;')
          .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += solC * 0.62;');
      };
      m.customProgramCacheKey = () => 'orrery-sol';
      disposables.push(m);
      return m;
    })();

    const tubes: Tube[] = [];
    const tube = (parent: THREE.Object3D, r: number, radius: number, mat: THREE.Material, t0: number) => {
      const segs = Math.round(120 + r * 70);
      const radial = 14;
      const g = new THREE.TubeGeometry(new Circle(r), segs, radius, radial, true);
      disposables.push(g);
      const mesh = new THREE.Mesh(g, mat);
      parent.add(mesh);
      tubes.push({ mesh, t0, step: radial * 6, segs });
      return mesh;
    };

    const frameBuf = buf();
    ring(frameBuf, HORIZON, 0, 0, 0.55, 420, 0.05);
    ring(frameBuf, HORIZON + 0.1, 0, 0, 0.28, 420, 0.1);
    for (let deg = 0; deg < 360; deg += 2) {
      const th = (deg / 180) * Math.PI;
      const big = deg % 10 === 0;
      seg(frameBuf, ringPoint(HORIZON + 0.1, 0, 0, th), ringPoint(HORIZON + 0.1 + (big ? 0.24 : 0.09), 0, 0, th), 0.3 + (deg / 360) * 0.8, big ? 0.55 : 0.3);
    }
    for (let deg = 0; deg < 360; deg += 15) {
      const th = (deg / 180) * Math.PI;
      seg(frameBuf, ringPoint(HORIZON - 0.06, 0, 0, th), ringPoint(HORIZON - 0.2, 0, 0, th), 0.4 + (deg / 360) * 0.8, 0.35);
    }
    lines(frameBuf, root, lineMat(ENGRAVE));

    const rigs: Rig[] = ORBITS.map((o, i) => {
      const tilt = new THREE.Group();
      tilt.rotation.set(o.rx, 0, o.rz);
      root.add(tilt);
      const spin = new THREE.Group();
      tilt.add(spin);
      const t0 = 0.15 + i * 0.07;
      tube(spin, o.r, o.tube, o.kind === 'light' ? lightMat : chrome(i === 4 ? '#e4e6f0' : '#ffffff', i === 4 ? 0.2 : 0.08), t0);
      const b = buf();
      for (let s = 0; s < 22; s++) {
        const dr = gauss() * 0.075 * o.r;
        const sx = 1 + gauss() * 0.014, sz = 1 + gauss() * 0.014;
        const from = rand() * Math.PI * 2;
        const span = Math.PI * (1.2 + rand() * 0.8);
        ring(b, o.r + dr, gauss() * 0.025, gauss() * 0.025, 0.08 + rand() * 0.16, 180, 0.2 + i * 0.06 + rand() * 0.2, sx, sz, from, span);
      }
      lines(b, spin, lineMat(FILAMENT, 0.6, 52 + i * 9, 0.45 + i * 0.05));
      if (o.kind === 'chrome') {
        const beadGeo = new THREE.SphereGeometry(o.tube * 1.9, 24, 16);
        disposables.push(beadGeo);
        for (let k = 0; k < 2; k++) {
          const bead = new THREE.Mesh(beadGeo, chrome('#ffffff', 0.06));
          bead.position.copy(ringPoint(o.r, 0, 0, rand() * Math.PI * 2));
          spin.add(bead);
        }
      }
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

    const cage = new THREE.Group();
    root.add(cage);
    const cageMat = chrome('#f4f2ff', 0.14);
    for (let k = 0; k < 7; k++) {
      const holder = new THREE.Group();
      holder.rotation.set(rand() * Math.PI, rand() * Math.PI, rand() * Math.PI);
      cage.add(holder);
      tube(holder, 0.5 + k * 0.04, 0.009, cageMat, 0.05 + k * 0.03);
    }
    const coreMat = new THREE.MeshPhysicalMaterial({ color: '#ffffff', emissive: '#ffffff', emissiveIntensity: 0.85, roughness: 0.35 });
    disposables.push(coreMat);
    const coreGeo = new THREE.SphereGeometry(0.31, 48, 32);
    disposables.push(coreGeo);
    const coreMesh = new THREE.Mesh(coreGeo, coreMat);
    root.add(coreMesh);
    const haloTex = haloTexture();
    disposables.push(haloTex);
    const haloMat = new THREE.SpriteMaterial({ map: haloTex, color: 0xffffff, transparent: true, depthWrite: false, opacity: 0.9 });
    disposables.push(haloMat);
    const halo = new THREE.Sprite(haloMat);
    halo.scale.setScalar(3);
    halo.renderOrder = 1;
    root.add(halo);

    const planetGeo = new THREE.SphereGeometry(0.17, 48, 32);
    disposables.push(planetGeo);
    const provs = new Map<string, Prov>();
    for (const p of rehearsal.providers) {
      const [oi, th] = NAMED[p.name] ?? [3, rand() * 6.28];
      const rig = rigs[oi];
      const local = ringPoint(ORBITS[oi].r, 0, 0, th);
      const color = (TINTS[p.name] ?? SOL[1]).clone();
      const node: Node = { pos: local.clone().applyMatrix4(rig.m), size: 70, alpha: 0.32, kind: 4, flare: 0, flareColor: color.clone(), down: 0, base: color };
      const trips = rehearsal.trips.filter((t) => t.provider === p.name).length;
      const traffic = buf();
      const n = hero ? 6 + trips * 2 : 12 + trips * 3;
      for (let s = 0; s < n; s++) {
        const lift = 0.7 + rand() * 0.9;
        const ctrl = local.clone().multiplyScalar(0.5 + gauss() * 0.06).add(new THREE.Vector3(gauss() * 0.25, lift, gauss() * 0.25));
        const pts = new THREE.QuadraticBezierCurve3(new THREE.Vector3(), ctrl, local).getPoints(60);
        const alpha = (hero ? 0.06 : 0.1) + rand() * (hero ? 0.07 : 0.1);
        for (let i = 0; i < pts.length - 1; i++) seg(traffic, pts[i], pts[i + 1], 0.9 + i / 120, alpha);
      }
      lines(traffic, rig.spin, lineMat(hero ? FILAMENT : GREEN, 0.9, 46, 2.4 + rand()));
      const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(), local.clone().multiplyScalar(0.5).add(new THREE.Vector3(0, 1.15, 0)), local.clone());
      const arcBuf = buf();
      const pts = curve.getPoints(80);
      for (let i = 0; i < pts.length - 1; i++) seg(arcBuf, pts[i], pts[i + 1], 0.9 + i / 160, 0.42);
      const mat = lineMat(ARC, 0.5, 70, 3.2);
      lines(arcBuf, rig.spin, mat);
      const pm = new THREE.MeshPhysicalMaterial({ color, roughness: 0.14, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.04, emissive: color, emissiveIntensity: 0.18, envMapIntensity: 1.1 });
      disposables.push(pm);
      const planet = new THREE.Mesh(planetGeo, pm);
      root.add(planet);
      provs.set(p.name, { node, local, rig, curve, mat, tint: 0, planet, color });
    }

    const nodes: Node[] = [];
    const core: Node = { pos: new THREE.Vector3(), size: 0, alpha: 0, kind: 1, flare: 0, flareColor: PURPLE.clone(), down: 0, base: HALO.clone() };
    nodes.push(core);
    nodes.push({ pos: core.pos, size: 260, alpha: 0.5, kind: 4, flare: 0, flareColor: PURPLE.clone(), down: 0, base: HALO.clone() });
    for (const pv of provs.values()) {
      nodes.push(pv.node);
      nodes.push({ pos: pv.node.pos, size: 30, alpha: 0.42, kind: 3, flare: 0, flareColor: pv.color.clone(), down: 0, base: ENGRAVE.clone() });
    }
    const CLOUD = 520, DUST = 700;
    const total = nodes.length + CLOUD + DUST;
    const pPos = new Float32Array(total * 3), pFrom = new Float32Array(total * 3);
    const pSize = new Float32Array(total), pAlpha = new Float32Array(total), pColor = new Float32Array(total * 3);
    const pDelay = new Float32Array(total), pKind = new Float32Array(total), pSwirl = new Float32Array(total);
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
    const speck = new THREE.Color('#7b6cd8');
    for (let k = 0; k < CLOUD; k++) {
      const i = nodes.length + k;
      const v = new THREE.Vector3(gauss(), gauss(), gauss()).multiplyScalar(0.34);
      if (v.length() < 0.3) v.setLength(0.3 + rand() * 0.2);
      pPos.set([v.x, v.y, v.z], i * 3);
      scatter(i, 7);
      pSize[i] = 1.4 + rand() * 1.2;
      pAlpha[i] = Math.max(0.1, 0.62 - v.length() * 0.8);
      pColor.set([speck.r, speck.g, speck.b], i * 3);
      pDelay[i] = rand() * 0.5;
      pSwirl[i] = 0.12 + 0.6 * Math.exp(-Math.hypot(v.x, v.z) * 4) + (rand() - 0.5) * 0.08;
    }
    for (let k = 0; k < DUST; k++) {
      const i = nodes.length + CLOUD + k;
      const a = rand() * Math.PI * 2, r = 4.9 + Math.pow(rand(), 0.7) * 3.2;
      pPos.set([r * Math.cos(a), gauss() * 0.35, r * Math.sin(a)], i * 3);
      scatter(i, 12);
      pSize[i] = 1.5 + rand() * 1.8;
      pAlpha[i] = 0.1 + rand() * 0.28;
      const c = SOL[0].clone().lerp(SOL[2], (Math.cos(a - 0.6) + 1) / 2).lerp(new THREE.Color('#b8b2d6'), 0.45);
      pColor.set([c.r, c.g, c.b], i * 3);
      pDelay[i] = rand() * 0.9;
      pSwirl[i] = 0.006 + rand() * 0.014;
    }
    if (reduce) {
      pFrom.set(pPos);
      pSwirl.fill(0);
    }
    const pGeo = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(pPos, 3);
    pGeo.setAttribute('position', posAttr);
    pGeo.setAttribute('aFrom', new THREE.BufferAttribute(pFrom, 3));
    const sizeAttr = new THREE.BufferAttribute(pSize, 1), alphaAttr = new THREE.BufferAttribute(pAlpha, 1), colorAttr = new THREE.BufferAttribute(pColor, 3);
    pGeo.setAttribute('aSize', sizeAttr);
    pGeo.setAttribute('aAlpha', alphaAttr);
    pGeo.setAttribute('aColor', colorAttr);
    pGeo.setAttribute('aDelay', new THREE.BufferAttribute(pDelay, 1));
    pGeo.setAttribute('aKind', new THREE.BufferAttribute(pKind, 1));
    pGeo.setAttribute('aSwirl', new THREE.BufferAttribute(pSwirl, 1));
    disposables.push(pGeo);
    const pointUniforms = { uScale: { value: 40 }, uIntro: { value: reduce ? 3 : 0 }, uCenter: shared.uCenter, uDepth: shared.uDepth, uTime: shared.uTime };
    const pMat = new THREE.ShaderMaterial({ vertexShader: POINT_VS, fragmentShader: POINT_FS, uniforms: pointUniforms, transparent: true, depthWrite: false });
    disposables.push(pMat);
    const pts = new THREE.Points(pGeo, pMat);
    pts.frustumCulled = false;
    pts.renderOrder = 3;
    root.add(pts);

    const TRAIL = 44, MAXP = 10, STEP = 0.0085;
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
    qGeo.setAttribute('aSwirl', new THREE.BufferAttribute(new Float32Array(MAXP * TRAIL), 1));
    disposables.push(qGeo);
    const qMat = new THREE.ShaderMaterial({ vertexShader: POINT_VS, fragmentShader: POINT_FS, uniforms: { ...pointUniforms, uIntro: { value: 3 } }, transparent: true, depthWrite: false, depthTest: false });
    disposables.push(qMat);
    const qPoints = new THREE.Points(qGeo, qMat);
    qPoints.frustumCulled = false;
    qPoints.renderOrder = 4;
    root.add(qPoints);
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
      core.flare = 1;
      core.flareColor.copy(PURPLE);
      const pv = provs.get(trip.provider);
      const word = `${trip.model}${trip.route === 'auto' ? '' : ROUTE_WORD[trip.route]}`;
      const go = () => {
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
            core.flare = 1;
            core.flareColor.copy(GREEN);
            if (pv) {
              pv.node.flare = 0.8;
              pv.node.flareColor.copy(GREEN);
              pv.tint = 1;
            }
            send('orrery:paid', { trip });
          }, false, 0.95);
        });
      };
      if (trip.fellThrough) {
        const first = 'Kestrel GPU Co-op';
        fly(first, false, false, 1.8, 'no answer', () => {
          const k = provs.get(first);
          if (k) k.node.down = 1;
          go();
        }, true);
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
          core.flare = 1;
          core.flareColor.copy(GREEN);
        });

    type Chip = { el: HTMLElement; anchor: THREE.Vector3 | null; key: string; w: number; h: number; side: 1 | -1; on: boolean; swapAt: number };
    const chips: Chip[] = [];
    const anchorFor = (key: string): THREE.Vector3 | null => {
      if (key === 'you') return core.pos;
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

    let W = 1, H = 1, mobile = false, corePx = 30, baseTilt = 0.34;
    const resize = () => {
      W = el.clientWidth;
      H = el.clientHeight;
      mobile = W < 900;
      renderer.setSize(W, H, false);
      camera.aspect = W / H;
      baseTilt = mobile ? 0.5 : 0.36;
      root.rotation.x = baseTilt;
      const halfV = Math.tan((camera.fov / 2) * (Math.PI / 180));
      const target = hero ? (mobile ? W * 0.44 : Math.min(W * 0.255, H * 0.46)) : mobile ? W * 0.46 : Math.min(W * 0.36, H * 0.56);
      const dist = (HORIZON * (H / 2)) / (target * halfV);
      camera.position.set(0, 0, dist);
      camera.lookAt(0, 0, 0);
      const offX = hero && !mobile ? -W * 0.235 : 0;
      const offY = hero ? (mobile ? H * 0.2 : H * 0.02) : H * (mobile ? 0.1 : 0.06);
      camera.setViewOffset(W, H, offX, offY, W, H);
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

    const v3 = new THREE.Vector3(), mv = new THREE.Vector3();
    const project = (p: THREE.Vector3) => {
      v3.copy(p).applyMatrix4(root.matrixWorld);
      mv.copy(v3).applyMatrix4(camera.matrixWorldInverse);
      const front = clamp01(0.5 + (mv.z - shared.uCenter.value) / shared.uDepth.value);
      v3.project(camera);
      return { x: (v3.x * 0.5 + 0.5) * W, y: (-v3.y * 0.5 + 0.5) * H, front };
    };
    const clear = () => el.parentElement?.querySelector<HTMLElement>('[data-orrery-clear]')?.getBoundingClientRect();
    type Box = [number, number, number, number];

    const placeChips = (nowMs: number) => {
      const hostRect = el.getBoundingClientRect();
      const taken: Box[] = [];
      const ex = clear();
      if (ex) taken.push([ex.left - hostRect.left - 10, ex.top - hostRect.top - 10, ex.right - hostRect.left + 10, ex.bottom - hostRect.top + 6]);
      const c0 = project(core.pos);
      const coreBox: Box = [c0.x - corePx, c0.y - corePx, c0.x + corePx, c0.y + corePx];
      taken.push(coreBox);
      const top = 80;
      const overlaps = (b: Box, t: Box) => !(b[2] < t[0] || b[0] > t[2] || b[3] < t[1] || b[1] > t[3]);
      const hit = (b: Box) => taken.some((t) => overlaps(b, t));
      const hitChips = (b: Box) => taken.some((t) => t !== coreBox && overlaps(b, t));
      const ready = shared.uDraw.value > 2.1;
      for (const c of chips) {
        const route = c.key.startsWith('r:');
        if (!c.anchor || (mobile && route)) {
          c.el.style.opacity = '0';
          c.el.style.pointerEvents = 'none';
          c.on = false;
          continue;
        }
        const p = project(c.anchor);
        const gap = route ? 0 : c.key === 'you' ? corePx + 10 : 22;
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
            q.alt = hit([pp.x - fw / 2, pp.y + 26, pp.x + fw / 2, pp.y + 26 + fh]);
          }
          const rx = pp.x - fw / 2, ry = q.alt ? pp.y - 26 - fh : pp.y + 26;
          const b = smooth(0.7, 1, q.t);
          const tr = travel(q, h, fw, fh);
          const x = tr.x + (rx - tr.x) * b, y = tr.y + (ry - tr.y) * b;
          if (Math.hypot(h.x - c0.x, h.y - c0.y) > corePx + 16 || q.t > 0.35) show(outEl, x, y, fw);
          else hide(outEl);
        } else if (outRest && nowMs < outRest.until) {
          const fw = outEl.offsetWidth, fh = outEl.offsetHeight;
          const pp = project(outRest.prov.node.pos);
          show(outEl, pp.x - fw / 2, outRest.alt ? pp.y - 26 - fh : pp.y + 26, fw);
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
        const restAt = (alt: boolean, fw: number, fh: number) => ({ x: c0.x - fw / 2, y: alt ? c0.y + corePx * 0.48 + 6 : c0.y - corePx * 0.48 - fh - 6 });
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

    const drawTubes = (draw: number) => {
      for (const t of tubes) {
        const k = clamp01((draw - t.t0) / 0.9);
        const g = t.mesh.geometry as THREE.BufferGeometry;
        const n = k >= 1 ? Infinity : Math.floor(k * t.segs) * t.step;
        g.setDrawRange(0, n);
        t.mesh.visible = k > 0;
      }
    };

    const coreTint = new THREE.Color();
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
        shared.uTime.value = age;
        solUniforms.uShift.value = age * 0.035;
        if (hero) {
          shared.uDraw.value = Math.min(3, age * 0.7);
          pointUniforms.uIntro.value = Math.min(3, age * 0.8);
          const sp = clamp01(window.scrollY / Math.max(1, H));
          root.rotation.x = baseTilt + sp * sp * 0.38;
        } else {
          const r = el.getBoundingClientRect();
          const k = clamp01((window.innerHeight - r.top) / (window.innerHeight * 0.85));
          const e = 1 - Math.pow(1 - k, 2);
          shared.uDraw.value = 3 * e;
          pointUniforms.uIntro.value = 3 * e;
        }
        if (!dragging) {
          vel *= 0.94;
          spin += vel;
          if (now - lastDrag > 2400) spin += dt * 0.012;
        }
        cage.rotation.y = age * 0.16;
        cage.rotation.x = Math.sin(age * 0.11) * 0.3;
      }
      root.rotation.y = spin;
      syncRigs(age);
      drawTubes(shared.uDraw.value);
      for (const pv of provs.values()) pv.node.pos.copy(pv.local).applyMatrix4(pv.rig.m);

      const intro = easeOut((pointUniforms.uIntro.value - 0.5) / 1.2);
      coreMesh.scale.setScalar(Math.max(0.001, intro * (1 + core.flare * 0.22)));
      halo.scale.setScalar(3 * Math.max(0.001, intro) * (1 + core.flare * 0.35));
      coreTint.set('#ffffff').lerp(core.flareColor, Math.min(1, core.flare) * 0.55);
      coreMat.emissive.copy(coreTint);
      haloMat.color.copy(coreTint);

      const drawn = shared.uDraw.value > (hero ? 2.4 : 2.6);
      if (!reduce && drawn && now > holdUntil && now > nextAuto) {
        if (nextAuto) {
          run(rehearsal.trips[cursor++ % rehearsal.trips.length]);
          nextAuto = now + (hero ? 4600 + Math.random() * 2000 : 2600 + Math.random() * 1200);
        } else nextAuto = now + 500;
      }
      for (const pv of provs.values()) {
        const n = pv.node;
        const breath = reduce ? 1 : 1 + 0.05 * Math.sin(age * 1.15 + pv.local.x);
        pv.planet.position.copy(n.pos);
        pv.planet.scale.setScalar(Math.max(0.001, easeOut((pointUniforms.uIntro.value - 1) / 1.2)) * breath * (1 + n.flare * 0.35));
        const m = pv.planet.material;
        m.color.copy(pv.color).lerp(new THREE.Color('#b9b6c6'), n.down * 0.85);
        m.emissive.copy(pv.color).lerp(n.flareColor, Math.min(1, n.flare));
        m.emissiveIntensity = 0.18 + n.flare * 0.7;
      }
      nodes.forEach((n, i) => {
        n.flare = Math.max(0, n.flare - dt * 1.4);
        n.down = Math.max(0, n.down - dt * 0.45);
        const c = n.base.clone().lerp(n.flareColor, Math.min(1, n.flare * 1.2));
        pColor.set([c.r, c.g, c.b], i * 3);
        pSize[i] = n.size * (1 + n.flare * (n.kind === 4 ? 0.3 : 0.8));
        pAlpha[i] = n.alpha * (1 - n.down * 0.8) * (n.kind === 4 && i > 1 ? 1 + n.flare * 1.4 : 1);
        pPos[i * 3] = n.pos.x;
        pPos[i * 3 + 1] = n.pos.y;
        pPos[i * 3 + 2] = n.pos.z;
      });
      posAttr.needsUpdate = colorAttr.needsUpdate = sizeAttr.needsUpdate = alphaAttr.needsUpdate = true;
      for (const pv of provs.values()) {
        pv.tint = Math.max(0, pv.tint - dt * 0.35);
        (pv.mat.uniforms.uColor.value as THREE.Color).copy(ARC).lerp(GREEN, pv.tint);
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
          qColor.set([col.r, col.g, col.b], idx * 3);
          const head = k === 0;
          const f = 1 - k / TRAIL;
          qSize[idx] = head ? (q.sealed ? 30 : 24) : 7 * f + 1.5;
          qKind[idx] = head && q.sealed ? 2 : head ? 1 : 0;
          qAlpha[idx] = (head ? 1 : 0.62 * Math.pow(f, 1.4)) * fadeOut;
        }
      });
      qa.pos.needsUpdate = qa.size.needsUpdate = qa.alpha.needsUpdate = qa.color.needsUpdate = qa.kind.needsUpdate = true;
      renderer.render(scene, camera);
      if (hero) placeChips(now);
    };
    raf = requestAnimationFrame(frame);

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
