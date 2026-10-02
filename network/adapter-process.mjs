import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';

// A process owns exactly one funded identity and one provider role. It never
// silently expands an allowlist or restarts against an unselected provider.
export class AdapterProcess extends EventEmitter {
  constructor({binary,configFile,route,provider,spawnProcess=spawn,log=()=>{}}) {
    super();Object.assign(this,{binary,configFile,route,provider,spawnProcess,log});this.closed=false;
  }
  start({timeoutMs=90000}={}) {
    if(this.child||this.closed)throw new Error('adapter already started or closed');
    const child=this.spawnProcess(this.binary,['--config',this.configFile],{stdio:['pipe','pipe','pipe'],windowsHide:true});
    this.child=child;
    return new Promise((resolve,reject)=>{
      let settled=false,ended=false;
      const timer=setTimeout(()=>{fail(new Error('provider allocation timeout'));this.close();},timeoutMs);
      const fail=error=>{if(!settled){settled=true;clearTimeout(timer);reject(error);}this.emit('down',error);};
      const lines=createInterface({input:child.stdout});
      lines.on('line',line=>{
        if(line.length>16384||this.closed)return;
        let v;try{v=JSON.parse(line);}catch{return;}
        if(v.type==='ready'&&v.id===this.route.id){
          if(v.provider!==this.provider.identity||v.address!==this.provider.address||v.beneficiary!==this.provider.beneficiary){fail(new Error('allocated provider metadata changed'));this.close();return;}
          if(!Array.isArray(v.tcp)||!Array.isArray(v.udp||[])||(v.udp||[]).length||v.tcp.length!==this.route.tcp.length||
             (!this.route.forward&&(this.route.publicTcp||this.route.tcp).some((port,i)=>port!==v.tcp[i]))){fail(new Error('unexpected public port allocation'));this.close();return;}
          this.allocation=v;if(!settled){settled=true;clearTimeout(timer);resolve(v);}this.emit('ready',v);
        }else if(v.type==='down'||v.type==='error'){fail(new Error(v.error||'provider disconnected'));this.close();}
      });
      child.stderr.on('data',b=>this.log(String(b).slice(0,2000)));
      child.stdin.on('error',()=>{});
      const exit=error=>{if(ended)return;ended=true;lines.close();this.allocation=null;fail(error);};
      child.once('error',exit);child.once('exit',(code,signal)=>exit(new Error(`adapter exited (${signal||code})`)));
      child.stdin.write(JSON.stringify({routes:[this.route]})+'\n');
    });
  }
  close() {if(this.closed)return;this.closed=true;if(this.child&&!this.child.killed){this.child.stdin.end();this.child.kill('SIGTERM');const child=this.child;const timer=setTimeout(()=>child.kill('SIGKILL'),5000);timer.unref();child.once('exit',()=>clearTimeout(timer));}}
}
