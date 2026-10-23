# Public RPC host role: integration note (from S, work/public-rpc-host-role, 2026-10-23)

This note is for F (`host-service-rpc-closure`, which owns the Windows composition), B (`rpc-runtime-final-integration`,
which owns the Linux runtime integration), and root. S edited none of your trees and restarted none of your jobs. The
source is at commit `36919aafe76c743272b323c8bca27871b5219ab9`; the role source is final at `4c059b99`, with root's
own-property allowlist fix. It is based on F's `14d1e4954`; see `RESULT-PUBLIC-RPC-ROLE.md`. The package pin is
`public-rpc.package.json` sha256 `300cdc81a4961763b2b0e8c84023f6238448e3fad02cea247af72d3354e57530`. **This role is not a
proof source**: it refuses `eth_getProof` and `eth_getBlockByHash`, so B's `proofSources` must not point at it (root's
interface gate).

## What exists now

There is a host-service role `public-rpc` (`network/public-rpc.mjs`):
- **What it is:** a browser-facing JSON-RPC origin answered by the operator's OWN Base node on the host (a loopback
  URL). Methods are exactly those of S's browser note; EIP-1898 is supported, and every privileged or signing method is
  refused by name.
- **Packaging and gating:** packaged like the other roles, run by `runner.mjs`, gated by the platform host policy.
- **Not indexed:** `kind: null`, and it is never advertised.
- **Its name:** `rpc-<base32(registry id)>.<zone>`, opt-in on both sides:
  - the **host** asks for it in its service request (`rpc: true`) only when `hostServices.ports` names `public-rpc`;
  - the **exit** grants it only when its operator set `hostServices.rpc: true`;
  - **otherwise** the exit refuses by name. A host without the role never sends the key, so every existing grant stays
    exactly three names.

## Changed shared files (each needs your composition's rebuild where you bundle it)

| file | change | who bundles it |
|---|---|---|
| `network/host-service-names.mjs` | `HOST_RPC_LABEL`/`HOST_RPC_ROLE`, `hostRpcName`/`hostRpcOrigin`, `rpc` in `isHostServiceName` | privacy agent, ingress, provider, Windows node |
| `network/host-service-transport.mjs` | `public-rpc` port accepted; the RPC name joins `granted`/`names` only with that port | privacy agent, Windows node |
| `network/wg-circuit-runtime.mjs` | service exit requests carry `rpc: true` when `granted` holds an `rpc-` name | privacy agent, Windows node |
| `network/wg-grants.mjs` | `request({ rpc })`: `rpc: true` only on a service request | same |
| `network/wg-provider/provider.mjs` | the request schema allows `rpc: true` only on `service`; grants the RPC name only with both opt-ins; refuses by name otherwise; restore keeps it | provider |
| `network/wg-provider/host-services-config.mjs` | provider `hostServices.rpc: true` | provider |
| `network/host-services/{roles,runner,stage-tool}.mjs` | the role; runner rules (hostId = keccak(endpoint), no advertisement); publication of the label | host-service packages, stage tool |
| `network/public-rpc.mjs`, `network/public-rpc-hosts.mjs` | new | the `public-rpc` package; the profile generator |
| `scripts/network/browser-profile.mjs` | `--verify-chain` refuses two RPCs of one host | tooling |

**Package build:** all five existing role packages rebuild byte-identical to F's `14d1e495` build. Only
`public-rpc.mjs` and `public-rpc.package.json` are new (`logs/pk1.out`).

## What each of you would carry (no action taken by S)

- **F (Windows):**
  - the host-service runner already runs any role from `roles.mjs`, so `public-rpc` needs only its package and the host's
    `hostServices.ports['public-rpc']`;
  - the Windows node bundle must include the changed transport, runtime and grants modules;
  - exits used by such a host must be opted in.
- **B (Linux):**
  - no duplicate proxy: B's 127.0.0.1 verifier can be this role's `chainVerifier` (loopback) for its proven methods;
  - the node must be the operator's own synced Base node;
  - the role is not part of B's runtime.
- **Root:**
  - G3 `service-tls` for `rpc-<b32>.<zone>` (HTTPS is required by browser profiles);
  - opted-in exits;
  - route-dns publication;
  - an activated platform host policy;
  - profiles that list RPCs of different hosts with different nodes;
  - a decision on whether an RPC ServiceIndex kind should ever exist (a reader convention; no contract change).

## Unresolved capabilities (listed, not dropped)

- **Raw transaction propagation.** The role forwards only with an operator-stated route, and the role cannot check it.
  A Base node with gossip off and no sequencer route does not propagate. P and E own this.
- **Receipts.** Receipts for transactions submitted elsewhere appear only if the operator's node sees them included.
- **Verifier coverage.** Proof-backed answers cover only the verifier's methods. Logs, receipts, estimates and
  transaction lookups are node answers, labelled `node`.
