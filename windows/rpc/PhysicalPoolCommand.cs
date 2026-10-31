// Fixed host-owner ledger command. No VM/provider operation, pool creation or release.
// Caller must reserve 128MiB post-entry +64MiB bootstrap and serialize invocations.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
namespace Enclave.OwnedRpc {
    public static class PhysicalPoolCommand {
        static readonly DateTime Epoch=new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc);
        static long Number(string text){return Int64.Parse(text,NumberStyles.None,CultureInfo.InvariantCulture);}
        static void Check(long end){if(BoundedWorker.MonotonicMilliseconds()>=end)throw new TimeoutException("Pool command expired");}
        static void PinImage(string hash,List<IDisposable> held,long end) {
            string path;using(var self=Process.GetCurrentProcess())path=self.MainModule.FileName;
            ProtectedAttempt.LocalPath(path);string root=Path.GetDirectoryName(path),current=Path.GetPathRoot(root);
            var paths=new List<string>{current};foreach(string part in root.Substring(3).Split('\\')){current=Path.Combine(current,part);paths.Add(current);}
            for(int i=0;i<paths.Count;i++){
                Check(end);var h=ProtectedAttempt.CreateFile(paths[i],0x20000|0x80,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
                if(h.IsInvalid){int error=Marshal.GetLastWin32Error();h.Dispose();throw new Win32Exception(error);}
                held.Add(h);ProtectedAttempt.Authority(h,i==paths.Count-1,true,paths[i]);
            }
            var image=ProtectedAttempt.CreateFile(path,0x80000000|0x20000,1,IntPtr.Zero,3,0x00200000,IntPtr.Zero);
            if(image.IsInvalid){int error=Marshal.GetLastWin32Error();image.Dispose();throw new Win32Exception(error);}
            held.Add(image);ProtectedAttempt.Authority(image,true,false,path);
            var stream=new FileStream(image,FileAccess.Read);held.Add(stream);
            if(stream.Length<1||stream.Length>262144)throw new InvalidOperationException("Command image size");
            var bytes=new byte[(int)stream.Length];int offset=0;
            while(offset<bytes.Length){Check(end);int n=stream.Read(bytes,offset,bytes.Length-offset);if(n==0)throw new IOException("Short command image");offset+=n;}
            if(stream.ReadByte()!=-1||ProtectedAttempt.Hash(bytes)!=hash)throw new InvalidOperationException("Command image differs");Check(end);
        }
        public static int Main(string[] args) {
            long origin=BoundedWorker.MonotonicMilliseconds();var held=new List<IDisposable>();
            try {
                if(args.Length!=11)throw new ArgumentException("Fixed pool command arguments");
                foreach(string arg in args)if(arg==null||arg.Length>512||arg.IndexOfAny(new[]{'\0','\r','\n','"'})>=0)throw new ArgumentException("Argument bound");
                string operation=args[0];if(operation!="acquire"&&operation!="consume")throw new ArgumentException("Fixed pool operation");
                StartIdentity.Hex(args[7],32);StartIdentity.Hex(args[10],64);
                long issued=Number(args[8]),until=Number(args[9]),utc=(DateTime.UtcNow.Ticks-Epoch.Ticks)/10000;
                if(issued>Int64.MaxValue-5000||until-issued!=5000||utc<issued||utc-issued>=2000||until<=utc)throw new ArgumentException("Expired caller request");
                // Absolute monotonic cutoff is fixed once; UTC changes cannot renew it.
                long end=checked(origin+until-utc);ProviderWorkerEntry.ArmOriginalDeadline(origin,end);
                BoundedWorker.EnterSupervisorEnvelope(128UL*1024*1024);ProtectedAttempt.RequireAdministrator();
                var claim=new PhysicalClaim(args[2],args[3],args[4],args[5],Number(args[6]));
                PinImage(args[10],held,end);
                using(var pool=new HostPhysicalPool(args[1],args[2],end)) {
                    if(operation=="acquire")pool.Acquire(claim);else pool.ConsumeStart(claim);
                }
                Check(end);
                Console.WriteLine(new JavaScriptSerializer().Serialize(new{schema="host-physical-pool-result/1",operation=operation,
                    poolHash=claim.PoolHash,boot=claim.Boot,actor=claim.Actor,id=claim.Id,bytes=claim.Bytes,nonce=args[7],imageHash=args[10]}));
                return 0;
            }catch {Console.Error.WriteLine("Physical pool command refused; any durable claim remains held");return 1;}
            finally {for(int i=held.Count-1;i>=0;i--)held[i].Dispose();}
        }
    }
}
