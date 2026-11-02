// The mark: the orrery in four strokes. A core, two crossing orbits, one provider reached.
export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <ellipse cx="12" cy="12" rx="10.2" ry="4.3" fill="none" stroke="currentColor" strokeWidth="1.1" opacity="0.9" />
      <ellipse cx="12" cy="12" rx="10.2" ry="4.3" fill="none" stroke="currentColor" strokeWidth="1.1" opacity="0.55" transform="rotate(62 12 12)" />
      <circle cx="12" cy="12" r="2.5" fill="currentColor" />
      <circle cx="20.6" cy="9.7" r="1.7" fill="#14f195" />
    </svg>
  );
}
