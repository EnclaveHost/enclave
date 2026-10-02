import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';

export class DiscoveryPeer {
  constructor({binary,configFile,deploymentId,log=()=>{}}){Object.assign(this,{binary,configFile,deploymentId,log});this.closed=false;}
  start(){
    if(this.child||this.closed)throw new Error('discovery peer already started');
    this.child=spawn(this.binary,['--config',this.configFile,'--deployment',this.deploymentId],{stdio:['pipe','pipe','pipe'],windowsHide:true});
    this.child.stdin.on('error',()=>{});this.child.stderr.on('data',b=>this.log(String(b).slice(0,1000)));
    this.lines=createInterface({input:this.child.stdout});
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.close();reject(new Error('discovery peer startup timeout'));},60000);
      const fail=e=>{clearTimeout(timer);reject(e);};
      this.child.once('error',fail);this.child.once('exit',()=>fail(new Error('discovery peer exited')));
      this.lines.on('line',line=>{try{const event=JSON.parse(line);if(event.type==='ready'){clearTimeout(timer);resolve(event);}else if(event.type==='subscription')this.log('NKN discovery subscription '+event.transaction);}catch{}});
    });
  }
  update(value){
    if(this.closed||!this.child?.stdin.writable)throw new Error('discovery peer is closed');
    const record=value?{deploymentId:this.deploymentId,expiresAt:value.expiresAt,name:value.name,cid:value.cid,block:value.block,ipns:value.ipns}:
      {deploymentId:this.deploymentId,expiresAt:0,name:'',cid:'',block:'',ipns:''};
    this.child.stdin.write(JSON.stringify(record)+'\n');
  }
  close(){if(this.closed)return;this.closed=true;this.lines?.close();this.child?.stdin.end();this.child?.kill('SIGTERM');}
}
