#!/usr/bin/env python3
"""Render public provider configuration; no wallet keys are read or printed."""
import argparse
import ipaddress
import json
import pathlib
import re

p = argparse.ArgumentParser()
p.add_argument('--beneficiary', required=True)
p.add_argument('--ipv4', required=True)
p.add_argument('--ipv6', required=True)
p.add_argument('--output', required=True)
args = p.parse_args()
if not re.fullmatch(r'NKN[1-9A-HJ-NP-Za-km-z]{30,40}', args.beneficiary):
    p.error('A native NKN beneficiary address is required; Ethereum addresses are incompatible')
v4, v6 = ipaddress.IPv4Address(args.ipv4), ipaddress.IPv6Address(args.ipv6)
if not v4.is_global or not v6.is_global:
    p.error('Public provider addresses are required')
out = pathlib.Path(args.output)
out.mkdir(parents=True, exist_ok=True)
rpc = ['https://mainnet-rpc-node-0001.nkn.org/mainnet/api/wallet',
       'https://mainnet-rpc-node-0002.nkn.org/mainnet/api/wallet',
       'https://mainnet-rpc-node-0003.nkn.org/mainnet/api/wallet']
configs = {
    'reverse.json': {
        'seedRPCServerAddr': rpc, 'reverse': True,
        'reverseBeneficiaryAddr': args.beneficiary,
        'reverseTCP': 30020, 'reverseUDP': 30021,
        'reverseServiceListenIP': '0.0.0.0', 'reversePrice': '0.0002',
        'reverseClaimInterval': 300, 'reverseSubscriptionDuration': 40000,
        'reverseSubscriptionFee': '0.001', 'reverseSubscriptionReplaceTxPool': False,
        'dialTimeout': 10, 'udpTimeout': 60, 'downloadGeoDB': False,
        'minNanoPayFee': '0.00001', 'nanoPayFeeRatio': 0.1},
    'forward.json': {
        'seedRPCServerAddr': rpc, 'beneficiaryAddr': args.beneficiary,
        'listenTCP': 30010, 'listenUDP': 30011,
        'dialTimeout': 10, 'udpTimeout': 60, 'claimInterval': 300,
        'subscriptionDuration': 40000, 'subscriptionFee': '0.001',
        'subscriptionReplaceTxPool': False, 'downloadGeoDB': False,
        'services': {'socksproxy': {'address': '127.0.0.1', 'price': '0.0002'}}},
    'services.json': [{'name': 'socksproxy', 'tcp': [30489],
                       'encryption': 'xsalsa20-poly1305'}]}
for name, config in configs.items():
    (out / name).write_text(json.dumps(config, indent=2) + '\n')

# No destination logging. TUNA is the only public entrance; Dante listens on loopback.
(out / 'danted.conf').write_text('''logoutput: stderr
internal: 127.0.0.1 port = 30489
external: eth0
socksmethod: none
clientmethod: none
user.privileged: tuna-proxy
user.unprivileged: tuna-proxy
timeout.negotiate: 10
timeout.connect: 10
timeout.io: 600
client pass {
  from: 127.0.0.1/32 to: 127.0.0.1/32
}
socks pass {
  from: 127.0.0.1/32 to: 0.0.0.0/0
  command: connect
  protocol: tcp
}
socks pass {
  from: 127.0.0.1/32 to: ::/0
  command: connect
  protocol: tcp
}
''')

# Rules examine the final destination IP, including names resolved by Dante.
# Only the separate proxy uid is restricted; SSH and TUNA control traffic are untouched.
(out / 'proxy.nft').write_text(f'''destroy table inet tuna_proxy
table inet tuna_proxy {{
  chain output {{
    type filter hook output priority 0; policy accept;
    meta skuid "tuna-proxy" jump proxy_only
    ip daddr 127.0.0.1 tcp dport 30489 meta skuid != "tuna-provider" meta skuid != 0 reject
  }}
  chain proxy_only {{
    ct state established,related accept
    ip daddr {{ 127.0.0.53, 127.0.0.54 }} meta l4proto {{ tcp, udp }} th dport 53 accept
    ip daddr {{ 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16,
      172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24, 192.88.99.0/24, 192.168.0.0/16,
      198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24, 224.0.0.0/4, 240.0.0.0/4,
      {v4} }} reject
    ip6 daddr != 2000::/3 reject
    ip6 daddr {{ 2001::/23, 2001:db8::/32, 2002::/16, 3fff::/20, {v6} }} reject
    tcp dport 25 reject
    meta l4proto tcp accept
    reject
  }}
}}
''')
