/* ============================================================
   /owner?contract=<address> - the second step of a two-step
   ownership hand-over (transferOwnership by the current owner,
   then acceptOwnership by the next one), for any Enclave contract
   that exposes owner() and pendingOwner(): EnclaveHostPaymaster,
   EnclaveProofOfTime, the ledger. Reads both from Base, connects
   the wallet (WalletConnect for a Trezor through Suite, or an
   extension) and sends acceptOwnership() only from the wallet the
   contract is waiting for.
   ============================================================ */
import "../../components/header/header.js";
import "../../components/footer/footer.js";
import "../../components/toast/toast.js";
import "../../components/section-head/section-head.js";
import { Enclave } from "../core/api.js";
import { connectWallet, ensureBaseChain, sendTx } from "../core/wallet.js";
import { baseRpc, waitReceipt } from "../core/chain.js";
import { $, esc, showToast } from "../core/util.js";

const SEL = { owner: "0x8da5cb5b", pendingOwner: "0xe30c3978", accept: "0x79ba5097" };
const ZERO = "0x0000000000000000000000000000000000000000";
const isAddr = (s) => /^0x[0-9a-fA-F]{40}$/.test(s || "");
const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const addrOf = (word) => "0x" + String(word || "").replace(/^0x/, "").slice(24).padStart(40, "0");

let st = null, busy = false, done = null;

async function read(contract){
  const call = (data) => baseRpc("eth_call", [{ to: contract, data }, "latest"]);
  const [code, owner, pending] = await Promise.all([baseRpc("eth_getCode", [contract, "latest"]), call(SEL.owner), call(SEL.pendingOwner)]);
  if (!code || code === "0x") throw new Error("There is no contract at this address on Base.");
  return { contract, owner: addrOf(owner), pending: addrOf(pending) };
}

function mount(){
  const body = $("#owBody"); if (!body) return;
  const contract = new URLSearchParams(location.search).get("contract");
  if (!isAddr(contract)){ body.innerHTML = card("<p class=\"co-note\">This link names no contract (<code>/owner?contract=0x…</code>).</p>"); return; }
  const load = () => read(contract).then((s) => { st = s; render(body); },
    (e) => { body.innerHTML = card("<p class=\"co-note\">Could not read the contract: " + esc(e.message || String(e)) + "</p>"); });
  load();
  document.addEventListener("enclave:wallet", () => render(body));
  body.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]"); if (!b || busy) return;
    (b.dataset.act === "connect" ? connectWallet() : accept()).then(() => (done ? load() : render(body)),
      (err) => { busy = false; showToast(err.message || String(err)); render(body); });
  });
}

async function accept(){
  busy = true; render($("#owBody"));
  if (!Enclave.provider) await connectWallet();
  await ensureBaseChain();
  if (!same(Enclave.address, st.pending)) throw new Error("Connect " + st.pending + ": that is the wallet the contract is waiting for.");
  const hash = await sendTx(st.contract, SEL.accept);
  showToast("Sent · " + hash.slice(0, 12) + "…");
  await waitReceipt(hash);
  done = hash; busy = false;
}

function render(body){
  if (!body || !st) return;
  const me = Enclave.address || null;
  const facts = "<dl class=\"ss-facts\"><dt>contract</dt><dd><code>" + esc(st.contract) + "</code> · <a href=\"https://basescan.org/address/" + esc(st.contract) + "\" target=\"_blank\" rel=\"noopener\">Basescan</a></dd>" +
    "<dt>owner</dt><dd><code>" + esc(st.owner) + "</code>" + (same(st.owner, me) ? " (this wallet)" : "") + "</dd>" +
    "<dt>waiting for</dt><dd>" + (st.pending !== ZERO ? "<code>" + esc(st.pending) + "</code>" + (same(st.pending, me) ? " (this wallet)" : "") : "nobody") + "</dd></dl>";
  let act;
  if (done && same(st.owner, me)) act = "<h3>Done. This wallet owns the contract.</h3><p class=\"co-note\">Transaction <code>" + esc(done) + "</code></p>";
  else if (st.pending === ZERO) act = "<h3>No hand-over in progress</h3><p>The current owner has not named a next owner, so there is nothing to accept.</p>";
  else if (!me) act = "<h3>Connect " + esc(st.pending.slice(0, 6) + "…" + st.pending.slice(-4)) + "</h3><p>WalletConnect works with Trezor Suite and mobile wallets; a browser extension works too.</p>" +
    "<button class=\"btn btn-primary\" data-act=\"connect\">Connect a wallet</button>";
  else if (!same(st.pending, me)) act = "<h3>This is not the wallet the contract is waiting for</h3><p>Connected: <code>" + esc(me) + "</code>. Switch to <code>" + esc(st.pending) + "</code> in your wallet.</p>" +
    "<button class=\"btn\" data-act=\"connect\">Connect another wallet</button>";
  else act = "<h3>Accept ownership</h3><p>One transaction on Base from this wallet: <code>acceptOwnership()</code> on the contract above (a few cents of gas). Your wallet shows the call before you sign.</p>" +
    "<button class=\"btn btn-primary\" data-act=\"accept\"" + (busy ? " disabled" : "") + ">" + (busy ? "Waiting for your wallet…" : "Accept ownership") + "</button>";
  body.innerHTML = card(facts) + card(act);
}

const card = (inner) => "<div class=\"ss-card\">" + inner + "</div>";

export function boot(){ mount(); }
