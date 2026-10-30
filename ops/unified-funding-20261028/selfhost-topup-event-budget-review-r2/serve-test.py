from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
from pathlib import Path
import json
from urllib.parse import urlsplit
p=Path(__file__).resolve().parent
root=p.parent
class H(SimpleHTTPRequestHandler):
 def __init__(self,*a,**kw):super().__init__(*a,directory=str(root),**kw)
 def do_POST(self):self.send_error(405)
 def do_HEAD(self):self.send_error(405)
 def do_GET(self):
  url=urlsplit(self.path).path
  allowed={
   '/'+p.name+'/browser-fixture.html',
   '/'+p.name+'/reviewed/selfhost-gas-topup.js',
   '/selfhost-topup-r1-20261029/reconstructed/enclave/site/js/funding/state.js',
   '/selfhost-topup-r1-20261029/reconstructed/enclave/site/js/funding/flows.js',
   '/live-css/site.css',
  }
  if url not in allowed:return self.send_error(404)
  return super().do_GET()
 def translate_path(self,url):
  if url=='/live-css/site.css':return str(root/'funding-quote-ux-release-r1/composite/site/css/site.css')
  return super().translate_path(url)
 def log_message(self,*a):pass
server=ThreadingHTTPServer(('127.0.0.1',0),H)
(p/'server.json').write_text(json.dumps({'port':server.server_port,'path':'/'+p.name+'/browser-fixture.html'})+'\n')
server.serve_forever()
