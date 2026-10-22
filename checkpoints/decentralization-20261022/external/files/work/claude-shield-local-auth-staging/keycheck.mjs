// STAGING ONLY: the REAL readCustodyCallbackKey (win32: Get-Acl through powershell.exe) on each path given; never prints key bytes.
import { readCustodyCallbackKey, windowsAclOf } from "./manager/custody-key-file.mjs";
for (const f of process.argv.slice(2)) {
  let verdict; try { verdict = `ACCEPTED ${readCustodyCallbackKey(f).length} bytes`; } catch (e) { verdict = `REFUSED ${e.message}`; }
  let acl = null; try { acl = windowsAclOf(f); } catch (e) { acl = e.message; }
  console.log(JSON.stringify({ file: f.split("\\").pop(), verdict, acl }));
}
