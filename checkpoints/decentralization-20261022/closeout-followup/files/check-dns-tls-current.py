import datetime, hashlib, http.client, json, pathlib, socket, ssl

host = '59f1273d.app.enclave.host'
context = ssl.create_default_context()
result = {'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'url': 'https://' + host + '/', 'observations': []}
addresses = sorted({item[4][0] for item in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)})
for address in addresses:
    observation = {'address': address}
    try:
        with socket.create_connection((address, 443), timeout=15) as raw:
            with context.wrap_socket(raw, server_hostname=host) as conn:
                cert = conn.getpeercert()
                observation.update(trustedHostnameAndChain=True, expires=cert['notAfter'], issuer=cert['issuer'], sha256=hashlib.sha256(conn.getpeercert(binary_form=True)).hexdigest())
                conn.sendall(('GET /api/status HTTP/1.1\r\nHost: ' + host + '\r\nConnection: close\r\n\r\n').encode())
                response = http.client.HTTPResponse(conn)
                response.begin()
                observation['httpStatus'] = response.status
                observation['responseBytesRead'] = len(response.read(65536))
    except Exception as exc:
        observation['error'] = str(exc)
    result['observations'].append(observation)
result['healthy'] = bool(addresses) and all(x.get('trustedHostnameAndChain') and x.get('httpStatus') == 200 for x in result['observations'])
result['limitation'] = 'Current public DNS addresses only; does not prove future renewal or provider independence.'
pathlib.Path('outputs/decentralization-audit/enclavedns-tls-followup-20261023T0317Z.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
raise SystemExit(0 if result['healthy'] else 1)
