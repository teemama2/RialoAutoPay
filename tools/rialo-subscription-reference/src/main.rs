use rialo_subscriber_interface::instruction::{
    Predicate,
    Subscription,
    SubscriptionKind,
    SubscriberInstruction,
};
use rialo_types::nonce::Nonce;
use rialo_s_pubkey::Pubkey;
use rialo_s_instruction::Instruction;
use rialo_s_program::system_program;
use std::str::FromStr;

fn main() {
    // Local reference test only. Nothing is signed or submitted.
    let subscriber = Pubkey::from_str(
        "11111111111111111111111111111111"
    ).expect("valid test public key");

    let nonce = Nonce::new([0u8; 32]);

    // A timestamp predicate covering the full timestamp range.
    let predicate = Predicate::new_with_timestamp_range(0..u64::MAX);

    // Harmless placeholder instruction used only to test the
    // native subscription instruction's serialization.
    // This is NOT a payment instruction.
    let placeholder = Instruction {
        program_id: system_program::id(),
        accounts: vec![],
        data: vec![],
    };

    let subscription = Subscription::new(
        subscriber,
        predicate,
        vec![placeholder],
        SubscriptionKind::Persistent,
        0..=u64::MAX,
    );

    let instruction = SubscriberInstruction::subscribe_to(
        subscriber,
        nonce,
        subscription,
    );

    println!("=== NATIVE RIALO SUBSCRIBE REFERENCE ===");
    println!("Program ID: {}", instruction.program_id);
    println!("Account count: {}", instruction.accounts.len());

    for (index, account) in instruction.accounts.iter().enumerate() {
        println!(
            "Account {}: {}, signer={}, writable={}",
            index,
            account.pubkey,
            account.is_signer,
            account.is_writable,
        );
    }

    let encoded_hex: String = instruction
        .data
        .iter()
        .map(|byte| format!("{:02x}", byte))
        .collect();

    println!("Instruction data length: {}", instruction.data.len());
    println!("Instruction data hex: {}", encoded_hex);
std::fs::write(
    "tools/rialo-subscription-reference/subscribe-reference.bin",
    &instruction.data,
).expect("write reference bytes");
println!("Reference bytes saved.");
    println!("Reference only: no transaction submitted.");
}
