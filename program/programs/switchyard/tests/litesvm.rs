//! The Switchyard program on LiteSVM with the real SPL Token and Associated Token programs.
//! Build first: `anchor build --arch v2`.

use std::path::PathBuf;

use anchor_lang::prelude::{Clock, Pubkey};
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use switchyard::{AttestArgs, Channel, Config, ParamsArgs, Provider, UpdateProviderArgs};

const SPL: Pubkey = anchor_lang::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA: Pubkey = anchor_lang::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYSTEM: Pubkey = anchor_lang::pubkey!("11111111111111111111111111111111");
const UPGRADEABLE: Pubkey = anchor_lang::pubkey!("BPFLoaderUpgradeab1e11111111111111111111111");
const SYSVAR_IX: Pubkey = anchor_lang::pubkey!("Sysvar1nstructions1111111111111111111111111");

const USD: u64 = 1_000_000;
const HOUR: i64 = 3_600;
const DAY: i64 = 86_400;

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &switchyard::ID).0
}
fn programdata() -> Pubkey {
    Pubkey::find_program_address(&[switchyard::ID.as_ref()], &UPGRADEABLE).0
}
fn ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[owner.as_ref(), SPL.as_ref(), mint.as_ref()], &ATA).0
}
fn config_pda() -> Pubkey {
    pda(&[switchyard::CONFIG_SEED])
}
fn provider_pda(authority: &Pubkey) -> Pubkey {
    pda(&[switchyard::PROVIDER_SEED, authority.as_ref()])
}
fn channel_pda(payer: &Pubkey, provider: &Pubkey, id: u64) -> Pubkey {
    pda(&[switchyard::CHANNEL_SEED, payer.as_ref(), provider.as_ref(), &id.to_le_bytes()])
}
fn mint_data(decimals: u8) -> Vec<u8> {
    let mut d = vec![0u8; 82];
    d[36..44].copy_from_slice(&u64::MAX.to_le_bytes());
    d[44] = decimals;
    d[45] = 1;
    d
}
fn params() -> ParamsArgs {
    ParamsArgs { close_grace_secs: HOUR, unbond_secs: 7 * DAY, min_deposit: USD / 10 }
}

struct Env {
    svm: LiteSVM,
    admin: Keypair,
    usdc: Pubkey,
}

struct Prov {
    wallet: Keypair,
    node: Keypair,
    pda: Pubkey,
}

struct User {
    wallet: Keypair,
    session: Keypair,
    tokens: Pubkey,
}

impl Env {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        let so = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/deploy/switchyard.so");
        svm.add_program(switchyard::ID, &std::fs::read(so).expect("anchor build --arch v2 first")).unwrap();
        let admin = Keypair::new();
        svm.airdrop(&admin.pubkey(), 100_000_000_000).unwrap();
        let mut acc = svm.get_account(&programdata()).unwrap();
        acc.data[12] = 1;
        acc.data[13..45].copy_from_slice(admin.pubkey().as_ref());
        svm.set_account(programdata(), acc).unwrap();
        let usdc = Pubkey::new_unique();
        let mut e = Env { svm, admin, usdc };
        e.put(usdc, mint_data(6), SPL);
        e
    }
    fn put(&mut self, addr: Pubkey, data: Vec<u8>, owner: Pubkey) {
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm.set_account(addr, Account { lamports, data, owner, executable: false, rent_epoch: u64::MAX }).unwrap();
    }
    fn token(&mut self, owner: &Pubkey, mint: &Pubkey, amount: u64) -> Pubkey {
        let a = ata(owner, mint);
        if !self.exists(&a) {
            let ix = Instruction {
                program_id: ATA,
                accounts: vec![
                    AccountMeta::new(self.admin.pubkey(), true),
                    AccountMeta::new(a, false),
                    AccountMeta::new_readonly(*owner, false),
                    AccountMeta::new_readonly(*mint, false),
                    AccountMeta::new_readonly(SYSTEM, false),
                    AccountMeta::new_readonly(SPL, false),
                ],
                data: vec![1],
            };
            let admin = self.admin.insecure_clone();
            self.send(vec![ix], &[&admin]).unwrap();
        }
        let mut acc = self.svm.get_account(&a).unwrap();
        acc.data[64..72].copy_from_slice(&amount.to_le_bytes());
        self.svm.set_account(a, acc).unwrap();
        a
    }
    fn amount(&self, a: &Pubkey) -> u64 {
        match self.svm.get_account(a) {
            Some(acc) if acc.data.len() >= 72 => u64::from_le_bytes(acc.data[64..72].try_into().unwrap()),
            _ => 0,
        }
    }
    fn exists(&self, a: &Pubkey) -> bool {
        self.svm.get_account(a).map(|x| !x.data.is_empty()).unwrap_or(false)
    }
    fn wallet(&mut self) -> Keypair {
        let k = Keypair::new();
        self.svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
        k
    }
    fn send(&mut self, ixs: Vec<Instruction>, signers: &[&Keypair]) -> Result<Vec<String>, String> {
        self.svm.expire_blockhash();
        let msg = Message::new_with_blockhash(&ixs, Some(&signers[0].pubkey()), &self.svm.latest_blockhash());
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).map_err(|e| e.to_string())?;
        match self.svm.send_transaction(tx) {
            Ok(meta) => Ok(meta.logs),
            Err(f) => Err(format!("{:?}\n{}", f.err, f.meta.logs.join("\n"))),
        }
    }
    fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }
    fn advance(&mut self, secs: i64) {
        let mut c = self.svm.get_sysvar::<Clock>();
        c.unix_timestamp += secs;
        c.slot += 1;
        self.svm.set_sysvar(&c);
    }
    fn read<T: AccountDeserialize>(&self, a: &Pubkey) -> T {
        let acc = self.svm.get_account(a).unwrap();
        T::try_deserialize(&mut acc.data.as_slice()).unwrap()
    }

    fn init(&mut self) {
        let ix = Instruction {
            program_id: switchyard::ID,
            accounts: switchyard::accounts::Initialize {
                admin: self.admin.pubkey(),
                program: switchyard::ID,
                program_data: programdata(),
                config: config_pda(),
                settle_mint: self.usdc,
                system_program: SYSTEM,
            }
            .to_account_metas(None),
            data: switchyard::instruction::Initialize { args: params() }.data(),
        };
        let admin = self.admin.insecure_clone();
        self.send(vec![ix], &[&admin]).unwrap();
    }

    fn register(&mut self, endpoint: &str) -> Prov {
        let wallet = self.wallet();
        let node = self.wallet();
        let p = provider_pda(&wallet.pubkey());
        let ix = Instruction {
            program_id: switchyard::ID,
            accounts: switchyard::accounts::RegisterProvider { authority: wallet.pubkey(), config: config_pda(), provider: p, system_program: SYSTEM }.to_account_metas(None),
            data: switchyard::instruction::RegisterProvider { node_key: node.pubkey(), endpoint: endpoint.to_string(), manifest_hash: [1u8; 32] }.data(),
        };
        self.send(vec![ix], &[&wallet]).unwrap();
        Prov { wallet, node, pda: p }
    }

    fn user(&mut self, usdc: u64) -> User {
        let wallet = self.wallet();
        let usdc_mint = self.usdc;
        let tokens = self.token(&wallet.pubkey(), &usdc_mint, usdc);
        User { wallet, session: Keypair::new(), tokens }
    }

    fn open_ix(&self, u: &User, p: &Prov, id: u64, deposit: u64) -> Instruction {
        let ch = channel_pda(&u.wallet.pubkey(), &p.pda, id);
        Instruction {
            program_id: switchyard::ID,
            accounts: switchyard::accounts::OpenChannel {
                payer: u.wallet.pubkey(),
                config: config_pda(),
                provider: p.pda,
                channel: ch,
                mint: self.usdc,
                payer_tokens: u.tokens,
                vault: ata(&ch, &self.usdc),
                token_program: SPL,
                associated_token_program: ATA,
                system_program: SYSTEM,
            }
            .to_account_metas(None),
            data: switchyard::instruction::OpenChannel { id, deposit, session_key: u.session.pubkey() }.data(),
        }
    }

    fn open(&mut self, u: &User, p: &Prov, id: u64, deposit: u64) -> Result<Pubkey, String> {
        let ix = self.open_ix(u, p, id, deposit);
        let w = u.wallet.insecure_clone();
        self.send(vec![ix], &[&w])?;
        Ok(channel_pda(&u.wallet.pubkey(), &p.pda, id))
    }

    fn voucher(&self, signer: &Keypair, channel: &Pubkey, cumulative: u64, usage: [u8; 32]) -> Instruction {
        let msg = switchyard::voucher::voucher_message(channel, cumulative, &usage);
        let sig = signer.sign_message(&msg);
        let sig: [u8; 64] = sig.into();
        solana_ed25519_program::new_ed25519_instruction_with_signature(&msg, &sig, &signer.pubkey().to_bytes())
    }

    fn redeem_ix(&self, caller: &Pubkey, p: &Prov, channel: &Pubkey, cumulative: u64, usage: [u8; 32]) -> Instruction {
        Instruction {
            program_id: switchyard::ID,
            accounts: switchyard::accounts::Redeem {
                caller: *caller,
                config: config_pda(),
                provider: p.pda,
                channel: *channel,
                mint: self.usdc,
                vault: ata(channel, &self.usdc),
                provider_authority: p.wallet.pubkey(),
                payout: ata(&p.wallet.pubkey(), &self.usdc),
                instructions: SYSVAR_IX,
                token_program: SPL,
                associated_token_program: ATA,
                system_program: SYSTEM,
            }
            .to_account_metas(None),
            data: switchyard::instruction::Redeem { cumulative, usage_hash: usage }.data(),
        }
    }

    fn redeem(&mut self, p: &Prov, u: &User, channel: &Pubkey, cumulative: u64) -> Result<Vec<String>, String> {
        let v = self.voucher(&u.session, channel, cumulative, [cumulative as u8; 32]);
        let r = self.redeem_ix(&p.node.pubkey(), p, channel, cumulative, [cumulative as u8; 32]);
        let node = p.node.insecure_clone();
        self.send(vec![v, r], &[&node])
    }

    fn close_ix(&self, closer: &Pubkey, p: &Prov, payer: &Pubkey, channel: &Pubkey) -> Instruction {
        Instruction {
            program_id: switchyard::ID,
            accounts: switchyard::accounts::CloseChannel {
                closer: *closer,
                provider: p.pda,
                channel: *channel,
                payer: *payer,
                mint: self.usdc,
                vault: ata(channel, &self.usdc),
                payer_tokens: ata(payer, &self.usdc),
                token_program: SPL,
                associated_token_program: ATA,
                system_program: SYSTEM,
            }
            .to_account_metas(None),
            data: switchyard::instruction::CloseChannel {}.data(),
        }
    }

    fn request_close(&mut self, u: &User, channel: &Pubkey) -> Result<Vec<String>, String> {
        let ix = Instruction {
            program_id: switchyard::ID,
            accounts: switchyard::accounts::PayerChannel { payer: u.wallet.pubkey(), config: config_pda(), channel: *channel }.to_account_metas(None),
            data: switchyard::instruction::RequestClose {}.data(),
        };
        let w = u.wallet.insecure_clone();
        self.send(vec![ix], &[&w])
    }
}

fn ready() -> (Env, Prov, User) {
    let mut e = Env::new();
    e.init();
    let p = e.register("https://node.example.org");
    let u = e.user(100 * USD);
    (e, p, u)
}

#[test]
fn only_the_upgrade_authority_can_initialize() {
    let mut e = Env::new();
    let stranger = e.wallet();
    let ix = Instruction {
        program_id: switchyard::ID,
        accounts: switchyard::accounts::Initialize {
            admin: stranger.pubkey(),
            program: switchyard::ID,
            program_data: programdata(),
            config: config_pda(),
            settle_mint: e.usdc,
            system_program: SYSTEM,
        }
        .to_account_metas(None),
        data: switchyard::instruction::Initialize { args: params() }.data(),
    };
    assert!(e.send(vec![ix], &[&stranger]).is_err());
    e.init();
    let c: Config = e.read(&config_pda());
    assert_eq!(c.admin, e.admin.pubkey());
    assert_eq!(c.settle_mint, e.usdc);
    assert_eq!(c.bond_mint, Pubkey::default());
}

#[test]
fn anyone_can_list_and_edit_only_their_own_listing() {
    let (mut e, p, _) = ready();
    let prov: Provider = e.read(&p.pda);
    assert_eq!(prov.authority, p.wallet.pubkey());
    assert_eq!(prov.node_key, p.node.pubkey());
    assert_eq!(prov.endpoint, "https://node.example.org");
    assert!(prov.active);
    assert_eq!(prov.manifest_seq, 1);

    let upd = |authority: Pubkey, provider: Pubkey, args: UpdateProviderArgs| Instruction {
        program_id: switchyard::ID,
        accounts: switchyard::accounts::UpdateProvider { authority, provider }.to_account_metas(None),
        data: switchyard::instruction::UpdateProvider { args }.data(),
    };
    let args = UpdateProviderArgs { node_key: None, endpoint: Some("https://gpu.example.org/v1".into()), manifest_hash: Some([2u8; 32]), active: None };
    let w = p.wallet.insecure_clone();
    e.send(vec![upd(w.pubkey(), p.pda, args.clone())], &[&w]).unwrap();
    let prov: Provider = e.read(&p.pda);
    assert_eq!(prov.endpoint, "https://gpu.example.org/v1");
    assert_eq!(prov.manifest_seq, 2);

    let other = e.wallet();
    assert!(e.send(vec![upd(other.pubkey(), p.pda, args)], &[&other]).is_err());

    let bad = UpdateProviderArgs { node_key: None, endpoint: Some("ftp://x".into()), manifest_hash: None, active: None };
    assert!(e.send(vec![upd(w.pubkey(), p.pda, bad)], &[&w]).is_err());
    let long = UpdateProviderArgs { node_key: None, endpoint: Some(format!("https://{}", "a".repeat(120))), manifest_hash: None, active: None };
    assert!(e.send(vec![upd(w.pubkey(), p.pda, long)], &[&w]).is_err());
}

#[test]
fn a_voucher_pays_the_provider_and_nothing_is_taken_on_the_way() {
    let (mut e, p, u) = ready();
    let ch = e.open(&u, &p, 7, 5 * USD).unwrap();
    assert_eq!(e.amount(&u.tokens), 95 * USD);
    assert_eq!(e.amount(&ata(&ch, &e.usdc)), 5 * USD);

    e.redeem(&p, &u, &ch, 1_250_000).unwrap();
    let payout = ata(&p.wallet.pubkey(), &e.usdc);
    assert_eq!(e.amount(&payout), 1_250_000);

    e.redeem(&p, &u, &ch, 2_000_000).unwrap();
    assert_eq!(e.amount(&payout), 2_000_000);
    let c: Channel = e.read(&ch);
    assert_eq!(c.redeemed, 2_000_000);
    assert_eq!(c.usage_hash, [2_000_000u64 as u8; 32]);

    assert!(e.redeem(&p, &u, &ch, 2_000_000).is_err(), "the same total twice pays nothing");
    assert!(e.redeem(&p, &u, &ch, 1_000_000).is_err(), "a lower total pays nothing");

    let prov: Provider = e.read(&p.pda);
    assert_eq!(prov.settled, 2_000_000);
    assert_eq!(prov.redeems, 2);
    assert_eq!(prov.channels, 1);
    let cfg: Config = e.read(&config_pda());
    assert_eq!(cfg.settled, 2_000_000);

    e.request_close(&u, &ch).unwrap();
    e.advance(HOUR);
    let w = u.wallet.insecure_clone();
    let ix = e.close_ix(&w.pubkey(), &p, &w.pubkey(), &ch);
    e.send(vec![ix], &[&w]).unwrap();
    assert_eq!(e.amount(&payout) + e.amount(&u.tokens), 100 * USD, "every unit went to the provider or back to the user");
    assert!(!e.exists(&ch));
    assert!(!e.exists(&ata(&ch, &e.usdc)));
}

#[test]
fn only_the_session_key_signature_over_this_channel_counts() {
    let (mut e, p, u) = ready();
    let ch = e.open(&u, &p, 1, 5 * USD).unwrap();
    let ch2 = e.open(&u, &p, 2, 5 * USD).unwrap();
    let node = p.node.insecure_clone();

    let forged = Keypair::new();
    let v = e.voucher(&forged, &ch, USD, [0u8; 32]);
    let r = e.redeem_ix(&node.pubkey(), &p, &ch, USD, [0u8; 32]);
    assert!(e.send(vec![v, r], &[&node]).is_err(), "someone else's key");

    let v = e.voucher(&u.session, &ch2, USD, [0u8; 32]);
    let r = e.redeem_ix(&node.pubkey(), &p, &ch, USD, [0u8; 32]);
    assert!(e.send(vec![v, r], &[&node]).is_err(), "a voucher for another channel");

    let v = e.voucher(&u.session, &ch, USD, [1u8; 32]);
    let r = e.redeem_ix(&node.pubkey(), &p, &ch, USD, [0u8; 32]);
    assert!(e.send(vec![v, r], &[&node]).is_err(), "different usage than was signed");

    let v = e.voucher(&u.session, &ch, USD, [0u8; 32]);
    let r = e.redeem_ix(&node.pubkey(), &p, &ch, 2 * USD, [0u8; 32]);
    assert!(e.send(vec![v, r], &[&node]).is_err(), "a bigger total than was signed");

    let r = e.redeem_ix(&node.pubkey(), &p, &ch, USD, [0u8; 32]);
    assert!(e.send(vec![r], &[&node]).is_err(), "no check in the transaction");

    let v = e.voucher(&u.session, &ch, USD, [0u8; 32]);
    let r = e.redeem_ix(&node.pubkey(), &p, &ch, USD, [0u8; 32]);
    e.send(vec![v, r], &[&node]).unwrap();
    assert_eq!(e.amount(&ata(&p.wallet.pubkey(), &e.usdc)), USD);
}

#[test]
fn a_total_above_the_deposit_pays_the_deposit() {
    let (mut e, p, u) = ready();
    let ch = e.open(&u, &p, 3, 2 * USD).unwrap();
    e.redeem(&p, &u, &ch, 9 * USD).unwrap();
    assert_eq!(e.amount(&ata(&p.wallet.pubkey(), &e.usdc)), 2 * USD);
    assert!(e.redeem(&p, &u, &ch, 10 * USD).is_err(), "an empty channel pays nothing more");
}

#[test]
fn anyone_can_submit_a_redeem_but_it_only_pays_the_provider() {
    let (mut e, p, u) = ready();
    let ch = e.open(&u, &p, 4, 3 * USD).unwrap();
    let stranger = e.wallet();
    let v = e.voucher(&u.session, &ch, USD, [0u8; 32]);
    let r = e.redeem_ix(&stranger.pubkey(), &p, &ch, USD, [0u8; 32]);
    e.send(vec![v, r], &[&stranger]).unwrap();
    assert_eq!(e.amount(&ata(&p.wallet.pubkey(), &e.usdc)), USD);

    let mut r = e.redeem_ix(&stranger.pubkey(), &p, &ch, 2 * USD, [0u8; 32]);
    let theirs = e.token(&stranger.pubkey(), &e.usdc.clone(), 0);
    r.accounts[7].pubkey = theirs;
    let v = e.voucher(&u.session, &ch, 2 * USD, [0u8; 32]);
    assert!(e.send(vec![v, r], &[&stranger]).is_err(), "payout must be the provider's own account");
}

#[test]
fn one_transaction_can_redeem_many_channels() {
    let (mut e, p, u) = ready();
    let u2 = e.user(10 * USD);
    let a = e.open(&u, &p, 10, 2 * USD).unwrap();
    let b = e.open(&u2, &p, 11, 2 * USD).unwrap();
    let node = p.node.insecure_clone();
    let ixs = vec![
        e.voucher(&u.session, &a, 700_000, [0u8; 32]),
        e.voucher(&u2.session, &b, 300_000, [0u8; 32]),
        e.redeem_ix(&node.pubkey(), &p, &a, 700_000, [0u8; 32]),
        e.redeem_ix(&node.pubkey(), &p, &b, 300_000, [0u8; 32]),
    ];
    e.send(ixs, &[&node]).unwrap();
    assert_eq!(e.amount(&ata(&p.wallet.pubkey(), &e.usdc)), USD);
    let prov: Provider = e.read(&p.pda);
    assert_eq!(prov.redeems, 2);
    assert_eq!(prov.channels, 2);
}

#[test]
fn the_user_waits_out_the_grace_period_and_the_provider_can_still_redeem_in_it() {
    let (mut e, p, u) = ready();
    let ch = e.open(&u, &p, 5, 4 * USD).unwrap();
    let w = u.wallet.insecure_clone();

    let ix = e.close_ix(&w.pubkey(), &p, &w.pubkey(), &ch);
    assert!(e.send(vec![ix], &[&w]).is_err(), "cannot close without asking first");

    e.request_close(&u, &ch).unwrap();
    assert!(e.request_close(&u, &ch).is_err(), "asking twice does not move the clock");
    let c: Channel = e.read(&ch);
    assert_eq!(c.closing_at, e.now() + HOUR);

    let up = Instruction {
        program_id: switchyard::ID,
        accounts: switchyard::accounts::TopUp { payer: w.pubkey(), channel: ch, mint: e.usdc, payer_tokens: u.tokens, vault: ata(&ch, &e.usdc), token_program: SPL }.to_account_metas(None),
        data: switchyard::instruction::TopUp { amount: USD }.data(),
    };
    assert!(e.send(vec![up], &[&w]).is_err(), "no top-ups while closing");

    e.advance(HOUR - 60);
    let ix = e.close_ix(&w.pubkey(), &p, &w.pubkey(), &ch);
    assert!(e.send(vec![ix], &[&w]).is_err(), "grace period not over");
    e.redeem(&p, &u, &ch, 1_500_000).unwrap();

    e.advance(60);
    let ix = e.close_ix(&w.pubkey(), &p, &w.pubkey(), &ch);
    e.send(vec![ix], &[&w]).unwrap();
    assert_eq!(e.amount(&u.tokens), 100 * USD - 1_500_000);
    assert_eq!(e.amount(&ata(&p.wallet.pubkey(), &e.usdc)), 1_500_000);
}

#[test]
fn the_provider_can_release_a_channel_at_any_time() {
    let (mut e, p, u) = ready();
    let ch = e.open(&u, &p, 6, 3 * USD).unwrap();
    e.redeem(&p, &u, &ch, USD).unwrap();
    let node = p.node.insecure_clone();
    let stranger = e.wallet();
    let ix = e.close_ix(&stranger.pubkey(), &p, &u.wallet.pubkey(), &ch);
    assert!(e.send(vec![ix], &[&stranger]).is_err());
    let ix = e.close_ix(&node.pubkey(), &p, &u.wallet.pubkey(), &ch);
    e.send(vec![ix], &[&node]).unwrap();
    assert_eq!(e.amount(&u.tokens), 99 * USD);
    assert!(!e.exists(&ch));
}

#[test]
fn top_ups_and_deposits_respect_the_rules() {
    let (mut e, p, u) = ready();
    assert!(e.open(&u, &p, 20, USD / 100).is_err(), "below the minimum deposit");
    let ch = e.open(&u, &p, 20, USD).unwrap();
    assert!(e.open(&u, &p, 20, USD).is_err(), "same id twice");
    let w = u.wallet.insecure_clone();
    let up = Instruction {
        program_id: switchyard::ID,
        accounts: switchyard::accounts::TopUp { payer: w.pubkey(), channel: ch, mint: e.usdc, payer_tokens: u.tokens, vault: ata(&ch, &e.usdc), token_program: SPL }.to_account_metas(None),
        data: switchyard::instruction::TopUp { amount: 2 * USD }.data(),
    };
    e.send(vec![up], &[&w]).unwrap();
    let c: Channel = e.read(&ch);
    assert_eq!(c.deposit, 3 * USD);
    e.redeem(&p, &u, &ch, 3 * USD).unwrap();
    assert_eq!(e.amount(&ata(&p.wallet.pubkey(), &e.usdc)), 3 * USD);

    let off = Instruction {
        program_id: switchyard::ID,
        accounts: switchyard::accounts::UpdateProvider { authority: p.wallet.pubkey(), provider: p.pda }.to_account_metas(None),
        data: switchyard::instruction::UpdateProvider { args: UpdateProviderArgs { node_key: None, endpoint: None, manifest_hash: None, active: Some(false) } }.data(),
    };
    let pw = p.wallet.insecure_clone();
    e.send(vec![off], &[&pw]).unwrap();
    assert!(e.open(&u, &p, 21, USD).is_err(), "an inactive provider takes no new channels");
    e.redeem(&p, &u, &ch, 3 * USD + 1).unwrap_err();
}

#[test]
fn enclave_claims_are_bounded_and_clearable() {
    let (mut e, p, _) = ready();
    let attest = |signer: Pubkey, args: AttestArgs| Instruction {
        program_id: switchyard::ID,
        accounts: switchyard::accounts::Attest { signer, provider: p.pda }.to_account_metas(None),
        data: switchyard::instruction::Attest { args }.data(),
    };
    let now = e.now();
    let good = AttestArgs { kind: switchyard::TEE_TDX_NVIDIA_CC, measurement: [4u8; 48], report_hash: [5u8; 32], tee_key: [6u8; 32], expires_at: now + DAY };
    let node = p.node.insecure_clone();
    e.send(vec![attest(node.pubkey(), good)], &[&node]).unwrap();
    let prov: Provider = e.read(&p.pda);
    assert_eq!(prov.tee_kind, 3);
    assert_eq!(prov.tee_key, [6u8; 32]);

    let stranger = e.wallet();
    assert!(e.send(vec![attest(stranger.pubkey(), good)], &[&stranger]).is_err());
    let late = AttestArgs { expires_at: now + 31 * DAY, ..good };
    assert!(e.send(vec![attest(node.pubkey(), late)], &[&node]).is_err());
    let stale = AttestArgs { expires_at: now - 1, ..good };
    assert!(e.send(vec![attest(node.pubkey(), stale)], &[&node]).is_err());
    let unknown = AttestArgs { kind: 9, ..good };
    assert!(e.send(vec![attest(node.pubkey(), unknown)], &[&node]).is_err());

    let clear = AttestArgs { kind: 0, measurement: [0u8; 48], report_hash: [0u8; 32], tee_key: [0u8; 32], expires_at: 0 };
    let w = p.wallet.insecure_clone();
    e.send(vec![attest(w.pubkey(), clear)], &[&w]).unwrap();
    let prov: Provider = e.read(&p.pda);
    assert_eq!(prov.tee_kind, 0);
}

#[test]
fn bonds_wait_out_the_delay_and_only_go_back_to_the_provider() {
    let (mut e, p, _) = ready();
    let yard = Pubkey::new_unique();
    e.put(yard, mint_data(6), SPL);
    let admin = e.admin.insecure_clone();
    let set = |mint: Pubkey| Instruction {
        program_id: switchyard::ID,
        accounts: switchyard::accounts::SetBondMint { admin: admin.pubkey(), config: config_pda(), bond_mint: mint }.to_account_metas(None),
        data: switchyard::instruction::SetBondMint {}.data(),
    };
    e.send(vec![set(yard)], &[&admin]).unwrap();
    let other = Pubkey::new_unique();
    e.put(other, mint_data(6), SPL);
    assert!(e.send(vec![set(other)], &[&admin]).is_err(), "set once");

    let w = p.wallet.insecure_clone();
    let mine = e.token(&w.pubkey(), &yard, 1_000 * USD);
    let vault = ata(&p.pda, &yard);
    let bond = Instruction {
        program_id: switchyard::ID,
        accounts: switchyard::accounts::Bond {
            authority: w.pubkey(),
            config: config_pda(),
            provider: p.pda,
            bond_mint: yard,
            authority_tokens: mine,
            bond_vault: vault,
            token_program: SPL,
            associated_token_program: ATA,
            system_program: SYSTEM,
        }
        .to_account_metas(None),
        data: switchyard::instruction::Bond { amount: 400 * USD }.data(),
    };
    e.send(vec![bond], &[&w]).unwrap();
    assert_eq!(e.amount(&vault), 400 * USD);

    let unbond = Instruction {
        program_id: switchyard::ID,
        accounts: switchyard::accounts::UnbondCtx { authority: w.pubkey(), config: config_pda(), provider: p.pda }.to_account_metas(None),
        data: switchyard::instruction::Unbond { amount: 150 * USD }.data(),
    };
    e.send(vec![unbond], &[&w]).unwrap();
    let prov: Provider = e.read(&p.pda);
    assert_eq!((prov.bonded, prov.unbonding), (250 * USD, 150 * USD));

    let withdraw = Instruction {
        program_id: switchyard::ID,
        accounts: switchyard::accounts::WithdrawBond {
            authority: w.pubkey(),
            config: config_pda(),
            provider: p.pda,
            bond_mint: yard,
            authority_tokens: mine,
            bond_vault: vault,
            token_program: SPL,
            associated_token_program: ATA,
            system_program: SYSTEM,
        }
        .to_account_metas(None),
        data: switchyard::instruction::WithdrawBond {}.data(),
    };
    assert!(e.send(vec![withdraw.clone()], &[&w]).is_err(), "unbonding delay");
    e.advance(7 * DAY);
    e.send(vec![withdraw.clone()], &[&w]).unwrap();
    assert_eq!(e.amount(&mine), 750 * USD);
    assert_eq!(e.amount(&vault), 250 * USD);
    assert!(e.send(vec![withdraw], &[&w]).is_err(), "nothing left unbonding");
}

#[test]
fn admin_params_stay_inside_their_bounds() {
    let (mut e, _, _) = ready();
    let admin = e.admin.insecure_clone();
    let set = |args: ParamsArgs| Instruction {
        program_id: switchyard::ID,
        accounts: switchyard::accounts::AdminOnly { admin: admin.pubkey(), config: config_pda() }.to_account_metas(None),
        data: switchyard::instruction::SetParams { args }.data(),
    };
    assert!(e.send(vec![set(ParamsArgs { close_grace_secs: 60, ..params() })], &[&admin]).is_err());
    assert!(e.send(vec![set(ParamsArgs { unbond_secs: 60 * DAY, ..params() })], &[&admin]).is_err());
    e.send(vec![set(ParamsArgs { close_grace_secs: 2 * HOUR, ..params() })], &[&admin]).unwrap();
    let c: Config = e.read(&config_pda());
    assert_eq!(c.close_grace_secs, 2 * HOUR);
}
