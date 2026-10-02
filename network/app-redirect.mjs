import http from 'node:http';
// The redirect is part of this app's allocation, and carries no host-wide
// hostname lookup. Unknown names cannot learn or reach another deployment.
export async function createAppRedirect({deploymentId,names,authorize,host='127.0.0.1',port=0}) {
 const allowed=new Set(names.map(n=>n.toLowerCase()));const sockets=new Set();
 const server=http.createServer((req,res)=>{
  const name=String(req.headers.host||'').toLowerCase().replace(/:80$/,'');
  if(!authorize(deploymentId)||!allowed.has(name)){res.writeHead(421,{'connection':'close'});res.end();return;}
  if(typeof req.url!=='string'||!req.url.startsWith('/')||req.url.startsWith('//')||/[\r\n\\]/.test(req.url)){res.writeHead(400,{'connection':'close'});res.end();return;}
  res.writeHead(308,{'location':'https://'+name+req.url,'connection':'close','cache-control':'no-store'});res.end();
 });
 server.maxConnections=256;server.headersTimeout=10000;server.requestTimeout=10000;
 server.on('connection',s=>{sockets.add(s);s.once('close',()=>sockets.delete(s));});
 await new Promise((r,j)=>{server.once('error',j);server.listen(port,host,r);});
 return {port:server.address().port,revoke(){for(const s of sockets)s.destroy();},close(){server.close();for(const s of sockets)s.destroy();}};
}
