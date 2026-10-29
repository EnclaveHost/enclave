from pathlib import Path
from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
from urllib.parse import urlsplit
import json
p=Path(__file__).resolve().parent
class H(SimpleHTTPRequestHandler):
 def __init__(self,*a,**kw):super().__init__(*a,directory=str(p/'composite/site'),**kw)
 def do_POST(self):self.send_error(405)
 def translate_path(self,url):
  path=urlsplit(url).path
  if '..' in path.split('/'):return '/dev/null'
  if path=='/__fixture.html':return str(p/'fixture.html')
  if path.startswith('/__source/'):return str(p/'source'/path.removeprefix('/__source/'))
  if path=='/dashboard':return str(p/'composite/site/dashboard.html')
  if path=='/host':return str(p/'composite/site/host.html')
  return super().translate_path(url)
 def log_message(self,fmt,*a):
  with (p/'http.log').open('a') as f:f.write(fmt%a+'\n')
server=ThreadingHTTPServer(('127.0.0.1',0),H)
(p/'server.json').write_text(json.dumps({'port':server.server_port}))
server.serve_forever()
