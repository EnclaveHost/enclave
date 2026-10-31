// Read-only sampler qualification. Never invoke a lifecycle/provider entry point.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

namespace Enclave.OwnedRpc {
    public static class ClockQualification {
        [StructLayout(LayoutKind.Sequential)] struct Memory {
            public uint Length,Load;
            public ulong Total,Available,PageTotal,PageAvailable,VirtualTotal,VirtualAvailable,Extended;
        }
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool GlobalMemoryStatusEx(ref Memory memory);
        [DllImport("kernel32.dll",SetLastError=true)] static extern SafeWaitHandle OpenProcess(uint access,bool inherit,uint pid);
        [DllImport("kernel32.dll",SetLastError=true)] static extern uint GetProcessId(SafeWaitHandle process);
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(SafeWaitHandle process,out long creation,out long exit,out long kernel,out long user);
        [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(SafeWaitHandle process,uint milliseconds);
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(SafeWaitHandle process,uint flags,StringBuilder path,ref int size);
        static readonly SecurityIdentifier Admin=new SecurityIdentifier("S-1-5-32-544"),SystemUser=new SecurityIdentifier("S-1-5-18");
        static readonly List<IDisposable> Held=new List<IDisposable>();
        static readonly JavaScriptSerializer Json=new JavaScriptSerializer { MaxJsonLength=8192,RecursionLimit=8 };
        static long Deadline;
        static void Current() { if(BoundedWorker.MonotonicMilliseconds()>=Deadline)throw new TimeoutException("Original clock qualification deadline"); }
        static void Hex(string value,int length) {
            if(value==null||value.Length!=length)throw new ArgumentException("Identity length");
            foreach(char c in value)if(!((c>='0'&&c<='9')||(c>='a'&&c<='f')))throw new ArgumentException("Identity encoding");
        }
        static void Namespace(string root) {
            string path=Path.GetPathRoot(root);var parts=root.Substring(3).Split('\\');
            for(int i=-1;i<parts.Length;i++) {
                if(i>=0)path=Path.Combine(path,parts[i]);
                var handle=ProtectedAttempt.CreateFile(path,0x20000|0x80,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
                if(handle.IsInvalid){handle.Dispose();throw new IOException("Namespace open failed");}
                Held.Add(handle);ProtectedAttempt.Authority(handle,i==parts.Length-1,true,path);Current();
            }
        }
        static FileStream Image(string path,string expected) {
            Hex(expected,64);ProtectedAttempt.LocalPath(path);
            var handle=ProtectedAttempt.CreateFile(path,0x80000000|0x20000,1,IntPtr.Zero,3,0x00200000,IntPtr.Zero);
            if(handle.IsInvalid){handle.Dispose();throw new IOException("Held image open failed");}
            Held.Add(handle);ProtectedAttempt.Authority(handle,true,false,path);
            var file=new FileStream(handle,FileAccess.Read);Held.Add(file);
            if(file.Length<1||file.Length>262144)throw new IOException("Image bound");
            byte[] raw=new byte[(int)file.Length];int offset=0;
            while(offset<raw.Length){Current();int n=file.Read(raw,offset,raw.Length-offset);if(n==0)throw new IOException("Short image");offset+=n;}
            if(file.ReadByte()!=-1||ProtectedAttempt.Hash(raw)!=expected)throw new IOException("Image pin differs");
            Current();return file;
        }
        static void WriteNew(string path,byte[] raw) {
            Current();
            var acl=new FileSecurity();acl.SetOwner(Admin);acl.SetAccessRuleProtection(true,false);
            foreach(var sid in new[]{Admin,SystemUser})acl.AddAccessRule(new FileSystemAccessRule(sid,FileSystemRights.FullControl,AccessControlType.Allow));
            using(var file=new FileStream(path,FileMode.CreateNew,FileSystemRights.FullControl,FileShare.None,4096,FileOptions.WriteThrough,acl)) {
                file.Write(raw,0,raw.Length);file.Flush(true);
            }
        }
        static List<SafeWaitHandle> Managers(string encoded,bool hosted) {
            var rows=new List<SafeWaitHandle>();var ids=new HashSet<int>();
            if(hosted){if(encoded!="none")throw new ArgumentException("CI manager fixture");return rows;}
            string[] parts=encoded.Split(',');if(parts.Length!=4)throw new ArgumentException("Four original managers required");
            foreach(string part in parts) {
                string[] pair=part.Split(':');if(pair.Length!=2)throw new ArgumentException("Manager identity pair");
                int pid=Int32.Parse(pair[0],NumberStyles.None,CultureInfo.InvariantCulture);
                long creation=Int64.Parse(pair[1],NumberStyles.None,CultureInfo.InvariantCulture);
                if(pid<=0||creation<=0||!ids.Add(pid))throw new ArgumentException("Manager incarnation");
                var process=OpenProcess(0x101000,false,(uint)pid);Held.Add(process);
                long actual,exit,kernel,user;var image=new StringBuilder(512);int size=image.Capacity;
                if(process.IsInvalid||GetProcessId(process)!=(uint)pid||!GetProcessTimes(process,out actual,out exit,out kernel,out user)||actual!=creation||
                    WaitForSingleObject(process,0)!=258||!QueryFullProcessImageName(process,0,image,ref size)||
                    !String.Equals(image.ToString(),@"C:\Program Files\Enclave\runtime\node\node.exe",StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("Original manager changed");
                rows.Add(process);Current();
            }
            return rows;
        }
        public static int Main(string[] args) {
            long origin=BoundedWorker.MonotonicMilliseconds();Deadline=origin+5000;
            Process child=null;
            try {
                // Same fixed five-second watchdog as the qualified sampler. There
                // is no PowerShell bootstrap or raised memory/deadline allowance.
                ClockSample.Arm(origin);
                var envelope=BoundedWorker.EnterSupervisorEnvelope(128UL*1024*1024);
                ProtectedAttempt.RequireAdministrator();
                bool hosted=false;
#if CLOCK_QUALIFICATION_CI
                hosted=true;
                if(Environment.GetEnvironmentVariable("GITHUB_ACTIONS")!="true"||Environment.GetEnvironmentVariable("RUNNER_ENVIRONMENT")!="github-hosted")return 64;
#endif
                if(args.Length!=7||args[0]!=(hosted?"--hosted-ci":"--target"))return 64;
                string root=ProtectedAttempt.LocalPath(args[1]),nonce=args[2],boot=args[3],sampleHash=args[4],selfHash=args[5];
                Hex(nonce,32);Hex(boot,32);Hex(sampleHash,64);Hex(selfHash,64);
                if(root!=@"C:\EnclaveRpcClock-"+nonce+@"\"+nonce||ProtectedAttempt.CurrentBoot()!=boot)
                    throw new InvalidOperationException("Exact clock namespace/boot differs");
                Namespace(root);
                using(var self=Process.GetCurrentProcess()) {
                    if(!String.Equals(self.MainModule.FileName,Path.Combine(root,"clock-controller.exe"),StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Controller image location differs");
                    Image(self.MainModule.FileName,selfHash);
                }
                var memory=new Memory();memory.Length=(uint)Marshal.SizeOf(typeof(Memory));
                if(!GlobalMemoryStatusEx(ref memory)||memory.Available<(hosted?3UL*1024*1024*1024:62709039104UL))
                    throw new InvalidOperationException("Retained pending-aware memory floor refused");
                var managers=Managers(args[6],hosted);
                byte[] contract=Encoding.UTF8.GetBytes("owned-rpc-inert-v1\n"+nonce+"\n"+boot+"\n"+origin+"\n"+Deadline+"\n"+sampleHash+"\ninert-v1\n");
                // All ancestors are already held and qualified before creation;
                // PinController additionally binds the immutable lease and entry.
                WriteNew(Path.Combine(root,"contract.txt"),contract);
                using(var pin=ProtectedAttempt.PinController(Path.Combine(root,"contract.txt"),ProtectedAttempt.Hash(contract))) {
                    string sample=Path.Combine(root,"clock-sample.exe");Image(sample,sampleHash);
                    WriteNew(Path.Combine(root,"qualification.intent"),Encoding.UTF8.GetBytes("one read-only sampler; no production startup\n"));
                    Current();long before=BoundedWorker.MonotonicMilliseconds();
                    if(Deadline-before<1000)throw new TimeoutException("Insufficient original child window");
                    child=Process.Start(new ProcessStartInfo(sample,nonce+" "+nonce+" "+sampleHash){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true,WorkingDirectory=root});
                    IntPtr exact=child.Handle;int pid=child.Id;long creation=child.StartTime.ToUniversalTime().ToFileTimeUtc();
                    if(!child.WaitForExit((int)Math.Min(1000,Deadline-BoundedWorker.MonotonicMilliseconds())))throw new TimeoutException("Sampler did not complete within original child window");
                    long after=BoundedWorker.MonotonicMilliseconds();
                    var buffer=new char[8193];int count=child.StandardOutput.ReadBlock(buffer,0,buffer.Length);
                    if(count>8192||child.StandardError.Read()!=-1||child.ExitCode!=0)throw new InvalidOperationException("Sampler output/exit differs");
                    var row=Json.Deserialize<Dictionary<string,object>>(new string(buffer,0,count));
                    if(row.Count!=5||(string)row["schema"]!="owned-rpc-windows-clock/1"||(string)row["attempt"]!=nonce||(string)row["vmAttempt"]!=nonce||(string)row["windowsBoot"]!=boot)
                        throw new InvalidOperationException("Sampler binding differs");
                    long time=Convert.ToInt64(row["monotonicMilliseconds"],CultureInfo.InvariantCulture);
                    if(time<before||time>after)throw new InvalidOperationException("Sampler time outside observed interval");
                    foreach(var process in managers)if(WaitForSingleObject(process,0)!=258)throw new InvalidOperationException("Original manager exited");
                    Current();
                    using(var self=Process.GetCurrentProcess())Console.WriteLine(Json.Serialize(new{
                        schema="owned-rpc-target-clock-qualification/1",passed=true,hostedCi=hosted,root=root,sourceSha256=sampleHash,
                        boot=boot,origin=origin,deadline=Deadline,before=before,after=after,sample=row,samplerPid=pid,samplerCreation=creation,
                        samplerExit=child.ExitCode,samplerExactDeath=child.HasExited,supervisorPid=self.Id,supervisorCreation=self.StartTime.ToUniversalTime().ToFileTimeUtc(),
                        supervisorEnvelope=envelope,freeBytes=memory.Available,prospectiveMiB=39388,floorMiB=18432,managersUnchanged=true,
                        productionClockAssigned=false,vmChanged=false,systemContextQualified=false}));
                }
                return 0;
            }catch(Exception error){Console.Error.WriteLine(error.GetType().Name+": "+error.Message);return 1;}
            finally {
                if(child!=null){try{if(!child.HasExited){child.Kill();child.WaitForExit(500);}}finally{child.Dispose();}}
                for(int i=Held.Count-1;i>=0;i--)Held[i].Dispose();
            }
        }
    }
}
