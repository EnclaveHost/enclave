// The app's Network tab (docs/design/enclave-network.md): how this app reaches the internet, whether its website and
// outbound traffic are working right now, what each choice exposes, and the owner-signed setting that changes it.
// Every change is a v5 network policy signed by the app owner (wallet, or the passkey vault's ERC-1271 signature);
// a BYO WireGuard config is checked here, sent only to the relay (which seals it) and never shown back in full.
import {Enclave} from "./api.js";
import {personalSign} from "./wallet.js";
import {eip191Hash} from "./eip191.js";
import {validateNetworkPolicy,networkPolicyMessage,networkUse,byoConfigMessage,byoOwnerMessage} from "../../../network/network-policy-core.mjs";
import {parseWireGuardConfig,wireGuardConfigDigest} from "../../../network/wg-config.mjs";

const relayBase=()=>(Enclave.base||"").replace(/\/v1\/?$/,"");
async function relay(path,init){
  const r=await fetch(relayBase()+path,{...init,headers:{"content-type":"application/json",...(init?.headers||{})}});
  const b=await r.json().catch(()=>({}));
  if(!r.ok)throw Object.assign(new Error(b.error||b.message||("HTTP "+r.status)),{problems:b.problems});
  return b;
}
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const hex=bytes=>"0x"+[...bytes].map(b=>b.toString(16).padStart(2,"0")).join("");
const usdc=n=>(Number(n)/1e6).toFixed(6).replace(/\.?0+$/,"")||"0";
const toU6=v=>{if(!/^(0|[1-9]\d{0,8})(\.\d{1,6})?$/.test(String(v).trim()))throw new Error("Enter a USDC amount like 0.05");const [a,b=""]=String(v).trim().split(".");return Number(a)*1e6+Number(b.padEnd(6,"0"));};
// The owner's signature on a message: the connected wallet, or the passkey vault's ERC-1271 signature
async function ownerSign(message,{viaVault}){
  if(!viaVault)return personalSign(message);
  const vault=await Enclave.billingVault();
  const digest=eip191Hash(message),bytes=new Uint8Array(digest.slice(2).match(/../g).map(h=>parseInt(h,16)));
  const challenge=btoa(String.fromCharCode(...bytes)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
  const {startAuthentication}=await import("/vendor/webauthn.js");
  const asr=await startAuthentication({optionsJSON:{challenge,allowCredentials:[{id:vault.credId,type:"public-key"}],userVerification:"preferred",timeout:120000}});
  const out=await Enclave.vaultExec({op:"sign",assertion:{credId:asr.id,authenticatorData:asr.response.authenticatorData,clientDataJSON:asr.response.clientDataJSON,signature:asr.response.signature}});
  return out.signature;
}

const MODE_TEXT={
  "enclave-network":{title:"Enclave network",sub:"Public HTTPS and outbound traffic through Enclave-network providers, two independent routes, each behind a guard hop."},
  "byo-wireguard":{title:"Bring your own WireGuard",sub:"Outbound traffic through your own VPN. Public HTTPS separately, through the Enclave network, or not at all."},
  "direct":{title:"Direct hosting",sub:"The host's own connection: the shortest path, and the host's public IP is visible to everyone."},
};
const PRIVACY={
  "enclave-network":"The host's IP stays hidden: the guard sees it but only encrypted traffic; the exit provider sees visitors and destinations but never the host. Your TLS key stays inside the enclave; providers only pass encrypted bytes. Qualification checks cannot prove a provider keeps no logs, and the current providers are all operated by Enclave on DigitalOcean, so separate addresses are not separate operators.",
  "byo-wireguard":"Your VPN provider sees the host's IP and where the app connects: there is no guard hop and no multi-hop privacy. The host running your app holds the WireGuard key while the app runs, so use a peer made for this app only, and do not use it anywhere else at the same time. A WireGuard VPN does not forward public ports: a website still needs Enclave-network ingress.",
  "direct":"Every visitor and every destination sees the host's public IP address. TLS still ends inside the enclave. Only hosts that opted in and passed qualification can serve direct apps.",
};

export async function renderEnclaveNetwork(box,id,{viaVault=false,owner=null}={}){
  id=id.toLowerCase();
  const wrap=document.createElement("div");wrap.className="enc-net-body";box.append(wrap);
  let status;
  try{status=await relay("/v1/network/status/"+id);}
  catch(e){wrap.innerHTML=`<p class="en-intro">Network status is unavailable: ${esc(e.message)}</p>`;return;}
  let route=null;try{const map=await Enclave.getTunaNetwork();route=map.labels?.[id.slice(2,10)]||null;}catch{}
  const policy=status.policy,use=networkUse(policy),host=status.host;
  const live=route&&route.expiresAt>Date.now()?route:null;
  const lines=[];
  lines.push(`<b>${esc(MODE_TEXT[policy.mode].title)}</b>${status.policySet?` <span class="en-sub">owner setting #${policy.nonce}</span>`:` <span class="en-sub">default</span>`}`);
  const website=use.ingress==="none"?"off (no public website)":live?`ready — ${esc(live.addresses?.join(", ")||live.a||"")}${live.transport==="enclave-network"?" (Enclave network)":live.transport==="direct"?" (direct)":" (TUNA, being retired)"}`:"not reachable yet";
  lines.push(`<span class="en-sub">Website (public HTTPS): ${website}</span>`);
  if(host){
    lines.push(`<span class="en-sub">Outbound: ${host.egress==="none"?"off":esc(host.egress)}${host.fallbackActive?' <span class="warn">— your BYO tunnel is down; the fallback you authorized (Enclave network) is carrying it</span>':""}</span>`);
    for(const c of host.circuits||[])lines.push(`<span class="en-sub">${c.kind==="byo"?"Your WireGuard peer":`Route: guard ${esc(c.guard?.region||"")} → exit ${esc(c.exit?.region||"")} ${esc(c.exit?.address||"")}`} — ${c.healthy?"healthy":'<span class="warn">checking</span>'}${c.ingress?" · website":""}${c.egress?" · outbound":""}</span>`);
    if(host.error)lines.push(`<span class="en-sub warn">${esc(host.error)}</span>`);
    lines.push(`<span class="en-sub dim">Host report ${Math.max(0,Math.round((Date.now()-status.hostReportedAt)/1000))} s ago</span>`);
  }else lines.push(`<span class="en-sub dim">The host has not reported this app's network yet.</span>`);
  const providers=status.providers||[];
  lines.push(`<span class="en-sub">${providers.length} qualified provider${providers.length===1?"":"s"}: ${esc(providers.map(p=>p.region).join(", ")||"none")}${providers.every(p=>p.kind==="enclave")&&providers.length?" — all operated by Enclave":""}; rechecked every few minutes, removed the moment a check fails.</span>`);
  wrap.innerHTML=`<div class="en-list">${lines.map(l=>`<div>${l}</div>`).join("")}</div><p class="en-intro">${esc(PRIVACY[policy.mode])}</p>`;

  // ---- the owner's setting ----
  const form=document.createElement("form");form.className="enc-network-controls";
  form.innerHTML=`<fieldset><legend>How this app reaches the internet</legend><div class="en-list">${Object.entries(MODE_TEXT).map(([k,v])=>
    `<label class="en-opt"><input type="radio" name="mode" value="${k}"${k===policy.mode?" checked":""}><b>${esc(v.title)}</b><span class="en-sub">${esc(v.sub)}</span></label>`).join("")}</div></fieldset>
   <div data-for="byo-wireguard" hidden>
     <label>WireGuard config <span class="en-sub">(standard [Interface]/[Peer] file; full tunnel only; no PostUp/PreUp scripts)</span><br>
       <textarea name="config" rows="9" cols="64" spellcheck="false" autocomplete="off" placeholder="${status.byoConfig?"A config is stored (sealed). Paste a new one to replace it.":"[Interface]\nPrivateKey = …\nAddress = 10.0.0.2/32\nDNS = 10.0.0.1\n\n[Peer]\nPublicKey = …\nEndpoint = vpn.example.com:51820\nAllowedIPs = 0.0.0.0/0, ::/0"}"></textarea></label>
     <div class="en-sub" data-check role="status"></div>
     <label>Public website <select name="ingress"><option value="enclave-network">Through the Enclave network (separately billed under the limits below)</option><option value="none">None: outbound only</option></select></label>
   </div>
   <div data-for="direct" hidden><p class="en-intro"><b>The host's public IP will be visible to every visitor and destination.</b> ${status.directHosts?"":"No host that runs this app currently offers direct hosting; the app stays unreachable until one does, unless you allow the fallback below."}</p></div>
   <div data-fallback hidden><label>If it fails <select name="fallback"><option value="none">Stay offline (nothing else is used)</option><option value="enclave-network">Use the Enclave network instead</option></select></label></div>
   <div data-network><label>Routes <select name="routes"><option value="2">2 (recommended)</option><option value="1">1</option></select></label>
     <label>Max price, USDC per GiB <input name="price" inputmode="decimal" size="8" value="${usdc(policy.enclaveNetwork?.maxPricePerGiB6??0)}"></label>
     <label>Budget, USDC <input name="budget" inputmode="decimal" size="8" value="${usdc(policy.enclaveNetwork?.budget6??0)}"></label>
     <span class="en-sub">0 uses only free providers (all current providers are free). A paid provider needs a price limit and a budget, settled from the app's USDC balance; your VPN provider (BYO) is paid by you directly.</span></div>
   <button type="submit">Sign and save</button> <span class="en-sub" role="status" data-save></span>`;
  box.append(form);
  const f=form.elements,show=()=>{
    const m=f.mode.value;
    for(const el of form.querySelectorAll("[data-for]"))el.hidden=el.dataset.for!==m;
    form.querySelector("[data-fallback]").hidden=m==="enclave-network";
    const needsNetwork=m==="enclave-network"||f.fallback.value==="enclave-network"||(m==="byo-wireguard"&&f.ingress.value==="enclave-network");
    form.querySelector("[data-network]").hidden=!needsNetwork;
  };
  if(policy.mode==="byo-wireguard")f.ingress.value=policy.byo.ingress;
  f.fallback.value=policy.fallback;f.routes.value=String(policy.enclaveNetwork?.routes||2);
  for(const el of [...form.querySelectorAll("input[name=mode]"),f.fallback,f.ingress])el.addEventListener("change",show);show();
  const check=form.querySelector("[data-check]");
  f.config.addEventListener("input",()=>{
    if(!f.config.value.trim()){check.textContent="";return;}
    try{const {config,warnings}=parseWireGuardConfig(f.config.value);check.innerHTML=`Valid: ${esc(config.addresses.join(", "))} via ${esc(config.endpoint.host)}:${config.endpoint.port}${warnings.map(w=>`<br><span class="warn">${esc(w)}</span>`).join("")}`;}
    catch(e){check.innerHTML=(e.problems||[e.message]).map(p=>`<span class="warn">${esc(p)}</span>`).join("<br>");}
  });
  const save=form.querySelector("button"),saveStatus=form.querySelector("[data-save]");
  const ownerOk=viaVault||(owner&&Enclave.address&&Enclave.address.toLowerCase()===String(owner).toLowerCase());
  if(!ownerOk){save.disabled=true;saveStatus.textContent="Connect the app owner's wallet to change this.";}
  form.addEventListener("submit",async ev=>{
    ev.preventDefault();save.disabled=true;
    try{
      const mode=f.mode.value,next={version:5,deploymentId:id,nonce:policy.nonce+1,issuedAt:Math.floor(Date.now()/1000),mode,fallback:mode==="enclave-network"?"none":f.fallback.value};
      const needsNetwork=mode==="enclave-network"||next.fallback==="enclave-network"||(mode==="byo-wireguard"&&f.ingress.value==="enclave-network");
      if(needsNetwork){const p=toU6(f.price.value),b=toU6(f.budget.value);if((p>0)!==(b>0))throw new Error("A price limit needs a budget, and a budget needs a price limit.");
        next.enclaveNetwork={routes:Number(f.routes.value),guard:true,maxPricePerGiB6:p,budget6:b};}
      if(mode==="direct")next.direct={maxPricePerGiB6:0};
      if(mode==="byo-wireguard"){
        let digest=status.byoConfig?.configDigest;
        if(f.config.value.trim()){
          const {config}=parseWireGuardConfig(f.config.value);
          const salt=hex(crypto.getRandomValues(new Uint8Array(32))).slice(2);
          digest=await wireGuardConfigDigest(salt,config);
          const expiry=Math.floor(Date.now()/1000)+300;
          saveStatus.textContent="Sign to store the WireGuard config (it is sealed on the relay and released only to the host running this app).";
          const signature=await ownerSign(byoConfigMessage({deploymentId:id,configDigest:digest,expiry}),{viaVault});
          await relay("/v1/network/byo/"+id,{method:"POST",body:JSON.stringify({config:f.config.value,salt,expiry,signature})});
          f.config.value="";check.textContent="Stored.";
        }
        if(!digest)throw new Error("Paste your WireGuard config first.");
        next.byo={configDigest:digest,ingress:f.ingress.value};
      }
      validateNetworkPolicy(next);
      saveStatus.textContent="Sign the network setting.";
      const signature=await ownerSign(networkPolicyMessage(next),{viaVault});
      await relay("/v1/network/policy/"+id,{method:"POST",body:JSON.stringify({envelope:{policy:next,signature}})});
      saveStatus.textContent="Saved. The host applies it within a minute; nothing switches silently in between.";
    }catch(e){saveStatus.textContent=(e.problems||[e.message]).join(" · ");}
    finally{save.disabled=!ownerOk;}
  });
  if(status.byoConfig){
    const view=document.createElement("button");view.type="button";view.textContent="Show the stored WireGuard config (redacted)";
    view.addEventListener("click",async()=>{try{const expiry=Math.floor(Date.now()/1000)+300;
      const signature=await ownerSign(byoOwnerMessage({deploymentId:id,action:"view",expiry}),{viaVault});
      const v=await relay(`/v1/network/byo/${id}/view`,{method:"POST",body:JSON.stringify({expiry,signature})});
      check.textContent=v.redacted?`Stored: ${v.redacted.addresses.join(", ")} via ${v.redacted.endpoint}, DNS ${v.redacted.dns.join(", ")}${v.redacted.hasPresharedKey?", preshared key":""} (keys are never shown)`:"No config stored.";}
      catch(e){check.textContent=e.message;}});
    form.querySelector("[data-for=byo-wireguard]").append(view);
  }
}
