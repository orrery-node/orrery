'use client';

// The docs' table of contents: numbered, and it marks the section being read.
import { useEffect, useState } from 'react';

export default function DocsToc({ items }: { items: readonly (readonly [string, string])[] }) {
  const [active, setActive] = useState(items[0]?.[0] ?? '');
  useEffect(() => {
    const els = items.map(([id]) => document.getElementById(id)).filter((e): e is HTMLElement => !!e);
    const pick = () => {
      let cur = els[0]?.id ?? '';
      for (const e of els) if (e.getBoundingClientRect().top < 140) cur = e.id;
      setActive(cur);
    };
    pick();
    window.addEventListener('scroll', pick, { passive: true });
    return () => window.removeEventListener('scroll', pick);
  }, [items]);
  return (
    <nav className="d-toc" aria-label="On this page">
      <span className="cap d-toc__cap">On this page</span>
      {items.map(([id, label], i) => (
        <a key={id} href={`#${id}`} className={active === id ? 'is-on' : undefined} aria-current={active === id ? 'location' : undefined}>
          <span className="num">{String(i + 1).padStart(2, '0')}</span>
          {label}
        </a>
      ))}
    </nav>
  );
}
