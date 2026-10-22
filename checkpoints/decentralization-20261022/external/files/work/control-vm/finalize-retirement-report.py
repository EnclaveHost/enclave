from pathlib import Path
import json,datetime
base=Path('outputs');storage=json.loads((base/'storage-retirement-backup.json').read_text());control=json.loads((base/'control-recovery-backup.json').read_text());integrity=json.loads((base/'storage-retirement-backup-integrity.json').read_text())
assert len(storage['replicas'])==4 and all(x['sha256Verified'] for x in storage['replicas'])
assert len(control['providers'])==4 and len(control['supplement']['providers'])==4
assert control['decryptAndArchiveIntegrityVerified'] and control['supplement']['decryptAndArchiveIntegrityVerified']
assert integrity['authenticatedDecryptionPassed'] and integrity['allSnapshotFileHashesVerified']
for name in ['nan-migration-progress.json','nan-retirement-verification.json']:
 p=base/name;r=json.loads(p.read_text());r.update({'reportFinalizedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'storageBackup':'retirement snapshot after historical import, verified on all four providers','storageBackupEvidence':'storage-retirement-backup.json','storageBackupIntegrityEvidence':'storage-retirement-backup-integrity.json','backupDecryptionKeysCopiedToProviders':False,'sourceCommit':'eecb7634dc6d323600cd2e6adb3d002d51abd533'});p.write_text(json.dumps(r,indent=2)+'\n')
p=base/'nan-migration-status.txt';s=p.read_text();s=s.replace('\nComplete censorship resistance', '\nRecovery: encrypted control and refreshed storage backups are verified on all four providers. Control recovery requires both its main archive and supplement. Storage snapshot contains 1,489 objects after the historical import. See control-recovery-runbook.txt and indexd-recovery-runbook.txt; preserve the separate local decryption material. Full control-VM restore rehearsal remains unperformed.\n\nValidation: 28 targeted migration tests and an isolated 61-test CLI rerun passed. Contracts, end-to-end and Go CI passed for eecb7634; the full unit CI job remains failed (details in nan-retirement-ci.json).\n\nComplete censorship resistance');p.write_text(s)
print('Final report and both recovery records complete')
