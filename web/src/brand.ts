// Working title lives here and in node/src/brand.ts only. Renaming the project means editing these two files.
export const NAME = 'Switchyard';
export const TICKER = 'YARD';
export const WORKING_TITLE = true;

// Set once the token exists (launched on Meteora DBC). null renders "not launched yet".
export const CA: string | null = null;
export const X_URL: string | null = null;
// Placeholder until the public repository exists.
export const REPO_URL = 'https://github.com/switchyard-network/switchyard';

export const ROUTER_URL = 'http://127.0.0.1:7171/v1';
export const PROGRAM_ID = '7UHevY47LgbJv9hz4iymecR8FURy27jX55KYb1sxytZS';
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3870';
