'use client';

// One orbit-line runs down the page from the hero and docks at each section, drawn by the scroll: solid behind the
// reader's eye line, faint ahead of it. It sweeps through the gap between the text and the card, never under text.
import { useEffect, useRef } from 'react';

export default function Thread() {
  const svg = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const el = svg.current!;
    const body = el.parentElement!;
    const ahead = el.querySelector<SVGPathElement>('.thread__ahead')!;
    const drawn = el.querySelector<SVGPathElement>('.thread__drawn')!;
    const tip = el.querySelector<SVGCircleElement>('.thread__tip')!;
    const docks = el.querySelector<SVGGElement>('.thread__docks')!;
    let len = 1;
    let marks: { y: number; el: SVGGElement }[] = [];
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const build = () => {
      const W = body.clientWidth, H = body.scrollHeight;
      el.setAttribute('viewBox', `0 0 ${W} ${H}`);
      el.style.height = `${H}px`;
      const top = body.getBoundingClientRect().top + window.scrollY;
      const secs = Array.from(body.querySelectorAll<HTMLElement>('[data-dock]'));
      const pts: { x: number; y: number; dock: number; side: number }[] = [{ x: -1, y: 0, dock: -1, side: 0 }];
      secs.forEach((s) => {
        const r = s.getBoundingClientRect();
        const y0 = r.top + window.scrollY - top;
        const text = s.querySelector<HTMLElement>('.split__text');
        const card = s.querySelector<HTMLElement>('.split__card, .split__art, .zero__cards');
        const edge = s.dataset.dock === 'edge';
        let gx = edge ? 18 : W / 2;
        if (!edge && text && card) {
          const a = text.getBoundingClientRect(), b = card.getBoundingClientRect();
          gx = a.right < b.left ? (a.right + b.left) / 2 : (b.right + a.left) / 2;
          gx -= body.getBoundingClientRect().left;
        }
        const cr = card?.getBoundingClientRect();
        const dockY = cr ? cr.top + window.scrollY - top : y0 + 80;
        const side = text && card && card.getBoundingClientRect().left > text.getBoundingClientRect().left ? 1 : -1;
        pts.push({ x: gx, y: Math.max(pts[pts.length - 1].y + 60, y0 - 40), dock: -1, side: 0 });
        pts.push({ x: gx, y: dockY + 24, dock: cr && !edge ? (side === 1 ? cr.left - body.getBoundingClientRect().left : cr.right - body.getBoundingClientRect().left) : -1, side });
        pts.push({ x: gx, y: y0 + r.height - 30, dock: -1, side: 0 });
      });
      pts[0].x = pts[1]?.x ?? W / 2;
      let d = `M ${pts[0].x} ${pts[0].y}`;
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i - 1], q = pts[i];
        const sway = Math.min(26, Math.abs(q.y - p.y) * 0.08) * (i % 2 ? 1 : -1);
        const my = (p.y + q.y) / 2;
        d += ` C ${p.x + sway} ${my}, ${q.x - sway} ${my}, ${q.x} ${q.y}`;
      }
      ahead.setAttribute('d', d);
      drawn.setAttribute('d', d);
      len = drawn.getTotalLength();
      drawn.style.strokeDasharray = `${len} ${len}`;
      docks.replaceChildren();
      marks = [];
      for (const p of pts) {
        if (p.dock < 0) continue;
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        const branch = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        const ex = p.dock;
        const bend = (ex - p.x) * 0.55;
        branch.setAttribute('d', `M ${p.x} ${p.y} C ${p.x + bend} ${p.y}, ${ex - bend * 0.2} ${p.y - 18}, ${ex} ${p.y - 18}`);
        branch.setAttribute('class', 'thread__branch');
        const ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        ring.setAttribute('cx', String(p.x));
        ring.setAttribute('cy', String(p.y));
        ring.setAttribute('r', '4.5');
        ring.setAttribute('class', 'thread__ring');
        g.append(branch, ring);
        docks.append(g);
        marks.push({ y: p.y, el: g });
      }
      draw();
    };

    const draw = () => {
      const top = body.getBoundingClientRect().top;
      const eye = window.innerHeight * 0.62 - top;
      let lo = 0, hi = len;
      for (let i = 0; i < 22; i++) {
        const mid = (lo + hi) / 2;
        if (drawn.getPointAtLength(mid).y < eye) lo = mid;
        else hi = mid;
      }
      const at = reduce ? len : lo;
      drawn.style.strokeDashoffset = String(len - at);
      const p = drawn.getPointAtLength(at);
      tip.setAttribute('cx', String(p.x));
      tip.setAttribute('cy', String(p.y));
      tip.style.opacity = at > 2 && at < len - 2 ? '1' : '0';
      for (const m of marks) m.el.classList.toggle('is-on', reduce || m.y < eye);
    };

    let raf = 0;
    const kick = () => {
      if (!raf) raf = requestAnimationFrame(() => ((raf = 0), draw()));
    };
    build();
    const ro = new ResizeObserver(() => build());
    ro.observe(body);
    window.addEventListener('scroll', kick, { passive: true });
    document.fonts?.ready.then(build);
    return () => {
      ro.disconnect();
      window.removeEventListener('scroll', kick);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <svg className="thread" ref={svg} aria-hidden="true" preserveAspectRatio="none">
      <path className="thread__ahead" />
      <path className="thread__drawn" />
      <g className="thread__docks" />
      <circle className="thread__tip" r="3.2" />
    </svg>
  );
}
