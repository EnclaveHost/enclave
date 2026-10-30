// Installed-host adapter: retain its existing CPU/GPU router and add a separate
// native image. A failed desktop preflight must not disable ordinary launches.
import { DESKTOP_DERIVATION } from './desktop-derive.mjs';
export class DesktopLauncher {
  constructor(base, desktop) {
    if (!base || !desktop?.desktopPlatform) throw new Error('desktop router requires both launchers');
    this.base=base;this.desktop=desktop;
  }
  get marker() { return this.base.marker; }
  get prefix() { return this.base.prefix; }
  get boundary() { return this.base.boundary; }
  get desktopPlatform() { return this.desktop.desktopPlatform; }
  async preflight() {
    const [base,native]=await Promise.allSettled([Promise.resolve().then(()=>this.base.preflight()),Promise.resolve().then(()=>this.desktop.preflight())]);
    if(base.status==='rejected')throw base.reason;
    const result=native.status==='fulfilled'?native.value:{ok:false,checks:[{name:'native desktop preflight',ok:false,detail:String(native.reason?.message??native.reason)}]};
    return {...base.value,roles:{...(base.value?.roles??{}),desktop:result}};
  }
  survey() { return this.base.survey(); }
  teardown(options) { return this.base.teardown(options); }
  start(mapping,opts) {
    const native=mapping?.record?.derivation===DESKTOP_DERIVATION||mapping?.record?.desktop!=null;
    return (native?this.desktop:this.base).start(mapping,opts);
  }
  stop(handle) { return (handle?.imageRole==='desktop'?this.desktop:this.base).stop(handle); }
}
