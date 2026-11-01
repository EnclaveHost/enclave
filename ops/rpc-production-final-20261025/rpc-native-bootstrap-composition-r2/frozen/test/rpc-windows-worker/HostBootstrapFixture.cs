// COMPILE-TIME hosted qualification only. No Hyper-V/TPM/network use. Native
// parent, anonymous pipes, identities, jobs and SYSTEM namespace remain real.
using System;
using System.IO;
using System.Text;
using System.Threading;
namespace Enclave.OwnedRpc {
 internal static class HostBootstrapFixture {
  static string root,mode;static int bytes;static bool replied;
  static readonly ManualResetEvent ready=new ManualResetEvent(false);
  internal static void Open(string path){root=path;mode=File.ReadAllText(Path.Combine(root,"fixture.mode"));}
  internal static int Read(byte[] b){
   ready.WaitOne();lock(ready){if(!replied){replied=true;byte[] answer=Encoding.ASCII.GetBytes("monitor-ok\n");Buffer.BlockCopy(answer,0,b,0,answer.Length);return answer.Length;}}
   Thread.Sleep(8000);throw new IOException("Fixture natural bound");
  }
  internal static int Write(byte[] b){
   if(mode=="blocked-monitor"){
    using(var f=new FileStream(Path.Combine(root,"fixture.blocked.pending"),FileMode.CreateNew,FileAccess.Write,FileShare.None)){f.WriteByte(1);f.Flush(true);}
      File.Move(Path.Combine(root,"fixture.blocked.pending"),Path.Combine(root,"fixture.blocked"));
    Thread.Sleep(8000);throw new IOException("Fixture natural bound");
   }
   foreach(byte c in b)if(c!=(byte)'m')throw new IOException("Fixture monitor payload differs");
   bytes+=b.Length;if(bytes>100000)throw new IOException("Fixture monitor bound");if(bytes==100000)ready.Set();return b.Length;
  }
 }
}
