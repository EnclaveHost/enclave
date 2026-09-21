// The Windows consumer node's claim policy (windows/node/chain.mjs).
//
// This is the whole of what that box will and will not take from the ledger, and every refusal is
// a feature it does not implement or capacity it does not have. It is worth a test of its own
// because the failure mode is silent in the direction that matters: a policy that accepts too much
// runs a tenant's app with a protection they paid for missing, and nothing on either side says so.
//
// Pure logic, no chain: claimPolicy reads a deployment record, the catalog version beside it and
// the box's own free capacity, and returns null or the reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import { claimPolicy, parseEnvelope, nodeFloorOf, gpuOptionalOfConfig, cpuFallbackOfConfig } from "../windows/node/chain.mjs";

const OWNER = "0x29479Bf04ED889D46a7AfB7f292B9Bb26e12647C";
const STRANGER = "0x1111111111111111111111111111111111111111";
const ENCLAVE = "0xd497d065ca395192db3630699dbc5a6418f2f028256212a4d9ab73288643fe1b";
const ZERO32 = "0x" + "0".repeat(64);
// A funded, public, coreless deployment: the shape this box exists to run.
const dep = (o = {}) => ({ id: "0x" + "a".repeat(64), owner: STRANGER, appRef: "catalog://0xapp/0",
  configCid: "", gpuMilli: 0, cpuMilli: 250, isPublic: true, active: true, createdAt: 1790000000n,
  runner: ZERO32, leaseUntil: 0n, ...o });
// Room for it: three slots, three quarters of a node, 80 GB.
const roomy = { slots: 4, slotsFree: 3, cpuShareFree: 0.75, ramMbFree: 81920, cpuGflops: 1000 };
const ctx = (o = {}) => ({ ownerAllow: OWNER, enclaveId: ENCLAVE, appsEnabled: true, capacity: roomy, ...o });
const version = (o = {}) => ({ cid: "bafy", version: "1.0.0", memMb: 512, cpuGflops: 10, config: "", approval: 1, yanked: false, ...o });

test("market scope takes a stranger's public deployment; owner-only does not", () => {
  assert.equal(claimPolicy(dep(), ctx()), null, "the default scope is the market: any wallet's");
  const refused = claimPolicy(dep(), ctx({ scope: "owner-only" }));
  assert.match(String(refused), /owner-only/, "the bring-up scope still narrows to the box owner");
  assert.equal(claimPolicy(dep({ owner: OWNER }), ctx({ scope: "owner-only" })), null);
});

// The one rule with no counterpart on a platform box. An app does run inside this box's enclave,
// but a VBS enclave on a consumer PC is a different guarantee from the fleet's confidential VMs:
// software-only, and test-signed on the dev tier. A buyer who picks this box has been told. Somebody
// who deployed months ago, when every enclave in the fleet was a CVM, has not.
test("an older stranger's deployment needs their own invitation", () => {
  const LISTED = 1790000000;                               // this box's registry entry
  const older = dep({ createdAt: BigInt(LISTED - 86400) });
  const refused = claimPolicy(older, ctx({ listedAt: LISTED }));
  assert.match(String(refused), /created before this box was listed/);
  assert.match(String(refused), /protects it against this machine's software/,
               "the refusal has to say WHY, or it reads as a bug");
  // The deploy console's target pick reaches the node as a claim hint naming this box.
  assert.equal(claimPolicy(older, ctx({ listedAt: LISTED, invited: true })), null);
  // Deployed while the row was up, with its disclosure on it: in scope.
  assert.equal(claimPolicy(dep({ createdAt: BigInt(LISTED + 60) }), ctx({ listedAt: LISTED })), null);
  // The box owner's own, at any age: theirs to place.
  assert.equal(claimPolicy(dep({ owner: OWNER, createdAt: 1n }), ctx({ listedAt: LISTED })), null);
  // Not yet registered (no listing date): the scan has nothing to compare against and this rule
  // stays out of the way. The box cannot claim anything without a registry entry regardless.
  assert.equal(claimPolicy(older, ctx({ listedAt: 0 })), null);
});

test("what it refuses outright, each by name", () => {
  // Not this box's to decide: the ledger says it is off.
  assert.match(String(claimPolicy(dep({ active: false }), ctx())), /not active/);
  assert.match(String(claimPolicy(null, ctx())), /no such deployment/);
  assert.match(String(claimPolicy(dep(), ctx({ appsEnabled: false }))), /not hosting apps/);
  // A private deployment's access control is a session token this box does not verify. Running it
  // would publish someone's private app to anyone who knows the id.
  assert.match(String(claimPolicy(dep({ isPublic: false }), ctx())), /private deployment/);
  // Somebody else is already serving it.
  const held = dep({ runner: "0x" + "b".repeat(64), leaseUntil: BigInt(Math.floor(Date.now() / 1000) + 600) });
  assert.match(String(claimPolicy(held, ctx())), /another enclave holds a live lease/);
  // ...but OUR OWN live lease is not a refusal, or the box would drop the app it is running.
  assert.equal(claimPolicy({ ...held, runner: ENCLAVE }, ctx()), null);
  // A lapsed lease held by someone else is claimable again.
  assert.equal(claimPolicy({ ...held, leaseUntil: 1n }, ctx()), null);
});

test("options it does not enforce are refused by name, never dropped", () => {
  assert.match(String(claimPolicy(dep({ configCid: JSON.stringify({ waf: { rateLimit: 10 } }) }), ctx())),
               /waf, which this node does not enforce/, "no per-IP limit here: say so");
  assert.match(String(claimPolicy(dep({ configCid: JSON.stringify({ secrets: ["API_KEY"] }) }), ctx())), /secrets/);
  assert.match(String(claimPolicy(dep({ configCid: "bafybeigdyrztabc123" }), ctx())),
               /bare CID/, "a pinned config is bytes this box does not fetch");
  assert.match(String(claimPolicy(dep({ configCid: "{not json" }), ctx())), /not readable JSON/);
  // ...and the three it does understand are accepted.
  assert.equal(claimPolicy(dep({ configCid: JSON.stringify({ config: { MODEL: "x" } }) }), ctx()), null);
  assert.equal(claimPolicy(dep({ configCid: JSON.stringify({ network: { relay: "us-west" } }) }), ctx()), null);
});

test("the card: refused unless the owner or the publisher said it is soft", () => {
  const gpu = dep({ gpuMilli: 500 });
  assert.match(String(claimPolicy(gpu, ctx())), /reserved for the enclave's masked inference/,
               "this box's GPU serves the model in VTL1 and sells no share of itself");
  // The OWNER's dial: they bought a card slice and would rather run on cores than queue.
  const optional = dep({ gpuMilli: 500, configCid: JSON.stringify({ gpu: { optional: true } }) });
  assert.equal(claimPolicy(optional, ctx()), null);
  // The PUBLISHER's word, in the version config, reaches the same place.
  assert.equal(claimPolicy(gpu, ctx({ version: version({ config: JSON.stringify({ gpuOptional: true }) }) })), null);
  // gpu.optional on a deployment that bought no card is a misunderstanding, and refused as one.
  assert.match(String(claimPolicy(dep({ configCid: JSON.stringify({ gpu: { optional: true } }) }), ctx())),
               /applies only to a deployment that bought GPU share/);
});

test("approval: rejected and yanked never run, pending runs only for the box owner", () => {
  // Mirrored from the platform runner deliberately: a box that reads the catalog's approval state
  // differently from the rest of the fleet is how an unapproved app ends up serving the public.
  const approved = version({ approval: 1 });
  assert.equal(claimPolicy(dep(), ctx({ version: approved })), null);
  assert.match(String(claimPolicy(dep(), ctx({ version: version({ approval: 2 }) }))), /rejected by the catalog owner/);
  assert.match(String(claimPolicy(dep(), ctx({ version: version({ approval: 1, yanked: true }) }))), /yanked by its publisher/);
  // Pending: refused for a stranger...
  assert.match(String(claimPolicy(dep(), ctx({ version: version({ approval: 0 }) }))), /awaiting the catalog owner's approval/);
  // ...allowed for the box owner's own deployment, which is the publisher testing their own app on
  // their own machine. The fleet's equivalent is dev mode on a PRIVATE deployment, which this box
  // cannot offer because it refuses private deployments.
  assert.equal(claimPolicy(dep({ owner: OWNER }), ctx({ version: version({ approval: 0 }) })), null);
});

test("capacity refusals carry the numbers they were decided on", () => {
  const full = { ...roomy, slotsFree: 0 };
  assert.match(String(claimPolicy(dep(), ctx({ capacity: full }))), /4 app slots already/);
  const thin = { ...roomy, cpuShareFree: 0.1 };
  assert.match(String(claimPolicy(dep({ cpuMilli: 250 }), ctx({ capacity: thin }))),
               /asks for 25% of a node and this box has 10% left/);
  // The publisher's cpuFallback is what makes this refusal possible at all: the on-chain memMb
  // describes the app beside its card, and the coreless case is the bigger number.
  const big = version({ memMb: 512, config: JSON.stringify({ cpuFallback: { memMb: 65536 } }) });
  assert.match(String(claimPolicy(dep(), ctx({ version: big, capacity: { ...roomy, ramMbFree: 4096 } }))),
               /65536 MB of node RAM on cores \(the publisher's cpuFallback\)/);
  // Without the declaration the same version fits, which is the fail-open direction and correct:
  // a publisher who declared nothing gets today's behaviour.
  assert.equal(claimPolicy(dep(), ctx({ version: version(), capacity: { ...roomy, ramMbFree: 4096 } })), null);
  // No capacity handed in at all (a policy check before the box knows its own state) does not
  // invent a refusal.
  assert.equal(claimPolicy(dep(), ctx({ capacity: null })), null);
});

test("the version config keys are read exactly as the platform runner reads them", () => {
  assert.equal(gpuOptionalOfConfig(JSON.stringify({ gpuOptional: true })), true);
  assert.equal(gpuOptionalOfConfig("not json"), false, "unparseable declares nothing, fail closed");
  assert.equal(cpuFallbackOfConfig(JSON.stringify({ cpuFallback: { memMb: 8192, cpuGflops: 40 } })).memMb, 8192);
  assert.equal(cpuFallbackOfConfig(JSON.stringify({ cpuFallback: { memMb: 1e12 } })), null,
               "past the catalog's own MAX_MB it is not a figure the publisher could have registered");
  // One-directional: the floor may only RISE on a coreless placement.
  assert.equal(nodeFloorOf(version({ memMb: 4096, config: JSON.stringify({ cpuFallback: { memMb: 1024 } }) })).memMb, 4096);
  assert.equal(nodeFloorOf(version({ memMb: 4096, config: JSON.stringify({ cpuFallback: { memMb: 16384 } }) })).memMb, 16384);
  assert.equal(nodeFloorOf(version({ memMb: 0 })).memMb, 512, "a version that declares nothing gets the default guest");
});

test("the envelope parser returns what it accepted, so the guest gets what the policy allowed", () => {
  assert.deepEqual(parseEnvelope("", 0), {});
  assert.deepEqual(parseEnvelope(JSON.stringify({ config: { A: 1 }, network: { relay: "" } }), 0),
                   { relay: "", config: { A: 1 } });
  assert.throws(() => parseEnvelope(JSON.stringify({ gpu: { optional: "yes" } }), 500), /must be true or false/);
  assert.throws(() => parseEnvelope(JSON.stringify({ network: { relay: "UPPER" } }), 0), /must be a relay name/);
  assert.throws(() => parseEnvelope(JSON.stringify({ config: "a string" }), 0), /config must be a JSON object/);
});
