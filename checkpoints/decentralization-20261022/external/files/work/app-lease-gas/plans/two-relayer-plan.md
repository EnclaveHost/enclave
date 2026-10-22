# Lease relays - PREPARED, NOT ACTIVATED; no amount here is authorized funding

Status: no relay key exists, no server runs, nothing is funded. Root owns activation, which comes only after:
- the reserve and executor are deployed from reviewed source;
- the deployment record and its digest are published;
- the host hunks are integrated;
- owners have enrolled.
The addresses in plans/*.json are FORK-LOCAL; a signable plan must use the actually deployed addresses and code hashes.

## What a relay is (and is not)
- A relay pays the L2 gas of ONE kind of transaction: a canonical `lease(...)` call to an operator's
  EIP-7702-delegated address, for the ONE reviewed reserve/executor deployment.
- It is reimbursed by the app's reserve in the SAME transaction when the operation lands (`finish()` pays, or the whole
  transaction reverts).
- It is not a call-anything service. Every other target, function, calldata length, executor, reserve or chain is
  refused before any spend (`checkRelayRequest`, quorum-verified authority per send).
- Relays are permissionless and interchangeable:
  - a host lists several and fails over;
  - the same signed lease lands at most once (executor nonce lane);
  - hosts verify every landing on their own RPC quorum.

## The float is at risk, boundedly
- A landed operation reimburses the relay in the same transaction.
- A REVERTED relay transaction is NOT reimbursed, and its gas is lost from the float. Pre-simulation narrows this but
  cannot remove it, for example:
  - another relay lands the same signed lease first;
  - the lease state changes between simulation and inclusion;
  - the owner withdraws or reconfigures in between.
- One relay key sends one transaction at a time, so a single loss is at most one transaction's gas at the price the
  relay itself chose.
- The reimbursement model and its measured margins (L2 gas alone non-negative for every kind; total +1.62% to +5.39%
  against the forked oracle's L1 ESTIMATE, which is not a fee actually debited on Base) are in
  fixtures/base-fork-calibration-recalibrated.json (fork10, limits: overheads 65,000 / 55,000 / 36,000,
  l1Bps 10,000, MAX_OVERHEAD_GAS 80,000).
- Base fees above the owner's cap are not reimbursed above the cap: a relay sending above the cap loses the difference.

## Software
`network/lease-relay-service.mjs` (test/lease-relay-service.test.mjs):

```
LEASE_RELAY_RECORD=/etc/enclave/lease-gas-record.json        # the reviewed deployment record
LEASE_RELAY_DIGEST=sha256:<reviewed digest>                   # trusted local setting, never fetched with the file
LEASE_RELAY_RPCS=https://<rpc A>,https://<rpc B>,https://<rpc C>   # distinct providers; strict-majority quorum
LEASE_RELAY_KEY_FILE=/etc/enclave/relay.key                   # chmod 600; the service refuses anything wider
LEASE_RELAY_LISTEN=127.0.0.1:8601                             # behind TLS (hosts accept https relays only)
LEASE_RELAY_MAX_FLOAT_ETH=<chosen>                            # refuses to start above it
LEASE_RELAY_MIN_FLOAT_ETH=<chosen>                            # warns: refill
node network/lease-relay-service.mjs
```

## Sizing (a proposal; the amounts are the owner's decision)
- At the fork's fee (0.006 gwei effective), one send costs the relay about 0.000002 ETH. Even at the platform ceiling
  (1 gwei), a first claim with its authorization is about 330k gas, so about 0.00033 ETH plus L1. A float of a few such
  sends is enough working capital.
- Minimal bootstrap for the nine expired records is in plans/recovery-budget.json (scripts/recovery-budget.mjs, local
  arithmetic):
  - one day at today's fee: about 0.00068 ETH for all nine;
  - 30 days at today's fee: about 0.0196 ETH;
  - at the owner's 0.05 gwei cap: about 0.0056 ETH for one day, about 0.162 ETH for 30 days.
  The existing admin wallet held 0.0042 ETH at root's last read-only preflight.
- Two relays (two operators, or two boxes and providers if one operator) are preferred for failover. One relay with a
  small float works: hosts then simply have no alternative while it is down.

## Monitoring and stop rules
- Watch the float log lines and each `[relay]` send (status, hash, the reserve's payment).
- A float that trends down beyond isolated reverts means under-reimbursement. STOP and compare with the calibration;
  do not top up blindly.
- To stop, kill the process; hosts fail over. Retire a key by moving its float out.
- Platform-wide stop: the reserve admin's `setPaused` (moderation stays with Enclave administration).

## Activation checklist (root)
1. Deploy the reserve and executor from the reviewed source with the calibrated limits, then bindExecutor.
2. Generate the deployment record from the CHAIN with scripts/make-deployment-record.mjs: code hashes and bindings,
   verified by an RPC quorum. Publish the record and its digest.
3. Create the relay key(s), fund each with the float chosen above, and start them behind TLS with the record + digest.
4. Owners enroll with the owner CLI (`lease-gas plan` / `deposit` / `configure`; the DNS app through its SessionVault
   ownerCall; no default amount).
5. Hosts get ENCLAVE_LEASE_GAS_FILE, _DIGEST, _RPCS and _RELAYS with the integrated hunks. There is no separate
   operator step: a key's first sponsored lease carries its EIP-7702 authorization, and the reserve charges it once.
6. Watch the first claim, renew and release per host, and compare the charge with the relay's actual cost.
