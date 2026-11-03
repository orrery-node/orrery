'use client';

// One request, drawn by the scroll. A single line leaves the hero's request bar, runs down the page's edge past a
// reading from the rehearsal at every section, and lands on the closing orrery's core. Scrolling back undraws it.
import { useEffect, useRef } from 'react';
import { emit, reducedMotion } from '@/lib/bus';

type Stop = { y: number; el: HTMLElement; lit: boolean; section: HTMLElement };
type Seg = { len: number; a: number; b: number; at: (u: number) => [number, number] };

const HEAD_AT = 0.62;

export default function Wire() {
  const root = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const ghost = useRef<SVGPathElement>(null);
  const line = useRef<SVGPathElement>(null);
  const ticks = useRef<SVGPathElement>(null);
  const tickClip = useRef<SVGRectElement>(null);
  const grad = useRef<SVGLinearGradientElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const stopsLayer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = root.current!;
    const main = host.parentElement!;
    const reduce = reducedMotion();
    let segs: Seg[] = [];
    let total = 0;
    let stops: Stop[] = [];
    let endY = 0;
    let arrived = false;
    let raf = 0;

    const build = () => {
      const mr = main.getBoundingClientRect();
      const W = main.clientWidth;
      const mobile = W < 760;
      const rel = (r: DOMRect) => ({ l: r.left - mr.left, t: r.top - mr.top, w: r.width, h: r.height });
      const body = main.querySelector<HTMLElement>('.body');
      const bar = main.querySelector<HTMLElement>('.req__bar');
      const close = main.querySelector<HTMLElement>('.orrery--close');
      if (!body || !bar || !close) return;
      const br = rel(body.getBoundingClientRect());
      const contentLeft = br.l + parseFloat(getComputedStyle(body).paddingLeft || '0');
      const railX = Math.round(Math.max(mobile ? 7 : 18, contentLeft - 36)) + 0.5;
      const b = rel(bar.getBoundingClientRect());
      const sx = b.l, sy = Math.round(b.t + b.h / 2) + 0.5;
      const c = rel(close.getBoundingClientRect());
      const ex = c.l + c.w / 2;
      const ey = Math.round(c.t + c.h * (0.5 - (mobile ? 0.1 : 0.06))) + 0.5;
      const r1 = Math.max(0, Math.min(18, (sx - railX) / 2));
      const r2 = Math.min(28, (ex - railX) / 2);
      endY = ey;

      segs = [];
      const lineSeg = (x0: number, y0: number, x1: number, y1: number, a: number, b2: number) => {
        const len = Math.hypot(x1 - x0, y1 - y0);
        if (len > 0.01) segs.push({ len, a, b: b2, at: (u) => [x0 + (x1 - x0) * u, y0 + (y1 - y0) * u] });
      };
      const arcSeg = (cx: number, cy: number, r: number, th0: number, th1: number, a: number, b2: number) => {
        if (r < 0.5) return;
        segs.push({ len: (Math.abs(th1 - th0) * r), a, b: b2, at: (u) => {
          const th = th0 + (th1 - th0) * u;
          return [cx + r * Math.cos(th), cy + r * Math.sin(th)];
        } });
      };
      lineSeg(sx, sy, railX + r1, sy, sy - 240, sy - 20);
      arcSeg(railX + r1, sy + r1, r1, -Math.PI / 2, -Math.PI, sy - 20, sy + r1);
      lineSeg(railX, sy + r1, railX, ey - r2, sy + r1, ey - r2);
      arcSeg(railX + r2, ey - r2, r2, Math.PI, Math.PI / 2, ey - r2, ey);
      lineSeg(railX + r2, ey, ex, ey, ey, ey + 90);
      total = segs.reduce((s, x) => s + x.len, 0);

      let d = `M${sx} ${sy} H${railX + r1}`;
      if (r1 >= 0.5) d += ` A${r1} ${r1} 0 0 0 ${railX} ${sy + r1}`;
      d += ` V${ey - r2} A${r2} ${r2} 0 0 0 ${railX + r2} ${ey} H${ex}`;
      const H = main.clientHeight;
      svg.current!.setAttribute('viewBox', `0 0 ${W} ${H}`);
      grad.current!.setAttribute('y1', String(sy));
      grad.current!.setAttribute('y2', String(ey));
      ghost.current!.setAttribute('d', d);
      line.current!.setAttribute('d', d);
      line.current!.style.strokeDasharray = `${total} ${total}`;
      let td = '';
      for (let y = Math.ceil((sy + r1) / 24) * 24; y < ey - r2; y += 24) {
        const big = y % 120 === 0;
        td += `M${railX - (big ? 6 : 3)} ${y + 0.5} H${railX}`;
      }
      ticks.current!.setAttribute('d', td);
      tickClip.current!.setAttribute('width', String(W));

      const layer = stopsLayer.current!;
      layer.replaceChildren();
      stops = [];
      main.querySelectorAll<HTMLElement>('[data-wire-k]').forEach((section) => {
        const sr = rel(section.getBoundingClientRect());
        const y = Math.round(sr.t + Number(section.dataset.wireAt ?? 56)) + 0.5;
        if (y <= sy + r1 || y >= ey - r2) return;
        const el = document.createElement('div');
        el.className = 'wire__stop';
        el.style.transform = `translate3d(${railX}px, ${y}px, 0)`;
        const k = document.createElement('span');
        k.className = 'wire__k';
        k.textContent = section.dataset.wireK ?? '';
        const v = document.createElement('span');
        v.className = section.dataset.wireMoney ? 'wire__v num green' : 'wire__v num';
        v.textContent = section.dataset.wireV ?? '';
        el.append(document.createElement('i'), k, v);
        layer.append(el);
        stops.push({ y, el, lit: false, section });
      });
      update();
    };

    const drawnAt = (hy: number) => segs.reduce((s, x) => s + x.len * Math.min(1, Math.max(0, (hy - x.a) / (x.b - x.a))), 0);
    const pointAt = (L: number): [number, number] => {
      let left = L;
      for (const s of segs) {
        if (left <= s.len) return s.at(s.len ? left / s.len : 0);
        left -= s.len;
      }
      const last = segs.at(-1);
      return last ? last.at(1) : [0, 0];
    };

    const update = () => {
      raf = 0;
      if (!segs.length) return;
      const mr = main.getBoundingClientRect();
      const hy = reduce ? Infinity : -mr.top + window.innerHeight * HEAD_AT;
      const L = reduce ? total : Math.min(total, drawnAt(hy));
      line.current!.style.strokeDashoffset = String(total - L);
      const [px, py] = pointAt(L);
      tickClip.current!.setAttribute('height', String(Math.max(0, py)));
      const h = head.current!;
      const showHead = !reduce && L > 2 && L < total - 1;
      h.style.opacity = showHead ? '1' : '0';
      h.style.transform = `translate3d(${px}px, ${py}px, 0)`;
      let paid = false;
      for (const s of stops) {
        const lit = py >= s.y - 1 || L >= total - 1;
        if (lit !== s.lit) {
          s.lit = lit;
          s.el.classList.toggle('is-lit', lit);
          s.section.classList.toggle('wire-passed', lit);
        }
        if (lit && s.section.dataset.wireMoney) paid = true;
      }
      h.classList.toggle('is-paid', paid);
      const done = L >= total - 1;
      if (done && !arrived) emit('orrery:arrive', { at: performance.now() });
      if (py < endY - 200) arrived = false;
      else if (done) arrived = true;
    };
    const queue = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };

    build();
    const ro = new ResizeObserver(() => build());
    ro.observe(main);
    document.fonts?.ready.then(build);
    const late = window.setTimeout(build, 1200);
    window.addEventListener('scroll', queue, { passive: true });
    window.addEventListener('resize', queue);
    window.addEventListener('orrery:layout', build);
    host.classList.add('is-on');
    return () => {
      ro.disconnect();
      window.clearTimeout(late);
      window.removeEventListener('scroll', queue);
      window.removeEventListener('resize', queue);
      window.removeEventListener('orrery:layout', build);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div className="wire" ref={root} aria-hidden="true">
      <svg ref={svg} className="wire__svg" preserveAspectRatio="none">
        <defs>
          <linearGradient id="wire-sol" ref={grad} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#9945ff" />
            <stop offset="0.5" stopColor="#5f8ff2" />
            <stop offset="1" stopColor="#14f195" />
          </linearGradient>
          <clipPath id="wire-drawn">
            <rect ref={tickClip} x="0" y="0" width="0" height="0" />
          </clipPath>
        </defs>
        <path ref={ghost} className="wire__ghost" />
        <path ref={ticks} className="wire__ticks" clipPath="url(#wire-drawn)" />
        <path ref={line} className="wire__line" />
      </svg>
      <div className="wire__stops" ref={stopsLayer} />
      <div className="wire__head" ref={head}>
        <i />
      </div>
    </div>
  );
}
