'use client';

// Scroll-scrubbed moments that sit on the page's one drawing: rules draw themselves, the film opens to full bleed,
// the zero paragraph lights word by word, the token loop draws and its marker runs the cycle. Everything scrubs both
// ways and nothing moves while the reader is still.
import { useEffect } from 'react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { reducedMotion } from '@/lib/bus';

gsap.registerPlugin(ScrollTrigger);

export default function ScrollFX() {
  useEffect(() => {
    const reduce = reducedMotion();
    document.documentElement.classList.add('fx-live');
    if (reduce) {
      document.documentElement.classList.add('fx-reduce');
      return () => document.documentElement.classList.remove('fx-live', 'fx-reduce');
    }
    const ctx = gsap.context(() => {
      gsap.utils.toArray<HTMLElement>('[data-rule]').forEach((row) => {
        const cells = row.querySelectorAll<HTMLElement>(':scope > *');
        gsap.fromTo(
          cells,
          { '--rule': 0 },
          { '--rule': 1, ease: 'none', stagger: 0.18, scrollTrigger: { trigger: row, start: 'top 92%', end: 'top 58%', scrub: 0.5 } },
        );
      });

      const film = document.querySelector<HTMLElement>('.film');
      if (film) {
        gsap.fromTo(
          film,
          { clipPath: 'inset(9% 6% 9% 6% round 26px)' },
          { clipPath: 'inset(0% 0% 0% 0% round 0px)', ease: 'none', scrollTrigger: { trigger: film, start: 'top 96%', end: 'top 18%', scrub: 0.6 } },
        );
        const media = film.querySelectorAll('.film__media');
        if (media.length) {
          gsap.fromTo(media, { scale: 1.16 }, { scale: 1, ease: 'none', scrollTrigger: { trigger: film, start: 'top bottom', end: 'bottom top', scrub: 0.6 } });
        }
      }

      document.querySelectorAll<HTMLElement>('[data-words]').forEach((p) => {
        if (!p.dataset.split) {
          const words = (p.textContent ?? '').split(/(\s+)/);
          p.replaceChildren(
            ...words.map((w) => {
              if (/^\s+$/.test(w)) return document.createTextNode(w);
              const s = document.createElement('span');
              s.className = 'w';
              s.textContent = w;
              return s;
            }),
          );
          p.dataset.split = '1';
        }
        gsap.fromTo(
          p.querySelectorAll('.w'),
          { opacity: 0.16 },
          { opacity: 1, ease: 'none', stagger: 0.08, scrollTrigger: { trigger: p, start: 'top 86%', end: 'bottom 52%', scrub: 0.4 } },
        );
      });

      const loop = document.querySelector<SVGSVGElement>('svg.loop');
      if (loop) {
        const orbit = loop.querySelector<SVGCircleElement>('.loop__orbit');
        const run = loop.querySelector<SVGCircleElement>('.loop__run');
        const stations = Array.from(loop.querySelectorAll<SVGGElement>('[data-deg]'));
        const C = 240, R = 168, len = 2 * Math.PI * R;
        if (orbit) {
          orbit.style.strokeDasharray = `${len} ${len}`;
          orbit.style.strokeDashoffset = String(len);
        }
        const state = { p: 0 };
        gsap.to(state, {
          p: 1,
          ease: 'none',
          scrollTrigger: { trigger: loop, start: 'top 82%', end: 'bottom 46%', scrub: 0.5 },
          onUpdate: () => {
            const deg = -90 + state.p * 360;
            if (orbit) orbit.style.strokeDashoffset = String(len * (1 - state.p));
            if (run) {
              const a = (deg * Math.PI) / 180;
              run.setAttribute('cx', (C + R * Math.cos(a)).toFixed(2));
              run.setAttribute('cy', (C + R * Math.sin(a)).toFixed(2));
              run.style.opacity = state.p > 0.002 && state.p < 0.998 ? '1' : '0';
            }
            for (const g of stations) {
              const at = Number(g.dataset.deg);
              const reach = ((at + 90 + 360) % 360) / 360;
              g.classList.toggle('is-on', state.p >= reach - 0.001 && state.p > 0.001);
            }
          },
        });
      }

      document.querySelectorAll<HTMLElement>('[data-count]').forEach((el) => {
        const to = Number(el.dataset.count);
        const fmt = el.dataset.fmt ?? 'int';
        const of = el.dataset.of;
        const decimals = fmt === 'usd6' ? 6 : 0;
        const render = (v: number) => {
          if (fmt === 'usd6') return `$${(v / 1e6).toFixed(decimals)}`;
          const n = Math.round(v);
          return of ? `${n}/${of}` : String(n);
        };
        const final = el.textContent;
        const state = { v: 0 };
        el.textContent = render(0);
        gsap.to(state, {
          v: to,
          duration: 1.3,
          ease: 'power3.out',
          scrollTrigger: { trigger: el, start: 'top 88%', once: true },
          onUpdate: () => (el.textContent = render(state.v)),
          onComplete: () => (el.textContent = final),
        });
      });
    });
    const refresh = () => {
      ScrollTrigger.refresh();
      window.dispatchEvent(new Event('orrery:layout'));
    };
    document.fonts?.ready.then(refresh);
    const late = window.setTimeout(refresh, 1300);
    return () => {
      window.clearTimeout(late);
      ctx.revert();
      document.documentElement.classList.remove('fx-live');
    };
  }, []);
  return null;
}
