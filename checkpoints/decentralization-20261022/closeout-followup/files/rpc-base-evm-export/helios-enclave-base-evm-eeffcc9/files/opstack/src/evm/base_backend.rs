// Base execution rules for the proof-backed EVM (Base mainnet 8453, Base Sepolia 84532).
//
// op-revm 20 implements Base only up to Isthmus/Jovian (Prague). Since Azul, Base executes Osaka plus Base-only
// precompile sets, and Cobalt adds state-backed precompiles. This backend runs the MAINTAINED Base EVM instead:
// base/base v1.5.1 (5476069f) `base-common-evm` (BaseEvmFactory, BaseSpecId, BasePrecompiles) on its REVM 42,
// with the fork ladder from `base-common-chains` and the Beryl/Cobalt activation-registry admin the Base node uses
// (`ChainConfig::beryl_activation_admin_address_by_chain_id`, as `BaseChainSpec::activation_admin_address`).
//
// State comes ONLY from Helios's ProofDB (REVM 43): every account, code and storage value it serves was verified
// against the trusted block's state root. `BaseDb` is the REVM 43 -> 42 database boundary, like `LegacyDb` is for
// op-revm's REVM 38. Nothing here contacts an RPC.
use std::fmt;

use alloy::primitives::{Address, Bytes, B256, U256};
use alloy_evm::{Evm, EvmEnv, EvmFactory};
use base_common_chains::{ChainConfig, ChainUpgrades};
use base_common_evm::{BaseEvmFactory, BaseHaltReason, BaseSpecId, BaseTransaction};
use base_revm::{
    context::{BlockEnv, CfgEnv, TxEnv},
    context_interface::{block::BlobExcessGasAndPrice, result as base_result},
    database_interface::ErasedError,
};
use op_revm::OpHaltReason;
use revm::context::result::{ExecutionResult, Output, ResultGas, SuccessReason};

/// The Base upgrade ladder this build executes, or None for a chain that is not Base.
pub(super) fn upgrades(chain_id: u64) -> Option<ChainUpgrades> {
    match chain_id {
        8453 => Some(ChainUpgrades::mainnet()),
        84532 => Some(ChainUpgrades::sepolia()),
        _ => None,
    }
}

/// The Base spec (upgrade) in force at `timestamp` on `chain_id`.
pub(super) fn spec_at(chain_id: u64, timestamp: u64) -> Option<BaseSpecId> {
    upgrades(chain_id).map(|u| BaseSpecId::from_timestamp(u, timestamp))
}

pub(super) struct BaseDb<'a, D>(pub &'a mut D);

impl<D> fmt::Debug for BaseDb<'_, D> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("BaseDb")
    }
}

impl<D: revm::Database> base_revm::Database for BaseDb<'_, D> {
    type Error = ErasedError;

    fn basic(
        &mut self,
        address: Address,
    ) -> Result<Option<base_revm::state::AccountInfo>, Self::Error> {
        self.0
            .basic(address)
            .map(|account| {
                account.map(|info| base_revm::state::AccountInfo {
                    balance: info.balance,
                    nonce: info.nonce,
                    code_hash: info.code_hash,
                    code: info
                        .code
                        .map(|code| base_revm::state::Bytecode::new_raw(code.original_bytes())),
                    ..Default::default()
                })
            })
            .map_err(Self::Error::new)
    }

    fn code_by_hash(&mut self, hash: B256) -> Result<base_revm::state::Bytecode, Self::Error> {
        self.0
            .code_by_hash(hash)
            .map(|code| base_revm::state::Bytecode::new_raw(code.original_bytes()))
            .map_err(Self::Error::new)
    }

    fn storage(&mut self, address: Address, index: U256) -> Result<U256, Self::Error> {
        self.0.storage(address, index).map_err(Self::Error::new)
    }

    fn block_hash(&mut self, number: u64) -> Result<B256, Self::Error> {
        self.0.block_hash(number).map_err(Self::Error::new)
    }
}

/// One call or transaction executed under Base rules at a trusted block.
pub(super) struct BaseCall {
    pub chain_id: u64,
    pub timestamp: u64,
    pub block: BlockEnv,
    pub tx: TxEnv,
    pub validate_tx: bool,
}

/// Execute `call` against `db` with the Base EVM. Errors are database misses (the caller fetches proofs and retries)
/// or validation failures; the string never claims a result.
pub(super) fn transact<D: revm::Database>(
    db: &mut D,
    call: BaseCall,
) -> Result<ExecutionResult<OpHaltReason>, String> {
    let spec = spec_at(call.chain_id, call.timestamp)
        .ok_or_else(|| format!("chain {} has no Base execution rules", call.chain_id))?;
    let mut cfg = CfgEnv::new_with_spec(spec);
    cfg.chain_id = call.chain_id;
    // the same relaxations Helios applies to op-revm for an unvalidated call (eth_call)
    cfg.disable_block_gas_limit = !call.validate_tx;
    cfg.disable_eip3607 = !call.validate_tx;
    cfg.disable_base_fee = !call.validate_tx;
    cfg.disable_nonce_check = !call.validate_tx;
    if !call.validate_tx {
        // Osaka's per-transaction gas cap (EIP-7825) applies to transactions, not to an unvalidated call whose
        // gas defaults to u64::MAX.
        cfg.tx_gas_limit_cap = Some(u64::MAX);
    }
    let factory = BaseEvmFactory::new(ChainConfig::beryl_activation_admin_address_by_chain_id(
        call.chain_id,
    ));
    let mut evm = factory.create_evm(BaseDb(db), EvmEnv::new(cfg, call.block));
    // as base/base's BaseTransactionRequest::try_into_tx_env builds an eth_call: an empty envelope (no L1 data
    // cost), no deposit, no EIP-8130 parts
    let tx = BaseTransaction {
        base: call.tx,
        enveloped_tx: Some(Bytes::new()),
        deposit: Default::default(),
        eip8130: None,
    };
    evm.transact_raw(tx)
        .map(|out| execution_result(out.result))
        .map_err(|e| e.to_string())
}

/// The block environment of a trusted header, for the Base EVM.
pub(super) fn block_env(
    number: u64,
    beneficiary: Address,
    timestamp: u64,
    gas_limit: u64,
    basefee: u64,
    difficulty: U256,
    prevrandao: B256,
    excess_blob_gas: u64,
    slot_num: u64,
) -> BlockEnv {
    BlockEnv {
        number: U256::from(number),
        beneficiary,
        timestamp: U256::from(timestamp),
        gas_limit,
        basefee,
        difficulty,
        prevrandao: Some(prevrandao),
        // Base inherits Prague's blob fee schedule (L2 blocks carry excess_blob_gas 0)
        blob_excess_gas_and_price: Some(BlobExcessGasAndPrice::new(
            excess_blob_gas,
            base_revm::primitives::eip4844::BLOB_BASE_FEE_UPDATE_FRACTION_PRAGUE,
        )),
        slot_num,
    }
}

fn execution_result(
    result: base_result::ExecutionResult<BaseHaltReason>,
) -> ExecutionResult<OpHaltReason> {
    use base_result::{ExecutionResult as B, Output as BOut, SuccessReason as BReason};
    let gas = result.gas();
    let gas = ResultGas::new_with_state_gas(
        gas.total_gas_spent(),
        gas.inner_refunded(),
        gas.floor_gas(),
        gas.state_gas_spent_final(),
    );
    match result {
        B::Success {
            reason,
            logs,
            output,
            ..
        } => ExecutionResult::Success {
            reason: match reason {
                BReason::Stop => SuccessReason::Stop,
                BReason::Return => SuccessReason::Return,
                BReason::SelfDestruct => SuccessReason::SelfDestruct,
            },
            gas,
            logs,
            output: match output {
                BOut::Call(data) => Output::Call(data),
                BOut::Create(data, address) => Output::Create(data, address),
            },
        },
        B::Revert { output, logs, .. } => ExecutionResult::Revert { gas, output, logs },
        B::Halt { reason, logs, .. } => ExecutionResult::Halt {
            gas,
            reason: halt_reason(reason),
            logs,
        },
    }
}

/// Base's halt reasons in the opstack client's halt type. The REVM 42 and op-revm (REVM 38) HaltReason enums have
/// the same variants, mapped one to one.
fn halt_reason(reason: BaseHaltReason) -> OpHaltReason {
    use base_result::{HaltReason as N, OutOfGasError as NG};
    use op_revm::revm::context::result::{HaltReason as O, OutOfGasError as OG};
    let base = match reason {
        BaseHaltReason::FailedDeposit => return OpHaltReason::FailedDeposit,
        BaseHaltReason::Base(h) => h,
    };
    OpHaltReason::Base(match base {
        N::OutOfGas(g) => O::OutOfGas(match g {
            NG::Basic => OG::Basic,
            NG::MemoryLimit => OG::MemoryLimit,
            NG::Memory => OG::Memory,
            NG::Precompile => OG::Precompile,
            NG::InvalidOperand => OG::InvalidOperand,
            NG::ReentrancySentry => OG::ReentrancySentry,
        }),
        N::OpcodeNotFound => O::OpcodeNotFound,
        N::InvalidFEOpcode => O::InvalidFEOpcode,
        N::InvalidJump => O::InvalidJump,
        N::NotActivated => O::NotActivated,
        N::StackUnderflow => O::StackUnderflow,
        N::StackOverflow => O::StackOverflow,
        N::OutOfOffset => O::OutOfOffset,
        N::CreateCollision => O::CreateCollision,
        N::PrecompileError => O::PrecompileError,
        N::PrecompileErrorWithContext(s) => O::PrecompileErrorWithContext(s),
        N::NonceOverflow => O::NonceOverflow,
        N::CreateContractSizeLimit => O::CreateContractSizeLimit,
        N::CreateContractStartingWithEF => O::CreateContractStartingWithEF,
        N::CreateInitCodeSizeLimit => O::CreateInitCodeSizeLimit,
        N::OverflowPayment => O::OverflowPayment,
        N::StateChangeDuringStaticCall => O::StateChangeDuringStaticCall,
        N::CallNotAllowedInsideStatic => O::CallNotAllowedInsideStatic,
        N::OutOfFunds => O::OutOfFunds,
        N::CallTooDeep => O::CallTooDeep,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy::primitives::{address, bytes, Address};
    use base_common_chains::MAINNET_BERYL_ACTIVATION_ADMIN_ADDRESS;
    use base_common_evm::BaseUpgrade;
    use base_revm::primitives::hardfork::SpecId;
    use revm::{
        database::InMemoryDB,
        state::{AccountInfo, Bytecode},
    };

    // base/base 5476069f crates/common/chains/src/config.rs MAINNET
    const JOVIAN: u64 = 1_764_691_201;
    const AZUL: u64 = 1_779_991_200;
    const BERYL: u64 = 1_782_410_400;
    const COBALT: u64 = 1_790_791_200;
    const DENIM: u64 = 1_793_901_600;
    const CALLER: Address = address!("0x00000000000000000000000000000000000c0de1");
    const TARGET: Address = address!("0x0000000000000000000000000000000000c0ffee");
    const ACTIVATION_REGISTRY: Address = address!("0x8453000000000000000000000000000000000001");
    const P256VERIFY: Address = address!("0x0000000000000000000000000000000000000100");

    fn with_code(code: Bytes) -> InMemoryDB {
        let mut db = InMemoryDB::default();
        db.insert_account_info(TARGET, AccountInfo::default().with_code(Bytecode::new_raw(code)));
        db
    }

    fn call(db: &mut InMemoryDB, timestamp: u64, to: Address, data: Bytes) -> ExecutionResult<OpHaltReason> {
        transact(
            db,
            BaseCall {
                chain_id: 8453,
                timestamp,
                block: block_env(1, Address::ZERO, timestamp, 30_000_000, 0, U256::ZERO, B256::ZERO, 0, 0),
                // legacy-typed, no chain id (TxEnv::default() carries chain id 1)
                tx: TxEnv { caller: CALLER, kind: to.into(), data, gas_limit: 5_000_000, chain_id: None, ..Default::default() },
                validate_tx: false,
            },
        )
        .expect("execution")
    }

    #[test]
    fn base_upgrade_ladder_selects_the_spec_in_force() {
        let at = |ts| spec_at(8453, ts).unwrap().upgrade();
        assert_eq!(at(JOVIAN), BaseUpgrade::Jovian);
        assert_eq!(at(AZUL - 1), BaseUpgrade::Jovian);
        assert_eq!(at(AZUL), BaseUpgrade::Azul);
        assert_eq!(at(BERYL), BaseUpgrade::Beryl);
        assert_eq!(at(COBALT), BaseUpgrade::Cobalt);
        assert_eq!(at(DENIM), BaseUpgrade::Denim);
        // Everest (EIP-8130 0x79) is not scheduled on mainnet in this release: never selected
        assert_eq!(at(u64::MAX), BaseUpgrade::Denim);
        assert_eq!(spec_at(84532, 1_776_708_000).unwrap().upgrade(), BaseUpgrade::Azul);
        assert!(spec_at(10, AZUL).is_none(), "OP mainnet is not Base");
        assert_eq!(SpecId::from(spec_at(8453, AZUL).unwrap()), SpecId::OSAKA);
        assert_eq!(SpecId::from(spec_at(8453, JOVIAN).unwrap()), SpecId::PRAGUE);
    }

    #[test]
    fn osaka_clz_runs_from_azul_and_is_invalid_before() {
        // PUSH1 1; CLZ; PUSH1 0; MSTORE; PUSH1 32; PUSH1 0; RETURN  -> clz(1) = 255
        let code = bytes!("60011e60005260206000f3");
        let out = call(&mut with_code(code.clone()), AZUL, TARGET, Bytes::new());
        assert!(out.is_success(), "{out:?}");
        assert_eq!(out.output().unwrap().as_ref(), U256::from(255).to_be_bytes::<32>());
        let before = call(&mut with_code(code), AZUL - 1, TARGET, Bytes::new());
        assert!(matches!(
            before,
            // REVM 42 reports an opcode outside the active spec as NotActivated
            ExecutionResult::Halt { reason: OpHaltReason::Base(op_revm::revm::context::result::HaltReason::NotActivated), .. }
        ), "{before:?}");
    }

    #[test]
    fn azul_prices_p256verify_like_osaka() {
        let jovian = call(&mut InMemoryDB::default(), AZUL - 1, P256VERIFY, Bytes::new());
        let azul = call(&mut InMemoryDB::default(), AZUL, P256VERIFY, Bytes::new());
        assert!(jovian.is_success() && azul.is_success(), "{jovian:?} {azul:?}");
        // RIP-7212 3450 gas (Fjord..Jovian) vs Osaka P256VERIFY 6900
        assert_eq!(azul.tx_gas_used() - jovian.tx_gas_used(), 3450);
    }

    #[test]
    fn beryl_installs_the_activation_registry_with_the_base_admin() {
        let admin = bytes!("f851a440"); // admin()
        let azul = call(&mut InMemoryDB::default(), AZUL, ACTIVATION_REGISTRY, admin.clone());
        assert!(azul.is_success() && azul.output().unwrap().is_empty(), "no precompile before Beryl: {azul:?}");
        let beryl = call(&mut InMemoryDB::default(), BERYL, ACTIVATION_REGISTRY, admin.clone());
        assert!(beryl.is_success(), "{beryl:?}");
        assert_eq!(beryl.output().unwrap().as_ref(), MAINNET_BERYL_ACTIVATION_ADMIN_ADDRESS.into_word().as_slice());
        let cobalt = call(&mut InMemoryDB::default(), COBALT, ACTIVATION_REGISTRY, admin);
        assert!(cobalt.is_success() && cobalt.output().unwrap().len() == 32, "state-backed admin read: {cobalt:?}");
    }

    #[test]
    fn code_and_storage_come_from_the_shared_proof_database() {
        // PUSH1 0; SLOAD; PUSH1 0; MSTORE; PUSH1 32; PUSH1 0; RETURN
        let mut db = with_code(bytes!("60005460005260206000f3"));
        db.insert_account_storage(TARGET, U256::ZERO, U256::from(42)).unwrap();
        let out = call(&mut db, COBALT, TARGET, Bytes::new());
        assert!(out.is_success(), "{out:?}");
        assert_eq!(out.output().unwrap().as_ref(), U256::from(42).to_be_bytes::<32>());
    }

    #[test]
    fn halts_and_reverts_keep_their_meaning() {
        let halt = call(&mut with_code(bytes!("fe")), COBALT, TARGET, Bytes::new());
        assert!(matches!(
            halt,
            ExecutionResult::Halt { reason: OpHaltReason::Base(op_revm::revm::context::result::HaltReason::InvalidFEOpcode), .. }
        ), "{halt:?}");
        // PUSH1 0; PUSH1 0; REVERT
        let revert = call(&mut with_code(bytes!("60006000fd")), COBALT, TARGET, Bytes::new());
        assert!(matches!(revert, ExecutionResult::Revert { .. }), "{revert:?}");
    }
}
