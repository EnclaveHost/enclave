import copy,importlib.util,pathlib,unittest
ROOT=pathlib.Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('inspector',ROOT/'driver/inspect-caddy.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
HOST='custody-canary.enclave.host'
def route(host=HOST):return {'match':[{'host':[host]}],'handle':[{'handler':'subroute','routes':[{'group':'group1','match':[{'method':['GET'],'path':['/v2/custody/info']}],'handle':[{'handler':'reverse_proxy','upstreams':[{'dial':'127.0.0.1:18972'}]}]},{'handle':[{'handler':'static_response','status_code':404}]}]}]}
def config():return {'apps':{'http':{'servers':{'s':{'listen':[':443'],'routes':[route()]}}}}}
class Inspector(unittest.TestCase):
 def test_exact_route_with_unrelated_origin_and_renumbered_groups(self):
  want=config();live=config();live['apps']['http']['servers']['s']['routes'].append(route('other.example'))
  live['apps']['http']['servers']['s']['routes'][1]['handle'][0]['routes'][0]['group']='group10'
  live['apps']['http']['servers']['s']['routes'][0]['handle'][0]['routes'][0]['group']='group20'
  self.assertEqual(m.validate_live(live,want,HOST),m.validate_live(want,want,HOST))
 def test_route_changes_and_ambiguous_routing_refuse(self):
  def cases():
   yield lambda s:s['routes'][0]['handle'][0]['routes'][0]['match'][0].update(path=['/state'])
   yield lambda s:s['routes'][0]['handle'][0]['routes'][0]['match'][0].update(method=['POST'])
   yield lambda s:s['routes'][0]['handle'][0]['routes'][0]['handle'][0]['upstreams'][0].update(dial='0.0.0.0:18972')
   yield lambda s:s['routes'][0]['handle'][0]['routes'][1]['handle'][0].update(status_code=200)
   yield lambda s:s['routes'].append(route())
   yield lambda s:s['routes'].append(route('*.enclave.host'))
   yield lambda s:s['routes'].append({'handle':[]})
   yield lambda s:s['routes'][0]['match'][0]['host'].append('other.example')
   yield lambda s:s['routes'][0]['match'][0].update(path=['/*'])
   yield lambda s:s['routes'].append(route('other.example')) # same group reused across sites
   yield lambda s:s.update(listen=['127.0.0.1:443'])
   yield lambda s:s.update(routes=[])
  for change in cases():
   with self.subTest(change=change):
    live=config();change(live['apps']['http']['servers']['s'])
    with self.assertRaises(ValueError):m.validate_live(live,config(),HOST)
 def test_additional_specific_address_server_cannot_shadow(self):
  live=config();live['apps']['http']['servers']['other']={'listen':['192.0.2.1:443'],'routes':[route()]}
  with self.assertRaises(ValueError):m.validate_live(live,config(),HOST)
if __name__=='__main__':unittest.main()
