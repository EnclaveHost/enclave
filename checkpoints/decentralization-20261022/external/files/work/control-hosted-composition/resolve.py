from pathlib import Path
import re
root=Path(__file__).resolve().parent
pattern=re.compile(r'<<<<<<< MCP\n(.*?)=======\n(.*?)>>>>>>> API\n',re.S)
def mc(i,a,b):
 if i in [1,4]:return a+b
 if i==2:return b.replace("['leaseGas', 'platformApi']","['leaseGas', 'mcp', 'platformApi']")
 if i==3:
  cut='  });\n}\n';al,ar=a.split(cut,1);bl,br=b.split(cut,1)
  return al+bl+cut+ar+'}\n'+br
 if i==5:return a.split('  return ',1)[0]+b.replace('selling: !!fw.registryKey, platformApi','selling: !!fw.registryKey, mcp, platformApi')
 if i==6:return b.replace('      ...(runtime.platformApiSha256',"      ...(runtime.mcpSha256 !== undefined ? { mcpSha256: runtime.mcpSha256 } : {}),\n      ...(runtime.platformApiSha256")
 if i==7:
  b=b.replace("mode = 'snp', maxQueue = 8,","mode = 'snp', maxQueue = 8, routes = [],")
  validation=a.split('  parseStatement(statementText);\n',1)[1]
  b=b.replace('  parseStatement(statementText);\n','  parseStatement(statementText);\n'+validation)
  return b.replace('prefixRoutes.find((r) => pathname.startsWith(r.prefix)) || null','prefixRoutes.find((r) => pathname.startsWith(r.prefix)) || routes.find((r) => pathname === r.path) || null')
 if i==8:return b.replace('    const up = http.request',"    const toPath = route?.rewrite ? route.rewrite + u.search : u.pathname + u.search;\n    const up = http.request").replace('path: u.pathname + u.search, headers','path: toPath, headers')
 if i==9:return a.replace('[] });','[],')+b
 raise ValueError(i)
def gsup(i,a,b):
 if i==1:
  return b.replace('      ...(plan.platformApi',"      ...(plan.mcp ? { mcpSha256: fileSha(MC.MCP_BUNDLE) } : {}),\n      ...(plan.platformApi",1).replace('    ...(plan.platformApi ? { hostRoutes:',"    routes: plan.mcp ? [plan.mcp.route] : [],\n    ...(plan.platformApi ? { hostRoutes:")
 if i==2:return a+'  }\n'+b
 raise ValueError(i)
for rel,handler,count in [('metal/guest/measured-control.mjs',mc,9),('metal/guest/gsup.mjs',gsup,2),('metal/build-image.mjs',lambda i,a,b:a+b,2)]:
 p=root/'merged'/rel;s=p.read_text();matches=list(pattern.finditer(s));assert len(matches)==count,(rel,len(matches));it=iter(range(1,count+1));s=pattern.sub(lambda m:handler(next(it),m[1],m[2]),s)
 if rel.endswith('/measured-control.mjs'):
  mark="  if ([8080, 8091, 8443].includes(controlPort)) bad('controlPort must not be a port another guest service listens on');\n"
  s=s.replace(mark,mark+"  const mcp = raw.mcp !== undefined ? directMcp(raw.mcp, { contracts, controlPort }) : null;\n  const platformApi = raw.platformApi !== undefined ? directPlatformApi(raw.platformApi, { controlPort }) : null;\n  if (mcp && platformApi && [platformApi.apiPort, platformApi.peerPort].includes(mcp.port)) bad('mcp.port must differ from both platformApi ports');\n")
  s=s.replace("...(raw.mcp !== undefined ? { mcp: directMcp(raw.mcp, { contracts, controlPort }) } : {})","...(mcp ? { mcp } : {})")
  s=s.replace("...(raw.platformApi !== undefined ? { platformApi: directPlatformApi(raw.platformApi, { controlPort }) } : {})","...(platformApi ? { platformApi } : {})")
 assert '<<<<<<<' not in s;p.write_text(s)
