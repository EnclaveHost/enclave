// One host owner's durable physical budget. Not a live resource measurement.
// Every allocator must enroll; callers must run in independently bounded workers.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Enclave.OwnedRpc {
    public sealed class PhysicalClaim {
        public readonly string PoolHash,Boot,Actor,Id;
        public readonly long Bytes;
        public PhysicalClaim(string poolHash,string boot,string actor,string id,long bytes) {
            StartIdentity.Hex(poolHash,64);StartIdentity.Hex(boot,32);StartIdentity.Hex(id,64);
            if(actor!="app-legacy"&&actor!="app-native"&&actor!="rpc")throw new ArgumentException("Enrolled allocator role");
            if(bytes<=0||bytes>9007199254740991L||bytes%1048576!=0)throw new ArgumentException("Integral bounded physical MiB");
            PoolHash=poolHash;Boot=boot;Actor=actor;Id=id;Bytes=bytes;
        }
        public string Encode(){return "host-physical-claim/1\n"+PoolHash+"\n"+Boot+"\n"+Actor+"\n"+Id+"\n"+Bytes.ToString(CultureInfo.InvariantCulture)+"\n";}
        public static PhysicalClaim Decode(string value) {
            string[] f=value.Split('\n');if(f.Length!=7||f[0]!="host-physical-claim/1"||f[6]!="")throw new InvalidOperationException("Claim schema");
            var c=new PhysicalClaim(f[1],f[2],f[3],f[4],Int64.Parse(f[5],NumberStyles.None,CultureInfo.InvariantCulture));
            if(c.Encode()!=value)throw new InvalidOperationException("Canonical claim required");return c;
        }
    }
    public sealed class HostPhysicalPool : IDisposable {
        static readonly UTF8Encoding Utf8=new UTF8Encoding(false,true);
        readonly List<IDisposable> held=new List<IDisposable>();
        readonly List<SafeFileHandle> directories=new List<SafeFileHandle>();
        readonly string root,owner;
        readonly long deadline;
        bool disposed;
        public readonly string Hash,Boot;
        public readonly long CapacityBytes;
        // Config is immutable and pre-provisioned by the host owner in a protected
        // namespace. No automatic empty-pool creation or reboot/reset/release.
        public HostPhysicalPool(string configPath,string expectedHash,long workerDeadline) {
            ProtectedAttempt.RequireAdministrator();ProtectedAttempt.LocalPath(configPath);StartIdentity.Hex(expectedHash,64);
            if(Path.GetFileName(configPath)!="pool.txt")throw new ArgumentException("Fixed pool configuration name");
            long now=BoundedWorker.MonotonicMilliseconds();
            if(workerDeadline<=now||workerDeadline-now>30000)throw new ArgumentException("Bounded worker deadline required");
            deadline=workerDeadline;root=Path.GetDirectoryName(configPath);Hash=expectedHash;
            using(var identity=WindowsIdentity.GetCurrent())owner=identity.User.Value=="S-1-5-18"?"S-1-5-18":"S-1-5-32-544";
            try {
                string current=Path.GetPathRoot(root);DirectoryPin(current,false);
                string[] segments=root.Substring(3).Split('\\');
                for(int i=0;i<segments.Length;i++){current=Path.Combine(current,segments[i]);DirectoryPin(current,i==segments.Length-1);}
                string config=Read("pool.txt",2048);
                if(ProtectedAttempt.Hash(Utf8.GetBytes(config))!=Hash)throw new InvalidOperationException("Pool configuration differs");
                string[] f=config.Split('\n');
                if(f.Length!=5||f[0]!="host-physical-pool/1"||f[4]!="")throw new InvalidOperationException("Pool schema");
                StartIdentity.Hex(f[1],32);StartIdentity.Hex(f[2],32);
                if(Path.GetFileName(root)!=f[1])throw new InvalidOperationException("Pool namespace differs");
                Boot=f[2];CapacityBytes=Int64.Parse(f[3],NumberStyles.None,CultureInfo.InvariantCulture);
                if(Boot!=ProtectedAttempt.CurrentBoot()||CapacityBytes<=0||CapacityBytes>9007199254740991L||CapacityBytes%1048576!=0||
                    CapacityBytes.ToString(CultureInfo.InvariantCulture)!=f[3])throw new InvalidOperationException("Pool boot/capacity differs");
                Check();
            }catch{Dispose();throw;}
        }
        void DirectoryPin(string path,bool strict) {
            var h=ProtectedAttempt.CreateFile(path,0x20000|0x80,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
            if(h.IsInvalid){int e=Marshal.GetLastWin32Error();h.Dispose();throw new Win32Exception(e);}
            held.Add(h);directories.Add(h);ProtectedAttempt.Authority(h,strict,true,path);
        }
        void Check() {
            if(disposed||BoundedWorker.MonotonicMilliseconds()>=deadline)throw new InvalidOperationException("Pool worker expired");
            for(int i=0;i<directories.Count;i++)ProtectedAttempt.Authority(directories[i],i==directories.Count-1,true,"held pool ancestor");
        }
        FileStream Open(string name,uint access,uint share) {
            Check();var h=ProtectedAttempt.CreateFile(Path.Combine(root,name),access|0x20000,share,IntPtr.Zero,3,0x00200000,IntPtr.Zero);
            if(h.IsInvalid){int e=Marshal.GetLastWin32Error();h.Dispose();throw new Win32Exception(e);}
            try{ProtectedAttempt.Authority(h,true,false,name);return new FileStream(h,(access&0x40000000)!=0?FileAccess.ReadWrite:FileAccess.Read);}
            catch{h.Dispose();throw;}
        }
        string Read(string name,int maximum) {
            // Keep every observed record immutable until this transaction object
            // closes. No WRITE/DELETE sharing, including immutable config.
            var stream=Open(name,0x80000000,1);held.Add(stream);
            if(stream.Length<1||stream.Length>maximum)throw new InvalidOperationException("Pool record bound");
            var bytes=new byte[(int)stream.Length];int offset=0,n;
            while(offset<bytes.Length){Check();n=stream.Read(bytes,offset,bytes.Length-offset);if(n==0)throw new IOException("Short pool record");offset+=n;}
            if(stream.ReadByte()!=-1)throw new IOException("Pool record grew");Check();return Utf8.GetString(bytes);
        }
        FileStream Lock() {
            // The pre-created exact lock inode is never removed or replaced. A
            // sharing violation refuses this operation; no wait/reset/stale-lock
            // deletion. Windows closes this kernel handle when its owner dies.
            var stream=Open("pool.lock",0x80000000|0x40000000,0);
            if(stream.Length!=0){stream.Dispose();throw new InvalidOperationException("Pool lock contents");}return stream;
        }
        Dictionary<string,PhysicalClaim> Snapshot(out HashSet<string> consumed) {
            Check();var claims=new Dictionary<string,PhysicalClaim>(StringComparer.Ordinal);
            consumed=new HashSet<string>(StringComparer.Ordinal);int count=0;long total=0;
            foreach(string path in Directory.EnumerateFileSystemEntries(root)) {
                Check();if(++count>514)throw new InvalidOperationException("Pool record count");
                string name=Path.GetFileName(path);if(name=="pool.txt"||name=="pool.lock")continue;
                string suffix=name.EndsWith(".claim",StringComparison.Ordinal)?".claim":name.EndsWith(".dispatch",StringComparison.Ordinal)?".dispatch":null;
                // Even zero-length pending/unknown entries are ambiguous. No
                // reset after a lost response, partial write, or restart.
                if(suffix==null)throw new InvalidOperationException("Incomplete or unknown pool record");
                string id=name.Substring(0,name.Length-suffix.Length);StartIdentity.Hex(id,64);
                if(suffix==".dispatch"){consumed.Add(id);continue;}
                var c=PhysicalClaim.Decode(Read(name,2048));
                if(c.Id!=id||c.PoolHash!=Hash||c.Boot!=Boot||claims.ContainsKey(id))throw new InvalidOperationException("Claim association differs");
                claims.Add(id,c);total=checked(total+c.Bytes);
            }
            if(total>CapacityBytes)throw new InvalidOperationException("Shared capacity already exceeded");
            foreach(string id in consumed) {
                PhysicalClaim c;if(!claims.TryGetValue(id,out c)||Read(id+".dispatch",2048)!=c.Encode())throw new InvalidOperationException("Unbound dispatch");
            }
            Check();return claims;
        }
        void Publish(string name,string value) {
            Check();byte[] bytes=Utf8.GetBytes(value);
            var security=new FileSecurity();security.SetOwner(new SecurityIdentifier(owner));security.SetAccessRuleProtection(true,false);
            foreach(string sid in new[]{"S-1-5-18","S-1-5-32-544"})security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid),FileSystemRights.FullControl,AccessControlType.Allow));
            string pending=Path.Combine(root,name+".pending");
            using(var stream=new FileStream(pending,FileMode.CreateNew,FileSystemRights.ReadData|FileSystemRights.WriteData|FileSystemRights.ReadPermissions,
                FileShare.None,4096,FileOptions.WriteThrough,security)) {
                ProtectedAttempt.Authority(stream.SafeFileHandle,true,false,pending);stream.Write(bytes,0,bytes.Length);stream.Flush(true);
            }
            Check();File.Move(pending,Path.Combine(root,name));
            if(Read(name,2048)!=value)throw new IOException("Published pool record differs");Check();
        }
        void Bind(PhysicalClaim claim) {Check();if(claim==null||claim.PoolHash!=Hash||claim.Boot!=Boot)throw new InvalidOperationException("Wrong shared pool claim");}
        public void Acquire(PhysicalClaim claim) {
            Bind(claim);using(var gate=Lock()) {
                HashSet<string> consumed;var claims=Snapshot(out consumed);PhysicalClaim old;
                if(claims.TryGetValue(claim.Id,out old)){if(old.Encode()!=claim.Encode())throw new InvalidOperationException("Conflicting claim");return;}
                long total=claim.Bytes;foreach(var c in claims.Values)total=checked(total+c.Bytes);
                if(claims.Count>=256||total>CapacityBytes)throw new InvalidOperationException("Shared physical capacity exhausted");
                Publish(claim.Id+".claim",claim.Encode());
            }
        }
        public void ConsumeStart(PhysicalClaim claim) {
            Bind(claim);using(var gate=Lock()) {
                HashSet<string> consumed;var claims=Snapshot(out consumed);PhysicalClaim old;
                if(!claims.TryGetValue(claim.Id,out old)||old.Encode()!=claim.Encode())throw new InvalidOperationException("Unreserved physical claim");
                if(consumed.Contains(claim.Id))throw new InvalidOperationException("Physical start already consumed");
                // Acquire is idempotent; permission to submit a native start is
                // not. Persist this record BEFORE invoking any native allocator.
                Publish(claim.Id+".dispatch",claim.Encode());
            }
        }
        // Deliberately no timeout/worker-death release. Native operation settlement,
        // original owned Off and write fencing are separate required evidence.
        public void Dispose(){if(disposed)return;disposed=true;for(int i=held.Count-1;i>=0;i--)held[i].Dispose();held.Clear();}
    }
}
