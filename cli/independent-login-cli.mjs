// cli/independent-login-cli.mjs -- the independent `login`, `logout`, `account`, `session resume-wait` and
// `session top-up-link` commands, over cli/independent-login.mjs. cli/enclave.mjs passes its context in (see
// work/independent-login-interface.txt); nothing here reads configuration of its own.
//
//   enclave --independent … login --frontend https://… [--owner ACCOUNT] [--preset auth-only|browser|staging-publish|…]
//         [--app a,b] [--days N] [--budget USD] [--approve-within MINUTES] [--wait-minutes N | --no-wait]
//         [--accept-owner ACCOUNT] [--switch-account]
//   enclave --independent … login --resume [<id>] [--accept-owner ACCOUNT]
//   enclave --independent … login --owner-signature 0x… [<id>] [--owner ACCOUNT]     (a signature handed back; a separate
//                                                                                      gas key submits the open)
//   enclave --independent … login --list | --discard <id>
//   enclave --independent … logout [<sid>] [--forget-key [--force]]
//   enclave --independent … account
//   enclave --independent … session resume-wait <id> | session top-up-link --amount USD [<sid>] [--frontend URL]
import { createIndependentLogin, LoginError } from "./independent-login.mjs";

const usage = `usage: enclave --independent … login --frontend https://<origin you reviewed> [--owner ACCOUNT] [--preset NAME] [--app a,b] [--days N]
         [--budget USD] [--approve-within MINUTES] [--wait-minutes N | --no-wait] [--accept-owner ACCOUNT] [--switch-account]
     | login --resume [<id>] | login --owner-signature 0x… [<id>] [--owner ACCOUNT] | login --list | login --discard <id>
     | logout [<sid>] [--forget-key [--force]] | account | session resume-wait <id> | session top-up-link --amount USD [<sid>]`;

/** ctx: { S, chain, pc, sessionSnapshot, store, stateDir, factory, chainId, profileDigest, env, flags, numFlag, say, info, jout,
 *  json, confirm, interactive, gasKey(): account | null, sendTx(account, {to, data}) -> receipt } */
export async function independentLoginCommand(cmd, rest, ctx) {
  const { flags, say, info = say, jout, json } = ctx;
  const f = flags(rest, { bool: ["--no-wait", "--resume", "--list", "--switch-account", "--forget-key", "--force"],
    val: ["--frontend", "--owner", "--preset", "--app", "--days", "--budget", "--approve-within", "--wait-minutes", "--accept-owner",
      "--owner-signature", "--discard", "--amount"] });
  const frontend = f.frontend || ctx.env?.ENCLAVE_FRONTEND || null;
  const login = createIndependentLogin({ S: ctx.S, chain: ctx.chain, pc: ctx.pc, sessionSnapshot: ctx.sessionSnapshot, store: ctx.store,
    stateDir: ctx.stateDir, factory: ctx.factory, chainId: ctx.chainId, profileDigest: ctx.profileDigest, frontend, now: ctx.now, sleep: ctx.sleep });
  const minutes = f["wait-minutes"] !== undefined ? ctx.numFlag(f["wait-minutes"], "--wait-minutes") : 30;
  const out = (o, text) => (json ? jout(o) : say(text));

  // wait for the chain, asking the person at the terminal when an unbound login was opened by an account it does not know
  async function settle(id, acceptOwner = f["accept-owner"] || null) {
    const r = await login.wait(id, { timeoutMs: Math.round(minutes * 60_000), acceptOwner,
      onTick: () => { if (!json) info(`waiting for the owner's approval on chain (resume later with: enclave --independent … login --resume ${id})`); } });
    if (r.state === "confirm-owner") {
      const lines = r.candidates.map((c) => `  ${c.owner} (vault ${c.vault})`).join("\n");
      if (ctx.interactive && !json && r.candidates.length === 1) {
        info(`this sign-in was approved by\n${lines}\nAnyone holding the link could have approved it in their own account.`);
        if (await ctx.confirm(`is ${r.candidates[0].owner} YOUR account (the one this CLI should act for)?`)) return settle(id, r.candidates[0].owner);
      }
      throw new LoginError("confirm-owner", `the sign-in was approved by an account this CLI does not act for yet:\n${lines}\n`
        + `if it is yours: enclave --independent … login --resume ${id} --accept-owner <that account>`);
    }
    if (r.state === "open") return out(r, `signed in: session ${r.sid} of ${r.owner} (vault ${r.vault}) is live and active`
      + (r.alsoOpenedBy ? `\n! the same request was also approved by ${r.alsoOpenedBy.join(", ")}: not followed; someone else saw the link` : ""));
    if (r.state === "expired") throw new LoginError("expired", `nobody approved sign-in ${id} in time; its key is deleted: run login again`);
    if (r.state === "refused") throw new LoginError("refused", `the session opened for ${id} is not the one requested (${r.reason}); nothing was adopted`);
    return out({ ...r, resumable: true }, `still waiting; resume with: enclave --independent … login --resume ${id}`);
  }

  if (cmd === "logout") {
    const r = await login.logout({ sid: f._[0] || null, forgetKey: !!f["forget-key"], force: !!f.force });
    if (!r.sid) return out(r, "no active session on this machine");
    return out(r, `the active session ${r.sid} is set aside on this machine${r.keyKept ? " (its key is kept)" : " and its key deleted"}; `
      + (r.live === false ? "it is not live on chain" : `it is ${r.live ? "STILL LIVE" : "of unknown state"} on chain: ${r.endWith}`));
  }
  if (cmd === "account") {
    const pin = login.identity(), active = ctx.store.activeId?.() || null;
    const rec = active ? await ctx.store.load(active) : null;
    let live = null;
    if (rec?.handle) live = await ctx.sessionSnapshot(ctx.chain, { factory: login.factory, vault: rec.handle.vault, sid: rec.handle.sid }).then((s) => s.live, () => null);
    const o = { account: pin?.owner || null, factory: login.factory, chainId: ctx.chainId, activeSession: rec?.handle ? { sid: rec.handle.sid, vault: rec.handle.vault, owner: rec.handle.owner, live } : null,
      pending: login.pending().map((p) => p.id) };
    return out(o, `account: ${o.account || "none yet (enclave --independent … login)"}\nsession factory: ${o.factory} (chain ${o.chainId})\n`
      + `active session: ${o.activeSession ? `${o.activeSession.sid} (${live === null ? "state unknown" : live ? "live" : "not live"})` : "none"}`
      + (o.pending.length ? `\npending sign-ins: ${o.pending.join(", ")}` : ""));
  }
  if (cmd === "session resume-wait") {
    if (!f._[0]) throw new LoginError("usage", "usage: enclave --independent … session resume-wait <id>");
    return settle(f._[0]);
  }
  if (cmd === "session top-up-link") {
    if (f.amount === undefined) throw new LoginError("usage", "usage: enclave --independent … session top-up-link --amount <usd> [<sid>] [--frontend https://…]");
    const r = await login.topUpLink({ sid: f._[0] || null, amountUsd: ctx.numFlag(f.amount, "--amount") });
    return out(r, `send this to the owner ${r.owner}; they approve the amount with their own account on their frontend:\n${r.link}`);
  }
  if (cmd !== "login") throw new LoginError("usage", usage);

  if (f.list) {
    const p = login.pending();
    return out({ account: login.identity()?.owner || null, pending: p.map((x) => ({ id: x.id, owner: x.owner, frontend: x.frontend, unusable: x.unusable || null })) },
      p.length ? p.map((x) => `${x.id}${x.owner ? ` for ${x.owner}` : ""} on ${x.frontend}${x.unusable ? ` (${x.unusable})` : ""}`).join("\n") : "no pending sign-ins");
  }
  if (f.discard) { await login.discard(f.discard); return out({ discarded: f.discard }, `sign-in ${f.discard} discarded (nothing on chain changed)`); }
  if (f.resume) {
    const p = login.pending().filter((x) => !x.unusable);
    const id = f._[0] || (p.length === 1 ? p[0].id : null);
    if (!id) throw new LoginError("usage", p.length ? `several pending sign-ins; name one: ${p.map((x) => x.id).join(", ")}` : "no pending sign-in to resume");
    return settle(id);
  }
  if (f["owner-signature"]) {
    const p = login.pending().filter((x) => !x.unusable);
    const id = f._[0] || (p.length === 1 ? p[0].id : null);
    if (!id) throw new LoginError("usage", "name the pending sign-in this signature is for");
    const tx = await login.signedOpen(id, f["owner-signature"], { owner: f.owner || null });
    const payer = ctx.gasKey();
    if (!payer) return out({ id, ...tx, submitted: false }, `the signature is accepted by the pinned factory (checked at an agreed block). Any gas payer may submit:\n`
      + `  to   ${tx.to}\n  data ${tx.data}\nthen: enclave --independent … login --resume ${id}`);
    if (!(await ctx.confirm(`submit the open of ${tx.owner}'s session with gas from ${payer.address} (it pays gas only; the account stays ${tx.owner})?`)))
      return out({ id, submitted: false }, "not submitted");
    await ctx.sendTx(payer, { to: tx.to, data: tx.data });
    return settle(id, tx.owner);
  }

  const b = await login.begin({ preset: f.preset || "auth-only", apps: f.app !== undefined ? String(f.app).split(",").map((a) => a.trim()).filter(Boolean) : undefined,
    days: f.days !== undefined ? ctx.numFlag(f.days, "--days") : undefined, budgetUsd: f.budget !== undefined ? ctx.numFlag(f.budget, "--budget") : 0,
    owner: f.owner || null, signWithinSec: f["approve-within"] !== undefined ? Math.round(ctx.numFlag(f["approve-within"], "--approve-within") * 60) : 1800,
    switchOwner: !!f["switch-account"] });
  if (json && f["no-wait"]) return jout(b);
  info(`Open this link in a browser you trust, on the frontend you chose (nothing is opened for you; the link holds no secret):\n\n  ${b.link}\n`);
  info(`check code ${b.checkCode}: the page and your wallet must show the same code. Approve only a request you just made.`);
  info(`session factory ${b.factory}${b.owner ? `; account ${b.owner} (vault ${b.vault})` : "; the account is chosen on the page"}; approve before ${new Date(b.signBefore * 1000).toISOString()}`);
  if (f["no-wait"]) return say(`not waiting; later: enclave --independent … login --resume ${b.id}`);
  return settle(b.id);
}
