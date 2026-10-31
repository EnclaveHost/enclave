// Compile separately as a disposable CI fixture; never stage this executable.
using System;
using System.Threading;
using Enclave.OwnedRpc;

public static class ClockSampleHarness {
    public static int Main(string[] args) {
        if(args.Length!=1 || args[0]!="blocked-main")return 64;
        ClockSample.Arm(BoundedWorker.MonotonicMilliseconds());
        BoundedWorker.EnterSupervisorEnvelope(128UL*1024*1024);
        Console.WriteLine("watchdog-armed");
        Thread.Sleep(Timeout.Infinite);
        return 99;
    }
}
