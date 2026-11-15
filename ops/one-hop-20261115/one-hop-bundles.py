#!/usr/bin/env python3
"""How the one-hop bundles for the edges and the control VM were made (main f814b020a carried onto installed files).

Each target is the installed file, identified by SHA-256, with a fixed list of replacements. Every anchor must occur
exactly once in the installed text or nothing is written. Everything else is the installed file byte for byte.

  one-hop-bundles.py <installed dir> <output dir>
"""
import hashlib, pathlib, sys

REFUSAL = "the owner's policy requires a guard: this request came from the host directly"

# provider, three edges (minified build)
PROVIDER_MIN = [
 # network-policy-core.mjs: guard:false is the owner's permission for one hop
 ('||o.guard!==!0||!Cm(', '||typeof o.guard!="boolean"||!Cm('),
 # provider.mjs: constructor takes providerAddresses
 ('targets:f=async()=>[],store:p=null,now:d=Date.now,log:m=()=>{}}){Object.assign(this,{config:t,signer:r,kernel:o,leases:n,hosts:s,verifyOwner:i,policyMemory:a,currentPolicy:c,domains:u,targets:f,store:p,now:d,log:m})',
  'targets:f=async()=>[],providerAddresses:oh1=null,store:p=null,now:d=Date.now,log:m=()=>{}}){Object.assign(this,{config:t,signer:r,kernel:o,leases:n,hosts:s,verifyOwner:i,policyMemory:a,currentPolicy:c,domains:u,targets:f,providerAddresses:oh1,store:p,now:d,log:m})'),
 # provider.mjs: direct(from), and handle() learns where the request came from
 ('async handle(t){let r=this.now();',
  'async direct(t){let r=typeof t=="string"?t.replace(/^::ffff:/i,""):"";if(!uv.isIP(r)||/^127\\.|^::1$/.test(r)||r===this.config.publicAddress||!this.providerAddresses)return null;let o=null;try{o=await this.providerAddresses()}catch(n){this.log("provider addresses: "+n.message)}return o?.size?!o.has(r):null}'
  'async handle(t,{from:oh2=null}={}){let r=this.now();'),
 # provider.mjs: a host without a guard in front only where the owner signed guard:false
 ('throw new Error("provider price is above the policy\'s limit");',
  'throw new Error("provider price is above the policy\'s limit");let oh3=o.role==="exit"?await this.direct(oh2):null;if(oh3&&c.enclaveNetwork?.guard!==!1)throw new Error("' + REFUSAL + '");'),
 ('policyNonce:a.nonce,paidNonce:f}),this.peers.set(d.key,d)',
  'policyNonce:a.nonce,paidNonce:f,...o.role==="exit"?{direct:oh3===!0}:{}}),this.peers.set(d.key,d)'),
 ('exit:[...this.peers.values()].filter(t=>t.role==="exit").length}}}',
  'exit:[...this.peers.values()].filter(t=>t.role==="exit").length,direct:[...this.peers.values()].filter(t=>t.direct===!0).length}}}'),
 # control.mjs: the request's source address
 ('m==="peer"?await e.handle(w):', 'm==="peer"?await e.handle(w,{from:p.socket.remoteAddress||null}):'),
 # main.mjs: the listed providers' addresses
 ('gp={at:0,list:[]},Dv=async()=>', 'gp={at:0,list:[],all:null},Dv=async()=>'),
 ('.map(r=>({address:r.address,ports:r.ports}))}}catch(e){Me("provider directory: "+e.message)}return gp.list}',
  '.map(r=>({address:r.address,ports:r.ports})),all:new Set(t.filter(r=>r.providerId!==ci).map(r=>r.address))}}catch(e){Me("provider directory: "+e.message)}return gp.list}'),
 ('domains:_v,targets:Dv,hosts:Ap,', 'domains:_v,targets:Dv,providerAddresses:async()=>(await Dv(),gp.all),hosts:Ap,'),
]

# provider, ca-east (unminified build with host services)
PROVIDER_HS = [
 ('![1, 2].includes(n.routes) || n.guard !== true || !amount(n.maxPricePerGiB6)',
  '![1, 2].includes(n.routes) || typeof n.guard !== "boolean" || !amount(n.maxPricePerGiB6)'),
 ('domains: domains2, targets: targets2 = async () => [], store: store2 = null, now = Date.now, log: log2 = () => {',
  'domains: domains2, targets: targets2 = async () => [], providerAddresses = null, store: store2 = null, now = Date.now, log: log2 = () => {'),
 ('currentPolicy, domains: domains2, targets: targets2, store: store2, now, log: log2 });',
  'currentPolicy, domains: domains2, targets: targets2, providerAddresses, store: store2, now, log: log2 });'),
 ('  async handle(envelope) {\n    const now = this.now();\n',
  '  async direct(from) {\n'
  '    const a = typeof from === "string" ? from.replace(/^::ffff:/i, "") : "";\n'
  '    if (!net2.isIP(a) || /^127\\.|^::1$/.test(a) || a === this.config.publicAddress || !this.providerAddresses) return null;\n'
  '    let all = null;\n'
  '    try {\n      all = await this.providerAddresses();\n    } catch (e) {\n      this.log("provider addresses: " + e.message);\n    }\n'
  '    return all?.size ? !all.has(a) : null;\n'
  '  }\n'
  '  async handle(envelope, { from = null } = {}) {\n    const now = this.now();\n'),
 ('throw new Error("provider price is above the policy\'s limit");\n',
  'throw new Error("provider price is above the policy\'s limit");\n'
  '    const direct = r.role === "exit" ? await this.direct(from) : null;\n'
  '    if (direct && use.enclaveNetwork?.guard !== false) throw new Error("' + REFUSAL + '");\n'),
 ('policyNonce: policy.nonce, paidNonce });', 'policyNonce: policy.nonce, paidNonce, ...r.role === "exit" ? { direct: direct === true } : {} });'),
 ('      exit: [...this.peers.values()].filter((p) => p.role === "exit").length,\n',
  '      exit: [...this.peers.values()].filter((p) => p.role === "exit").length,\n'
  '      direct: [...this.peers.values()].filter((p) => p.direct === true).length,\n'),
 ('route === "peer" ? await provider2.handle(body) :', 'route === "peer" ? await provider2.handle(body, { from: req.socket.remoteAddress || null }) :'),
 ('var targetCache = { at: 0, list: [] };', 'var targetCache = { at: 0, list: [], all: null };'),
 ('.map((p) => ({ address: p.address, ports: p.ports })) };',
  '.map((p) => ({ address: p.address, ports: p.ports })), all: new Set(ok.filter((p) => p.providerId !== providerId).map((p) => p.address)) };'),
 ('  domains,\n  targets,\n  hosts,\n', '  domains,\n  targets,\n  providerAddresses: async () => {\n    await targets();\n    return targetCache.all;\n  },\n  hosts,\n'),
]

# public directory, four edges (minified): the policy rule alone
DIRECTORY = [('||o.guard!==!0||!tp(', '||typeof o.guard!="boolean"||!tp(')]

# relay network bundle on the control VM (unminified): the policy rule alone
RELAY = [('![1, 2].includes(n.routes) || n.guard !== true || !amount(n.maxPricePerGiB6)',
          '![1, 2].includes(n.routes) || typeof n.guard !== "boolean" || !amount(n.maxPricePerGiB6)')]

TARGETS = [
 ('provider-464cad3.mjs', '464cad341e4a816a', 'provider.mjs', PROVIDER_MIN),
 ('provider-39d1513b.mjs', '39d1513b8a884317', 'wg-provider.mjs', PROVIDER_HS),
 ('directory-37366ab.mjs', '37366abb5a33725c', 'enclave-directory.mjs', DIRECTORY),
 ('relay-network-runtime-55544ec1.mjs', '55544ec1c9fd2576', 'network-runtime.bundle.mjs', RELAY),
 # control VM, the two transitional mirrors (unminified, the same policy rule): the bridge that copies owner policies from
 # the relay to the public directories, and the mirror that pulls public route publications back for the legacy API
 ('bridge-mirror-a219f492.mjs', 'a219f4920444fbfe', 'mirror.mjs', RELAY),
 ('route-pull-mirror-934b511e.mjs', '934b511e173a8afa', 'mirror-public-providers.mjs', RELAY),
]

def main(src, out):
    src, out = pathlib.Path(src), pathlib.Path(out)
    for name, prefix, installed_as, edits in TARGETS:
        raw = (src / name).read_bytes()
        before = hashlib.sha256(raw).hexdigest()
        if not before.startswith(prefix):
            sys.exit(f'{name}: not the installed file ({before[:16]})')
        text = raw.decode('utf-8')
        for anchor, replacement in edits:
            if text.count(anchor) != 1:
                sys.exit(f'{name}: anchor occurs {text.count(anchor)} times: {anchor[:60]!r}')
            text = text.replace(anchor, replacement)
        data = text.encode('utf-8')
        after = hashlib.sha256(data).hexdigest()
        target = out / after[:8] / installed_as
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        print(f'{name}\t{len(raw)}\t{before}\t->\t{after[:8]}/{installed_as}\t{len(data)}\t{after}\t{len(edits)} replacements')

if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
