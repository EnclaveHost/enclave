import{a as S}from"./chunk-JPEPIZSM.js";import{L as p,Wa as x,Y as u}from"./chunk-ZUJ5AN73.js";import{Ya as f}from"./chunk-HUSM3R7T.js";import{a as z,b}from"./chunk-DDX3EYZS.js";import{e as h}from"./chunk-KL2DZ7E2.js";var o=h(b(),1),C=h(S(),1),$=h(z(),1);var w=e=>(0,o.jsx)("svg",{viewBox:"0 0 50 50",fill:"none",xmlns:"http://www.w3.org/2000/svg",...e,children:(0,o.jsx)("rect",{width:"50",height:"50",fill:"black",rx:10,ry:10})}),m=(e,r,l,t,a)=>{for(let i=r;i<r+t;i++)for(let g=l;g<l+a;g++){let n=e?.[g];n&&n[i]&&(n[i]=0)}return e},y=(e,r)=>{let l=C.default.create(e,{errorCorrectionLevel:r}).modules,t=p(Array.from(l.data),l.size);return t=m(t,0,0,7,7),t=m(t,t.length-7,0,7,7),m(t,0,t.length-7,7,7)},v=({x:e,y:r,cellSize:l,bgColor:t,fgColor:a})=>(0,o.jsx)(o.Fragment,{children:[0,1,2].map((i=>(0,o.jsx)("circle",{r:l*(7-2*i)/2,cx:e+7*l/2,cy:r+7*l/2,fill:i%2!=0?t:a},`finder-${e}-${r}-${i}`)))}),F=({cellSize:e,matrixSize:r,bgColor:l,fgColor:t})=>(0,o.jsx)(o.Fragment,{children:[[0,0],[(r-7)*e,0],[0,(r-7)*e]].map((([a,i])=>(0,o.jsx)(v,{x:a,y:i,cellSize:e,bgColor:l,fgColor:t},`finder-${a}-${i}`)))}),L=({matrix:e,cellSize:r,color:l})=>(0,o.jsx)(o.Fragment,{children:e.map(((t,a)=>t.map(((i,g)=>i?(0,o.jsx)("rect",{height:r-.4,width:r-.4,x:a*r+.1*r,y:g*r+.1*r,rx:.5*r,ry:.5*r,fill:l},`cell-${a}-${g}`):(0,o.jsx)($.default.Fragment,{},`circle-${a}-${g}`)))))}),j=({cellSize:e,matrixSize:r,element:l,sizePercentage:t,bgColor:a})=>{if(!l)return(0,o.jsx)(o.Fragment,{});let i=r*(t||.14),g=Math.floor(r/2-i/2),n=Math.floor(r/2+i/2);(n-g)%2!=r%2&&(n+=1);let c=(n-g)*e,d=c-.2*c,s=g*e;return(0,o.jsxs)(o.Fragment,{children:[(0,o.jsx)("rect",{x:g*e,y:g*e,width:c,height:c,fill:a}),(0,o.jsx)(l,{x:s+.1*c,y:s+.1*c,height:d,width:d})]})},k=e=>{let r=e.outputSize,l=y(e.url,e.errorCorrectionLevel),t=r/l.length,a=u(2*t,{min:.025*r,max:.036*r});return(0,o.jsxs)("svg",{height:e.outputSize,width:e.outputSize,viewBox:`0 0 ${e.outputSize} ${e.outputSize}`,style:{height:"100%",width:"100%",padding:`${a}px`},children:[(0,o.jsx)(L,{matrix:l,cellSize:t,color:e.fgColor}),(0,o.jsx)(F,{cellSize:t,matrixSize:l.length,fgColor:e.fgColor,bgColor:e.bgColor}),(0,o.jsx)(j,{cellSize:t,element:e.logo?.element,bgColor:e.bgColor,matrixSize:l.length})]})},B=x.div.attrs({className:"ph-no-capture"})`
  display: flex;
  justify-content: center;
  align-items: center;
  height: ${e=>`${e.$size}px`};
  width: ${e=>`${e.$size}px`};
  margin: auto;
  background-color: ${e=>e.$bgColor};

  && {
    border-width: 2px;
    border-color: ${e=>e.$borderColor};
    border-radius: var(--privy-border-radius-md);
  }
`,A=e=>{let{appearance:r}=f(),l=e.bgColor||"#FFFFFF",t=e.fgColor||"#000000",a=e.size||160,i=r.palette.colorScheme==="dark"?l:t;return(0,o.jsx)(B,{$size:a,$bgColor:l,$fgColor:t,$borderColor:i,children:(0,o.jsx)(k,{url:e.url,logo:e.hideLogo?void 0:{element:e.squareLogoElement??w},outputSize:a,bgColor:l,fgColor:t,errorCorrectionLevel:e.errorCorrectionLevel||"Q"})})};export{A as a};
