// The project name lives here and nowhere else in the node software. Renaming the project means editing this file
// (and the web's brand file). On-chain and wire names (crate `orrery`, voucher prefix `orrery/voucher/1`, x-orrery-*
// headers) are protocol: changing them after the mainnet deploy breaks every deployed node.
export const NAME = 'Orrery';
export const CLI = 'orrery';
export const TICKER = 'OREY';
export const HOME_DIR = '.orrery';
export const ROUTER_PORT = 7171;
export const PROVIDER_PORT = 7272;
export const PROGRAM_ID = process.env.ORRERY_PROGRAM_ID ?? '7UHevY47LgbJv9hz4iymecR8FURy27jX55KYb1sxytZS';
export const USDC_MAINNET = 'EPjFWJd5Wm8eUi4wSPdf8qJxQAXnmSeKEr5mVGYLm3CY';
