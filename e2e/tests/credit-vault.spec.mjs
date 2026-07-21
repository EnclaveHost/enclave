// The credit era, end to end: a passkey user adds credit by card (Stripe stub
// + signed webhook), the relay deposits into their on-chain vault (created on
// first use), and ONE passkey tap signs a vault op that creates + funds a
// deployment the vault owns. The dashboard shows the balance and the row;
// Extend funds more runtime from credit. The virtual authenticator answers
// every WebAuthn ceremony; the P-256 verifier at 0x100 checks them on anvil
// exactly as Base's native precompile does in prod.
import { test, expect } from "@playwright/test";
import { seedStorage, addVirtualAuthenticator, fireStripeWebhook } from "../fixtures/session.mjs";

test("credit: card top-up lands on-chain; one passkey tap deploys from it; dashboard extends it", async ({ page, context }) => {
  await seedStorage(context);
  await addVirtualAuthenticator(context, page);

  // sign up (passkey chain) straight from the checkout gate
  await page.goto("/checkout");
  await page.click("#coSignin");
  await page.click("#authPasskey");
  await expect(page.locator("#coBal")).toContainText("$0.00");

  // $25 by card: stub Stripe bounces back, the signed webhook settles it
  await page.fill("#coAmt", "25");
  await page.click("#coCard");
  await page.waitForURL(/checkout\?order=/);
  const orderId = new URL(page.url()).searchParams.get("order");
  await fireStripeWebhook(orderId);
  await expect(page.locator(".os-head")).toContainText("Credit added", { timeout: 30_000 });

  await page.goto("/checkout");
  await expect(page.locator("#coBal")).toContainText("$25.00");

  // one tap = one signed vault op: create + fund, owned by the vault.
  // (driven through the site's own vault module - the deploy console calls
  // exactly this with its validated spec)
  const out = await page.evaluate(async () => {
    const { vaultOp } = await import("/js/core/vault.js");
    return vaultOp("deploy", {
      spec: { appRef: "ipfs://bafyvaultapp", gpuShare: 0.25, cpuShare: 0.1, appPort: 8080, isPublic: true },
      fundUsd: 5,
    });
  });
  expect(out.deploymentId).toMatch(/^0x[0-9a-f]{64}$/);

  // dashboard: balance card + the vault-owned row, with Extend
  await page.goto("/dashboard");
  await expect(page.locator("#acctBalV")).toContainText("$20.00");
  await expect(page.locator("#acctDeps .acct-row")).toContainText("bafyvaultapp");
  await expect(page.locator("#acctDeps .acct-st")).toContainText("queued");   // no live enclave claims in e2e

  page.on("dialog", (d) => d.accept("3"));
  // dispatchEvent, not click(): headless Chromium freezes frame production on
  // this page (stuck cross-document view transition), so Playwright's
  // rAF-based stability gate never settles - the button itself is visible,
  // uncovered, and fine in real browsers (elementFromPoint probed = self)
  await page.locator("[data-extend]").dispatchEvent("click");
  await expect(page.locator("#acctBalV")).toContainText("$17.00", { timeout: 20_000 });
});

test("credit: a spend beyond the balance is refused with a plain message", async ({ page, context }) => {
  await seedStorage(context);
  await addVirtualAuthenticator(context, page);
  await page.goto("/checkout");
  await page.click("#coSignin");
  await page.click("#authPasskey");
  await expect(page.locator("#coBal")).toContainText("$0.00");   // session settled

  const msg = await page.evaluate(async () => {
    const { vaultOp } = await import("/js/core/vault.js");
    try {
      await vaultOp("deploy", { spec: { appRef: "ipfs://bafybroke", gpuShare: 0.25, cpuShare: 0.1, appPort: 8080, isPublic: true }, fundUsd: 500 });
      return "no error";
    } catch (e) { return e.message; }
  });
  expect(msg).toMatch(/credit/i);
  expect(msg).toMatch(/Add credit/i);
});
