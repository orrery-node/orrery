//! A voucher is the router's promise to pay: "this channel owes its provider `cumulative` base units in total,
//! and the usage behind that total hashes to `usage_hash`". The router's session key signs the 88 bytes below
//! with ed25519. The provider redeems the highest one it holds by putting the runtime's ed25519 check in the same
//! transaction; this module finds that check and confirms it covered exactly this key and these bytes.

use anchor_lang::prelude::*;

use crate::OrreryError;

pub const ED25519_PROGRAM_ID: Pubkey = solana_sdk_ids::ed25519_program::ID;
pub const INSTRUCTIONS_SYSVAR_ID: Pubkey = solana_sdk_ids::sysvar::instructions::ID;

pub const VOUCHER_PREFIX: &[u8; 16] = b"orrery/voucher/1";
pub const VOUCHER_LEN: usize = 16 + 32 + 8 + 32;

const SAME_INSTRUCTION: u16 = u16::MAX;
const OFFSETS_START: usize = 2;
const OFFSETS_LEN: usize = 14;

pub fn voucher_message(channel: &Pubkey, cumulative: u64, usage_hash: &[u8; 32]) -> [u8; VOUCHER_LEN] {
    let mut out = [0u8; VOUCHER_LEN];
    out[..16].copy_from_slice(VOUCHER_PREFIX);
    out[16..48].copy_from_slice(channel.as_ref());
    out[48..56].copy_from_slice(&cumulative.to_le_bytes());
    out[56..88].copy_from_slice(usage_hash);
    out
}

// Zero-copy reads of the Instructions sysvar, so a batch of redeems does not allocate every account list.
fn read_u16(data: &[u8], at: usize) -> Result<usize> {
    let end = at.checked_add(2).ok_or(ProgramError::InvalidAccountData)?;
    let bytes = data.get(at..end).ok_or(ProgramError::InvalidAccountData)?;
    Ok(u16::from_le_bytes([bytes[0], bytes[1]]) as usize)
}

fn instruction_count(data: &[u8]) -> Result<usize> {
    read_u16(data, 0)
}

fn instruction_at(data: &[u8], index: usize) -> Result<(&[u8], &[u8])> {
    let bad = || error!(OrreryError::BadVoucher);
    if index >= instruction_count(data)? {
        return Err(ProgramError::InvalidArgument.into());
    }
    let start = read_u16(data, OFFSETS_START + index * 2)?;
    let accounts = read_u16(data, start)?;
    let program_at = accounts.checked_mul(33).and_then(|n| n.checked_add(start + 2)).ok_or_else(bad)?;
    let program_end = program_at.checked_add(32).ok_or_else(bad)?;
    let program = data.get(program_at..program_end).ok_or(ProgramError::InvalidAccountData)?;
    let len = read_u16(data, program_end)?;
    let data_at = program_end + 2;
    let ix_data = data.get(data_at..data_at.checked_add(len).ok_or_else(bad)?).ok_or(ProgramError::InvalidAccountData)?;
    Ok((program, ix_data))
}

fn slice_at(data: &[u8], offset: usize, len: usize) -> Option<&[u8]> {
    data.get(offset..offset.checked_add(len)?)
}

/// True when `data` is a one-signature ed25519 precompile instruction whose offsets all point into itself and
/// whose public key and message are exactly `signer` and `message`. If the transaction runs at all, the runtime
/// has already verified that signature.
pub fn ed25519_instruction_matches(data: &[u8], signer: &Pubkey, message: &[u8]) -> bool {
    if data.len() < OFFSETS_START + OFFSETS_LEN || data[0] != 1 {
        return false;
    }
    let field = |i: usize| u16::from_le_bytes([data[OFFSETS_START + i * 2], data[OFFSETS_START + i * 2 + 1]]);
    let (signature_offset, signature_ix) = (field(0) as usize, field(1));
    let (public_key_offset, public_key_ix) = (field(2) as usize, field(3));
    let (message_offset, message_size, message_ix) = (field(4) as usize, field(5) as usize, field(6));
    if signature_ix != SAME_INSTRUCTION || public_key_ix != SAME_INSTRUCTION || message_ix != SAME_INSTRUCTION {
        return false;
    }
    if slice_at(data, signature_offset, 64).is_none() {
        return false;
    }
    let (Some(public_key), Some(signed)) = (slice_at(data, public_key_offset, 32), slice_at(data, message_offset, message_size)) else {
        return false;
    };
    public_key == signer.as_ref() && signed == message
}

/// Accepts when any top-level instruction of this transaction is a matching ed25519 check, so one transaction
/// can redeem many channels, each with its own check.
pub fn require_voucher(instructions: &AccountInfo, signer: &Pubkey, message: &[u8]) -> Result<()> {
    require_keys_eq!(*instructions.key, INSTRUCTIONS_SYSVAR_ID, OrreryError::BadVoucher);
    let data = instructions.try_borrow_data()?;
    for index in 0..instruction_count(&data)? {
        let (program, ix_data) = instruction_at(&data, index)?;
        if program == ED25519_PROGRAM_ID.as_ref() && ed25519_instruction_matches(ix_data, signer, message) {
            return Ok(());
        }
    }
    err!(OrreryError::BadVoucher)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn one_signature(public_key: &[u8; 32], message: &[u8]) -> Vec<u8> {
        let header = OFFSETS_START + OFFSETS_LEN;
        let (pk_at, sig_at) = (header, header + 32);
        let msg_at = sig_at + 64;
        let mut d = vec![1u8, 0];
        for v in [sig_at as u16, u16::MAX, pk_at as u16, u16::MAX, msg_at as u16, message.len() as u16, u16::MAX] {
            d.extend_from_slice(&v.to_le_bytes());
        }
        d.extend_from_slice(public_key);
        d.extend_from_slice(&[7u8; 64]);
        d.extend_from_slice(message);
        d
    }

    #[test]
    fn message_layout_is_fixed() {
        let ch = Pubkey::new_from_array([3u8; 32]);
        let m = voucher_message(&ch, 1_234_567, &[9u8; 32]);
        assert_eq!(&m[..16], b"orrery/voucher/1");
        assert_eq!(&m[16..48], ch.as_ref());
        assert_eq!(u64::from_le_bytes(m[48..56].try_into().unwrap()), 1_234_567);
        assert_eq!(&m[56..], &[9u8; 32]);
    }

    #[test]
    fn check_must_cover_this_key_and_these_bytes() {
        let key = Pubkey::new_from_array([5u8; 32]);
        let msg = voucher_message(&Pubkey::new_from_array([1u8; 32]), 10, &[0u8; 32]);
        let data = one_signature(&key.to_bytes(), &msg);
        assert!(ed25519_instruction_matches(&data, &key, &msg));
        assert!(!ed25519_instruction_matches(&data, &Pubkey::new_from_array([6u8; 32]), &msg));
        let other = voucher_message(&Pubkey::new_from_array([1u8; 32]), 11, &[0u8; 32]);
        assert!(!ed25519_instruction_matches(&data, &key, &other));
        let mut elsewhere = data.clone();
        elsewhere[4] = 0;
        elsewhere[5] = 0;
        assert!(!ed25519_instruction_matches(&elsewhere, &key, &msg));
        let mut two = data.clone();
        two[0] = 2;
        assert!(!ed25519_instruction_matches(&two, &key, &msg));
        assert!(!ed25519_instruction_matches(&data[..20], &key, &msg));
    }
}
