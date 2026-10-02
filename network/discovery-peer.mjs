import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {EventEmitter} from 'node:events';

export class DiscoveryPeer extends EventEmitter {
  constructor({binary,configFile,deploymentId,log=()=>{}}){super();Object.assign(this,{binary,configFile,deploymentId,log});this.closed=false;}
  start(){
    if(this.child||this.closed)throw new Error('discovery peer already started');
    this.child=spawn(this.binary,['--config',this.configFile,'--deployment',this.deploymentId],{stdio:['pipe','pipe','pipe'],windowsHide:true});
    this.child.stderr.on('data',b=>this.log(String(b).slice(0,1000)));
    this.lines=createInterface({input:this.child.stdout});
    return new Promise((resolve,reject)=>{
      let settled=false;
      const fail=e=>{clearTimeout(timer);if(this.closed)return;this.close();if(!settled){settled=true;reject(e);}this.emit('down',e);};
      const timer=setTimeout(()=>fail(new Error('discovery peer startup timeout')),60000);
      this.child.once('error',fail);this.child.once('exit',()=>fail(new Error('discovery peer exited')));
      this.child.stdin.on('error',()=>fail(new Error('discovery command stream failed')));
      this.lines.on('line',line=>{try{const event=JSON.parse(line);if(event.type==='ready'&&!settled){clearTimeout(timer);settled=true;resolve(event);}else if(event.type==='subscription')this.log('NKN discovery subscription '+event.transaction);}catch{}});
    });
  }
  update(value){
    if(this.closed||!this.child?.stdin.writable)throw new Error('discovery peer is closed');
    const record=value?{deploymentId:this.deploymentId,expiresAt:value.expiresAt,name:value.name,cid:value.cid,block:value.block,ipns:value.ipns}:
      {deploymentId:this.deploymentId,expiresAt:0,name:'',cid:'',block:'',ipns:''};
    const line=JSON.stringify(record)+'\n';
    if(Buffer.byteLength(line)>65536||this.child.stdin.writableLength>131072)throw new Error('discovery update exceeds queue bound');
    this.child.stdin.write(line);
  }
  close(){if(this.closed)return;this.closed=true;this.lines?.close();this.child?.stdin.end();this.child?.kill('SIGTERM');}
}
