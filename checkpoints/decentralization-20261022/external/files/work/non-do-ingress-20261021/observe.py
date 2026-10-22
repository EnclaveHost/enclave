#!/usr/bin/env python3
"""READ-ONLY uplink observation (the prior S4 methods only): local + minipc public egress (one IPv4 and one IPv6 lookup
each), interface/route metadata (global addresses only), and ONE TP-Link UPnP GetExternalIPAddress read. No scan, no
router/firewall change, no secret. -> observe.json"""
import json, re, subprocess, time, urllib.request, importlib.util, os
HERE = os.path.dirname(os.path.abspath(__file__))
src = open(os.path.join(HERE, '..', 'cron-startup-20261021', 'probe.py')).read().split("LOGS = r")[0]
ns = {}; exec(compile(src, 'probe.py', 'exec'), ns); ps = ns['ps']
out = {'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
def get(url):
    try: return urllib.request.urlopen(url, timeout=10).read().decode().strip()[:64]
    except Exception as e: return 'error: ' + str(e)[:80]
out['local'] = {'egressIPv4': get('https://api.ipify.org'), 'egressIPv6': get('https://api6.ipify.org'),
  'globalIPv6': subprocess.run(['ip', '-6', 'addr', 'show', 'scope', 'global'], capture_output=True, text=True).stdout.strip() or 'none',
  'defaultRoute': subprocess.run(['ip', 'route', 'show', 'default'], capture_output=True, text=True).stdout.strip()}
out['minipc'] = ps(r"""$a=@(Get-NetIPAddress -ErrorAction SilentlyContinue | Where-Object {$_.PrefixOrigin -ne 'WellKnown' -and $_.IPAddress -notlike 'fe80*' -and $_.IPAddress -notlike '169.254*' -and $_.IPAddress -ne '127.0.0.1' -and $_.IPAddress -ne '::1'} | ForEach-Object {"$($_.InterfaceAlias)=$($_.IPAddress)/$($_.PrefixLength)"});
$r=@(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | ForEach-Object {"$($_.InterfaceAlias) via $($_.NextHop)"});
$r6=@(Get-NetRoute -DestinationPrefix '::/0' -ErrorAction SilentlyContinue | ForEach-Object {"$($_.InterfaceAlias) via $($_.NextHop)"});
function G($u){try{(Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 -Uri $u).Content.Trim()}catch{'error: '+$_.Exception.Message.Substring(0,[Math]::Min(60,$_.Exception.Message.Length))}}
[ordered]@{addresses=$a;default4=$r;default6=$r6;egressIPv4=(G 'https://api.ipify.org');egressIPv6=(G 'https://api6.ipify.org')}|ConvertTo-Json -Compress""".replace('\n', ''), 90)
soap = ('<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
        '<s:Body><u:GetExternalIPAddress xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1"/></s:Body></s:Envelope>')
try:
    desc = urllib.request.urlopen('http://192.168.88.1:1900/nxaada/gatedesc.xml', timeout=5).read().decode()
    ctl = re.search(r'WANIPConnection:1</serviceType>.*?<controlURL>([^<]+)</controlURL>', desc, re.S).group(1)
    req = urllib.request.Request('http://192.168.88.1:1900' + ctl, data=soap.encode(), headers={'Content-Type': 'text/xml; charset="utf-8"',
          'SOAPAction': '"urn:schemas-upnp-org:service:WANIPConnection:1#GetExternalIPAddress"'})
    out['tplinkGetExternalIPAddress'] = re.search(r'<NewExternalIPAddress>([^<]*)<', urllib.request.urlopen(req, timeout=5).read().decode()).group(1)
except Exception as e: out['tplinkGetExternalIPAddress'] = 'error: ' + str(e)[:100]
json.dump(out, open(os.path.join(HERE, 'observe.json'), 'w'), indent=1); print(json.dumps(out, indent=1))
