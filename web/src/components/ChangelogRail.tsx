'use client';

import { useEffect, useRef } from 'react';

/** The line down the changelog fills as you scroll, and each release's dot lights when the line reaches it. It only
 * answers to scrolling, and sits filled and lit when motion is reduced. */
export default function ChangelogRail({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const dots = [...el.querySelectorAll<HTMLElement>('[data-dot]')];
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.style.setProperty('--fill', '1');
      dots.forEach((d) => d.classList.add('is-lit'));
      return;
    }
    let raf = 0;
    const update = () => {
      raf = 0;
      const r = el.getBoundingClientRect();
      const head = window.innerHeight * 0.62;
      const p = Math.max(0, Math.min(1, (head - r.top) / Math.max(1, r.height)));
      el.style.setProperty('--fill', p.toFixed(4));
      for (const d of dots) d.classList.toggle('is-lit', d.getBoundingClientRect().top < head);
    };
    const on = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', on, { passive: true });
    window.addEventListener('resize', on);
    return () => {
      window.removeEventListener('scroll', on);
      window.removeEventListener('resize', on);
      cancelAnimationFrame(raf);
    };
  }, []);
  return (
    <div className="cl__rail" ref={ref}>
      <span className="cl__line" aria-hidden="true">
        <i />
      </span>
      {children}
    </div>
  );
}
