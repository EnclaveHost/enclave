// Wallet sign-in through the auth modal. With sessions on (every relay this
// suite runs), the wallet signs ONE EIP-712 session grant - not a SIWE message -
// and the relay account token is derived from that session (method "session").
// The SIWE path remains the fallback for a relay without sessions.
import { test, expect } from "@playwright/test";
import { seedStorage, injectWallet, stack } from "../fixtures/session.mjs";

test("wallet sign-in: connect, sign the session grant, a session-derived account session lands", async ({ page, context }) => {
  await seedStorage(context, page);
  await injectWallet(context, stack.payer);

  await page.goto("/index.html");
  await page.click("#walletBtn");
  await expect(page.locator("#walletPick .wp-h")).toHaveText("Sign in to Enclave");
  await page.click("#authWallet");
  // config.js carries a WalletConnect project id, so with the injected wallet
  // there are two transports and the chooser appears: pick the injected entry
  const pick = page.locator("#walletPick");
  await expect(pick.locator(".wp-h")).toHaveText("Choose a wallet");
  await pick.locator(".wp-item", { hasNotText: "WalletConnect" }).first().click();
  // the session chooser takes over the same overlay
  await expect(pick.locator(".wp-h")).toHaveText("Start a session");
  await pick.locator("#smGo").click();
  await expect(page.locator("#walletBtn")).toContainText(new RegExp(stack.payer.slice(0, 6), "i"));
  await expect.poll(() => page.evaluate(() => {
    const s = localStorage.getItem("enclave_account");
    return s ? JSON.parse(s).method : null;
  }), { timeout: 30_000 }).toBe("session");
  const sess = await page.evaluate(() => JSON.parse(localStorage.getItem("enclave_account")));
  expect(sess.accountId).toMatch(/^acct_/);
  // the account really carries the wallet (relay /v1/account/me)
  const me = await page.evaluate(async () => {
    const r = await fetch(localStorage.getItem("enclave_api_base") + "/account/me",
      { headers: { Authorization: "Bearer " + JSON.parse(localStorage.getItem("enclave_account")).token } });
    return r.json();
  });
  expect(me.wallets).toContain(stack.payer.toLowerCase());
});
