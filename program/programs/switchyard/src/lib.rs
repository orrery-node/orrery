//! Switchyard (working title): the on-chain half of a peer-to-peer AI inference network.
//!
//! Providers list themselves: an endpoint, the key their node signs with, and the hash of a price manifest the
//! node serves. A user's router opens a payment channel to a provider. USDC moves from the user's wallet into an
//! account the channel owns, and a session key on the user's own computer signs a running total after each
//! request. The provider redeems the highest total it holds, whenever it likes.
//!
//! There is no fee anywhere in this program. Every unit redeemed goes to the provider's own token account and
//! every unit not redeemed goes back to the user when the channel closes. A provider may also claim a hardware
//! enclave (the router verifies the full report itself) and may bond the network token as a public cost signal.
//!
//! What the admin can do: tune the close grace period, the unbonding delay and the smallest deposit inside fixed
//! bounds, and set the bond mint once. What no one can do: list or delist a provider for someone else, move a
//! channel's deposit anywhere except to its provider (with the user's signed voucher) or back to its user, or
//! move a bond anywhere except back to the provider that posted it.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{self, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked};

pub mod voucher;

declare_id!("7UHevY47LgbJv9hz4iymecR8FURy27jX55KYb1sxytZS");

pub const CONFIG_SEED: &[u8] = b"config";
pub const PROVIDER_SEED: &[u8] = b"provider";
pub const CHANNEL_SEED: &[u8] = b"channel";

pub const MAX_ENDPOINT: usize = 120;
pub const MIN_GRACE_SECS: i64 = 10 * 60;
pub const MAX_GRACE_SECS: i64 = 7 * 86_400;
pub const MIN_UNBOND_SECS: i64 = 3_600;
pub const MAX_UNBOND_SECS: i64 = 30 * 86_400;
pub const MAX_ATTESTATION_SECS: i64 = 30 * 86_400;

pub const TEE_NONE: u8 = 0;
pub const TEE_INTEL_TDX: u8 = 1;
pub const TEE_AMD_SEV_SNP: u8 = 2;
pub const TEE_TDX_NVIDIA_CC: u8 = 3;

#[program]
pub mod switchyard {
    use super::*;

    /// Only the program's upgrade authority may initialize, so no one can race the deploy and claim the config.
    pub fn initialize(ctx: Context<Initialize>, args: ParamsArgs) -> Result<()> {
        check_params(&args)?;
        let c = &mut ctx.accounts.config;
        c.admin = ctx.accounts.admin.key();
        c.pending_admin = Pubkey::default();
        c.settle_mint = ctx.accounts.settle_mint.key();
        c.bond_mint = Pubkey::default();
        c.close_grace_secs = args.close_grace_secs;
        c.unbond_secs = args.unbond_secs;
        c.min_deposit = args.min_deposit;
        c.providers = 0;
        c.channels = 0;
        c.settled = 0;
        c.bump = ctx.bumps.config;
        emit!(ParamsChanged { close_grace_secs: args.close_grace_secs, unbond_secs: args.unbond_secs, min_deposit: args.min_deposit });
        Ok(())
    }

    pub fn set_params(ctx: Context<AdminOnly>, args: ParamsArgs) -> Result<()> {
        check_params(&args)?;
        let c = &mut ctx.accounts.config;
        c.close_grace_secs = args.close_grace_secs;
        c.unbond_secs = args.unbond_secs;
        c.min_deposit = args.min_deposit;
        emit!(ParamsChanged { close_grace_secs: args.close_grace_secs, unbond_secs: args.unbond_secs, min_deposit: args.min_deposit });
        Ok(())
    }

    /// The bond mint is the network token, which does not exist when the program is deployed. It can be set once.
    pub fn set_bond_mint(ctx: Context<SetBondMint>) -> Result<()> {
        let c = &mut ctx.accounts.config;
        require_keys_eq!(c.bond_mint, Pubkey::default(), SwitchyardError::BondMintSet);
        c.bond_mint = ctx.accounts.bond_mint.key();
        emit!(BondMintSet { bond_mint: c.bond_mint });
        Ok(())
    }

    pub fn propose_admin(ctx: Context<AdminOnly>, next: Pubkey) -> Result<()> {
        ctx.accounts.config.pending_admin = next;
        Ok(())
    }

    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        let c = &mut ctx.accounts.config;
        c.admin = c.pending_admin;
        c.pending_admin = Pubkey::default();
        Ok(())
    }

    /// Anyone can list a provider. No approval, no stake required.
    pub fn register_provider(ctx: Context<RegisterProvider>, node_key: Pubkey, endpoint: String, manifest_hash: [u8; 32]) -> Result<()> {
        check_endpoint(&endpoint)?;
        let now = Clock::get()?.unix_timestamp;
        let p = &mut ctx.accounts.provider;
        p.authority = ctx.accounts.authority.key();
        p.node_key = node_key;
        p.endpoint = endpoint;
        p.manifest_hash = manifest_hash;
        p.manifest_seq = 1;
        p.active = true;
        p.tee_kind = TEE_NONE;
        p.tee_measurement = [0u8; 48];
        p.tee_report_hash = [0u8; 32];
        p.tee_key = [0u8; 32];
        p.tee_expires_at = 0;
        p.bonded = 0;
        p.unbonding = 0;
        p.unbond_at = 0;
        p.settled = 0;
        p.redeems = 0;
        p.channels = 0;
        p.registered_at = now;
        p.last_settled_at = 0;
        p.bump = ctx.bumps.provider;
        ctx.accounts.config.providers += 1;
        emit!(ProviderRegistered { provider: p.key(), authority: p.authority, node_key, endpoint: p.endpoint.clone(), manifest_hash });
        Ok(())
    }

    pub fn update_provider(ctx: Context<UpdateProvider>, args: UpdateProviderArgs) -> Result<()> {
        let p = &mut ctx.accounts.provider;
        if let Some(k) = args.node_key {
            p.node_key = k;
        }
        if let Some(e) = args.endpoint {
            check_endpoint(&e)?;
            p.endpoint = e;
        }
        if let Some(h) = args.manifest_hash {
            if h != p.manifest_hash {
                p.manifest_hash = h;
                p.manifest_seq = p.manifest_seq.saturating_add(1);
            }
        }
        if let Some(a) = args.active {
            p.active = a;
        }
        emit!(ProviderUpdated { provider: p.key(), node_key: p.node_key, endpoint: p.endpoint.clone(), manifest_hash: p.manifest_hash, manifest_seq: p.manifest_seq, active: p.active });
        Ok(())
    }

    /// Record an enclave claim: which kind of TEE, the measurement it booted, the hash of the full attestation
    /// report the node serves, and the key prompts are encrypted to. The program cannot check a hardware report;
    /// routers fetch the report, check this hash, and verify it against the vendor roots before trusting it.
    /// Kind 0 clears the claim. The provider's wallet or its node key may post it.
    pub fn attest(ctx: Context<Attest>, args: AttestArgs) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let p = &mut ctx.accounts.provider;
        let signer = ctx.accounts.signer.key();
        require!(signer == p.authority || signer == p.node_key, SwitchyardError::NotProvider);
        if args.kind == TEE_NONE {
            p.tee_kind = TEE_NONE;
            p.tee_measurement = [0u8; 48];
            p.tee_report_hash = [0u8; 32];
            p.tee_key = [0u8; 32];
            p.tee_expires_at = 0;
        } else {
            require!(args.kind <= TEE_TDX_NVIDIA_CC, SwitchyardError::BadAttestation);
            require!(args.expires_at > now && args.expires_at <= now + MAX_ATTESTATION_SECS, SwitchyardError::BadAttestation);
            require!(args.report_hash != [0u8; 32] && args.tee_key != [0u8; 32], SwitchyardError::BadAttestation);
            p.tee_kind = args.kind;
            p.tee_measurement = args.measurement;
            p.tee_report_hash = args.report_hash;
            p.tee_key = args.tee_key;
            p.tee_expires_at = args.expires_at;
        }
        emit!(Attested { provider: p.key(), kind: p.tee_kind, measurement: p.tee_measurement, report_hash: p.tee_report_hash, expires_at: p.tee_expires_at });
        Ok(())
    }

    /// Post the network token as a bond. Routers read it as one input to reputation; it is never slashed.
    pub fn bond(ctx: Context<Bond>, amount: u64) -> Result<()> {
        require!(amount > 0, SwitchyardError::ZeroAmount);
        let a = &ctx.accounts;
        token_interface::transfer_checked(
            CpiContext::new(
                a.token_program.key(),
                TransferChecked { from: a.authority_tokens.to_account_info(), mint: a.bond_mint.to_account_info(), to: a.bond_vault.to_account_info(), authority: a.authority.to_account_info() },
            ),
            amount,
            a.bond_mint.decimals,
        )?;
        let p = &mut ctx.accounts.provider;
        p.bonded = p.bonded.checked_add(amount).ok_or(SwitchyardError::Overflow)?;
        emit!(Bonded { provider: p.key(), amount, bonded: p.bonded });
        Ok(())
    }

    /// Start taking a bond back. It stops counting at once and can be withdrawn after the unbonding delay;
    /// unbonding more resets the clock on the whole unbonding amount.
    pub fn unbond(ctx: Context<UnbondCtx>, amount: u64) -> Result<()> {
        require!(amount > 0, SwitchyardError::ZeroAmount);
        let now = Clock::get()?.unix_timestamp;
        let delay = ctx.accounts.config.unbond_secs;
        let p = &mut ctx.accounts.provider;
        require!(amount <= p.bonded, SwitchyardError::InsufficientBond);
        p.bonded -= amount;
        p.unbonding = p.unbonding.checked_add(amount).ok_or(SwitchyardError::Overflow)?;
        p.unbond_at = now + delay;
        emit!(Unbonding { provider: p.key(), amount, bonded: p.bonded, unbonding: p.unbonding, unbond_at: p.unbond_at });
        Ok(())
    }

    pub fn withdraw_bond(ctx: Context<WithdrawBond>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let (amount, ready, authority, bump) = {
            let p = &ctx.accounts.provider;
            (p.unbonding, p.unbond_at, p.authority, p.bump)
        };
        require!(amount > 0, SwitchyardError::ZeroAmount);
        require!(now >= ready, SwitchyardError::TooEarly);
        let seeds: &[&[u8]] = &[PROVIDER_SEED, authority.as_ref(), &[bump]];
        let a = &ctx.accounts;
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                a.token_program.key(),
                TransferChecked { from: a.bond_vault.to_account_info(), mint: a.bond_mint.to_account_info(), to: a.authority_tokens.to_account_info(), authority: a.provider.to_account_info() },
                &[seeds],
            ),
            amount,
            a.bond_mint.decimals,
        )?;
        let p = &mut ctx.accounts.provider;
        p.unbonding = 0;
        p.unbond_at = 0;
        emit!(BondWithdrawn { provider: p.key(), amount });
        Ok(())
    }

    /// Lock a deposit for one provider. `session_key` is the router's local key that signs vouchers, so the wallet
    /// signs once per channel instead of once per request. `id` is chosen by the router (random) so channels to the
    /// same provider never collide.
    pub fn open_channel(ctx: Context<OpenChannel>, id: u64, deposit: u64, session_key: Pubkey) -> Result<()> {
        require!(ctx.accounts.provider.active, SwitchyardError::ProviderInactive);
        require!(deposit >= ctx.accounts.config.min_deposit && deposit > 0, SwitchyardError::DepositTooSmall);
        require!(session_key != Pubkey::default(), SwitchyardError::BadVoucher);
        let a = &ctx.accounts;
        token_interface::transfer_checked(
            CpiContext::new(
                a.token_program.key(),
                TransferChecked { from: a.payer_tokens.to_account_info(), mint: a.mint.to_account_info(), to: a.vault.to_account_info(), authority: a.payer.to_account_info() },
            ),
            deposit,
            a.mint.decimals,
        )?;
        let now = Clock::get()?.unix_timestamp;
        let ch = &mut ctx.accounts.channel;
        ch.payer = ctx.accounts.payer.key();
        ch.provider = ctx.accounts.provider.key();
        ch.session_key = session_key;
        ch.mint = ctx.accounts.mint.key();
        ch.id = id;
        ch.deposit = deposit;
        ch.redeemed = 0;
        ch.usage_hash = [0u8; 32];
        ch.opened_at = now;
        ch.closing_at = 0;
        ch.bump = ctx.bumps.channel;
        ctx.accounts.provider.channels += 1;
        ctx.accounts.config.channels += 1;
        emit!(ChannelOpened { channel: ch.key(), payer: ch.payer, provider: ch.provider, session_key, deposit });
        Ok(())
    }

    pub fn top_up(ctx: Context<TopUp>, amount: u64) -> Result<()> {
        require!(amount > 0, SwitchyardError::ZeroAmount);
        require!(ctx.accounts.channel.closing_at == 0, SwitchyardError::ChannelClosing);
        let a = &ctx.accounts;
        token_interface::transfer_checked(
            CpiContext::new(
                a.token_program.key(),
                TransferChecked { from: a.payer_tokens.to_account_info(), mint: a.mint.to_account_info(), to: a.vault.to_account_info(), authority: a.payer.to_account_info() },
            ),
            amount,
            a.mint.decimals,
        )?;
        let ch = &mut ctx.accounts.channel;
        ch.deposit = ch.deposit.checked_add(amount).ok_or(SwitchyardError::Overflow)?;
        emit!(ToppedUp { channel: ch.key(), amount, deposit: ch.deposit });
        Ok(())
    }

    /// Pay a provider up to a voucher's total. Anyone can submit it (usually the provider's node), and the money
    /// can only go to the provider's own token account. A total above the deposit pays the deposit and no more.
    pub fn redeem(ctx: Context<Redeem>, cumulative: u64, usage_hash: [u8; 32]) -> Result<()> {
        let (channel_key, session_key, deposit, redeemed, payer, provider, id, bump) = {
            let ch = &ctx.accounts.channel;
            (ch.key(), ch.session_key, ch.deposit, ch.redeemed, ch.payer, ch.provider, ch.id, ch.bump)
        };
        require!(cumulative > redeemed, SwitchyardError::NothingToRedeem);
        let message = voucher::voucher_message(&channel_key, cumulative, &usage_hash);
        voucher::require_voucher(&ctx.accounts.instructions, &session_key, &message)?;
        let pay = cumulative.min(deposit).checked_sub(redeemed).ok_or(SwitchyardError::NothingToRedeem)?;
        require!(pay > 0, SwitchyardError::NothingToRedeem);
        let idb = id.to_le_bytes();
        let seeds: &[&[u8]] = &[CHANNEL_SEED, payer.as_ref(), provider.as_ref(), &idb, &[bump]];
        let a = &ctx.accounts;
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                a.token_program.key(),
                TransferChecked { from: a.vault.to_account_info(), mint: a.mint.to_account_info(), to: a.payout.to_account_info(), authority: a.channel.to_account_info() },
                &[seeds],
            ),
            pay,
            a.mint.decimals,
        )?;
        let now = Clock::get()?.unix_timestamp;
        let ch = &mut ctx.accounts.channel;
        ch.redeemed += pay;
        ch.usage_hash = usage_hash;
        let p = &mut ctx.accounts.provider;
        p.settled = p.settled.checked_add(pay).ok_or(SwitchyardError::Overflow)?;
        p.redeems += 1;
        p.last_settled_at = now;
        let c = &mut ctx.accounts.config;
        c.settled = c.settled.checked_add(pay).ok_or(SwitchyardError::Overflow)?;
        emit!(Redeemed { channel: channel_key, provider, payer, cumulative, paid: pay, redeemed: ch.redeemed, usage_hash });
        Ok(())
    }

    /// The user starts closing a channel. The provider keeps the grace period to redeem its last voucher.
    pub fn request_close(ctx: Context<PayerChannel>) -> Result<()> {
        let grace = ctx.accounts.config.close_grace_secs;
        let ch = &mut ctx.accounts.channel;
        require!(ch.closing_at == 0, SwitchyardError::ChannelClosing);
        ch.closing_at = Clock::get()?.unix_timestamp + grace;
        emit!(CloseRequested { channel: ch.key(), closing_at: ch.closing_at });
        Ok(())
    }

    /// Return what was not redeemed to the user and close the channel. The user can after the grace period; the
    /// provider (wallet or node key) can at any time, which gives up anything it has not redeemed.
    pub fn close_channel(ctx: Context<CloseChannel>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let closer = ctx.accounts.closer.key();
        let (payer, provider, id, bump, closing_at, deposit, redeemed) = {
            let ch = &ctx.accounts.channel;
            (ch.payer, ch.provider, ch.id, ch.bump, ch.closing_at, ch.deposit, ch.redeemed)
        };
        let by_provider = closer == ctx.accounts.provider.authority || closer == ctx.accounts.provider.node_key;
        if !by_provider {
            require_keys_eq!(closer, payer, SwitchyardError::NotPayer);
            require!(closing_at != 0 && now >= closing_at, SwitchyardError::TooEarly);
        }
        let refund = ctx.accounts.vault.amount;
        let idb = id.to_le_bytes();
        let seeds: &[&[u8]] = &[CHANNEL_SEED, payer.as_ref(), provider.as_ref(), &idb, &[bump]];
        let a = &ctx.accounts;
        if refund > 0 {
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    a.token_program.key(),
                    TransferChecked { from: a.vault.to_account_info(), mint: a.mint.to_account_info(), to: a.payer_tokens.to_account_info(), authority: a.channel.to_account_info() },
                    &[seeds],
                ),
                refund,
                a.mint.decimals,
            )?;
        }
        token_interface::close_account(CpiContext::new_with_signer(
            a.token_program.key(),
            CloseAccount { account: a.vault.to_account_info(), destination: a.payer.to_account_info(), authority: a.channel.to_account_info() },
            &[seeds],
        ))?;
        emit!(ChannelClosed { channel: a.channel.key(), payer, provider, deposit, redeemed, refund, by_provider });
        Ok(())
    }
}

fn check_params(a: &ParamsArgs) -> Result<()> {
    require!((MIN_GRACE_SECS..=MAX_GRACE_SECS).contains(&a.close_grace_secs), SwitchyardError::BadParams);
    require!((MIN_UNBOND_SECS..=MAX_UNBOND_SECS).contains(&a.unbond_secs), SwitchyardError::BadParams);
    require!(a.min_deposit > 0, SwitchyardError::BadParams);
    Ok(())
}

fn check_endpoint(e: &str) -> Result<()> {
    require!(!e.is_empty() && e.len() <= MAX_ENDPOINT, SwitchyardError::BadEndpoint);
    require!(e.bytes().all(|b| b.is_ascii_graphic()), SwitchyardError::BadEndpoint);
    require!(e.starts_with("https://") || e.starts_with("http://"), SwitchyardError::BadEndpoint);
    Ok(())
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
    pub settle_mint: Pubkey,
    pub bond_mint: Pubkey,
    pub close_grace_secs: i64,
    pub unbond_secs: i64,
    pub min_deposit: u64,
    pub providers: u64,
    pub channels: u64,
    pub settled: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Provider {
    pub authority: Pubkey,
    pub node_key: Pubkey,
    #[max_len(120)]
    pub endpoint: String,
    pub manifest_hash: [u8; 32],
    pub manifest_seq: u32,
    pub active: bool,
    pub tee_kind: u8,
    pub tee_measurement: [u8; 48],
    pub tee_report_hash: [u8; 32],
    pub tee_key: [u8; 32],
    pub tee_expires_at: i64,
    pub bonded: u64,
    pub unbonding: u64,
    pub unbond_at: i64,
    pub settled: u64,
    pub redeems: u64,
    pub channels: u64,
    pub registered_at: i64,
    pub last_settled_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Channel {
    pub payer: Pubkey,
    pub provider: Pubkey,
    pub session_key: Pubkey,
    pub mint: Pubkey,
    pub id: u64,
    pub deposit: u64,
    pub redeemed: u64,
    pub usage_hash: [u8; 32],
    pub opened_at: i64,
    pub closing_at: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct ParamsArgs {
    pub close_grace_secs: i64,
    pub unbond_secs: i64,
    pub min_deposit: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct UpdateProviderArgs {
    pub node_key: Option<Pubkey>,
    pub endpoint: Option<String>,
    pub manifest_hash: Option<[u8; 32]>,
    pub active: Option<bool>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct AttestArgs {
    pub kind: u8,
    pub measurement: [u8; 48],
    pub report_hash: [u8; 32],
    pub tee_key: [u8; 32],
    pub expires_at: i64,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ SwitchyardError::NotUpgradeAuthority)]
    pub program: Program<'info, crate::program::Switchyard>,
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()) @ SwitchyardError::NotUpgradeAuthority)]
    pub program_data: Account<'info, ProgramData>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    pub settle_mint: InterfaceAccount<'info, Mint>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ SwitchyardError::NotAdmin)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct SetBondMint<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ SwitchyardError::NotAdmin)]
    pub config: Account<'info, Config>,
    pub bond_mint: InterfaceAccount<'info, Mint>,
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub pending_admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = pending_admin @ SwitchyardError::NotAdmin)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct RegisterProvider<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(init, payer = authority, space = 8 + Provider::INIT_SPACE, seeds = [PROVIDER_SEED, authority.key().as_ref()], bump)]
    pub provider: Account<'info, Provider>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateProvider<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [PROVIDER_SEED, authority.key().as_ref()], bump = provider.bump, has_one = authority @ SwitchyardError::NotProvider)]
    pub provider: Account<'info, Provider>,
}

#[derive(Accounts)]
pub struct Attest<'info> {
    pub signer: Signer<'info>,
    #[account(mut, seeds = [PROVIDER_SEED, provider.authority.as_ref()], bump = provider.bump)]
    pub provider: Account<'info, Provider>,
}

#[derive(Accounts)]
pub struct Bond<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = bond_mint)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [PROVIDER_SEED, authority.key().as_ref()], bump = provider.bump, has_one = authority @ SwitchyardError::NotProvider)]
    pub provider: Box<Account<'info, Provider>>,
    #[account(mint::token_program = token_program)]
    pub bond_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = bond_mint, token::authority = authority, token::token_program = token_program)]
    pub authority_tokens: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init_if_needed, payer = authority, associated_token::mint = bond_mint, associated_token::authority = provider, associated_token::token_program = token_program)]
    pub bond_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UnbondCtx<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [PROVIDER_SEED, authority.key().as_ref()], bump = provider.bump, has_one = authority @ SwitchyardError::NotProvider)]
    pub provider: Account<'info, Provider>,
}

#[derive(Accounts)]
pub struct WithdrawBond<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = bond_mint)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [PROVIDER_SEED, authority.key().as_ref()], bump = provider.bump, has_one = authority @ SwitchyardError::NotProvider)]
    pub provider: Box<Account<'info, Provider>>,
    #[account(mint::token_program = token_program)]
    pub bond_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(init_if_needed, payer = authority, associated_token::mint = bond_mint, associated_token::authority = authority, associated_token::token_program = token_program)]
    pub authority_tokens: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = bond_mint, associated_token::authority = provider, associated_token::token_program = token_program)]
    pub bond_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct OpenChannel<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, constraint = config.settle_mint == mint.key() @ SwitchyardError::WrongMint)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [PROVIDER_SEED, provider.authority.as_ref()], bump = provider.bump)]
    pub provider: Box<Account<'info, Provider>>,
    #[account(init, payer = payer, space = 8 + Channel::INIT_SPACE, seeds = [CHANNEL_SEED, payer.key().as_ref(), provider.key().as_ref(), &id.to_le_bytes()], bump)]
    pub channel: Box<Account<'info, Channel>>,
    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = mint, token::authority = payer, token::token_program = token_program)]
    pub payer_tokens: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init, payer = payer, associated_token::mint = mint, associated_token::authority = channel, associated_token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct TopUp<'info> {
    pub payer: Signer<'info>,
    #[account(mut, seeds = [CHANNEL_SEED, payer.key().as_ref(), channel.provider.as_ref(), &channel.id.to_le_bytes()], bump = channel.bump, has_one = payer @ SwitchyardError::NotPayer, has_one = mint)]
    pub channel: Box<Account<'info, Channel>>,
    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = mint, token::authority = payer, token::token_program = token_program)]
    pub payer_tokens: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = channel, associated_token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Redeem<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [PROVIDER_SEED, provider.authority.as_ref()], bump = provider.bump)]
    pub provider: Box<Account<'info, Provider>>,
    #[account(mut, seeds = [CHANNEL_SEED, channel.payer.as_ref(), provider.key().as_ref(), &channel.id.to_le_bytes()], bump = channel.bump, has_one = provider, has_one = mint)]
    pub channel: Box<Account<'info, Channel>>,
    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = channel, associated_token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: the provider's wallet, which owns the payout account
    #[account(address = provider.authority)]
    pub provider_authority: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = caller, associated_token::mint = mint, associated_token::authority = provider_authority, associated_token::token_program = token_program)]
    pub payout: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: the instructions sysvar, read for the ed25519 check
    #[account(address = voucher::INSTRUCTIONS_SYSVAR_ID)]
    pub instructions: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PayerChannel<'info> {
    pub payer: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [CHANNEL_SEED, payer.key().as_ref(), channel.provider.as_ref(), &channel.id.to_le_bytes()], bump = channel.bump, has_one = payer @ SwitchyardError::NotPayer)]
    pub channel: Account<'info, Channel>,
}

#[derive(Accounts)]
pub struct CloseChannel<'info> {
    #[account(mut)]
    pub closer: Signer<'info>,
    #[account(seeds = [PROVIDER_SEED, provider.authority.as_ref()], bump = provider.bump)]
    pub provider: Box<Account<'info, Provider>>,
    #[account(mut, close = payer, seeds = [CHANNEL_SEED, channel.payer.as_ref(), provider.key().as_ref(), &channel.id.to_le_bytes()], bump = channel.bump, has_one = provider, has_one = payer, has_one = mint)]
    pub channel: Box<Account<'info, Channel>>,
    /// CHECK: the channel's user, who gets the refund and both accounts' rent
    #[account(mut)]
    pub payer: UncheckedAccount<'info>,
    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = channel, associated_token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init_if_needed, payer = closer, associated_token::mint = mint, associated_token::authority = payer, associated_token::token_program = token_program)]
    pub payer_tokens: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct ParamsChanged {
    pub close_grace_secs: i64,
    pub unbond_secs: i64,
    pub min_deposit: u64,
}

#[event]
pub struct BondMintSet {
    pub bond_mint: Pubkey,
}

#[event]
pub struct ProviderRegistered {
    pub provider: Pubkey,
    pub authority: Pubkey,
    pub node_key: Pubkey,
    pub endpoint: String,
    pub manifest_hash: [u8; 32],
}

#[event]
pub struct ProviderUpdated {
    pub provider: Pubkey,
    pub node_key: Pubkey,
    pub endpoint: String,
    pub manifest_hash: [u8; 32],
    pub manifest_seq: u32,
    pub active: bool,
}

#[event]
pub struct Attested {
    pub provider: Pubkey,
    pub kind: u8,
    pub measurement: [u8; 48],
    pub report_hash: [u8; 32],
    pub expires_at: i64,
}

#[event]
pub struct Bonded {
    pub provider: Pubkey,
    pub amount: u64,
    pub bonded: u64,
}

#[event]
pub struct Unbonding {
    pub provider: Pubkey,
    pub amount: u64,
    pub bonded: u64,
    pub unbonding: u64,
    pub unbond_at: i64,
}

#[event]
pub struct BondWithdrawn {
    pub provider: Pubkey,
    pub amount: u64,
}

#[event]
pub struct ChannelOpened {
    pub channel: Pubkey,
    pub payer: Pubkey,
    pub provider: Pubkey,
    pub session_key: Pubkey,
    pub deposit: u64,
}

#[event]
pub struct ToppedUp {
    pub channel: Pubkey,
    pub amount: u64,
    pub deposit: u64,
}

#[event]
pub struct Redeemed {
    pub channel: Pubkey,
    pub provider: Pubkey,
    pub payer: Pubkey,
    pub cumulative: u64,
    pub paid: u64,
    pub redeemed: u64,
    pub usage_hash: [u8; 32],
}

#[event]
pub struct CloseRequested {
    pub channel: Pubkey,
    pub closing_at: i64,
}

#[event]
pub struct ChannelClosed {
    pub channel: Pubkey,
    pub payer: Pubkey,
    pub provider: Pubkey,
    pub deposit: u64,
    pub redeemed: u64,
    pub refund: u64,
    pub by_provider: bool,
}

#[error_code]
pub enum SwitchyardError {
    #[msg("only the program's upgrade authority can initialize")]
    NotUpgradeAuthority,
    #[msg("only the admin can do this")]
    NotAdmin,
    #[msg("parameter out of bounds")]
    BadParams,
    #[msg("the bond mint is already set")]
    BondMintSet,
    #[msg("endpoint must be an http(s) URL of at most 120 printable characters")]
    BadEndpoint,
    #[msg("only the provider's wallet or node key can do this")]
    NotProvider,
    #[msg("only the channel's user can do this")]
    NotPayer,
    #[msg("attestation claim is malformed or expired")]
    BadAttestation,
    #[msg("amount must be more than zero")]
    ZeroAmount,
    #[msg("not enough bonded")]
    InsufficientBond,
    #[msg("too early")]
    TooEarly,
    #[msg("provider is not taking new channels")]
    ProviderInactive,
    #[msg("deposit is below the minimum")]
    DepositTooSmall,
    #[msg("wrong mint")]
    WrongMint,
    #[msg("channel is closing")]
    ChannelClosing,
    #[msg("no signed voucher for this channel, total and usage in this transaction")]
    BadVoucher,
    #[msg("nothing new to redeem")]
    NothingToRedeem,
    #[msg("arithmetic overflow")]
    Overflow,
}
