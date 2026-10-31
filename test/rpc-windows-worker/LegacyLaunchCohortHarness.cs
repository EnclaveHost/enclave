// Disposable Windows processes/files. No VM or provider operation.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Enclave.OwnedRpc;
public static class LegacyLaunchCohortHarness {
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h,uint code);
 static long deadline;static int count;
 static void Check(bool ok,string message){if(!ok)throw new Exception(message);}
 static void Pass(string name){Console.WriteLine("PASS "+name);count++;}
 static void Refuse(Action f){bool no=false;try{f();}catch{no=true;}Check(no,"Expected refusal");}
 static FileSecurity FileAcl(){var s=new FileSecurity();s.SetOwner(new SecurityIdentifier("S-1-5-32-544"));s.SetAccessRuleProtection(true,false);foreach(string id in new[]{"S-1-5-18","S-1-5-32-544"})s.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(id),FileSystemRights.FullControl,AccessControlType.Allow));return s;}
 static void DirectoryNew(string path){var d=new DirectorySecurity();d.SetOwner(new SecurityIdentifier("S-1-5-32-544"));d.SetAccessRuleProtection(true,false);foreach(string id in new[]{"S-1-5-18","S-1-5-32-544"})d.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(id),FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));Directory.CreateDirectory(path,d);}
 sealed class Fixture {
  public readonly string Root,Master,Intent,Signal;public readonly byte[] Bytes=new byte[]{7,1,5,9};
  public Fixture(){Root=Path.Combine(Path.GetPathRoot(Environment.SystemDirectory),"rpc-cohort-ci-"+Guid.NewGuid().ToString("N"));DirectoryNew(Root);DirectoryNew(Path.Combine(Root,"records"));Master=Path.Combine(Root,"master.vmgs");Intent=Path.Combine(Root,"records","definition-fence.intent");Signal=Path.Combine(Root,"entered");File.WriteAllBytes(Master,Bytes);File.SetAccessControl(Master,FileAcl());}
  public LegacyLaunchCohort.Receipt Apply(LegacyLaunchCohort.Issuer[] issuers,string shell,long d){return LegacyLaunchCohort.ApplyAndDrain(issuers,shell,Master,ProtectedAttempt.Hash(Bytes),4,ProtectedAttempt.CurrentBoot(),Intent,d);}
 }
 static Process Child(Fixture f,string shell,int millis){
  string script="[IO.File]::WriteAllText('"+f.Signal+"','entered');Start-Sleep -Milliseconds "+millis+";exit 0";
  var p=Process.Start(new ProcessStartInfo(shell,"-NoProfile -NonInteractive -EncodedCommand "+Convert.ToBase64String(Encoding.Unicode.GetBytes(script))){UseShellExecute=false,CreateNoWindow=true});
  var held=p.Handle;
  while(!File.Exists(f.Signal)){Check(BoundedWorker.MonotonicMilliseconds()<deadline&&!p.HasExited,"Child did not enter");Thread.Sleep(5);}
  return p;
 }
 public static int Main(){try{
  BoundedWorker.EnterSupervisorEnvelope(256UL*1024*1024);deadline=BoundedWorker.MonotonicMilliseconds()+9000;
  new Thread(()=>{while(BoundedWorker.MonotonicMilliseconds()<deadline)Thread.Sleep(5);TerminateProcess(GetCurrentProcess(),124);}){IsBackground=true}.Start();
  var me=Process.GetCurrentProcess();string image=me.MainModule.FileName;
  var issuer=new LegacyLaunchCohort.Issuer((uint)me.Id,me.StartTime.ToUniversalTime().ToFileTimeUtc(),image);
  var issuers=new[]{issuer};string shell=Path.Combine(Environment.SystemDirectory,@"WindowsPowerShell\v1.0\powershell.exe");
  var good=new Fixture();using(var p=Child(good,shell,600)){
   long creation=p.StartTime.ToUniversalTime().ToFileTimeUtc();var r=good.Apply(issuers,shell,deadline);
   Check(r.Fence.PersistentReadDenial&&r.Exited.Length==1&&r.Exited[0].Pid==p.Id&&r.Exited[0].Created==creation&&p.HasExited,"Exact child death before cut");
   Check(!r.ProviderOperationsSettled&&!r.CapacityAdmitted&&!r.ReservationMayRelease,"No provider or capacity assertion");Pass("exact-pre-fence-child-exit-and-memory-only-receipt");
   Refuse(()=>File.ReadAllBytes(good.Master));Check(File.Exists(good.Intent),"Fence survives handle close");Pass("persistent-fence-retained-after-cut");
  }
  var empty=new Fixture();var zero=empty.Apply(issuers,shell,deadline);Check(zero.Exited.Length==0&&zero.CutAt>0,"Empty captured cohort");Pass("empty-cohort-still-applies-real-fence");
  var wrong=new Fixture();Refuse(()=>wrong.Apply(new[]{new LegacyLaunchCohort.Issuer(issuer.Pid,issuer.Created+1,image)},shell,deadline));Check(!File.Exists(wrong.Intent),"Identity refusal before mutation");Pass("wrong-creation-refused-before-fence");
  var duplicate=new Fixture();Refuse(()=>duplicate.Apply(new[]{issuer,issuer},shell,deadline));Check(!File.Exists(duplicate.Intent),"Duplicate refusal before mutation");Pass("duplicate-issuer-refused");
  var different=new Fixture();Refuse(()=>different.Apply(issuers,Path.Combine(Environment.SystemDirectory,"cmd.exe"),deadline));Check(!File.Exists(different.Intent),"Wrong topology before mutation");Pass("unsupported-shell-refused");
  var blocked=new Fixture();using(var p=Child(blocked,shell,5000)){
   try{
    long shortDeadline=BoundedWorker.MonotonicMilliseconds()+250;
    Refuse(()=>blocked.Apply(issuers,shell,shortDeadline));
    Check(File.Exists(blocked.Intent)&&!p.HasExited,"Deadline retains live child and consumed fence");
    Refuse(()=>File.ReadAllBytes(blocked.Master));Pass("deadline-keeps-fence-and-does-not-kill-live-issuer-child");
   }finally{if(!p.HasExited)p.Kill();Check(p.WaitForExit(1000),"Exact fixture child death");}
  }
  Check(!me.HasExited,"Retained issuer survives");
  Console.WriteLine("RESULT tests="+count+" nativeProcessHandles=true providerCalls=false vmChanged=false");return 0;
 }catch(Exception e){Console.Error.WriteLine(e.ToString());return 1;}}
}
