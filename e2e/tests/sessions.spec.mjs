// Sessions in the browser end to end (docs/design/sessions.md §9): sign in opens
// a session with one signature, the header shows its budget and time, a wallet
// top-up is one more signature, /sessions lists it as "this browser", and
// signing out ends it on-chain (budget back to the wallet) and revokes the
// session-derived account token in the same flow.
import { test, expect } from "@playwright/test";
import { seedStorage, injectWallet, stack } from "../fixtures/session.mjs";

const SECONDARY = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";   // anvil account 4: unused elsewhere (3 is the sessions relayer)
async function signIn(page, context, address){
  await seedStorage(context, page);
  await injectWallet(context, address);
  await page.goto("/index.html");
  await page.click("#walletBtn");
  await page.click("#authWallet");
  const pick = page.locator("#walletPick");
  await expect(pick.locator(".wp-h")).toHaveText("Choose a wallet");
  await pick.locator(".wp-item", { hasNotText: "WalletConnect" }).first().click();
  await expect(pick.locator(".wp-h")).toHaveText("Start a session");
  await pick.locator("#smHours").selectOption("1");
  await pick.locator("#smGo").click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("enclave_wallet_session")), { timeout: 30_000 }).toMatch(/^0x[0-9a-f]{64}$/);
}

test("sign in -> indicator -> top up -> /sessions -> sign out refunds and revokes", async ({ page, context }) => {
  await signIn(page, context, stack.payer);
  // the persistent indicator: budget and time left on the wallet button
  await expect(page.locator("#wbSess")).toContainText("$0.00", { timeout: 15_000 });
  await expect(page.locator("#wbSess")).toContainText(/\d+m|1h/);

  // the popover: no per-host "Host login" any more - its deployment counts load through the session, which
  // signs the list read (EnclaveSession v1) and the relay verifies it (api.status) - no wallet prompt
  const listRead = page.waitForRequest((r) => /\/v1\/deployments\?owner=/i.test(r.url())
    && /^EnclaveSession v1 /.test(r.headers()["authorization"] || ""), { timeout: 20_000 });
  await page.click("#walletBtn");
  const signedList = await listRead;
  expect((await signedList.response()).status()).toBe(200);
  await expect(page.locator("#wpBal")).toContainText("Deployments", { timeout: 15_000 });
  await expect(page.locator("#walletPop")).not.toContainText("Host login");

  // top up from the popover: one USDC authorization signature, relayed gas-free
  await expect(page.locator("#wpSess")).toContainText("left", { timeout: 15_000 });
  await page.click("#wpSessTop");
  await page.fill("#tuAmt", "3");
  await page.click("#tuGo");
  await expect(page.locator("#wbSess")).toContainText("$3.00", { timeout: 30_000 });

  // /sessions: this browser's session, live, with its budget
  await page.goto("/sessions.html");
  const card = page.locator(".ss-card[data-sid]").first();
  await expect(card).toContainText("this browser", { timeout: 20_000 });
  await expect(card).toContainText("live");
  await expect(card).toContainText("$3.00 left");
  // the ledger delegation card: the rig runs main's rev 16 ledger, which has no setDelegate, so it is read
  // off the code as unsupported (and no Grant is offered)
  await expect(page.locator("#ssWallet")).toContainText("not supported by this ledger");
  await expect(page.locator("#ssDelegGrant")).toHaveCount(0);
  const sid = await page.evaluate(() => localStorage.getItem("enclave_wallet_session"));
  const token = await page.evaluate(() => JSON.parse(localStorage.getItem("enclave_account")).token);

  // sign out: the session key ends its own session; the account token dies with it
  await page.click("#walletBtn");
  await page.click("#wpDisc");
  await expect.poll(async () => {
    const r = await fetch(`${stack.relay}/v1/sessions/owner/${stack.payer}`);
    const j = await r.json();
    const s = (j.sessions || []).find((x) => x.sid === sid);
    return s ? Boolean(s.ended) : null;
  }, { timeout: 30_000 }).toBe(true);
  const me = await fetch(`${stack.relay}/v1/account/me`, { headers: { Authorization: "Bearer " + token } });
  expect(me.status).toBe(401);
});

test("a grant link from an agent is reviewed and approved in the browser", async ({ page, context }) => {
  // what `enclave session new` does, minus the CLI: make a key + a staging-publish grant request
  const sdk = await import("../../sdk/sessions/dist/node.mjs");
  const store = new sdk.MemoryStore();
  const { signer } = await sdk.newSessionKey(store, { relay: stack.relay, chainId: 8453, label: "E2E agent", extractable: true });
  const grant = sdk.buildGrant({ sessionKey: signer.keyHash, label: "E2E agent", preset: "staging-publish",
    policy: { apps: ["e2e-staging"], budget: 0n } });
  const frag = sdk.encodeGrantRequest({ v: 1, chainId: 8453, relay: stack.relay, x: signer.x.toString(), y: signer.y.toString(), grant });

  await seedStorage(context, page);
  await injectWallet(context, SECONDARY);
  await page.goto("/grant.html#" + frag);
  await expect(page.locator("#grBody")).toContainText("E2E agent");
  await expect(page.locator("#grBody")).toContainText(sdk.checkCode(signer.keyHash));
  await expect(page.locator("#grBody")).toContainText("STAGING");
  await page.click("#grConnect");
  const pick = page.locator("#walletPick");
  await expect(pick.locator(".wp-h")).toHaveText("Choose a wallet");
  await pick.locator(".wp-item", { hasNotText: "WalletConnect" }).first().click();
  await page.click("#grGo");
  await expect(page.locator("#grAct")).toContainText("Session approved", { timeout: 30_000 });
  // the agent's side: the relay index finds it by key
  await expect.poll(async () => {
    const r = await fetch(`${stack.relay}/v1/sessions/by-key/${signer.keyHash}`);
    return ((await r.json()).sessions || []).length;
  }, { timeout: 30_000 }).toBe(1);

  // a TAMPERED link (key swapped) is refused before any wallet prompt
  const other = await sdk.newSessionKey(store, { relay: stack.relay, chainId: 8453, label: "x", extractable: true });
  const bad = sdk.encodeGrantRequest({ v: 1, chainId: 8453, relay: stack.relay, x: other.signer.x.toString(), y: other.signer.y.toString(), grant });
  await page.goto("/grant.html#" + bad);
  await expect(page.locator("#grBody")).toContainText("inconsistent");
});
