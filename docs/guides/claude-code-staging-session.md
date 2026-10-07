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

## 1. The agent asks for a session

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

## 5. Ending it

- **The agent signs out:** `enclave session terminate`. The unspent budget comes back immediately.
- **You end it from anywhere** (lost key, deleted environment, changed your mind): enclave.host → **Sessions** → **Terminate**, or **Revoke all sessions**.
- **Expiry:** the session stops working at its expiry. The relay's keeper closes it and returns the unspent budget without you doing anything. If the relay were ever down, you can still end it, or withdraw, straight from your wallet: the vault has no admin and needs no platform cooperation.

## If the session key leaks

Assume it can happen. A leaked key can do exactly what the session allows until it ends, and no more:
- it can spend at most the session budget, never your wallet's funds;
- it can never touch production, secrets or money outside the vault.

Terminate it on the Sessions page as soon as you notice. Every action it took is listed there, with transaction links.
