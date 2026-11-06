'use client';

// The providers chapter: three night shots of providers' own machines, crossfading in turn. The caption is the
// rehearsal provider's name, region and lowest price. Videos play only while the section is on screen; under reduced
// motion the stills stay. Rendered straight into the film section so the shade sits between the footage and the text.
import { useEffect, useRef, useState } from 'react';
import { reducedMotion } from '@/lib/bus';

export type Reel = { src: string; poster: string; name: string; region: string; from: string };

export default function FilmReel({ reels }: { reels: Reel[] }) {
  const cap = useRef<HTMLDivElement>(null);
  const vids = useRef<(HTMLVideoElement | null)[]>([]);
  const [on, setOn] = useState(0);
  const [inView, setInView] = useState(false);
  const [still, setStill] = useState(false);

  useEffect(() => {
    setStill(reducedMotion());
    const target = cap.current?.parentElement;
    if (!target) return;
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), { threshold: 0.15 });
    io.observe(target);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    vids.current.forEach((v, i) => {
      if (!v) return;
      if (inView && !still && i === on) {
        v.currentTime = 0;
        void v.play().catch(() => undefined);
      } else v.pause();
    });
    if (!inView || still) return;
    const t = window.setTimeout(() => setOn((x) => (x + 1) % reels.length), 5200);
    return () => window.clearTimeout(t);
  }, [on, inView, still, reels.length]);

  return (
    <>
      {reels.map((r, i) => (
        <video
          key={r.src}
          ref={(el) => {
            vids.current[i] = el;
          }}
          className={`film__media reel__v${i === on ? ' is-on' : ''}`}
          src={r.src}
          poster={r.poster}
          muted
          loop
          playsInline
          preload={i === 0 ? 'metadata' : 'none'}
          aria-hidden="true"
        />
      ))}
      <div className="reel__cap" ref={cap}>
        <div className="reel__rows">
          {reels.map((r, i) => (
            <div key={r.name} className={`reel__row${i === on ? ' is-on' : ''}`} aria-hidden={i !== on}>
              <i />
              <span className="reel__name">{r.name}</span>
              <span className="num">{r.region} · from {r.from}/M</span>
            </div>
          ))}
        </div>
        <div className="reel__ticks" aria-hidden="true">
          {reels.map((r, i) => (
            <b key={r.name} className={i === on ? 'is-on' : undefined} />
          ))}
        </div>
      </div>
    </>
  );
}
