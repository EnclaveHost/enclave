# Give Claude Code a staging session

A session lets an agent such as Claude Code publish and test **staging** versions of your app without ever holding your wallet key. You approve it once with your wallet. After that the agent signs its own actions with a session key that can only do what you allowed, can only spend the budget you gave it, and stops working when it expires.

What the `staging-publish` preset allows:

| The agent can | The agent can never |
|---|---|
| publish new versions of the apps you name | touch production: it can't change what a prod deployment runs |
| create staging deployments and point them at new versions | read or set secrets |
| fund, suspend and resume those staging deployments | withdraw money, top itself up, or extend itself |
| upload bundles, read status and logs, restart | open, change or revoke other sessions |

Its spending is capped twice: by the session's budget, which you escrow when you approve it, and by a daily limit. Whatever it doesn't spend comes back to your wallet when the session ends.

A staging session never reaches the apps your wallet owns, even after you let your sessions manage them (step 5). To let an agent stop, resume or fund production, give it a separate session (step 6).

## 1. The agent asks for a session

Sessions need the Enclave CLI cli-v1.3.0 or later. To install or update it, run `curl -fsSL https://get.enclave.host | sh`.

In the agent's terminal (or ask Claude Code to run it):

```
enclave session new --preset staging-publish --app myapp-staging --budget 10 --days 7 --label "Claude Code"
```

It prints:
- a summary of what the session would allow;
- a **check code** such as `3F9A-0C1E`;
- a link like `https://enclave.host/grant#…`.

Then it waits for you.

Notes:
- `--app` names the app or apps the agent may publish to. Publishing goes to an app held by your session vault, so use a dedicated staging app (`myapp-staging`). Your production app stays wallet-published, and production releases stay yours (step 4).
- The budget and the days are optional. Defaults are $10 and 7 days; the most a staging-publish session can last is 28 days.

## 2. You approve it in the browser

Open the link. The page shows the request in plain language, any warnings, and the check code.

**Compare the check code with the one the terminal printed.** Your wallet shows the same characters as the start of `sessionKey`. If they differ, close the page: someone swapped the key.

Click **Approve with wallet**.
- With a budget you sign twice: the session itself, then the USDC it escrows.
- Without a budget you sign once.

The relay submits both, so you need no ETH.

The terminal notices within a few seconds, stores the session key (`~/.config/enclave/sessions/`, readable only by you), and makes it the active session.

### Agents that keep secrets in environment variables

Add `--env` to `session new`. Instead of writing a file, it prints:

```
export ENCLAVE_SESSION=…
```

Put that value in the agent's secret store. Never commit it: it is a key. Anyone who has it can act within the session's limits until the session ends.

## 3. The agent works

With a session active, the usual commands act through it, with no wallet prompts:

```
enclave publish …           # a new version of myapp-staging
enclave deploy … --env staging
enclave upgrade <id> <ref>  # re-point a STAGING deployment
enclave session status      # budget, spend, time left
```

When the agent hits a limit, the command says which one and what to do. For example, when the budget runs out:

```
enclave session top-up-link --amount 5
```

That prints a link; you open it and approve the top-up with your wallet.

## 4. You promote to production

The agent can't promote anything to production; that is always your wallet's decision.
- **Production app published by your wallet:** publish the tested CID and config under it as usual, then point the production deployment at it.
- **Production deployment held by your session vault:** use **Promote** on the Sessions page. Your wallet shows the exact version label you are promoting. Production secrets are released only for the version and config you promoted.

No session can change the version or config of an app your wallet owns, with or without step 5.

## 5. Let your sessions manage the apps your wallet owns (one-time, optional)

Since 2026-10-07, sessions can also act on the apps your **wallet** owns (the ones you deployed from your wallet, not through a session). You allow it once, for your session vault, with one wallet transaction to the deployments ledger (it needs a little ETH on Base for gas):

- enclave.host → **Sessions** → **Apps your wallet owns** → **Grant**; or
- `enclave session delegate`, run by you with your wallet key, not by the agent.

`enclave session delegate --status` shows whether it is granted.

What it changes:
- To a session, every app your wallet owns is **production**. Only sessions whose grant includes production reach them. The `staging-publish` session above doesn't, so the grant changes nothing for it.
- A session that does include production may, within its own actions: suspend and resume, resize, add runtime out of its budget (credited to your wallet), lower the price cap, and cancel (the refund goes to your wallet). It can add runtime to a paid app only if the session names that app and the app's fee is under the session's fee ceiling.
- It can never change what an app runs (version or config), raise its price cap, move it out of your wallet, or touch its secrets.

To take it back: **Revoke** on the same card, or `enclave session delegate --revoke`. One wallet transaction cuts every session off your wallet's apps at once. The sessions themselves keep running, with their budgets and anything in your vault.

## 6. Optional: let an agent stop, resume and fund production

Keep the staging session as it is and give the agent a **second** session for production operations. Its grant should have:
- the environment `prod`;
- only the actions it needs: `deploy.setActive` (stop and resume), `deploy.fund` (top up) and `api.status`. The `staging-publish` actions with `prod` added fit: they include those two and leave out `deploy.refund` (cancel) and `deploy.setShares` (resize). They also let the agent create production deployments of its named apps in your vault; those get no production secrets until you Promote them;
- a price ceiling at least as high as the price cap of the apps it should fund. `staging-publish` allows $5/hour; funding an app whose cap is higher is refused;
- for paid apps it should fund: each named by app id (`0x…`), and a publisher-fee ceiling above their fee. The `staging-publish` fee ceiling is $0, so with it the agent can fund only free apps;
- a small budget and a short expiry, a day or two.

Then do step 5 if you haven't.

How the agent asks for it:
- **MCP:** `session_request` with `preset: "staging-publish"` and `environments: ["staging", "prod"]`. It returns a grant link for you to open, exactly as in step 2. See the MCP tab at enclave.host/develop. Without a `preset`, `session_request` uses `agent`: the full browser policy (every deployment action, any free app, staging and production, signing in to your account) with a $20 budget for 7 days. That is far more than stop, resume and fund.
- **CLI:** `enclave session new --preset staging-publish` never includes production. The `browser` preset does, but it is the full sign-in policy (every deployment action, any app, signing in to your account as you), so don't give it to an agent.

Before you approve, read the grant page. It warns when a session covers production. Check:
- **It reaches every app your wallet owns.** The apps list limits only which paid apps it can fund. A production session that can stop one of your apps can stop all of them.
- **It can't change what production runs**, read secrets, or spend beyond its budget. The worst a leaked key can do is stop your apps (or cancel or resize them, if the grant allows) and spend its budget on them, until you cut it off.
- **Two ways to cut it off**: **Terminate** that session on the Sessions page, or **Revoke** the delegation (step 5) to cut off every session at once.

## 7. Ending it

- **The agent signs out:** `enclave session terminate`. The unspent budget comes back immediately.
- **You end it from anywhere** (lost key, deleted environment, changed your mind): enclave.host → **Sessions** → **Terminate**, or **Revoke all sessions**. Revoke all leaves the step 5 delegation in place for future sessions; revoke that separately if you want it gone too.
- **Expiry:** the session stops working at its expiry. The relay's keeper closes it and returns the unspent budget without you doing anything. If the relay were ever down, you can still end it, or withdraw, straight from your wallet: the vault has no admin and needs no platform cooperation.

Ending a session never stops what is already running. Deployments keep their own balance on the ledger.

## If the session key leaks

Assume it can happen. A leaked key can do exactly what the session allows until it ends, and no more:
- it can spend at most the session budget, never your wallet's funds;
- a staging session can never touch production, secrets or money outside the vault;
- a production session (step 6) can also stop the apps your wallet owns (and cancel, resize or re-price them, if its actions allow) until it ends or you revoke the delegation. It still can't change what they run or reach their secrets.

Terminate it on the Sessions page as soon as you notice. Every action it took is listed there, with transaction links.
