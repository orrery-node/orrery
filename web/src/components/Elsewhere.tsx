import { NPM_URL, REPO_URL, X_URL } from '@/brand';

const LINKS = [
  {
    label: 'npm',
    href: NPM_URL,
    box: '0 0 24 24',
    size: 16,
    d: 'M1.763 0C.786 0 0 .786 0 1.763v20.474C0 23.214.786 24 1.763 24h20.474c.977 0 1.763-.786 1.763-1.763V1.763C24 .786 23.214 0 22.237 0zM5.13 5.323l13.837.019-.009 13.836h-3.464l.01-10.382h-3.456L12.04 19.17H5.113z',
  },
  {
    label: 'GitHub',
    href: REPO_URL,
    box: '0 0 16 16',
    size: 18,
    d: 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z',
  },
  {
    label: 'X',
    href: X_URL,
    box: '0 0 24 24',
    size: 16,
    d: 'M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z',
  },
];

/** npm, GitHub and X as icon links, for every page header. */
export default function Elsewhere() {
  return (
    <nav className="elsewhere" aria-label="Elsewhere">
      {LINKS.filter((l) => l.href).map((l) => (
        <a key={l.label} href={l.href as string} rel="noopener noreferrer" target="_blank" aria-label={l.label} title={l.label}>
          <svg viewBox={l.box} width={l.size} height={l.size} aria-hidden="true">
            <path d={l.d} fill="currentColor" />
          </svg>
        </a>
      ))}
    </nav>
  );
}
