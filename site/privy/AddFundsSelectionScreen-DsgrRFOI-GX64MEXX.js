import{a as l,e as s,g as c}from"./chunk-3NDFBEW4.js";import{d as y}from"./chunk-TKAVDQ3O.js";import"./chunk-JQ6DT4YA.js";import"./chunk-LM3E7TAR.js";import{D as h,b as p,p as f}from"./chunk-6OIK6AQW.js";import"./chunk-LYEKNA4O.js";import"./chunk-PJ7AUMFY.js";import{Ka as C,La as b}from"./chunk-CCJ375T7.js";import"./chunk-JW7IXFK7.js";import"./chunk-PG6KE6SF.js";import"./chunk-PEK5XNIJ.js";import"./chunk-WYODC4XA.js";import"./chunk-VB4GAETT.js";import"./chunk-4OKB5CBM.js";import"./chunk-OTJO3D3I.js";import"./chunk-6IJIREI6.js";import"./chunk-PXBHYJL2.js";import"./chunk-7TY2UZWD.js";import"./chunk-TXU6LPUF.js";import"./chunk-SJEGAIFT.js";import"./chunk-V4WK2F2S.js";import{b as u}from"./chunk-35KF2EFG.js";import{Wa as a,ka as j}from"./chunk-ZUJ5AN73.js";import"./chunk-L5QBOKTA.js";import{Ya as d}from"./chunk-HUSM3R7T.js";import"./chunk-SKQJ66NO.js";import"./chunk-UXHCDCTD.js";import"./chunk-ZHGYXUNN.js";import{a as k,b as S}from"./chunk-DDX3EYZS.js";import"./chunk-SI3PT7TS.js";import"./chunk-VLQ5R6WU.js";import"./chunk-5PU5HUC2.js";import"./chunk-B7WXSOLG.js";import"./chunk-DKJONMGP.js";import{e as n}from"./chunk-KL2DZ7E2.js";var r=n(S(),1);var i=n(k(),1);var z=n(j(),1);var E={component:()=>{let t=C(),{onUserCloseViaDialogOrKeybindRef:m}=u(),x=d(),o=(0,i.useRef)(!1);(0,i.useEffect)((()=>{t&&(o.current=!1)}),[t]);let e=(0,i.useCallback)((async()=>{!o.current&&t&&(o.current=!0,b(),await t.onCancel())}),[t]);return(0,i.useEffect)((()=>(m.current=e,()=>{m.current===e&&(m.current=null)})),[e,m]),t?t.error?(0,r.jsx)(l,{icon:p,iconVariant:"warning",title:"Unable to add funds",subtitle:t.error,showClose:!0,onClose:e,primaryCta:{label:"Close",onClick:e}}):(0,r.jsx)(l,{icon:p,iconVariant:"subtle",title:"Select method",subtitle:"Choose how to fund your wallet",showClose:!0,onClose:e,children:(0,r.jsxs)(y,{style:{marginTop:"1rem"},$colorScheme:x.appearance.palette.colorScheme,children:[t.startFiat&&(0,r.jsxs)(c,{onClick:async()=>{o.current||(o.current=!0,await t.startFiat?.())},children:[(0,r.jsx)(g,{children:(0,r.jsx)(f,{})}),(0,r.jsxs)(w,{children:[(0,r.jsx)(s,{children:"Pay with fiat"}),(0,r.jsx)(v,{children:"Apple Pay, Google Pay, or debit card"})]})]}),t.startCrypto&&(0,r.jsxs)(c,{onClick:async()=>{o.current||(o.current=!0,await t.startCrypto?.())},children:[(0,r.jsx)(g,{children:(0,r.jsx)(h,{})}),(0,r.jsxs)(w,{children:[(0,r.jsx)(s,{children:"Transfer from wallet"}),(0,r.jsx)(v,{children:"Send crypto from any wallet"})]})]})]})}):null}},g=a.span`
  width: 2rem;
  height: 2rem;
  border-radius: var(--privy-border-radius-full);
  background-color: var(--privy-color-background-2);
  color: var(--color-icon-muted, #64668b);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;

  svg {
    width: 1.125rem;
    height: 1.125rem;
  }
`,w=a.span`
  display: flex;
  flex-direction: column;
  align-items: flex-start;
`,v=a.span`
  font-size: 0.875rem;
  line-height: 1.25rem;
  color: var(--privy-color-foreground-3);
`;export{E as AddFundsSelectionScreen,E as default};
