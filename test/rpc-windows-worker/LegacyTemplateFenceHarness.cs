// Disposable hosted files only. No real VMGS, production path, WMI or Hyper-V call.
using System;
using System.Diagnostics;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading;
using System.Text;
using Enclave.OwnedRpc;
public static class LegacyTemplateFenceHarness {
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h,uint code);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateHardLink(string link,string target,IntPtr security);
 static long deadline;static int count;
 static void Check(bool x,string m){if(!x)throw new Exception(m);}
 static void Pass(string name){count++;Console.WriteLine("PASS "+name);}
 static void Refuse(Action f){bool refused=false;try{f();}catch{refused=true;}Check(refused,"Expected refusal");}
 static FileSecurity FileAcl(){var s=new FileSecurity();s.SetOwner(new SecurityIdentifier("S-1-5-32-544"));s.SetAccessRuleProtection(true,false);foreach(string id in new[]{"S-1-5-18","S-1-5-32-544"})s.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(id),FileSystemRights.FullControl,AccessControlType.Allow));return s;}
 static void DirectoryNew(string path){var d=new DirectorySecurity();d.SetOwner(new SecurityIdentifier("S-1-5-32-544"));d.SetAccessRuleProtection(true,false);foreach(string id in new[]{"S-1-5-18","S-1-5-32-544"})d.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(id),FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));Directory.CreateDirectory(path,d);}
 sealed class Fixture {
  public string Root,Master,Intent,Run,Next,Hash;public byte[] Bytes=new byte[]{1,7,3,9};
  public Fixture(){Root=Path.Combine(Path.GetPathRoot(Environment.SystemDirectory),"rpc-template-ci-"+Guid.NewGuid().ToString("N"));DirectoryNew(Root);DirectoryNew(Path.Combine(Root,"records"));Master=Path.Combine(Root,"master.vmgs");Intent=Path.Combine(Root,"records","definition-fence.intent");Run=Path.Combine(Root,"existing-run.vmgs");Next=Path.Combine(Root,"new-master.vmgs");foreach(string p in new[]{Master,Run,Next}){File.WriteAllBytes(p,Bytes);File.SetAccessControl(p,FileAcl());}Hash=ProtectedAttempt.Hash(Bytes);}
  public LegacyTemplateFence.Receipt Apply(){return LegacyTemplateFence.Apply(Master,Hash,Bytes.Length,ProtectedAttempt.CurrentBoot(),Intent,deadline);}
 }
 public static int Main(string[] args){try{
  if(args.Length==2&&args[0]=="read-refused"){
   try{File.ReadAllBytes(args[1]);return 7;}catch(UnauthorizedAccessException){return 0;}
  }
  Check(args.Length==0,"Unexpected fixture arguments");
  BoundedWorker.EnterSupervisorEnvelope(256UL*1024*1024);deadline=BoundedWorker.MonotonicMilliseconds()+9000;
  new Thread(()=>{while(BoundedWorker.MonotonicMilliseconds()<deadline)Thread.Sleep(5);TerminateProcess(GetCurrentProcess(),124);}){IsBackground=true}.Start();
  var f=new Fixture();var receipt=f.Apply();Check(receipt.PersistentReadDenial&&!receipt.ExistingOperationsSettled&&!receipt.ReservationMayRelease,"Narrow receipt");Pass("durable-read-denial-only");
  Refuse(()=>File.ReadAllBytes(f.Master));Refuse(()=>File.Copy(f.Master,Path.Combine(f.Root,"late-copy.vmgs")));Pass("hash-read-and-copy-refused-after-all-handles-close");
  string exe=Process.GetCurrentProcess().MainModule.FileName;
  var child=BoundedWorker.Run(exe,"\""+exe+"\" read-refused \""+f.Master+"\"",Path.GetDirectoryName(exe),
   new Dictionary<string,string>{{"SystemRoot",Environment.GetEnvironmentVariable("SystemRoot")}},deadline,1000,128UL*1024*1024);
  Check(child.LocalSuccess,"Fresh child confirms persistent access denial with exact death/job cleanup");Pass("separate-process-denial");
  string ps=Path.Combine(Environment.SystemDirectory,"WindowsPowerShell",@"v1.0\powershell.exe");
  string progress=Path.Combine(f.Root,"ps-progress.txt");
  string script="[IO.File]::WriteAllText('"+progress+"','entered');$ErrorActionPreference='Stop';$m='"+f.Master+"';$dest='"+Path.Combine(f.Root,"ps-copy.vmgs")+"';"+
   "if(-not (Test-Path -LiteralPath $m) -or (Get-Item -LiteralPath $m).Length -ne 4){exit 4};"+
   "[IO.File]::AppendAllText('"+progress+"',' metadata');$denied=0;try{Get-FileHash -LiteralPath $m -Algorithm SHA256 -ErrorAction Stop|Out-Null}catch{$denied++};"+
   "[IO.File]::AppendAllText('"+progress+"',' hashed');try{Copy-Item -LiteralPath $m -Destination $dest -ErrorAction Stop}catch{$denied++};if($denied -ne 2 -or (Test-Path -LiteralPath $dest)){exit 5};exit 0";
  var psResult=BoundedWorker.Run(ps,"\""+ps+"\" -NoProfile -NonInteractive -EncodedCommand "+Convert.ToBase64String(Encoding.Unicode.GetBytes(script)),f.Root,
   new Dictionary<string,string>{{"SystemRoot",Environment.GetEnvironmentVariable("SystemRoot")}},deadline-2000,500,128UL*1024*1024);
  Console.WriteLine("PS_PROBE timedOut="+psResult.TimedOut+" exitKnown="+psResult.ExitCodeKnown+" exit="+psResult.ExitCode+" dead="+psResult.ProcessExited+" jobEmpty="+psResult.JobEmpty+" stage="+(File.Exists(progress)?File.ReadAllText(progress):"not-entered"));
  Check(psResult.LocalSuccess,"Actual PowerShell metadata/hash/copy semantics");Pass("powershell-preflight-preserved-content-reads-denied");
  Check(File.Exists(f.Master)&&new FileInfo(f.Master).Length==4,"Metadata remains available");Pass("preflight-metadata-preserved");
  Check(ProtectedAttempt.Hash(File.ReadAllBytes(f.Run))==f.Hash&&ProtectedAttempt.Hash(File.ReadAllBytes(f.Next))==f.Hash,"Distinct copies remain readable");Pass("existing-run-and-new-master-unaffected");
  Check(File.ReadAllText(f.Intent).StartsWith("legacy-template-fence/1\n"),"Consumed intent");Refuse(()=>f.Apply());Pass("consumed-intent-no-retry");
  var wrong=new Fixture();Refuse(()=>LegacyTemplateFence.Apply(wrong.Master,new string('0',64),4,ProtectedAttempt.CurrentBoot(),wrong.Intent,deadline));Check(!File.Exists(wrong.Intent)&&File.ReadAllBytes(wrong.Master).Length==4,"No mutation for wrong hash");Pass("wrong-hash-before-intent");
  var active=new Fixture();using(var reader=File.Open(active.Master,FileMode.Open,FileAccess.Read,FileShare.Read)){Refuse(()=>active.Apply());}Check(!File.Exists(active.Intent)&&File.ReadAllBytes(active.Master).Length==4,"Open-reader refusal");Pass("existing-content-reader-prevents-fence");
  var alias=new Fixture();Check(CreateHardLink(Path.Combine(alias.Root,"alias.vmgs"),alias.Master,IntPtr.Zero),"Create fixture alias");Refuse(()=>alias.Apply());Check(!File.Exists(alias.Intent),"No alias mutation");Pass("hardlink-alias-refused");
  var consumed=new Fixture();File.WriteAllText(consumed.Intent,"preexisting-consumed-intent");File.SetAccessControl(consumed.Intent,FileAcl());
  Refuse(()=>consumed.Apply());Check(File.ReadAllBytes(consumed.Master).Length==4&&File.ReadAllText(consumed.Intent)=="preexisting-consumed-intent","No mutation or journal replacement");Pass("preexisting-intent-refused-before-DACL-mutation");
  var expired=new Fixture();Refuse(()=>LegacyTemplateFence.Apply(expired.Master,expired.Hash,4,ProtectedAttempt.CurrentBoot(),expired.Intent,BoundedWorker.MonotonicMilliseconds()-1));Check(!File.Exists(expired.Intent),"Expired no intent");Pass("expired-before-mutation");
  // Qualification restores ONLY its disposable fixture to verify byte integrity.
  // The production class deliberately exposes no release or rollback operation.
  File.SetAccessControl(f.Master,FileAcl());Check(ProtectedAttempt.Hash(File.ReadAllBytes(f.Master))==f.Hash,"Template bytes unchanged");Pass("unchanged-content-after-fixture-only-restore");
  Console.WriteLine("RESULT tests="+count+" nativeAcl=true providerCalls=false vmChanged=false");return 0;
 }catch(Exception e){Console.Error.WriteLine(e.ToString());return 1;}}
}
