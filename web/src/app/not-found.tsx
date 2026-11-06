import Link from 'next/link';
import { Mark } from '@/components/Mark';
import { NAME } from '@/brand';

export default function NotFound() {
  return (
    <main className="lost">
      <div className="lost__sky" aria-hidden="true" />
      <Link href="/" className="nav__brand lost__brand" aria-label={`${NAME} home`}>
        <Mark id="lost" />
        <span className="grad">{NAME}</span>
      </Link>
      <div className="lost__body">
        <span className="cap">404</span>
        <h1>
          <span className="lead">This page left the network.</span> Nothing answered here.
        </h1>
        <div className="cta cta--center">
          <Link href="/" className="pill">Back to the network</Link>
          <Link href="/docs" className="ghost">Read the docs</Link>
        </div>
      </div>
    </main>
  );
}
