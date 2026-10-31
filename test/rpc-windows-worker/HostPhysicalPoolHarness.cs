// Actual Windows file sharing/ACL and cross-process fixtures. No Hyper-V calls.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Enclave.OwnedRpc;
public static class HostPhysicalPoolHarness {
    const long MiB=1048576;
    static int passed;static long deadline;
    [DllImport("kernel32.dll")]static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")]static extern bool TerminateProcess(IntPtr process,uint code);
    static void Check(bool yes,string why){if(!yes)throw new Exception(why);}
    static void Refuse(Action a,string text){try{a();}catch(Exception e){if(e.Message.IndexOf(text,StringComparison.OrdinalIgnoreCase)>=0)return;throw;}throw new Exception("Expected refusal: "+text);}
    static void Pass(string name,Action body){body();passed++;Console.WriteLine("PASS "+name);}
    static FileSecurity Security(){var s=new FileSecurity();s.SetOwner(new SecurityIdentifier("S-1-5-32-544"));s.SetAccessRuleProtection(true,false);
        foreach(string sid in new[]{"S-1-5-18","S-1-5-32-544"})s.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),FileSystemRights.FullControl,AccessControlType.Allow));return s;}
    static void Write(string path,string value){using(var f=new FileStream(path,FileMode.CreateNew,FileSystemRights.ReadData|FileSystemRights.WriteData|FileSystemRights.ReadPermissions,FileShare.None,4096,FileOptions.WriteThrough,Security())){byte[] b=Encoding.UTF8.GetBytes(value);f.Write(b,0,b.Length);f.Flush(true);}}
    static void Capture(Stream stream,Action<byte[]> completed,Action failed,ManualResetEvent done) {
        new Thread(()=>{try{using(var bytes=new MemoryStream(2048)){
            var buffer=new byte[256];int n;
            while((n=stream.Read(buffer,0,buffer.Length))!=0){if(bytes.Length+n>2048){failed();return;}bytes.Write(buffer,0,n);}
            completed(bytes.ToArray());
        }}catch{failed();}finally{done.Set();}}){IsBackground=true}.Start();
    }
    static int Transport(string[] args) {
        var f=new Fixture(2048*MiB);string parent=System.IO.Path.GetDirectoryName(f.Root),exe=System.IO.Path.Combine(parent,"physical-pool-command.exe");
        byte[] bytes=File.ReadAllBytes(args[0]);Check(bytes.Length<262144,"Command bound");
        using(var file=new FileStream(exe,FileMode.CreateNew,FileSystemRights.ReadData|FileSystemRights.WriteData|FileSystemRights.ReadPermissions,FileShare.None,4096,FileOptions.WriteThrough,Security())){file.Write(bytes,0,bytes.Length);file.Flush(true);}
        string script=System.IO.Path.Combine(parent,"physical-pool-transport.mjs");
        Write(script,File.ReadAllText(args[2]));
        Write(System.IO.Path.Combine(parent,"physical-reservations.mjs"),File.ReadAllText(System.IO.Path.Combine(System.IO.Path.GetDirectoryName(args[2]),"..","..","windows","vbslike","manager","physical-reservations.mjs")));
        string argv="\""+script+"\" \""+exe+"\" "+ProtectedAttempt.Hash(bytes)+" \""+f.Path+"\" "+f.Hash+" "+f.Boot;
        using(var child=new Process{StartInfo=new ProcessStartInfo(args[1],argv){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true}}) {
            byte[] output=null,error=null;int captureFailed=0;var outDone=new ManualResetEvent(false);var errDone=new ManualResetEvent(false);
            Check(child.Start(),"Node launch");var held=child.Handle;
            Action failed=()=>{Interlocked.Exchange(ref captureFailed,1);try{child.Kill();}catch{}};
            Capture(child.StandardOutput.BaseStream,b=>{output=b;},failed,outDone);
            Capture(child.StandardError.BaseStream,b=>{error=b;},failed,errDone);
            try{
                Check(Finish(child)==0,"Actual Node transport result");
                Check(outDone.WaitOne((int)Math.Max(1,deadline-BoundedWorker.MonotonicMilliseconds()))&&errDone.WaitOne((int)Math.Max(1,deadline-BoundedWorker.MonotonicMilliseconds())),"Node bounded output completion");
                string line=output==null?null:new UTF8Encoding(false,true).GetString(output);
                Check(captureFailed==0&&error!=null&&error.Length==0&&line=="RESULT actualNodeTransport=7 vmChanged=false\n","Exact Node protocol test result");Console.Write(line);
            }finally{if(!child.HasExited){child.Kill();Check(child.WaitForExit(1000),"Exact Node death");}}
        }
        Check(Directory.GetFiles(f.Root,"*.claim").Length==2&&Directory.GetFiles(f.Root,"*.dispatch").Length==2,"Exactly two durable claims and dispatches");
        Check(Directory.GetFiles(f.Root,"*.pending").Length==0,"No unaccounted publication");
        Console.WriteLine("RESULT transportLedgerVerified=true vmChanged=false");return 0;
    }
    sealed class Fixture {
        internal readonly string Root,Path,Hash,Boot;
        internal Fixture(long capacity) {
            var sec=new DirectorySecurity();sec.SetOwner(new SecurityIdentifier("S-1-5-32-544"));sec.SetAccessRuleProtection(true,false);
            foreach(string sid in new[]{"S-1-5-18","S-1-5-32-544"})sec.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),FileSystemRights.FullControl,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
            string parent=System.IO.Path.Combine(System.IO.Path.GetPathRoot(Environment.SystemDirectory),"rpc-pool-ci-"+Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(parent,sec);string nonce=Guid.NewGuid().ToString("N");Root=System.IO.Path.Combine(parent,nonce);Directory.CreateDirectory(Root,sec);
            Boot=ProtectedAttempt.CurrentBoot();Path=System.IO.Path.Combine(Root,"pool.txt");
            string config="host-physical-pool/1\n"+nonce+"\n"+Boot+"\n"+capacity+"\n";Hash=ProtectedAttempt.Hash(Encoding.UTF8.GetBytes(config));Write(Path,config);Write(System.IO.Path.Combine(Root,"pool.lock"),"");
        }
        internal HostPhysicalPool Open(){return new HostPhysicalPool(Path,Hash,deadline);}
        internal PhysicalClaim Claim(char id,long mib,string actor="app-legacy"){return new PhysicalClaim(Hash,Boot,actor,new string(id,64),mib*MiB);}
    }
    static Process Child(Fixture f,string mode,char id,string actor,string gate) {
        var p=new Process();p.StartInfo=new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName,
            "child \""+f.Path+"\" "+f.Hash+" "+mode+" "+id+" "+actor+" \""+gate+"\" "+deadline){UseShellExecute=false,CreateNoWindow=true};
        Check(p.Start(),"Child launch");var held=p.Handle;return p;
    }
    static void WaitFile(string path){while(!File.Exists(path)){if(BoundedWorker.MonotonicMilliseconds()>=deadline)throw new Exception("Fixture rendezvous timeout");Thread.Sleep(5);}}
    static int Finish(Process p){if(!p.WaitForExit((int)Math.Max(1,deadline-BoundedWorker.MonotonicMilliseconds())))throw new Exception("Exact child did not exit");return p.ExitCode;}
    static void Stop(Process p){if(!p.HasExited)p.Kill();Check(p.WaitForExit(1000),"Held child death");p.Dispose();}
    static int ChildMain(string[] args) {
        string path=args[1],hash=args[2],mode=args[3],id=args[4],actor=args[5],gate=args[6];
        deadline=Int64.Parse(args[7]);BoundedWorker.EnterSupervisorEnvelope(128UL*1024*1024);
        using(var pool=new HostPhysicalPool(path,hash,deadline)) {
            Write(gate+"."+id+".ready","");WaitFile(gate);
            if(mode=="lock")using(var held=File.Open(System.IO.Path.Combine(System.IO.Path.GetDirectoryName(path),"pool.lock"),FileMode.Open,FileAccess.ReadWrite,FileShare.None)) {
                Write(gate+".locked","");while(BoundedWorker.MonotonicMilliseconds()<deadline)Thread.Sleep(10);return 3;
            }
            var c=new PhysicalClaim(hash,pool.Boot,actor,new string(mode=="consume"?'a':id[0],64),1024*MiB);
            try {if(mode=="consume")pool.ConsumeStart(c);else pool.Acquire(c);return 0;}
            catch(Win32Exception e){if(e.NativeErrorCode==32)return 21;throw;}
            catch(InvalidOperationException e){if(e.Message=="Shared physical capacity exhausted"||e.Message=="Physical start already consumed")return 22;throw;}
        }
    }
    public static int Main(string[] args){try {
        if(args.Length==8&&args[0]=="child")return ChildMain(args);
        Check(args.Length==0||args.Length==3,"Arguments");BoundedWorker.EnterSupervisorEnvelope(256UL*1024*1024);
        deadline=BoundedWorker.MonotonicMilliseconds()+15000;
        new Thread(()=>{while(BoundedWorker.MonotonicMilliseconds()<deadline)Thread.Sleep(10);TerminateProcess(GetCurrentProcess(),124);}){IsBackground=true}.Start();
        if(args.Length==3)return Transport(args);
        Pass("durable exact claim",()=>{var f=new Fixture(2048*MiB);using(var p=f.Open())p.Acquire(f.Claim('a',1024));Check(File.ReadAllText(System.IO.Path.Combine(f.Root,new string('a',64)+".claim"))==f.Claim('a',1024).Encode(),"Claim persisted");});
        Pass("all actors share one ceiling",()=>{var f=new Fixture(2048*MiB);using(var p=f.Open()){p.Acquire(f.Claim('a',1024));p.Acquire(f.Claim('b',1024,"rpc"));Refuse(()=>p.Acquire(f.Claim('c',1024,"app-native")),"capacity exhausted");}});
        Pass("idempotent acquire does not resize or change actor",()=>{var f=new Fixture(2048*MiB);using(var p=f.Open()){p.Acquire(f.Claim('a',1024));p.Acquire(f.Claim('a',1024));Refuse(()=>p.Acquire(f.Claim('a',2048)),"Conflicting claim");Refuse(()=>p.Acquire(f.Claim('a',1024,"rpc")),"Conflicting claim");}});
        Pass("pool hash and boot binding",()=>{var f=new Fixture(2048*MiB);Refuse(()=>{using(var p=new HostPhysicalPool(f.Path,new string('f',64),deadline)){}},"configuration differs");using(var p=f.Open())Refuse(()=>p.Acquire(new PhysicalClaim(f.Hash,new string('0',32),"rpc",new string('a',64),MiB)),"Wrong shared pool");});
        Pass("dispatch consumes once without poisoning later claims",()=>{var f=new Fixture(2048*MiB);using(var p=f.Open()){p.Acquire(f.Claim('a',1024));p.ConsumeStart(f.Claim('a',1024));Refuse(()=>p.ConsumeStart(f.Claim('a',1024)),"already consumed");p.Acquire(f.Claim('b',1024,"rpc"));}Check(Directory.GetFiles(f.Root,"*.pending").Length==0,"Duplicate did not poison pool");});
        Pass("lost response reopening still holds claim and consumed dispatch",()=>{var f=new Fixture(1024*MiB);using(var p=f.Open()){p.Acquire(f.Claim('a',1024));p.ConsumeStart(f.Claim('a',1024));}using(var p=f.Open()){p.Acquire(f.Claim('a',1024));Refuse(()=>p.ConsumeStart(f.Claim('a',1024)),"already consumed");Refuse(()=>p.Acquire(f.Claim('b',1024)),"capacity exhausted");}});
        Pass("partial publication refuses all new admission",()=>{var f=new Fixture(2048*MiB);Write(System.IO.Path.Combine(f.Root,new string('a',64)+".claim.pending"),"");using(var p=f.Open())Refuse(()=>p.Acquire(f.Claim('b',1024)),"Incomplete or unknown");});
        Pass("unknown records cannot be omitted",()=>{var f=new Fixture(2048*MiB);Write(System.IO.Path.Combine(f.Root,"unexpected"),"");using(var p=f.Open())Refuse(()=>p.Acquire(f.Claim('a',1024)),"Incomplete or unknown");});
        Pass("expired worker cannot acquire",()=>{var f=new Fixture(2048*MiB);Refuse(()=>{using(var p=new HostPhysicalPool(f.Path,f.Hash,BoundedWorker.MonotonicMilliseconds()-1)){}},"deadline required");});
        Pass("two real processes cannot oversell",()=>{var f=new Fixture(1024*MiB);string gate=System.IO.Path.Combine(System.IO.Path.GetDirectoryName(f.Root),"gate");var a=Child(f,"acquire",'a',"app-legacy",gate);var b=Child(f,"acquire",'b',"rpc",gate);try{WaitFile(gate+".a.ready");WaitFile(gate+".b.ready");Write(gate,"");int x=Finish(a),y=Finish(b);Check((x==0&&(y==21||y==22))||(y==0&&(x==21||x==22)),"Exactly one admitted");Check(Directory.GetFiles(f.Root,"*.claim").Length==1,"One durable claim");}finally{Stop(a);Stop(b);}});
        Pass("two real processes cannot consume one start twice",()=>{var f=new Fixture(1024*MiB);using(var p=f.Open())p.Acquire(f.Claim('a',1024));string gate=System.IO.Path.Combine(System.IO.Path.GetDirectoryName(f.Root),"gate");var a=Child(f,"consume",'a',"app-legacy",gate);var b=Child(f,"consume",'b',"app-legacy",gate);try{WaitFile(gate+".a.ready");WaitFile(gate+".b.ready");Write(gate,"");int x=Finish(a),y=Finish(b);Check((x==0&&(y==21||y==22))||(y==0&&(x==21||x==22)),"One dispatch");Check(Directory.GetFiles(f.Root,"*.dispatch").Length==1,"One durable dispatch");}finally{Stop(a);Stop(b);}});
        Pass("lock-owner death releases kernel lock but not its durable commitments",()=>{var f=new Fixture(2048*MiB);using(var p=f.Open())p.Acquire(f.Claim('a',1024));string gate=System.IO.Path.Combine(System.IO.Path.GetDirectoryName(f.Root),"gate");var child=Child(f,"lock",'l',"rpc",gate);try{WaitFile(gate+".l.ready");Write(gate,"");WaitFile(gate+".locked");try{using(var p=f.Open())p.Acquire(f.Claim('b',1024));throw new Exception("Lock not held");}catch(Win32Exception e){Check(e.NativeErrorCode==32,"Exact sharing violation");}child.Kill();Check(child.WaitForExit(1000),"Exact owner death");using(var p=f.Open()){p.Acquire(f.Claim('b',1024));Refuse(()=>p.Acquire(f.Claim('c',1024)),"capacity exhausted");}}finally{Stop(child);}});
        Pass("unreserved and orphan dispatch refuse",()=>{var f=new Fixture(2048*MiB);using(var p=f.Open())Refuse(()=>p.ConsumeStart(f.Claim('a',1024)),"Unreserved");Write(System.IO.Path.Combine(f.Root,new string('a',64)+".dispatch"),f.Claim('a',1024).Encode());using(var p=f.Open())Refuse(()=>p.Acquire(f.Claim('b',1024)),"Unbound dispatch");});
        Pass("preexisting over-budget ledger refuses instead of truncating",()=>{var f=new Fixture(1024*MiB);Write(System.IO.Path.Combine(f.Root,new string('a',64)+".claim"),f.Claim('a',2048).Encode());using(var p=f.Open())Refuse(()=>p.Acquire(f.Claim('b',1024)),"already exceeded");});
        Check(passed==14,"Case count");Console.WriteLine("RESULT tests=14 nativeFileSharing=true providerCalls=false vmChanged=false");return 0;
    }catch(Exception e){Console.Error.WriteLine(e);return 1;}}
}
