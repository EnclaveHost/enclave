#!/usr/bin/env node
// Harness helper for test-m2.sh: from one report a live domain produced, fetch that chip's VCEK from AMD
// KDS ONCE (KDS answers 429 after a couple of requests), and write the two TEST minimum-TCB policies the
// trusted checks use.
//
// The policies are NOT a recommended floor and nothing here claims the firmware is acceptable:
//   min-tcb.json        the box's own reported TCB     -> must pass (equal meets the floor)
//   min-tcb-above.json  the same with SNP one higher   -> must fail (proves the floor is enforced)
// An operator's real floor comes from AMD's security bulletins and is theirs to supply.
//
// The VCEK is fetched, not trusted: the verifier still requires it to sign the report, chain to AMD's
// pinned root and name this chip and TCB.
//
// usage: node vcek-prep.mjs <doc.json saved by client --save> <outdir>
//   writes <outdir>/vcek.der, min-tcb.json, min-tcb-above.json; prints "product <P>" and "kds <url>"
import fs from 'node:fs';
import path from 'node:path';
import { parseSnpReport, snpProductHint, kdsVcekUrl, decodeTcb } from '../../relay/snp-verify.mjs';

const [docPath, outdir] = process.argv.slice(2);
const g = JSON.parse(fs.readFileSync(docPath, 'utf8'));
const p = parseSnpReport(Buffer.from(g.doc.report, 'base64'));
const product = snpProductHint(p);
if (!product) { console.error('vcek-prep: the report names no product line'); process.exit(1); }
const own = decodeTcb(product, p.reportedTcb);
fs.writeFileSync(path.join(outdir, 'min-tcb.json'), JSON.stringify({ [product]: own }));
fs.writeFileSync(path.join(outdir, 'min-tcb-above.json'), JSON.stringify({ [product]: { ...own, snp: own.snp + 1 } }));
const url = kdsVcekUrl(product, p);
console.log(`product ${product}`);
console.log(`kds ${url}`);
console.log(`test-floor ${JSON.stringify(own)}`);

const out = path.join(outdir, 'vcek.der');
if (fs.existsSync(out)) { console.log('vcek already held'); process.exit(0); }
for (let attempt = 1; attempt <= 6; attempt++) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) }).catch((e) => ({ status: 0, error: e }));
  if (r.status === 200) {
    fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()));
    console.log(`vcek fetched (attempt ${attempt})`);
    process.exit(0);
  }
  const wait = Math.min(Number(r.headers?.get?.('retry-after')) || 10, 30);
  console.log(`kds answered ${r.status || r.error?.message} (attempt ${attempt}); retrying in ${wait}s`);
  await new Promise((res) => setTimeout(res, wait * 1000));
}
console.error('vcek-prep: no VCEK from KDS');
process.exit(1);
