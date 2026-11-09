'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export default function WalletLookup({ placeholder = 'Paste a Solana wallet or node address' }: { placeholder?: string }) {
  const router = useRouter();
  const [value, setValue] = useState('');
  const [bad, setBad] = useState(false);
  return (
    <form
      className="wlook"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        const v = value.trim();
        if (!BASE58.test(v)) return setBad(true);
        router.push(`/address/${v}`);
      }}
    >
      <label className="sr" htmlFor="wlook-input">Wallet or node address</label>
      <input
        id="wlook-input"
        className="num"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setBad(false);
        }}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={bad}
      />
      <button type="submit">Look up</button>
      {bad ? <span className="wlook__bad" role="status">That isn&apos;t a Solana address.</span> : null}
    </form>
  );
}
