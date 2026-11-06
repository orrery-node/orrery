// Working title lives here and in node/src/brand.ts only. Renaming the project means editing these two files.
export const NAME = 'Orrery';
export const TICKER = 'OREY';
export const WORKING_TITLE = false;

// Set once the token exists (launched on Meteora DBC). null renders "not launched yet".
export const CA: string | null = null;
export const X_URL: string | null = 'https://x.com/OrreryNode';
export const REPO_URL: string | null = 'https://github.com/orrery-node/orrery';

export const ROUTER_URL = 'http://127.0.0.1:7171/v1';
export const NPM_PACKAGE = 'orrery-node';
export const NPM_URL = `https://www.npmjs.com/package/${NPM_PACKAGE}`;
export const PROGRAM_ID = '7UHevY47LgbJv9hz4iymecR8FURy27jX55KYb1sxytZS';
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3870';
