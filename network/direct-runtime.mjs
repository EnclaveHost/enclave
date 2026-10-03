import net from 'node:net';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {randomBytes} from 'node:crypto';
import {clientHelloName} from './tuna-host.mjs';
import {validateAppNames} from './app-ingress.mjs';
import {meteredSocket} from './traffic-meter.mjs';
import {createDirectEgress} from './direct-egress.mjs';

// TLS stays in the guest. Only the ClientHello is inspected to select an
// already-admitted app; this service has no app certificate or private key.
export class DirectRuntime {
  constructor({address,bindHost='0.0.0.0',httpsPort=443,httpPort=80,authorize,forward,
    terms,meter,canary,ownAddresses=[],log=()=>{},now=Date.now}) {
    Object.assign(this,{address,bindHost,httpsPort,httpPort,authorize,forward,terms,meter,canary,log,now});
    this.ownAddresses=[address,...ownAddresses];this.apps=new Map();this.names=new Map();this.sockets=new Set();this.closed=false;
  }
  allowed(app) {return !this.closed&&!app.closed&&app.until>this.now()&&this.authorize(app.deploymentId);}
  async listen() {
    if(this.listening)return this.listening;
    this.listening=(async()=>{
      this.web=net.createServer(socket=>{
        if(this.closed||this.sockets.size>=4096)return socket.destroy();
        this.sockets.add(socket);socket.once('close',()=>this.sockets.delete(socket));socket.on('error',()=>{});
        socket.setTimeout(10000,()=>socket.destroy());let hello=Buffer.alloc(0);
        const read=chunk=>{
          hello=Buffer.concat([hello,chunk]);if(hello.length>65536)return socket.destroy();
          const name=clientHelloName(hello);if(name===null)return;
          socket.pause();socket.removeListener('data',read);
          if(this.canary&&name===this.canary.hostname){socket.setTimeout(0);socket.unshift(hello);return this.canary.accept(socket);}
          const app=name&&this.names.get(name);
          if(!app||!this.allowed(app))return socket.destroy();
          socket.setTimeout(0);socket.unshift(hello);app.sockets.add(socket);
          socket.once('close',()=>app.sockets.delete(socket));
          const metered=meteredSocket(socket,(direction,size)=>app.meter.consume(direction,size),()=>this.allowed(app));
          Promise.resolve().then(()=>this.forward(metered,app.deploymentId)).catch(e=>{this.log(e.message);metered.destroy();});
        };
        socket.on('data',read);
      });
      this.http=http.createServer({headersTimeout:10000,requestTimeout:10000,maxHeaderSize:8192},(req,res)=>{
        const hostname=String(req.headers.host||'').toLowerCase().replace(/:80$/,'');
        if(this.canary&&hostname===this.canary.hostname)return this.canary.http(req,res);
        const app=this.names.get(hostname);
        if(!app||!this.allowed(app)){res.writeHead(421,{connection:'close'});res.end();return;}
        if(!['GET','HEAD'].includes(req.method)||!req.url.startsWith('/')||req.url.startsWith('//')||/[\r\n\\]/.test(req.url)){
          res.writeHead(400,{connection:'close'});res.end();return;
        }
        res.writeHead(308,{location:'https://'+hostname+req.url,connection:'close','cache-control':'no-store'});res.end();
      });
      try {
        await new Promise((r,j)=>{this.web.once('error',j);this.web.listen(this.httpsPort,this.bindHost,r);});
        await new Promise((r,j)=>{this.http.once('error',j);this.http.listen(this.httpPort,this.bindHost,r);});
        this.httpsPort=this.web.address().port;this.httpPort=this.http.address().port;
      }catch(e){this.web.close();this.http.close();throw e;}
    })();return this.listening;
  }
  async start({deploymentId,names,policy}) {
    if(this.closed||this.apps.has(deploymentId))throw new Error('direct runtime stopped or app already exists');
    validateAppNames(deploymentId,names);
    if(this.canary&&names.includes(this.canary.hostname))throw Error('reserved provider probe hostname');
    if(names.some(n=>this.names.has(n.toLowerCase())))throw new Error('direct hostname already assigned');
    const terms=await this.terms(deploymentId,policy);
    // A paid route never silently becomes free when settlement is unavailable.
    const meter=await this.meter(deploymentId,policy,terms);
    if(!meter||typeof meter.consume!=='function')throw new Error('bandwidth accounting unavailable');
    await this.listen();
    if(this.closed||this.apps.has(deploymentId)||names.some(n=>this.names.has(n.toLowerCase())))throw new Error('direct allocation changed');
    const app=new EventEmitter();Object.assign(app,{id:randomBytes(16).toString('hex'),deploymentId,policy,names,
      address:this.address,port:443,transport:'direct',closed:false,until:0,meter,sockets:new Set(),terms,
      providers:{},isolation:{},publishDiscovery(){}});
    const revoke=()=>{for(const socket of app.sockets)socket.destroy();app.egressService?.revoke();};
    app.admit=until=>{app.until=Math.min(until,app.terms.expiresAt);if(!this.allowed(app))revoke();};
    app.close=async reason=>{
      if(app.closed)return;app.closed=true;revoke();await app.egressService?.close();
      this.apps.delete(deploymentId);for(const n of names)if(this.names.get(n.toLowerCase())===app)this.names.delete(n.toLowerCase());
      app.emit('down',reason||'direct route closed');
    };
    try{
      app.egressService=await createDirectEgress({authorize:()=>this.allowed(app),meter,ownAddresses:this.ownAddresses});
      app.egress=app.egressService.proxy;
      this.apps.set(deploymentId,app);for(const n of names)this.names.set(n.toLowerCase(),app);
      return app;
    }catch(e){await app.close(e.message);throw e;}
  }
  async refresh(app) {
    const terms=await this.terms(app.deploymentId,app.policy);
    if(terms.pricePerGiB6!==app.terms.pricePerGiB6||terms.selfHosted!==app.terms.selfHosted)throw new Error('direct bandwidth terms changed');
    app.terms=terms;app.meter.terms=terms;
  }
  async close(){this.closed=true;await Promise.all([...this.apps.values()].map(a=>a.close('direct runtime stopped')));
    for(const s of this.sockets)s.destroy();this.web?.close();this.http?.close();await this.canary?.close();}
}
