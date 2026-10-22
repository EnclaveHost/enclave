// ABIs the migration reads and writes. The ledger ABI is the FROZEN candidate's external ABI (a superset of every
// rev-16d getter and event: work/lease-generation-candidate/out/EnclaveDeployments.external-abi.json).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAbi } from 'viem';

export const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WORK = path.resolve(HERE, '..');
export const CANDIDATE = path.join(WORK, 'lease-generation-candidate');
export const REPO = path.join(WORK, 'enclave');
export const FULL_CLONE = '/home/steven/Projects/enclave/.git';   // read-only: verified public source only

export const LEDGER_ABI = JSON.parse(fs.readFileSync(path.join(CANDIDATE, 'out/EnclaveDeployments.external-abi.json'), 'utf8'));
// emitted by the linked library on the ledger's address, not declared on the ledger contract itself
export const LIBRARY_EVENTS = parseAbi(['event BandwidthSplit(bytes32 indexed id, address indexed operator, uint256 gross6, uint256 provider6, uint256 platform6)']);
export const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)']);
export const BOOK = parseAbi(['function all() view returns (bytes32[] keys_, address[] values)', 'function owner() view returns (address)',
  'function pendingOwner() view returns (address)', 'function addr(bytes32) view returns (address)',
  'function setMany(bytes32[] keys_, address[] values)', 'function set(bytes32 key, address value)']);
export const PROVER = parseAbi(['function owner() view returns (address)', 'function pendingOwner() view returns (address)',
  'function proofWindowSec() view returns (uint64)', 'function deployments() view returns (address)', 'function registry() view returns (address)',
  'function proofSchema() view returns (uint256)', 'function setProofWindow(uint64)', 'function transferOwnership(address)', 'function acceptOwnership()',
  'event Checkpointed(bytes32 indexed id, bytes32 indexed enclaveId, address indexed operator, uint64 provenUntil, uint64 secondsProven, uint64 anchorBlock)']);
export const FEES = parseAbi(['function ledger() view returns (address)', 'function proof() view returns (address)', 'function token() view returns (address)',
  'event Configured(bytes32 indexed source, address indexed payer, address wallet, uint64 epoch)',
  'event FeeAllocated(bytes32 indexed source, address indexed payer, address wallet, uint256 amount6)',
  'event JobCreated(bytes32 indexed source, bytes32 indexed job, bytes32 indexed hostId, uint256 amount6)']);
export const CONNECTIVITY = parseAbi(['function ledger() view returns (address)', 'function registry() view returns (address)',
  'event HostConfigured(bytes32 indexed hostId, bool direct, bool tuna, uint64 pricePerGiB6)',
  'event DirectAuthorized(bytes32 indexed id, uint64 nonce, uint64 expires, uint64 maxPricePerGiB6, uint128 budget6)',
  'event BandwidthCharged(bytes32 indexed id, bytes32 indexed hostId, uint256 amount6, uint256 cumulativeUnits)',
  'event ProbeTrustAuthorized(bytes32 indexed id, uint64 nonce, address[] signers, uint8 threshold)',
  'event TunaAuthorized(bytes32 indexed id, uint64 nonce, bytes32[] providers)']);
export const AUTHORITY = parseAbi(['function deployments() view returns (address)', 'function appCatalog() view returns (address)',
  'function sessionVaultFactory() view returns (address)', 'function addr(bytes32) view returns (address)']);
export const FACTORY = parseAbi(['function implementation() view returns (address)', 'function isVault(address) view returns (bool)',
  'event VaultCreated(address indexed owner, address vault)']);
export const VAULT = parseAbi(['function owner() view returns (address)', 'function book() view returns (address)', 'function factory() view returns (address)']);
export const SECRET_V2 = parseAbi(['function book() view returns (address)', 'function enclaveOwner() view returns (address)',
  'function hostOwnership() view returns (address)', 'function hostRegistry() view returns (address)', 'function deploymentLedger() view returns (address)',
  'function sessionVaultFactory() view returns (address)',
  'event CommitteeCreated(bytes32 indexed committeeId, address indexed identity, bytes Y)',
  'event PolicyUpdated(bytes32 indexed id, address indexed owner, uint64 policyRev, bytes32 committeeId, bool paused)',
  'event BundlePut(bytes32 indexed id, uint64 secretRev, bytes32 committeeId, uint256 bundleBytes)',
  'event PolicyClaimed(bytes32 indexed id, address indexed previousOwner, address indexed newOwner, uint64 policyRev)']);
export const REGISTRY4 = parseAbi(['function count() view returns (uint256)',
  'function getPage(uint256,uint256) view returns ((string endpoint,string repo,bytes32 measurement,address operator,uint64 registeredAt,uint64 lastSeen,bool active,uint64 cpuPricePerSec6,uint64 gpuPricePerSec6,address proofKey,address payoutWallet)[])']);
export const OWNABLE = parseAbi(['function owner() view returns (address)', 'function pendingOwner() view returns (address)']);
export const EVENT_ABI = [...LEDGER_ABI.filter((e) => e.type === 'event'), ...LIBRARY_EVENTS,
  ...[PROVER, FEES, CONNECTIVITY, FACTORY, SECRET_V2].flatMap((a) => a.filter((e) => e.type === 'event'))];
