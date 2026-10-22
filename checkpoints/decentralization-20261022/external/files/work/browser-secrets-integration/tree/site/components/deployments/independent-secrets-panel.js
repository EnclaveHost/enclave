/* ============================================================
   The independent dashboard's Secrets tab (one deployment row's `.enc-isec` box; opened by deployments.js _indSecrets).
   The policy owner's custody v2 values (site/js/core/independent-secrets.js): list names, reveal values, set, remove,
   replace, clear, the explicit owner-read opt-in, pause/resume, claim after a transfer, and a first policy.
   Values reach the page only after an explicit click ("Reveal values"); they are shown as text, never copied to the
   clipboard, never stored, and wiped from the DOM on Hide, on any other action and when the panel closes. Entered values
   are cleared from the form once written. Every refusal is the module's precise message.
   ============================================================ */
import { esc } from "../../js/core/util.js";
import { paintLine } from "../../js/core/runlog.js";
import * as IS from "../../js/core/independent-secrets.js";

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
/* KEY=value lines (quotes optional; inside double quotes \" and \\ are escapes), as the hosted editor reads them */
export function parsePairs(text){
  const out = {};
  for (const [i, raw] of String(text || "").split(/\r?\n/).entries()){
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    const k = eq > 0 ? line.slice(0, eq).trim() : "";
    if (!KEY.test(k)) throw new Error("line " + (i + 1) + ": not KEY=value");
    let v = line.slice(eq + 1).trim();
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\(["\\])/g, "$1");
    else if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1);
    if (Object.prototype.hasOwnProperty.call(out, k)) throw new Error("line " + (i + 1) + ": " + k + " is given twice");
    out[k] = v;
  }
  return out;
}
const keysOf = (text) => String(text || "").split(/[\s,]+/).filter(Boolean);

const configChoice = (cls) => '<fieldset class="isec-config ' + cls + '"><legend class="dim">The config these values may be substituted into</legend>'
  + '<label><input type="radio" name="' + cls + '" value="inline" checked> this deployment’s inline config</label> '
  + '<label><input type="radio" name="' + cls + '" value="none"> no config</label> '
  + '<label><input type="radio" name="' + cls + '" value="text"> this exact config JSON:</label>'
  + '<textarea class="isec-config-text" rows="2" spellcheck="false" autocomplete="off" placeholder="{…}"></textarea></fieldset>';
const configOf = (box, cls) => {
  const f = box.querySelector(".isec-config." + cls);
  const mode = (f.querySelector("input:checked") || {}).value || "inline";
  return { mode, text: f.querySelector(".isec-config-text").value };
};

export const THREAT_NOTE = "With owner read on, whoever holds the owner key (your wallet, or your passkey account's approvals) can read these values from any client, silently. Without it, only an admitted guest ever receives them.";

/** mount the panel into `box` for deployment `id`; -> { close() } */
export function mountSecretsPanel(box, id){
  box.innerHTML = '<div class="ap-attbar">secrets · custody v2 · ' + esc(id) + '</div>'
    + '<p class="dim isec-intro">Your values live encrypted to this deployment’s custodian committee on the pinned vault, never on Enclave’s servers. Reading them back is the committee’s <b>owner read</b>: you sign one request for a one-time key this page makes, and only this page can open the answers. Nothing here is stored in the browser.</p>'
    + '<dl class="isec-facts"></dl>'
    + '<div class="isec-acts">'
    +   '<button type="button" class="btn btn-sm isec-refresh">Refresh</button> '
    +   '<button type="button" class="btn btn-sm isec-list">List names</button> '
    +   '<button type="button" class="btn btn-sm isec-reveal" title="Shows every value in this panel until you hide it">Reveal values</button> '
    +   '<button type="button" class="btn btn-sm isec-hide" hidden>Hide values</button>'
    + '</div>'
    + '<div class="isec-names" hidden></div>'
    + '<div class="isec-values" hidden aria-live="off"></div>'
    + '<div class="isec-edit" hidden>'
    +   '<label class="dim">Values, one KEY=value per line <textarea class="isec-pairs" rows="4" spellcheck="false" autocomplete="off" placeholder="API_KEY=&quot;…&quot;"></textarea></label>'
    +   '<span class="isec-edit-acts"><button type="button" class="btn btn-sm isec-set" title="Adds or replaces these keys; every other value stays">Set (merge)</button> '
    +   '<button type="button" class="btn btn-sm isec-replace" title="Stores exactly these values; every other value is removed">Replace all</button></span>'
    +   configChoice("isec-cfg-replace")
    +   '<label class="dim">Remove keys <input class="isec-rmkeys ac-in" type="text" spellcheck="false" autocomplete="off" placeholder="KEY OTHER_KEY"></label> '
    +   '<button type="button" class="btn btn-sm isec-rm">Remove</button> '
    +   '<button type="button" class="btn btn-sm danger isec-clear">Clear all</button>'
    + '</div>'
    + '<div class="isec-policy" hidden>'
    +   '<p class="dim isec-or-note"></p>'
    +   '<button type="button" class="btn btn-sm isec-or-on">Turn on owner read</button> <button type="button" class="btn btn-sm isec-or-off">Turn off owner read</button> '
    +   '<button type="button" class="btn btn-sm isec-pause">Pause</button> <button type="button" class="btn btn-sm isec-resume">Resume</button>'
    + '</div>'
    + '<div class="isec-claim" hidden><button type="button" class="btn btn-sm danger isec-claimbtn">Claim custody (destroys the previous owner’s values)</button></div>'
    + '<div class="isec-create" hidden>'
    +   '<p class="dim">No custody policy yet. Create one: the rules say which code may receive the values (custody SNP rules, or Enclave Shield rules with their acceptTier), the committee holds the key.</p>'
    +   '<label class="dim">Rules JSON <textarea class="isec-rules" rows="4" spellcheck="false" autocomplete="off"></textarea></label>'
    +   '<label class="dim">Committee <input class="isec-committee ac-in" type="text" spellcheck="false" autocomplete="off" placeholder="0x…"></label> <button type="button" class="btn btn-sm isec-seats">Check committee</button>'
    +   '<div class="isec-seatlist dim"></div>'
    +   '<label><input type="checkbox" class="isec-allow-enclave"> allow an Enclave-operated seat in this committee</label><br>'
    +   '<label><input type="checkbox" class="isec-ownerread"> <b>owner read</b>: let me list, show and edit single values from the dashboard and the CLI</label>'
    +   '<p class="dim isec-create-note"></p>'
    +   '<label class="dim">First values, one KEY=value per line <textarea class="isec-create-pairs" rows="3" spellcheck="false" autocomplete="off"></textarea></label>'
    +   configChoice("isec-cfg-create")
    +   '<button type="button" class="btn btn-sm btn-primary isec-createbtn">Create policy</button>'
    + '</div>'
    + '<div class="term isec-status" role="status" aria-live="polite"></div>';

  const $ = (sel) => box.querySelector(sel);
  const st = $(".isec-status"), facts = $(".isec-facts"), names = $(".isec-names"), values = $(".isec-values");
  const paint = (cls, t) => paintLine(st, cls, t);
  let closed = false, busy = false, clearArmed = false;
  const buttons = () => [...box.querySelectorAll("button")];
  const wipeValues = () => { values.replaceChildren(); values.hidden = true; $(".isec-hide").hidden = true; };
  const wipeNames = () => { names.replaceChildren(); names.hidden = true; };

  const fact = (k, v, cls = "") => '<dt>' + esc(k) + '</dt><dd class="' + cls + '">' + esc(v) + '</dd>';
  async function refresh(){
    let d;
    try { d = await IS.describe(await IS.readState(id), await IS.identityAddress()); }
    catch (e){ facts.innerHTML = ""; paint("warn", "[x] " + (e.message || e)); return null; }
    if (closed) return null;
    const who = (d.me.kind === "account" ? "passkey account " : "wallet ") + (d.me.address || "(none)");
    facts.innerHTML = fact("vault", d.vault + " (its ledger, registry" + (d.vaultChecked.includes("sessionVaultFactory") ? ", session factory" : "") + " checked against your profile; code not reviewed by the profile)")
      + fact("read at", "block " + d.block + " · " + d.agreeing)
      + (d.exists
        ? fact("policy owner", d.owner + (d.owner === d.me.address ? " (you)" : ""), "isec-owner")
          + fact("ledger owner", d.beneficialOwner + (d.transferred ? " (the ledger moved this deployment: custody must be claimed)" : ""), d.transferred ? "isec-moved" : "")
          + fact("you act as", who)
          + fact("revisions", "policy " + d.policyRev + " · secrets " + d.secretRev)
          + fact("committee", d.committee ? d.committee.t + " of " + d.committee.n + " custodians, epoch " + d.committee.epoch + (d.committee.enclaveSeats ? " · " + d.committee.enclaveSeats + " Enclave-operated seat(s)" : " · no Enclave-operated seat") : "unreadable")
          + fact("rules", d.rulesError ? "UNPARSEABLE: " + d.rulesError : d.kind === "shield" ? "Enclave Shield" : "SEV-SNP custody rules")
          + fact("owner read", d.ownerRead ? "on" : "off" + (d.ownerReadKey === "absent" ? " (not set in the rules)" : ""), "isec-or")
          + fact("state", (d.paused ? "PAUSED: custodians release nothing, to you either · " : "") + (d.stored ? d.bundleBytes + " encrypted bytes stored" : "nothing stored"), "isec-state")
        : fact("policy", "none yet") + fact("ledger owner", d.beneficialOwner + (d.mine ? " (you)" : "")) + fact("you act as", who));
    const owns = d.exists && !d.transferred && d.mine;
    $(".isec-edit").hidden = !owns;
    $(".isec-policy").hidden = !owns;
    $(".isec-claim").hidden = !d.claimable;
    $(".isec-create").hidden = d.exists || !d.mine;
    const canRead = owns && d.ownerRead && !d.paused && d.stored;
    for (const sel of [".isec-list", ".isec-reveal", ".isec-set", ".isec-rm"]) $(sel).disabled = !canRead;
    $(".isec-or-on").hidden = !owns || d.ownerRead; $(".isec-or-off").hidden = !owns || !d.ownerRead;
    $(".isec-pause").hidden = !owns || d.paused; $(".isec-resume").hidden = !owns || !d.paused;
    $(".isec-or-note").textContent = THREAT_NOTE;
    $(".isec-create-note").textContent = "Owner read is OFF unless you tick it. " + THREAT_NOTE;
    if (owns && !d.ownerRead) paint("dimln", "owner read is off for this policy: listing, revealing, Set and Remove are unavailable; Replace all and Clear still work");
    if (owns && d.paused) paint("dimln", "custody is paused: nothing is released, owner reads included; Replace all and Clear still work");
    return d;
  }

  // one action at a time; every action starts from a fresh agreed read (inside the module) and ends with a refresh
  // box[data-busy] marks an action (or the first read) in flight, until its closing refresh is painted
  const run = (label, fn) => async () => {
    if (busy || closed) return;
    busy = true; box.dataset.busy = "1"; buttons().forEach((b) => (b.disabled = true)); wipeValues();
    if (label !== "clear") clearArmed = false;
    try { await fn(); }
    catch (e){ paint("warn", "[x] " + (e && e.message || e)); }
    finally { busy = false; buttons().forEach((b) => (b.disabled = false)); if (!closed) await refresh(); delete box.dataset.busy; }
  };

  $(".isec-refresh").addEventListener("click", run("refresh", async () => {
    wipeNames(); paint("info", "[*] reading custody at an agreed block…");
    const d = await IS.describe(await IS.readState(id));
    paint("ok", "[✓] custody read at agreed block " + d.block);
  }));
  $(".isec-list").addEventListener("click", run("list", async () => {
    paint("info", "[*] sign the owner read (one request, for a one-time key this page made)…");
    const r = await IS.listSecrets(id);
    names.replaceChildren(...(r.sizes.length ? r.sizes.map(([n, size]) => { const li = document.createElement("div"); li.className = "isec-name"; li.textContent = n + "  (" + size + " bytes)"; return li; })
      : [Object.assign(document.createElement("div"), { className: "dim", textContent: "no values stored" })]));
    names.hidden = false;
    paint("ok", "[✓] " + r.names.length + " value(s) at secrets revision " + r.secretRev + ", from " + r.answered + " custodian share(s); values not shown");
  }));
  $(".isec-reveal").addEventListener("click", run("reveal", async () => {
    paint("info", "[*] sign the owner read to reveal the values…");
    const r = await IS.revealSecrets(id);
    const rows = r.names.map((n) => {
      const row = document.createElement("div"); row.className = "isec-value";
      const k = document.createElement("span"); k.className = "isec-k"; k.textContent = n + "=";
      const v = document.createElement("code"); v.className = "isec-v"; v.textContent = r.env[n];
      row.append(k, v); return row;
    });
    values.replaceChildren(...rows); values.hidden = false; $(".isec-hide").hidden = false;
    paint("ok", "[✓] revealed " + r.names.length + " value(s) (secrets revision " + r.secretRev + "); Hide removes them from the page");
  }));
  $(".isec-hide").addEventListener("click", () => { wipeValues(); paint("dimln", "values hidden"); });

  const written = (what, r) => paint("ok", "[✓] " + what + ": policy revision " + r.policyRev + ", secrets revision " + r.secretRev + ", read back at agreed block " + r.block
    + (r.names ? " · " + r.names.length + " value(s)" + (r.names.length ? ": " + r.names.join(", ") : "") : ""));
  $(".isec-set").addEventListener("click", run("set", async () => {
    const pairs = parsePairs($(".isec-pairs").value);
    paint("info", "[*] reading the current values (sign the owner read), then writing the merge (confirm in your " + (IS.identityAddress().kind === "account" ? "passkey" : "wallet") + ")…");
    const r = await IS.editSecrets(id, { op: "set", pairs });
    $(".isec-pairs").value = ""; written("stored", r);
  }));
  $(".isec-replace").addEventListener("click", run("replace", async () => {
    const pairs = parsePairs($(".isec-pairs").value);
    paint("info", "[*] writing exactly these " + Object.keys(pairs).length + " value(s); nothing is read…");
    const r = await IS.editSecrets(id, { op: "replace", pairs, config: configOf(box, "isec-cfg-replace") });
    $(".isec-pairs").value = ""; written("replaced", r);
  }));
  $(".isec-rm").addEventListener("click", run("rm", async () => {
    const keys = keysOf($(".isec-rmkeys").value);
    if (!keys.length) throw new Error("Name at least one key to remove.");
    paint("info", "[*] reading the current values (sign the owner read), then removing " + keys.join(", ") + "…");
    const r = await IS.editSecrets(id, { op: "rm", keys });
    $(".isec-rmkeys").value = ""; written("removed", r);
  }));
  $(".isec-clear").addEventListener("click", run("clear", async () => {
    if (!clearArmed){ clearArmed = true; paint("warn", "[!] Clear destroys every stored value of this deployment. Click Clear all again to confirm."); return; }
    clearArmed = false;
    const r = await IS.editSecrets(id, { op: "clear" });
    if (r.noop) paint("dimln", "nothing stored: already clear"); else written("cleared", r);
  }));
  $(".isec-or-on").addEventListener("click", run("or-on", async () => {
    paint("info", "[*] turning owner read ON (a visible policy change: the rules gain ownerRead: true; values, committee and pause unchanged). " + THREAT_NOTE);
    written("owner read is on", await IS.setOwnerRead(id, true));
  }));
  $(".isec-or-off").addEventListener("click", run("or-off", async () => { written("owner read is off", await IS.setOwnerRead(id, false)); }));
  $(".isec-pause").addEventListener("click", run("pause", async () => { written("paused: custodians release nothing for this deployment until you resume", await IS.setPaused(id, true)); }));
  $(".isec-resume").addEventListener("click", run("resume", async () => { written("resumed", await IS.setPaused(id, false)); }));
  $(".isec-claimbtn").addEventListener("click", run("claim", async () => {
    const r = await IS.claimCustody(id);
    paint("ok", "[✓] claimed: policy revision " + r.policyRev + " is yours, paused, with no values (the previous owner's are destroyed); store your own with Replace all, then Resume");
  }));
  $(".isec-seats").addEventListener("click", run("seats", async () => {
    const lay = await IS.committeeLayout($(".isec-committee").value.trim());
    $(".isec-seatlist").textContent = lay.t + " of " + lay.n + " custodians, epoch " + lay.epoch + ": " + lay.seats.map((x) => x.endpoint + (x.enclave ? " (Enclave-operated)" : "")).join(", ");
  }));
  $(".isec-createbtn").addEventListener("click", run("create", async () => {
    const pairs = parsePairs($(".isec-create-pairs").value), ownerRead = $(".isec-ownerread").checked;
    paint("info", "[*] creating the policy with owner read " + (ownerRead ? "ON" : "OFF") + "; the values are encrypted here to the committee’s key…");
    const r = await IS.createPolicy(id, { rulesText: $(".isec-rules").value, committeeId: $(".isec-committee").value.trim(), ownerRead, pairs,
                                          config: configOf(box, "isec-cfg-create"), allowEnclaveSeat: $(".isec-allow-enclave").checked });
    $(".isec-create-pairs").value = "";
    written("created (owner read " + (r.ownerRead ? "on" : "off") + ")", r);
  }));

  paint("info", "[*] reading custody at an agreed block…");
  box.dataset.busy = "1";
  refresh().finally(() => { if (!busy) delete box.dataset.busy; });
  return { close(){ closed = true; wipeValues(); wipeNames(); box.querySelectorAll("textarea, input[type=text]").forEach((t) => (t.value = "")); box.replaceChildren(); } };
}
