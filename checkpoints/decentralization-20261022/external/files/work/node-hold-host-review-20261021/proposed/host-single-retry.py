# Remove the host-level hold-write retry: the writer (wallet-admission.mjs COMMIT_RETRY) is the ONLY retry layer.
import sys
for p in sys.argv[1:]:
    s=open(p).read()
    a='''    // Windows refuses the rename while the network agent has the file open (its 1-s read): a sharing refusal is retried
    // briefly (a hold rewritten is the same hold); anything else, or a refusal that persists, is the old retire
    let hold;
    for (let attempt = 0; ; attempt++) {
      try { hold = this.walletChannel.hold(String(id).toLowerCase()); break; }
      catch (e) {
        if (!["EPERM", "EACCES", "EBUSY"].includes(e.code) || attempt >= 9) return { ok: false, why: `the hold could not be written (${e.message})` };
        await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
      }
    }
'''
    b='''    // ONE write: the writer already retried a Windows sharing violation within its own bounded budget
    // (wallet-admission.mjs COMMIT_RETRY, <= 375 ms). Any error left - a persistent refusal included - is the old retire.
    let hold;
    try { hold = this.walletChannel.hold(String(id).toLowerCase()); }
    catch (e) { return { ok: false, why: `the hold could not be written (${e.message})` }; }
'''
    assert s.count(a)==1,p; open(p,'w').write(s.replace(a,b)); print('patched',p)
