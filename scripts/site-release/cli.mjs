#!/usr/bin/env node
// site-release: build output -> one content-addressed release -> operator targets -> owner-authorized publication.
// Every step is explicit; nothing names a host. See work/site-release-interface.txt and docs/site-release.md.
//
//   prepare  --dist DIR --installers DIR --out DIR (--base DIR | --no-base-i-accept-dropping-old-chunks)
//            [--base-built-at ISO] [--headers FILE] [--commit SHA] [--dirty]
//   fetch    --cid CID --gateway URL[,URL] --out DIR [--as-base]
//   review   DIR          verify   DIR
//   mirror   --release DIR --targets FILE --approve CID
//   activate --release DIR --targets FILE --approve CID --journal DIR
//   rollback --targets FILE --to CID --approve CID --journal DIR
//   resolve  --targets FILE --journal DIR --rollout ID     (after ANY interrupted rollout, from any machine)
//            exit codes for activate/rollback/deliver/resolve: 0 active, 1 reverted (nothing of it in effect),
//            5 pending (an outcome is unknown or an undo did not land: hosts may differ; run resolve)
//   prune    --targets FILE [--keep-hours N]
//   publish-plan --release DIR --publisher-config FILE --deployment ID [--owner ADDR] --out DIR
//   deliver  --release DIR --targets FILE --approve CID [--publish FILE --plan-out DIR]
//            --journal DIR: mirror EVERY target, then a journalled, fenced rollout (each target's activation is its
//            own operation; failures are compensated by fenced undo; a lost answer is resolved, never re-sent), then
//            optionally publish (only when every target is active)
//   publish  --release DIR --publish FILE --approve CID --plan-out DIR
//   agent    --config FILE      (on a target host, as an ssh forced command: SSH_ORIGINAL_COMMAND carries the operation)
import fs from "node:fs";
import { prepareRelease, verifyRelease, reviewRelease, fetchRelease } from "./release.mjs";
import path from "node:path";
import { loadTargets, mirror, prune } from "./targets.mjs";
import { rollout, resolve } from "./rollout.mjs";
import { publicationPlan, loadPublication, publishRelease } from "./publish.mjs";
import { runAgent } from "./agent.mjs";

const BOOL = new Set(["--no-base-i-accept-dropping-old-chunks", "--dirty", "--as-base", "--json"]);
function parse(argv) {
  const f = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (BOOL.has(a)) f[a.slice(2)] = true;
    else if (a.startsWith("--")) { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); f[a.slice(2)] = argv[++i]; }
    else f._.push(a);
  }
  return f;
}
const need = (f, ...keys) => { for (const k of keys) if (!f[k]) throw new Error(`--${k} is required`); };
const say = (x) => process.stdout.write((typeof x === "string" ? x : JSON.stringify(x, null, 2)) + "\n");
/** A rollout's outcome on stdout, and its exit code: 0 active, 1 reverted / not started, 5 pending. */
function report(r) {
  say(r);
  if (r.status === "pending") {
    process.stderr.write(`site-release: rollout ${r.rolloutId} is PENDING: ${r.meaning}.\n  journal: ${r.journal}\n  run: ${r.recovery}\n`);
    process.exitCode = 5;
  } else if (r.status !== "active") {
    process.stderr.write(`site-release: rollout ${r.rolloutId} ${r.status === "not-started" ? "did not start (a target's status was unavailable); nothing was changed"
      : "failed and was reverted: no target serves it as a result of this rollout"} (${r.targets.map((x) => `${x.name}: ${x.state}`).join(", ")})\n`);
    process.exitCode = 1;
  }
}
function approved(f, releaseDir) {
  need(f, "approve");
  const m = verifyRelease(releaseDir);
  if (f.approve !== m.cid) throw new Error(`--approve ${f.approve} is not this release (${m.cid}); review it first`);
  return m;
}

async function main([cmd, ...rest]) {
  const f = parse(rest);
  switch (cmd) {
    case "prepare": {
      need(f, "dist", "installers", "out");
      const r = prepareRelease({ dist: f.dist, installers: f.installers, out: f.out, base: f.base || null, baseBuiltAt: f["base-built-at"] || null,
        noBase: !!f["no-base-i-accept-dropping-old-chunks"], ...(f.headers ? { headers: f.headers } : {}),
        source: { commit: f.commit || null, dirty: f.dirty ? true : f.commit ? false : null } });
      say(reviewRelease(r.dir).text);
      say(`  this run: ${r.dropped.inherited} chunks inherited from the base; dropped as expired: ${r.dropped.chunks.length} chunks, ${r.dropped.cspHashes.length} CSP hashes${r.reused ? " (an identical release already existed)" : ""}`);
      say(`release dir: ${r.dir}`);
      return;
    }
    case "fetch": {
      need(f, "cid", "gateway", "out");
      const r = await fetchRelease({ cid: f.cid, gateways: f.gateway.split(",").map((x) => x.trim()).filter(Boolean), out: f.out, asBase: !!f["as-base"] });
      return say(`fetched ${f.cid} from ${r.gateway} (verified by CID): ${r.dir}`);
    }
    case "review": if (!f._[0]) throw new Error("review DIR"); return say(reviewRelease(f._[0]).text);
    case "verify": { if (!f._[0]) throw new Error("verify DIR"); const m = verifyRelease(f._[0]); return say(`verified ${m.cid}: ${m.counts.files} files, CAR ${m.car.sha256}`); }
    case "mirror": {
      need(f, "release", "targets"); approved(f, f.release);
      const r = await mirror(loadTargets(f.targets), f.release);
      say(r);
      if (!r.ok) throw new Error("not every target holds the release: nothing should be activated");
      return;
    }
    case "activate": {
      need(f, "release", "targets", "journal"); const m = approved(f, f.release);
      return report(await rollout(loadTargets(f.targets), m.cid, { journalDir: f.journal, targetsFile: f.targets }));
    }
    case "rollback": {
      need(f, "targets", "to", "approve", "journal");
      if (f.approve !== f.to) throw new Error("--approve must repeat the CID you roll back to");
      return report(await rollout(loadTargets(f.targets), f.to, { journalDir: f.journal, kind: "rollback", targetsFile: f.targets }));
    }
    case "resolve": {
      need(f, "targets", "journal", "rollout");
      if (!/^[0-9a-f]{32}$/.test(f.rollout)) throw new Error("--rollout is the rollout id from the journal");
      return report(await resolve(loadTargets(f.targets), path.join(f.journal, `${f.rollout}.json`), { targetsFile: f.targets }));
    }
    case "prune": {
      need(f, "targets");
      return say(await Promise.all(loadTargets(f.targets).filter((t) => t.kind === "local-root").map((t) => prune(t, f["keep-hours"] ? { keepHours: Number(f["keep-hours"]) } : {}))));
    }
    case "publish-plan": {
      need(f, "release", "publisher-config", "deployment", "out");
      const r = publicationPlan({ releaseDir: f.release, shown: JSON.parse(fs.readFileSync(f["publisher-config"], "utf8")), deployment: f.deployment,
        owner: f.owner || null, out: f.out });
      say(r.plan);
      return say(`wrote ${r.configFile} and ${r.planFile}; nothing was signed or sent`);
    }
    case "deliver": {
      need(f, "release", "targets", "journal"); const m = approved(f, f.release);
      const targets = loadTargets(f.targets), pub = f.publish ? loadPublication(f.publish) : null;
      if (pub) need(f, "plan-out");
      const mirrored = await mirror(targets, f.release);
      say({ step: "mirror", ...mirrored });
      if (!mirrored.ok) throw new Error("delivery stopped: not every target holds the release, so nothing was activated");
      if (targets.some((t) => t.activate)) {
        const r = await rollout(targets, m.cid, { journalDir: f.journal, targetsFile: f.targets });
        report({ step: "activate", ...r });
        if (r.status !== "active") return;   // nothing is published unless every target serves the release
      }
      if (pub) {
        const p = await publishRelease(pub, f.release, { out: f["plan-out"] });
        say({ step: "publish", ...p });
        if (p.state === "outcome-unknown") { process.exitCode = 4; return; }
        if (p.state === "pending-owner") process.exitCode = 3;
      }
      return;
    }
    case "publish": {
      need(f, "release", "publish", "plan-out"); approved(f, f.release);
      const p = await publishRelease(loadPublication(f.publish), f.release, { out: f["plan-out"] });
      say(p);
      if (p.state === "outcome-unknown") process.exitCode = 4; else if (p.state === "pending-owner") process.exitCode = 3;
      return;
    }
    case "agent": {
      need(f, "config");
      const a = await runAgent({ configFile: f.config, argv: f._ });
      process.stdout.write(JSON.stringify(a) + "\n");
      if (!a.ok) process.exitCode = 1;
      return;
    }
    default:
      throw new Error("usage: site-release prepare|fetch|review|verify|mirror|activate|rollback|prune|deliver|publish|publish-plan|agent (see scripts/site-release/cli.mjs)");
  }
}
main(process.argv.slice(2)).catch((e) => { process.stderr.write(`site-release: ${e.message}\n`); process.exit(1); });
