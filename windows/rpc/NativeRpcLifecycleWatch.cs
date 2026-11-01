// Separate SYSTEM lifecycle entrypoint. Caller prepares/pins contract, entry.exe
// and worker.exe before scheduling this one-shot process. No implicit activation.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
namespace Enclave.OwnedRpc {
 // The watch thread does not execute native start or depend on its caller's loop.
 // Exactly one dispatch occurs. A failed dispatch is held, never retried.
 internal sealed class NativeLifecycleWatch {
  internal readonly ManualResetEvent Armed=new ManualResetEvent(false),Done=new ManualResetEvent(false);internal Exception Failure;internal string Reason;int invoked,abort;
  internal void Abort(){Interlocked.Exchange(ref abort,1);}
  internal NativeLifecycleWatch(long origin,long deadline,Func<long> clock,Func<bool> failed,Action<string> cleanup){
   if(origin<0||deadline<=origin||deadline-origin>900000||clock==null||failed==null||cleanup==null)throw new ArgumentException("Original lifecycle watch");long now=clock();if(now<origin||now>=deadline)throw new InvalidOperationException("Original lifecycle already expired");
   new Thread(delegate(){Armed.Set();try{long last=now;while(true){if(Thread.VolatileRead(ref abort)!=0){Reason="original-binding-failure";break;}long t=clock();if(t<last){Reason="clock-rollback";break;}last=t;if(t>=deadline){Reason="original-deadline";break;}try{if(failed()){Reason="original-worker-failure";break;}}catch{Reason="peer-observation-failure";break;}Thread.Sleep(5);}if(Interlocked.CompareExchange(ref invoked,1,0)!=0)throw new InvalidOperationException("Cleanup consumed");cleanup(Reason);}catch(Exception e){Failure=e;}finally{Done.Set();}}){IsBackground=true}.Start();
   if(!Armed.WaitOne(1000))throw new InvalidOperationException("Independent lifecycle watch unarmed");
  }
 }
}
