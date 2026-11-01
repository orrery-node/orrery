// The mark: one center point and three spokes to three nodes, one of them reached. Drawn, not a glyph.
export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 12 4.6 6.2M12 12l7.8-3.6M12 12l1.4 8.2" stroke="#8f88c8" strokeWidth="1.1" strokeLinecap="round" />
      <circle cx="4.6" cy="6.2" r="1.7" fill="#dcd9f0" />
      <circle cx="19.8" cy="8.4" r="1.7" fill="#14f195" />
      <circle cx="13.4" cy="20.2" r="1.7" fill="#dcd9f0" />
      <circle cx="12" cy="12" r="2.6" fill="#f2f0ff" />
      <circle cx="12" cy="12" r="4.6" fill="none" stroke="#b48cff" strokeWidth="0.9" />
    </svg>
  );
}

// The link arrow, drawn at the same stroke as the mark and the check.
export function Arrow() {
  return (
    <svg className="arrow" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 8h9.4M8.6 4.2 12.4 8l-3.8 3.8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
