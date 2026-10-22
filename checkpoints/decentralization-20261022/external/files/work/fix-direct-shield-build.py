from pathlib import Path
r=Path('work/shield-lineage-integration/isolation/m2/front')
p=r/'main.go';s=p.read_text().replace('"fmt"','"fmt"\n"io"',1);p.write_text(s)
p=r/'shield_direct_test.go';s=p.read_text().replace('"not released to an Enclave Shield partition"','"no custody startup channel"');p.write_text(s)
p=r/'oracle_test.go';s=p.read_text().replace('"front/shield_secrets.go front.serveShieldSecrets: f.askMonitor",','"front/shield_direct_custody.go front.shieldCustodyEvidence: f.askMonitor", // Shield custody domain + owner + v2 release binding; monitor supplies AppID\n\t\t"front/shield_secrets.go front.serveShieldSecrets: f.askMonitor",');p.write_text(s)
p=r/'shield_direct.go';s=p.read_text().replace('//   - custody-v2. Not released to this tier yet: refused here (the domain ends) rather than run without its values.','//   - custody-v2. Released directly by the owner-selected committee under explicit Shield rules; the runtime waits\n//     until the package, bundle config, egress and fresh lease agree. No relay release is accepted.');p.write_text(s)
