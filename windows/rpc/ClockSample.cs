// Read-only clock handshake, not a VM/controller admission or process-death receipt.
using System;
using System.Globalization;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

namespace Enclave.OwnedRpc {
    public static class ClockSample {
        [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
        // Fixed five seconds from entry. The caller's original cross-host startup
        // window starts BEFORE transport and includes CLR/SSH bootstrap time.
        internal static void Arm(long origin) {
            if(origin<0 || origin>Int64.MaxValue-5000)throw new ArgumentOutOfRangeException("origin");
            long deadline=origin+5000;
            var armed=new ManualResetEvent(false);
            var watchdog=new Thread(delegate() {
                armed.Set();
                while(BoundedWorker.MonotonicMilliseconds()<deadline)
                    Thread.Sleep((int)Math.Max(1,Math.Min(10,deadline-BoundedWorker.MonotonicMilliseconds())));
                if(!TerminateProcess(GetCurrentProcess(),124))Environment.FailFast("Clock deadline termination failed");
            });
            watchdog.IsBackground=true;watchdog.Start();
            if(!armed.WaitOne(1000) || BoundedWorker.MonotonicMilliseconds()>=deadline)
                throw new TimeoutException("Clock watchdog did not arm in time");
            // Event and job handles live until OS teardown; no close/query race.
        }
        static void Identity(string value) {
            if(value==null || value.Length!=32)throw new ArgumentException("Clock identity length");
            foreach(char c in value)if(!((c>='0'&&c<='9')||(c>='a'&&c<='f')))
                throw new ArgumentException("Clock identity encoding");
        }
        internal static string Capture(string attempt,string vmAttempt) {
            Identity(attempt);Identity(vmAttempt);
            string boot=ProtectedAttempt.CurrentBoot();
            long sample=BoundedWorker.MonotonicMilliseconds();
            Identity(boot);
            if(sample<0)throw new InvalidOperationException("Clock sample negative");
            return "{\"schema\":\"owned-rpc-windows-clock/1\",\"attempt\":\""+attempt+
                "\",\"vmAttempt\":\""+vmAttempt+"\",\"windowsBoot\":\""+boot+
                "\",\"monotonicMilliseconds\":"+sample.ToString(CultureInfo.InvariantCulture)+"}";
        }
        static void VerifyImage(string expected) {
            if(expected==null || expected.Length!=64)throw new ArgumentException("Image digest length");
            foreach(char c in expected)if(!((c>='0'&&c<='9')||(c>='a'&&c<='f')))throw new ArgumentException("Image digest encoding");
            using(var self=Process.GetCurrentProcess())
            using(var file=new FileStream(self.MainModule.FileName,FileMode.Open,FileAccess.Read,FileShare.Read)) {
                if(file.Length<1 || file.Length>262144)throw new InvalidOperationException("Clock image size");
                byte[] bytes=new byte[(int)file.Length];int offset=0;
                while(offset<bytes.Length){int n=file.Read(bytes,offset,bytes.Length-offset);if(n==0)throw new IOException("Short image read");offset+=n;}
                if(file.ReadByte()!=-1 || ProtectedAttempt.Hash(bytes)!=expected)throw new InvalidOperationException("Clock image differs");
            }
            // This verifies bytes at the image path. Protected target namespace
            // staging/ancestor authority must precede transport; not established here.
        }
        public static int Main(string[] args) {
            long origin=BoundedWorker.MonotonicMilliseconds();
            try {
                Arm(origin);
                var envelope=BoundedWorker.EnterSupervisorEnvelope(128UL*1024*1024);
                if(!envelope.MembershipVerified || !envelope.LimitsVerified)throw new InvalidOperationException("Clock envelope differs");
                if(args.Length!=3)return 64;
                VerifyImage(args[2]);
                string result=Capture(args[0],args[1]);
                if(BoundedWorker.MonotonicMilliseconds()>=origin+5000)return 124;
                Console.WriteLine(result);return 0;
            } catch {return 1;}
        }
    }
}
