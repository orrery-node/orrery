// The mark: the orrery in four strokes. A core, two crossing orbits in the Solana gradient (purple where a request
// leaves, green where it is paid), one provider reached.
export function Mark({ size = 22, id = 'mark' }: { size?: number; id?: string }) {
  const g = `${id}-sol`;
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <defs>
        <linearGradient id={g} x1="2" y1="18" x2="22" y2="6" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#9945ff" />
          <stop offset="0.5" stopColor="#5f8ff2" />
          <stop offset="1" stopColor="#14f195" />
        </linearGradient>
      </defs>
      <ellipse cx="12" cy="12" rx="10.2" ry="4.3" fill="none" stroke={`url(#${g})`} strokeWidth="1.3" />
      <ellipse cx="12" cy="12" rx="10.2" ry="4.3" fill="none" stroke={`url(#${g})`} strokeWidth="1.3" opacity="0.6" transform="rotate(62 12 12)" />
      <circle cx="12" cy="12" r="2.5" fill="#f2f2ef" />
      <circle cx="20.6" cy="9.7" r="1.7" fill="#14f195" />
    </svg>
  );
}
