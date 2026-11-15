"""Backport of main f814b020a (one hop: the owner's enclaveNetwork.guard may be false) onto the r6 site source, for the
hosted Network tab the live site has (the r6 source has no independent form):

- network/network-policy-core.mjs: guard is a boolean (the validator the tab runs before it asks for a signature and
  on the setting it shows).
- site/js/core/enclave-network.js: the "One hop, no guard" box with what it gives up (offered for ticking only when
  the app's host reports that it knows the setting), the route line of a guardless circuit, the privacy sentence.

python3 -I backport.py SOURCE_ENCLAVE_DIR

The texts are main's. No style sheet changes: the box uses classes the tab already has. Each anchor must match
exactly once.
"""
import sys

FILES = {
'network/network-policy-core.mjs': [
    ("  if(!keys(n,['routes','guard','maxPricePerGiB6','budget6'])||![1,2].includes(n.routes)||n.guard!==true||!amount(n.maxPricePerGiB6)||!amount(n.budget6)||\n",
     "  // guard:false is the owner's permission for one hop: one provider may be a whole circuit, where the host's operator\n  // allows it too (docs/design/enclave-network.md, One hop). A validator from before it refuses the policy.\n  if(!keys(n,['routes','guard','maxPricePerGiB6','budget6'])||![1,2].includes(n.routes)||typeof n.guard!=='boolean'||!amount(n.maxPricePerGiB6)||!amount(n.budget6)||\n"),
],
'site/js/core/enclave-network.js': [
    ('};\n\nexport async function renderEnclaveNetwork(box,id,{viaVault=false,owner=null}={}){\n',
     '};\n\n// One hop (docs/design/enclave-network.md, "One hop"): the owner\'s enclaveNetwork.guard:false. It permits a host whose\n// operator allows it to build this app\'s routes through one provider with no guard; nothing else changes in what is signed.\n// hostAllows: true/false as the app\'s current host reports it (status.host.oneHop); null when the host has not said\n// (no report, or a host from before this setting, which refuses a policy that carries it: the app would have no network\n// there), so the box cannot then be newly ticked; left out where there is no host report to go by (independent mode).\nexport const ONE_HOP_PRIVACY="With one hop, a single provider carries the whole route: it sees the host\'s IP address together with this app\'s visitors and destinations. Your TLS key still stays inside the enclave.";\nexport function oneHopControl({checked=false,hostAllows}={}){\n  const unknown=hostAllows===null,note=hostAllows===true?"This app\'s host allows it."\n    :hostAllows===false?"This app\'s host does not allow it: routes keep their guard there until its operator opts in for this app."\n    :unknown?"This app\'s host has not reported that it knows this setting. A host that does not know it refuses the whole network setting, and the app is unreachable there."\n    :"A host or directory that does not know this setting refuses the whole network setting, and the app is unreachable on such a host.";\n  return `<label class="en-opt"><input type="checkbox" name="oneHop"${checked?" checked":""}${unknown&&!checked?" disabled":""}> <b>One hop, no guard</b>`\n    +`<span class="en-sub warn">Shorter path, less private. ${esc(ONE_HOP_PRIVACY)}</span>`\n    +`<span class="en-sub">Used only on a host whose operator allows it for this app; anywhere else routes keep their guard. ${esc(note)}</span></label>`;\n}\n// the owner\'s enclaveNetwork block from the form\'s values\nexport function enclaveNetworkChoice({routes,oneHop,price,budget}){\n  const p=toU6(price),b=toU6(budget);if((p>0)!==(b>0))throw new Error("A price limit needs a budget, and a budget needs a price limit.");\n  return {routes:Number(routes),guard:!oneHop,maxPricePerGiB6:p,budget6:b};\n}\n// one circuit of the host\'s report, as a line of the status list (escaped)\nexport function circuitLine(c){\n  const where=c.kind==="byo"?"Your WireGuard peer":c.kind==="host"?"The host\'s own connection"\n    :c.kind==="network"&&!c.guard&&c.exit?`Route: one hop through ${esc(c.exit.region||"")} ${esc(c.exit.address||"")} (no guard: this provider sees the host)`\n    :`Route: guard ${esc(c.guard?.region||"")} → exit ${esc(c.exit?.region||"")} ${esc(c.exit?.address||"")}`;\n  return `${where}${c.standby?" · standing by":""} — ${c.healthy?"healthy":\'<span class="warn">checking</span>\'}${c.ingress?" · website":""}${c.egress?" · outbound":""}`;\n}\n\nexport async function renderEnclaveNetwork(box,id,{viaVault=false,owner=null}={}){\n'),
    ('    for(const c of host.circuits||[])lines.push(`<span class="en-sub">${c.kind==="byo"?"Your WireGuard peer":c.kind==="host"?"The host\'s own connection":`Route: guard ${esc(c.guard?.region||"")} → exit ${esc(c.exit?.region||"")} ${esc(c.exit?.address||"")}`} — ${c.healthy?"healthy":\'<span class="warn">checking</span>\'}${c.ingress?" · website":""}${c.egress?" · outbound":""}</span>`);\n',
     '    for(const c of host.circuits||[])lines.push(`<span class="en-sub">${circuitLine(c)}</span>`);\n'),
    ('  wrap.innerHTML=`<div class="en-list">${lines.map(l=>`<div>${l}</div>`).join("")}</div><p class="en-intro">${esc(PRIVACY[policy.mode])}</p>`;\n',
     '  wrap.innerHTML=`<div class="en-list">${lines.map(l=>`<div>${l}</div>`).join("")}</div><p class="en-intro">${esc(PRIVACY[policy.mode])}${policy.enclaveNetwork?.guard===false?` <b>${esc(ONE_HOP_PRIVACY)}</b>`:""}</p>`;\n'),
    ('     <span class="en-sub">0 uses only free providers (all current providers are free). A paid provider needs a price limit and a budget, settled from the app\'s USDC balance; your VPN provider (BYO) is paid by you directly.</span></div>\n',
     '     <span class="en-sub">0 uses only free providers (all current providers are free). A paid provider needs a price limit and a budget, settled from the app\'s USDC balance; your VPN provider (BYO) is paid by you directly.</span>\n     ${oneHopControl({checked:policy.enclaveNetwork?.guard===false,hostAllows:typeof host?.oneHop==="boolean"?host.oneHop:null})}</div>\n'),
    ('      if(needsNetwork){const p=toU6(f.price.value),b=toU6(f.budget.value);if((p>0)!==(b>0))throw new Error("A price limit needs a budget, and a budget needs a price limit.");\n        next.enclaveNetwork={routes:Number(f.routes.value),guard:true,maxPricePerGiB6:p,budget6:b};}\n',
     '      if(needsNetwork)next.enclaveNetwork=enclaveNetworkChoice({routes:f.routes.value,oneHop:f.oneHop.checked,price:f.price.value,budget:f.budget.value});\n'),
],
}

def patch(root):
    for name, patches in FILES.items():
        path = root.rstrip('/') + '/' + name
        s = open(path, encoding='utf-8').read()
        for old, _ in patches:
            if s.count(old) != 1:
                raise SystemExit('anchor not found exactly once in %s: %r' % (name, old[:70]))
        for old, new in patches:
            s = s.replace(old, new)
        open(path, 'w', encoding='utf-8').write(s)

if __name__ == '__main__':
    patch(sys.argv[1])
