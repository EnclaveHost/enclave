// Windows-only test infrastructure. The unnamed job contains this fixture and its
// future descendants, never processes selected by command line or executable name.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

namespace Enclave.Testing {
    public sealed class JobCleanup {
        public bool ok;
        public int found;
        public int[] killed = new int[0];
        public string why;
    }

    public sealed class FixtureJob : IDisposable {
        private IntPtr job;
        private readonly int self = Process.GetCurrentProcess().Id;
        private const uint Access = 0x0001 | 0x1000 | 0x00100000; // terminate, query-limited, synchronize
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError=true)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError=true)]
        private static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr info, uint size, IntPtr length);
        [DllImport("kernel32.dll", SetLastError=true)]
        private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
        [DllImport("kernel32.dll", SetLastError=true)]
        private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
        [DllImport("kernel32.dll", SetLastError=true)]
        private static extern bool TerminateProcess(IntPtr process, uint code);
        [DllImport("kernel32.dll", SetLastError=true)]
        private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll")]
        private static extern bool CloseHandle(IntPtr handle);

        public FixtureJob() {
            // No inheritable/named handle, breakaway permission, or kill-on-close.
            // Nested assignment must succeed before any test workload is launched.
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject");
            using (Process current = Process.GetCurrentProcess()) {
                if (!AssignProcessToJobObject(job, current.Handle)) {
                    int error = Marshal.GetLastWin32Error(); Dispose();
                    throw new Win32Exception(error, "fixture job assignment refused");
                }
            }
        }

        public bool Contains(IntPtr processHandle) {
            if (job == IntPtr.Zero) throw new ObjectDisposedException("FixtureJob");
            bool member;
            if (!IsProcessInJob(processHandle, job, out member))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "IsProcessInJob");
            return member;
        }

        private int[] Members() {
            if (job == IntPtr.Zero) throw new ObjectDisposedException("FixtureJob");
            // Bounded allocation. A larger or changing list fails closed, never
            // treats a truncated query as proof that cleanup finished.
            const int capacity = 8192;
            int size = 8 + capacity * IntPtr.Size;
            IntPtr data = Marshal.AllocHGlobal(size);
            try {
                if (!QueryInformationJobObject(job, 3, data, (uint)size, IntPtr.Zero))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "job membership query");
                int assigned = Marshal.ReadInt32(data, 0), count = Marshal.ReadInt32(data, 4);
                if (count < 1 || count > capacity || assigned != count)
                    throw new InvalidOperationException("incomplete job membership query");
                int[] result = new int[count]; bool hasSelf = false;
                for (int i=0; i<count; i++) {
                    result[i] = checked((int)Marshal.ReadIntPtr(data, 8 + i * IntPtr.Size).ToInt64());
                    hasSelf |= result[i] == self;
                }
                if (!hasSelf) throw new InvalidOperationException("fixture missing from its job");
                return result;
            } finally { Marshal.FreeHGlobal(data); }
        }

        public JobCleanup StopChildren(int budgetMs) {
            JobCleanup result = new JobCleanup();
            HashSet<int> seen = new HashSet<int>(); List<int> killed = new List<int>();
            Stopwatch clock = Stopwatch.StartNew();
            try {
                while (clock.ElapsedMilliseconds < budgetMs) {
                    int[] members = Members();
                    if (members.Length == 1) { result.ok = true; break; }
                    foreach (int pid in members) {
                        if (pid == self) continue;
                        seen.Add(pid);
                        if (clock.ElapsedMilliseconds >= budgetMs) break;
                        IntPtr process = OpenProcess(Access, false, pid);
                        if (process == IntPtr.Zero) {
                            int error = Marshal.GetLastWin32Error();
                            if (error == 87) continue; // exited since the snapshot; re-query below
                            throw new Win32Exception(error, "open job member " + pid);
                        }
                        try {
                            // Check membership and terminate through the SAME open
                            // handle. Reuse of the numeric PID cannot change its target.
                            if (WaitForSingleObject(process, 0) == 0 || !Contains(process)) continue;
                            if (TerminateProcess(process, 125)) killed.Add(pid);
                            else if (WaitForSingleObject(process, 0) != 0)
                                throw new Win32Exception(Marshal.GetLastWin32Error(), "terminate own job member " + pid);
                            int left = Math.Max(0, budgetMs - (int)clock.ElapsedMilliseconds);
                            uint wait = WaitForSingleObject(process, (uint)Math.Min(5000, left));
                            if (wait == 0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error(), "wait for own child");
                        } finally { CloseHandle(process); }
                    }
                    // Descendants created during cleanup remain in this same job.
                    // Re-query, rather than trusting the original member snapshot.
                    int pause = Math.Min(10, Math.Max(0, budgetMs - (int)clock.ElapsedMilliseconds));
                    if (pause > 0) Thread.Sleep(pause);
                }
                if (!result.ok) result.why = "job drain not confirmed within cleanup budget";
            } catch (Exception e) { result.why = e.GetType().Name + ": " + e.Message; }
            result.found = seen.Count; result.killed = killed.ToArray();
            return result;
        }

        public void Dispose() {
            if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; }
            // No kill-on-close: UNKNOWN leaves evidence and reports recovery required.
        }
    }
}
