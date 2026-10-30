import{a as b}from"./chunk-SSBE5LNP.js";import{a as s,b as l}from"./chunk-TUEG6NQU.js";import{d as P,j as A}from"./chunk-EWXR7LNF.js";import{e as S,n as L,u as j,v as _,w as T}from"./chunk-MR3EHJCJ.js";import{I as o}from"./chunk-I6WWIAX7.js";import{a as E,c,q as p,t as y,z as x}from"./chunk-X3FRN2UR.js";var g=class extends s{static _tpl=`<div class="wallet-mount" id="walletMount">
  <button class="btn btn-primary btn-sm" id="walletBtn" type="button" aria-controls="walletPop">Sign in <span class="arr" aria-hidden="true">\u2192</span></button>
  <div class="wallet-pop" id="walletPop" hidden></div>
</div>
`;renderedCallback(){if(this._wired)return;if(this._wired=!0,!E("#walletPick")){let n=document.createElement("div");n.className="wallet-pick",n.id="walletPick",n.hidden=!0,document.body.appendChild(n)}let e=this.querySelector("#walletBtn");e.addEventListener("click",async()=>{if(o.address||o.accountAuthed()){T();return}if(x){try{await A(),b("dashboard",{push:!0})}catch(r){/cancelled/i.test(r&&r.message||"")||p(r&&r.message||String(r))}return}let n=e.innerHTML;e.disabled=!0,e.innerHTML="connecting\u2026";try{await L(),b("dashboard",{push:!0})}catch(r){p(r.message)}finally{e.disabled=!1,o.address||(e.innerHTML=n)}});let a=n=>{let r=this.querySelector("#walletPop");return!r||r.hidden?!1:(r.hidden=!0,r.innerHTML="",e.setAttribute("aria-expanded","false"),n&&e.focus(),!0)};document.addEventListener("pointerdown",n=>{n.target.closest("#walletPop")||n.target.closest("#walletBtn")||a(!1)}),document.addEventListener("keydown",n=>{n.key==="Escape"&&a(!0)}),S.init(),_(),j(),P(),import("./account-TVXJ7U6S.js").then(n=>n.restoreSessionAccount()).catch(()=>{})}};l("c-wallet-button",g);var k=class extends s{static properties={current:""};static _tpl=`<header class="nav">
  <a class="skip-link" href="#main">Skip to main content</a>
  <div class="wrap nav-inner">
    <a href="./" class="brand" aria-label="Enclave home">
      <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <path d="M16 2 28 9v14L16 30 4 23V9z" stroke="var(--jade)" stroke-width="1.6"/>
        <path d="M16 7.333 24 12v8L16 24.667 8 20v-8z" stroke="var(--jade)" stroke-width="1.2" opacity=".55"/>
        <circle cx="16" cy="12.55" r="2.45" stroke="var(--jade)" stroke-width="1.6"/>
        <path d="M16 15v6.6M16 21.6h2M16 19.4h1.5" stroke="var(--jade)" stroke-width="1.6" stroke-linecap="round"/>
      </svg>
      <svg class="nm" viewBox="0 0 148 20" fill="currentColor" aria-hidden="true"><mask id="wmkH"><rect width="148" height="20" fill="#fff"/><rect y="6.4" width="148" height="1.2" fill="#000"/><rect y="12.4" width="148" height="1.2" fill="#000"/></mask><path mask="url(#wmkH)" d="M0 0h16v4h-16zM0 8h12v4h-12zM0 16h16v4h-16zM0 0h4v20h-4zM22 20V0h4.4l7.2 11V0h4.4v20h-4.4l-7.2-11v11zM44 0h16v4h-16zM44 16h16v4h-16zM44 0h4v20h-4zM66 0h4v20h-4zM66 16h16v4h-16zM88 0h16v4h-16zM88 0h4v20h-4zM100 0h4v20h-4zM92 9h8v4h-8zM110 0h4.4l3.6 13.4 3.6-13.4H126l-5.6 20h-4.8zM132 0h16v4h-16zM132 8h12v4h-12zM132 16h16v4h-16zM132 0h4v20h-4z"/></svg>
    </a>
    <nav class="nav-links" aria-label="Primary">
      <a href="./" data-view="overview">Overview</a>
      <a href="apps" data-view="apps">Apps</a>
      <a href="develop" data-view="develop">Develop</a>
      <a href="host" data-view="host">Host</a>
      <a href="dashboard" data-view="dashboard" hidden>Dashboard</a>
    </nav>
    <c-wallet-button></c-wallet-button>
  </div>
</header>
`;renderedCallback(){this.querySelectorAll(".nav-links a").forEach(a=>a.classList.toggle("active",a.dataset.view===this.current));let e=this.querySelector('a[data-view="dashboard"]');e&&(e.hidden=!(o.address||o.accountAuthed()))}};l("c-header",k);var C=()=>{let t=document.querySelector('c-header a[data-view="dashboard"]');t&&(t.hidden=!(o.address||o.accountAuthed()))};y("enclave:wallet",C);y("enclave:account",C);var d=null,v=null;function D(){return d?Promise.resolve(d):(v||(v=fetch("openapi.json",{headers:{Accept:"application/json"}}).then(t=>{if(!t.ok)throw new Error("openapi.json: HTTP "+t.status);return t.json()}).then(t=>d=t).catch(t=>{throw v=null,t})),v)}function Y(){return d}function O(t){let e=t.replace(/^#\//,"").split("/"),a=d;for(let n of e)a=a&&a[n];return a}function f(t){let e=0;for(;t&&t.$ref&&e<24;)t=O(t.$ref),e++;return t}function H(t){return t&&t.$ref?t.$ref.split("/").pop():null}function m(t){if(t=f(t),!t)return null;if("example"in t)return t.example;if(t.enum)return t.enum[0];if("default"in t)return t.default;switch(t.type){case"object":{let e={},a=t.properties||{};for(let n in a)e[n]=m(a[n]);return e}case"array":return[m(t.items||{})];case"integer":case"number":return 0;case"boolean":return!0;case"string":return t.format==="date-time"?"2026-06-26T17:05:00Z":"string";default:return null}}function I(t){let e=f(t);if(!e)return"any";if(e.type==="array"){let n=e.items||{},r=H(n)||(f(n)||{}).type||"any";return"array&lt;"+c(r)+"&gt;"}let a=H(t)||e.type||"object";return a=c(a),e.format&&(a+=' <span class="sopt">&lt;'+c(e.format)+"&gt;</span>"),a}function q(t,e,a,n){n=n||0;let r=f(t)||{},i='<div class="srow">';e!==void 0&&(i+='<span class="skey">'+c(e)+"</span>"),a&&(i+='<span class="sreq">*</span>'),e!==void 0&&(i+='<span class="sopt">: </span>'),i+='<span class="stype">'+I(t)+"</span>",r.enum&&(i+=' <span class="sopt">('+r.enum.map(c).join(" | ")+")</span>"),"default"in r&&(i+=' <span class="sopt">= '+c(JSON.stringify(r.default))+"</span>");let h=t&&t.description||r.description;h&&(i+='  <span class="sdesc">// '+c(h)+"</span>"),i+="</div>";let u="";if(n<6)if(r.type==="object"&&r.properties){let B=r.required||[];for(let w in r.properties)u+=q(r.properties[w],w,B.includes(w),n+1)}else r.type==="array"&&r.items&&(u+=q(r.items,"items",!1,n+1));return u?i+'<div class="sindent">'+u+"</div>":i}function ee(t){let e=t.requestBody;if(!e)return null;let a=e.content&&e.content["application/json"]&&e.content["application/json"].schema;return a?m(a):null}function te(t){let e=t.requestBody;return e?e.content&&e.content["application/json"]&&e.content["application/json"].schema:null}function ne(t){let e=t&&t.content&&t.content["application/json"]&&t.content["application/json"].schema;return e?m(e):null}function ae(){let t=[];for(let e in d.paths){let a=d.paths[e];for(let n of["get","post","patch","delete","put"])a[n]&&t.push({method:n.toUpperCase(),path:e,op:a[n]})}return t}async function V(){let t=await D(),e=new Blob([JSON.stringify(t,null,2)],{type:"application/json"}),a=URL.createObjectURL(e),n=document.createElement("a");n.href=a,n.download="openapi.json",document.body.appendChild(n),n.click(),n.remove(),setTimeout(()=>URL.revokeObjectURL(a),1e3),p("openapi.json downloaded")}var M=class extends s{static _tpl=`<footer aria-label="Footer">
  <div class="wrap">
    <div class="foot-grid">
      <div class="foot-brand">
        <a href="./" class="brand" aria-label="Enclave home">
          <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
            <path d="M16 2 28 9v14L16 30 4 23V9z" stroke="var(--jade)" stroke-width="1.6"/>
            <path d="M16 7.333 24 12v8L16 24.667 8 20v-8z" stroke="var(--jade)" stroke-width="1.2" opacity=".55"/>
            <circle cx="16" cy="12.55" r="2.45" stroke="var(--jade)" stroke-width="1.6"/>
            <path d="M16 15v6.6M16 21.6h2M16 19.4h1.5" stroke="var(--jade)" stroke-width="1.6" stroke-linecap="round"/>
          </svg>
          <svg class="nm" viewBox="0 0 148 20" fill="currentColor" aria-hidden="true"><mask id="wmkF"><rect width="148" height="20" fill="#fff"/><rect y="6.4" width="148" height="1.2" fill="#000"/><rect y="12.4" width="148" height="1.2" fill="#000"/></mask><path mask="url(#wmkF)" d="M0 0h16v4h-16zM0 8h12v4h-12zM0 16h16v4h-16zM0 0h4v20h-4zM22 20V0h4.4l7.2 11V0h4.4v20h-4.4l-7.2-11v11zM44 0h16v4h-16zM44 16h16v4h-16zM44 0h4v20h-4zM66 0h4v20h-4zM66 16h16v4h-16zM88 0h16v4h-16zM88 0h4v20h-4zM100 0h4v20h-4zM92 9h8v4h-8zM110 0h4.4l3.6 13.4 3.6-13.4H126l-5.6 20h-4.8zM132 0h16v4h-16zM132 8h12v4h-12zM132 16h16v4h-16zM132 0h4v20h-4z"/></svg>
        </a>
        <p>Compute that cannot see your data. Paid per second, for anything that holds a key.</p>
        <div class="foot-meta">
          <span>built + operated by Enclave Host, Inc.</span>
          <span>front-end: static, pinned to IPFS \xB7 <code>enclave.host</code></span>
        </div>
      </div>
      <nav aria-label="Product">
        <h2>Product</h2>
        <ul>
          <li><a href="./#why">What you get</a></li>
          <li><a href="./#how">How it works</a></li>
          <li><a href="apps">App store</a></li>
          <li><a href="./#pricing">Pricing</a></li>
          <li><a href="develop#architecture">Architecture</a></li>
          <li><a href="develop#progress">Engineering evidence</a></li>
          <li><a href="./#about">About the company</a></li>
        </ul>
      </nav>
      <nav aria-label="Developers">
        <h2>Developers</h2>
        <ul>
          <li><a href="develop#docs">App development guide</a></li>
          <li><a href="develop#api">API reference</a></li>
          <li><a href="openapi.json" id="dlSpec2">OpenAPI spec</a></li>
          <li><a href="./#attest">Attestation guide</a></li>
          <li><a href="develop#api">Error codes</a></li>
        </ul>
      </nav>
      <nav aria-label="Trust">
        <h2>Trust</h2>
        <ul>
          <li><a href="develop#contract">The isolation contract</a></li>
          <li><a href="develop#shield">Enclave Shield</a></li>
          <li><a href="./#attest">Verify an enclave</a></li>
          <li><a href="develop#verify">What is measured</a></li>
          <li><a href="develop#independent">What runs on our servers</a></li>
          <li><a href="https://github.com/EnclaveHost/enclave" target="_blank" rel="noopener">Source on GitHub</a></li>
        </ul>
      </nav>
      <nav aria-label="Contact and legal">
        <h2>Contact</h2>
        <ul>
          <li><a class="foot-mail" href="mailto:support@enclave.host">Support<code>support@enclave.host</code></a></li>
          <li><a class="foot-mail" href="mailto:security@enclave.host">Security disclosures<code>security@enclave.host</code></a></li>
          <li><a href=".well-known/security.txt">security.txt</a></li>
          <li><a href="terms">Terms of Service</a></li>
          <li><a href="privacy">Privacy Policy</a></li>
        </ul>
      </nav>
    </div>
    <div class="foot-bottom">
      <span>\xA9 2026 Enclave Host, Inc. \xB7 content-addressed on IPFS \xB7 build <span data-build>dev</span></span>
      <span>designed to outlive any one operator</span>
    </div>
  </div>
</footer>
`;renderedCallback(){let e=this.querySelector("#dlSpec2");e&&!e._wired&&(e._wired=!0,e.addEventListener("click",a=>{a.preventDefault(),V()}))}};l("c-footer",M);var z=class extends s{static _tpl=`<div id="toast" role="status" aria-live="polite" aria-atomic="true"></div>
`;renderedCallback(){if(this._wired)return;this._wired=!0;let e=this.querySelector("#toast");if(!e)return;let a=()=>{e.classList.remove("show"),e.removeAttribute("tabindex"),e.textContent=""},n=()=>{clearTimeout(this._t),this._left=Math.max(0,this._left-(Date.now()-this._at))},r=()=>{this._at=Date.now(),this._t=setTimeout(a,Math.max(1e3,this._left))};document.addEventListener("enclave:toast",i=>{let h=i.detail&&i.detail.message||"";e.textContent=h,e.classList.add("show"),e.setAttribute("tabindex","0"),clearTimeout(this._t),this._left=Math.min(12e3,Math.max(2200,1200+h.length*45)),this._at=Date.now(),this._t=setTimeout(a,this._left)}),e.addEventListener("mouseenter",n),e.addEventListener("mouseleave",r),e.addEventListener("focus",n),e.addEventListener("blur",r),e.addEventListener("click",()=>{clearTimeout(this._t),a()}),document.addEventListener("keydown",i=>{i.key==="Escape"&&e.classList.contains("show")?(clearTimeout(this._t),a()):(i.key==="Enter"||i.key===" ")&&i.target===e&&(i.preventDefault(),clearTimeout(this._t),a())})}};l("c-toast",z);export{D as a,Y as b,f as c,m as d,I as e,q as f,ee as g,te as h,ne as i,ae as j,V as k};
//# sourceMappingURL=chunk-TDHNED77.js.map
