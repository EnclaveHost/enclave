// Unqualified source primitive. No caller runs merely by loading this type.
// Local process containment is NOT cancellation of a Hyper-V provider operation.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Enclave.OwnedRpc {
    public sealed class WorkerResult {
        public uint ProcessId;
        public long CreationFileTime;
        public uint ExitCode;
        public bool ProcessCreated;
        public bool ExitCodeKnown;
        public bool HandleCleanupConfirmed;
        public bool TimedOut;
        public bool ProcessExited;
        public bool JobEmpty;
        public long ElapsedMilliseconds;
        public string Failure;
        public bool LocalSuccess {
            get { return ProcessCreated && ProcessId != 0 && CreationFileTime > 0 &&
                ExitCodeKnown && ExitCode == 0 && !TimedOut && ProcessExited && JobEmpty &&
                HandleCleanupConfirmed && String.IsNullOrEmpty(Failure); }
        }
        public bool ProviderOperationFenced { get { return false; } }
        public bool ReservationMayRelease { get { return false; } }
    }

    public static class BoundedWorker {
        const uint Suspended = 4, NoWindow = 0x08000000, ExtendedStartup = 0x00080000;
        const uint UnicodeEnvironment = 0x400, KillOnClose = 0x2000;
        const uint JobMemory = 0x200, ActiveLimit = 8, AffinityLimit = 0x10;
        const uint WaitObject = 0, WaitTimeout = 258, WaitFailed = 0xffffffff;
        const int ExtendedLimitsClass = 9, AccountingClass = 1;
        // ProcThreadAttributeValue(JobList=13, thread=false, input=true, additive=false).
        static readonly IntPtr JobListAttribute = new IntPtr(0x0002000d);

        [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
            public long ProcessUserTime, JobUserTime;
            public uint Flags;
            public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass, SchedulingClass;
        }
        [StructLayout(LayoutKind.Sequential)] struct IoCounters {
            public ulong ReadOperations, WriteOperations, OtherOperations;
            public ulong ReadBytes, WriteBytes, OtherBytes;
        }
        [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
            public BasicLimits Basic;
            public IoCounters Io;
            public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
        }
        [StructLayout(LayoutKind.Sequential)] struct Accounting {
            public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
            public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
        }
        [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupInfo {
            public int Size;
            public string Reserved, Desktop, Title;
            public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
            public ushort ShowWindow, ReservedBytes;
            public IntPtr ReservedPointer, Stdin, Stdout, Stderr;
        }
        [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx {
            public StartupInfo Startup;
            public IntPtr Attributes;
        }
        [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
            public IntPtr Process, Thread;
            public uint ProcessId, ThreadId;
        }

        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError=true)]
        static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits value, uint size);
        [DllImport("kernel32.dll", SetLastError=true)]
        static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting value, uint size, IntPtr returned);
        [DllImport("kernel32.dll", SetLastError=true)]
        static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref UIntPtr size);
        [DllImport("kernel32.dll", SetLastError=true)]
        static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, UIntPtr size, IntPtr previous, IntPtr returned);
        [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes,
            IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment,
            string directory, ref StartupInfoEx startup, out ProcessInfo process);
        [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
        [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
        [DllImport("kernel32.dll", SetLastError=true)]
        static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
        [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);

        static void Check(bool ok, string operation) {
            if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
        }
        static uint Active(IntPtr job) {
            Accounting value;
            Check(QueryInformationJobObject(job, AccountingClass, out value,
                (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero), "Query owned job");
            return value.ActiveProcesses;
        }
        public static long MonotonicMilliseconds() {
            return (long)Decimal.Floor(((decimal)Stopwatch.GetTimestamp()*1000)/Stopwatch.Frequency);
        }
        static void CloseOwnedHandle(IntPtr handle, WorkerResult result) {
            if (handle != IntPtr.Zero && !CloseHandle(handle)) {
                result.HandleCleanupConfirmed=false;
                result.Failure=(result.Failure ?? "")+"; CloseHandle error "+Marshal.GetLastWin32Error();
            }
        }
        static string EnvironmentBlock(IDictionary<string,string> environment) {
            if (environment == null) throw new ArgumentNullException("environment");
            var ordered = new SortedDictionary<string,string>(StringComparer.OrdinalIgnoreCase);
            foreach (var pair in environment) {
                if (pair.Key != "SystemRoot" && pair.Key != "WINDIR" && pair.Key != "PATH" &&
                    pair.Key != "TEMP" && pair.Key != "TMP") throw new ArgumentException("Environment key refused");
                if (pair.Value == null || pair.Value.IndexOf('\0') >= 0 || pair.Value.Length > 4096)
                    throw new ArgumentException("Environment value refused");
                ordered.Add(pair.Key, pair.Value);
            }
            if (!ordered.ContainsKey("SystemRoot")) throw new ArgumentException("SystemRoot required");
            var block = new StringBuilder();
            foreach (var pair in ordered) block.Append(pair.Key).Append('=').Append(pair.Value).Append('\0');
            return block.Append('\0').ToString();
        }

        // Caller must qualify/pin executable, argv, environment, working directory,
        // ACL ancestry and all script/module bytes. This is not an authorization API.
        // There is deliberately no shell, process lookup by PID or inherited handle.
        public static WorkerResult Run(string application, string commandLine, string directory,
            IDictionary<string,string> environment, long absoluteDeadlineMs, int cleanupMs, ulong memoryBytes) {
            if (IntPtr.Size != 8 || Environment.OSVersion.Platform != PlatformID.Win32NT)
                throw new PlatformNotSupportedException("64-bit Windows required");
            if (!Path.IsPathRooted(application) || !Path.IsPathRooted(directory) ||
                application.IndexOf('\0') >= 0 || directory.IndexOf('\0') >= 0 ||
                commandLine == null || commandLine.IndexOf('\0') >= 0 || commandLine.Length > 30000)
                throw new ArgumentException("Explicit bounded executable and command required");
            long remaining=absoluteDeadlineMs-MonotonicMilliseconds();
            if (remaining < 1 || remaining > 30000 || cleanupMs < 1 || cleanupMs > 5000 ||
                memoryBytes < 16UL*1024*1024 || memoryBytes > 256UL*1024*1024)
                throw new ArgumentOutOfRangeException("Worker bounds");
            string block = EnvironmentBlock(environment);
            var clock = Stopwatch.StartNew();
            var result = new WorkerResult();
            IntPtr job=IntPtr.Zero, attributes=IntPtr.Zero, jobList=IntPtr.Zero, env=IntPtr.Zero;
            bool attributesInitialized=false, created=false;
            ProcessInfo process = new ProcessInfo();
            try {
                job=CreateJobObject(IntPtr.Zero, null);
                Check(job != IntPtr.Zero, "Create private job");
                var limits = new ExtendedLimits();
                limits.Basic.Flags=KillOnClose|JobMemory|ActiveLimit|AffinityLimit;
                limits.Basic.ActiveProcessLimit=4;
                limits.Basic.Affinity=new UIntPtr(2); // CPU 1; never widen on failure.
                limits.JobMemory=new UIntPtr(memoryBytes);
                Check(SetInformationJobObject(job, ExtendedLimitsClass, ref limits,
                    (uint)Marshal.SizeOf(typeof(ExtendedLimits))), "Set private job limits");
                UIntPtr size=UIntPtr.Zero;
                bool sized=InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);
                int sizeError=Marshal.GetLastWin32Error();
                if (sized || sizeError != 122 || size.ToUInt64()==0 || size.ToUInt64()>65536)
                    throw new InvalidOperationException("Unexpected attribute size result");
                attributes=Marshal.AllocHGlobal((int)size.ToUInt64());
                Check(InitializeProcThreadAttributeList(attributes,1,0,ref size), "Initialize job attribute");
                attributesInitialized=true;
                jobList=Marshal.AllocHGlobal(IntPtr.Size);
                Marshal.WriteIntPtr(jobList,job);
                Check(UpdateProcThreadAttribute(attributes,0,JobListAttribute,jobList,
                    new UIntPtr((uint)IntPtr.Size),IntPtr.Zero,IntPtr.Zero), "Set creation-time job list");
                env=Marshal.StringToHGlobalUni(block);
                var startup=new StartupInfoEx();
                startup.Startup.Size=Marshal.SizeOf(typeof(StartupInfoEx));
                startup.Attributes=attributes;
                if (MonotonicMilliseconds() >= absoluteDeadlineMs) { result.TimedOut=true; return result; }
                // Atomic creation-time membership closes the parent-death gap between
                // CreateProcess and AssignProcessToJobObject. Never fall back to that gap.
                Check(CreateProcess(application,new StringBuilder(commandLine),IntPtr.Zero,IntPtr.Zero,
                    false,Suspended|NoWindow|ExtendedStartup|UnicodeEnvironment,env,directory,
                    ref startup,out process), "Create contained suspended worker");
                created=true;
                result.ProcessCreated=true;
                result.ProcessId=process.ProcessId;
                long exit,kernel,user,creation;
                Check(GetProcessTimes(process.Process,out creation,out exit,out kernel,out user), "Read exact process identity");
                result.CreationFileTime=creation;
                if (MonotonicMilliseconds() >= absoluteDeadlineMs) result.TimedOut=true;
                else {
                    uint resumed=ResumeThread(process.Thread);
                    if (resumed != 1) throw new InvalidOperationException("Unexpected suspension count");
                    while (MonotonicMilliseconds() < absoluteDeadlineMs) {
                        uint state=WaitForSingleObject(process.Process,0);
                        if (state==WaitObject) { result.ProcessExited=true; break; }
                        if (state==WaitFailed) throw new Win32Exception(Marshal.GetLastWin32Error(),"Wait worker");
                        if (state!=WaitTimeout) throw new InvalidOperationException("Unexpected wait status");
                        Thread.Sleep((int)Math.Min(20,Math.Max(1,absoluteDeadlineMs-MonotonicMilliseconds())));
                    }
                    if (!result.ProcessExited) result.TimedOut=true;
                }
            } catch (Exception error) {
                result.Failure=error.GetType().Name+": "+error.Message;
            } finally {
                if (created) {
                    // Also remove descendants after normal parent exit. No async child
                    // is allowed to outlive this one-shot worker invocation.
                    bool requested=TerminateJobObject(job,0xE0000001);
                    int terminateError=Marshal.GetLastWin32Error();
                    var cleanup=Stopwatch.StartNew();
                    try {
                        while (cleanup.ElapsedMilliseconds < cleanupMs) {
                            uint state=WaitForSingleObject(process.Process,0);
                            if (state==WaitFailed) throw new Win32Exception(Marshal.GetLastWin32Error(),"Wait cleanup");
                            result.ProcessExited=(state==WaitObject);
                            result.JobEmpty=(Active(job)==0);
                            if (result.ProcessExited && result.JobEmpty) break;
                            Thread.Sleep(10);
                        }
                        uint code;
                        if (result.ProcessExited) {
                            Check(GetExitCodeProcess(process.Process,out code),"Get worker exit");
                            result.ExitCode=code;
                            result.ExitCodeKnown=true;
                        }
                        if (!requested && !result.JobEmpty)
                            throw new Win32Exception(terminateError,"Terminate owned job");
                        if (!result.ProcessExited || !result.JobEmpty)
                            throw new InvalidOperationException("Cleanup unconfirmed; retain reservation");
                    } catch (Exception error) {
                        result.Failure=(result.Failure ?? "")+"; cleanup: "+error.Message;
                    }
                }
                result.HandleCleanupConfirmed=true;
                CloseOwnedHandle(process.Thread,result);
                CloseOwnedHandle(process.Process,result);
                CloseOwnedHandle(job,result); // KILL_ON_JOB_CLOSE remains a final backstop, not proof.
                if (attributesInitialized) DeleteProcThreadAttributeList(attributes);
                if (attributes!=IntPtr.Zero) Marshal.FreeHGlobal(attributes);
                if (jobList!=IntPtr.Zero) Marshal.FreeHGlobal(jobList);
                if (env!=IntPtr.Zero) Marshal.FreeHGlobal(env);
                result.ElapsedMilliseconds=clock.ElapsedMilliseconds;
            }
            return result;
        }
    }
}
