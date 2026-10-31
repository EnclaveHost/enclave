// Windows startup storage checks and physical headroom. No changes to host
// security settings or volumes; journal directory ACL is installed explicitly.
import {execFile} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import {randomBytes} from 'node:crypto';
const quote=s=>"'"+String(s).replaceAll("'","''")+"'";
function powershell(script){return new Promise((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from("$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';"+script,'utf16le').toString('base64')],{windowsHide:true,timeout:10000,maxBuffer:65536},(e,stdout)=>{if(e)return reject(Error('host storage or memory check failed'));try{resolve(JSON.parse(stdout));}catch{reject(Error('invalid host check result'));}}));}
// On Windows libuv queries GlobalMemoryStatusEx (ullAvailPhys) in-process.
// Spawning PowerShell here consumes memory during the admission measurement.
export async function availableMemoryMiB({platform=process.platform,freeMemory=os.freemem}={}){
 if(platform!=='win32')throw Error('physical headroom requires the Windows host');
 const bytes=freeMemory();
 if(!Number.isSafeInteger(bytes)||bytes<=0)throw Error('physical memory unknown');
 return Math.floor(bytes/(1024*1024));
}
export async function checkJournalStorage(file){
 if(process.platform!=='win32')return;
 const r=await powershell(`
 $f=Get-Item -LiteralPath ${quote(file)} -Force;
 $d=$f.Directory;
 $v=Get-Volume -DriveLetter $f.PSDrive.Name;
 if([string]$v.FileSystem -ne 'NTFS' -or [string]$v.DriveType -ne 'Fixed'){throw 'journal volume must be fixed local NTFS'};
 foreach($p in @($f,$d)){
  $acl=Get-Acl -LiteralPath $p.FullName;
  if(-not $acl.AreAccessRulesProtected){throw 'journal ACL inheritance enabled'};
  if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne 'S-1-5-18'){throw 'journal owner must be SYSTEM'};
  $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));
  if($rules.Count -lt 2){throw 'journal ACL incomplete'};
  foreach($a in $rules){
   if($a.IsInherited -or $a.AccessControlType -ne 'Allow' -or $a.IdentityReference.Value -notin @('S-1-5-18','S-1-5-32-544')){throw 'journal ACL grants another identity'};
  }
 }
 $p=$f;while($p){if(($p.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'journal ancestry is a reparse point'};$p=if($p -is [IO.FileInfo]){$p.Directory}else{$p.Parent}};
 @{ok=$true}|ConvertTo-Json -Compress`);
 if(r.ok!==true)throw Error('journal storage not verified');
}
// Only the running service owns the journal. An unclean exit leaves a stale
// lock for the documented offline procedure; PID absence never clears it here.
export function lockJournal(file){
 const lock=file+'.lock',token=randomBytes(32).toString('hex');
 const fd=fs.openSync(lock,'wx',0o600);
 try{fs.writeFileSync(fd,JSON.stringify({pid:process.pid,token,createdAt:new Date().toISOString()}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 return ()=>{try{const row=JSON.parse(fs.readFileSync(lock));if(row.pid===process.pid&&row.token===token)fs.unlinkSync(lock);}catch{}};
}
