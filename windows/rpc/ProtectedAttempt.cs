// Protected Windows namespace and finite worker leases. Default construction is
// inert; provider workers require a separate explicit profile and VM permit.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Enclave.OwnedRpc {
    public sealed partial class ProtectedAttempt : IDisposable {
        public readonly string Root,Nonce,Boot,ContractHash,ExecutableHash;
        public readonly long Origin,Deadline;
        public readonly string LeaseProfile,Operation,PermitPath,PermitHash;
        public readonly uint GuardianPid;
        public readonly long GuardianCreation;
        readonly List<IDisposable> held=new List<IDisposable>();
        readonly List<SafeFileHandle> directories=new List<SafeFileHandle>();
        // VM journals reuse these held namespace checks, but have a separate
        // short read/submit lease. The immutable VM deadline is never renewed.
        readonly ProtectedAttempt accessLease;
        readonly bool reconciliationOnly;
        readonly bool guardianOnly;
        readonly bool cleanupAccess;
        readonly bool evidenceOnly;
        readonly bool definitionJournal;
        readonly bool startupCleanup;
        readonly string recordOwner;
        bool disposed;
        const string SystemSid="S-1-5-18",AdminSid="S-1-5-32-544";
        static readonly UTF8Encoding Utf8=new UTF8Encoding(false,true);
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
        internal static extern SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr attributes,
            uint disposition,uint flags,IntPtr template);
        [DllImport("kernel32.dll",SetLastError=true)]
        static extern bool GetFileInformationByHandle(SafeFileHandle handle,out FileInfo value);
        [DllImport("advapi32.dll",SetLastError=true)]
        static extern uint GetSecurityInfo(SafeFileHandle handle,int kind,uint information,
            out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
        [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
        [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
        [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int kind,out BootInfo value,int length,out int returned);
        [StructLayout(LayoutKind.Sequential,Pack=4)] struct FileInfo {
            public uint Attributes;
            public long Created,Accessed,Written;
            public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;
        }
        // Fail closed on an unsupported native class/layout; no guessed boot identity.
        // Explicit layout is qualified on each Windows target before any activation.
        [StructLayout(LayoutKind.Explicit,Size=32)] struct BootInfo {
            [FieldOffset(0)] public Guid Identifier;
            [FieldOffset(16)] public uint Firmware;
            [FieldOffset(24)] public ulong Flags;
        }
        public static string CurrentBoot() {
            BootInfo value;int returned;
            int status=NtQuerySystemInformation(90,out value,32,out returned);
            if(status!=0 || returned!=32 || value.Identifier==Guid.Empty)
                throw new InvalidOperationException("Native boot identity unavailable");
            return value.Identifier.ToString("N");
        }
        public static void RequireSystem() {
            using(var identity=WindowsIdentity.GetCurrent())
                if(identity.User==null || identity.User.Value!=SystemSid || identity.ImpersonationLevel!=TokenImpersonationLevel.None)
                    throw new InvalidOperationException("SYSTEM primary execution context required");
        }
        public static string Hash(byte[] data) {
            using(var sha=SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(data)).Replace("-","").ToLowerInvariant();
        }
        static void Hex(string value,int length) {
            if(value==null || value.Length!=length) throw new ArgumentException("Hex length");
            foreach(char c in value) if(!((c>='0'&&c<='9') || (c>='a'&&c<='f'))) throw new ArgumentException("Hex encoding");
        }
        internal static string LocalPath(string path) {
            if(path==null || path.Length>240 || path.Length<4 || path[1]!=':' || path[2]!='\\' ||
                !Char.IsLetter(path[0]) || path.IndexOf(':',2)>=0 || path.IndexOf('/')>=0 || path.IndexOf('\0')>=0 ||
                path.IndexOf('"')>=0 || path.IndexOf('\r')>=0 || path.IndexOf('\n')>=0 ||
                !String.Equals(Path.GetFullPath(path),path,StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("Canonical local drive path required");
            foreach(string segment in path.Substring(3).Split('\\'))
                if(segment.Length==0 || segment.EndsWith(".") || segment.EndsWith(" ")) throw new ArgumentException("Ambiguous path segment");
            return path;
        }
        internal static void Authority(SafeFileHandle handle,bool strict,bool directory,string label) {
            AuthorityCore(handle,strict,directory,label,true);
        }
        // Only the template-fence operation uses this entry after holding and
        // qualifying every ancestor. Keep strict file ownership/mutation checks;
        // its consumed intent precedes converting the inherited ACL to protected.
        internal static void PinnedTemplateAuthority(SafeFileHandle handle,string label) {
            AuthorityCore(handle,true,false,label,false);
        }
        // Only a constructed custody object can request the NTFS metadata case.
        // It owns and rechecks a relative-opened, protected immediate child.
        internal static void CustodiedAncestorAuthority(AncestorCustody custody) {
            if(custody==null)throw new ArgumentNullException("custody");
            AuthorityCore(custody.ParentHandle,false,true,custody.ParentPath,true,0x110);
        }
        static void AuthorityCore(SafeFileHandle handle,bool strict,bool directory,string label,bool requireProtected,int heldChildMetadata=0) {
            if(heldChildMetadata!=0&&(heldChildMetadata!=0x110||strict||!directory))throw new InvalidOperationException("Invalid custody policy");
            FileInfo info;
            if(!GetFileInformationByHandle(handle,out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if((info.Attributes&0x400)!=0 || ((info.Attributes&0x10)!=0)!=directory)
                throw new InvalidOperationException("Reparse point or object kind refused");
            IntPtr owner,group,dacl,sacl,descriptor;
            uint error=GetSecurityInfo(handle,1,1|4,out owner,out group,out dacl,out sacl,out descriptor);
            if(error!=0) throw new Win32Exception((int)error);
            try {
                uint size=GetSecurityDescriptorLength(descriptor);
                if(size==0 || size>65536) throw new InvalidOperationException("Security descriptor size");
                var bytes=new byte[size];Marshal.Copy(descriptor,bytes,0,(int)size);
                var sd=new RawSecurityDescriptor(bytes,0);
                string ownerSid=sd.Owner==null?"":sd.Owner.Value;
                // OS-owned ancestors may be TrustedInstaller-owned. Leaf attempt
                // directory and files require SYSTEM or built-in Administrators.
                string installer=strict?"":((SecurityIdentifier)new NTAccount("NT SERVICE","TrustedInstaller").Translate(typeof(SecurityIdentifier))).Value;
                if(ownerSid!=SystemSid && ownerSid!=AdminSid && ownerSid!=installer)
                    throw new InvalidOperationException("Untrusted namespace owner");
                if(sd.DiscretionaryAcl==null || (strict && requireProtected && (sd.ControlFlags&ControlFlags.DiscretionaryAclProtected)==0))
                    throw new InvalidOperationException("Protected non-null DACL required");
                // For ancestors, creation of unrelated children is harmless while
                // these exact existing ancestors are held without DELETE sharing.
                // Existing-object mutation, DELETE_CHILD, owner/DACL change are not.
                const int ancestorDanger=0x000d0150; // DELETE, WRITE_DAC, WRITE_OWNER, DELETE_CHILD, WRITE_EA, WRITE_ATTRIBUTES
                const int leafDanger=0x000d0156; // also WRITE_DATA/ADD_FILE and APPEND_DATA/ADD_SUBDIRECTORY
                foreach(GenericAce ace in sd.DiscretionaryAcl) {
                    var common=ace as CommonAce;
                    if(common==null || common.IsCallback) throw new InvalidOperationException("Unsupported namespace ACE");
                    if((common.AceFlags&AceFlags.InheritOnly)!=0 || common.AceQualifier==AceQualifier.AccessDenied) continue;
                    if(common.AceQualifier!=AceQualifier.AccessAllowed) throw new InvalidOperationException("Unsupported namespace qualifier");
                    string sid=common.SecurityIdentifier.Value;
                    int danger=strict?leafDanger:(ancestorDanger&~heldChildMetadata);
                    if(sid==SystemSid || sid==AdminSid || (!strict && sid==installer)) continue;
                    if(sid!=SystemSid && sid!=AdminSid && ((common.AccessMask&danger)!=0 || (common.AccessMask&unchecked((int)0x50000000))!=0))
                        throw new InvalidOperationException("Untrusted namespace mutation right: "+label+" sid="+sid+" mask="+common.AccessMask.ToString("x8")+" strict="+strict);
                }
            } finally {if(descriptor!=IntPtr.Zero)LocalFree(descriptor);}
        }
        void HoldDirectory(string path,bool strict) {
            // FILE_FLAG_OPEN_REPARSE_POINT | BACKUP_SEMANTICS; no DELETE sharing.
            var handle=CreateFile(path,0x20000|0x80,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
            if(handle.IsInvalid) {handle.Dispose();throw new Win32Exception(Marshal.GetLastWin32Error());}
            held.Add(handle);directories.Add(handle);Authority(handle,strict,true,path);
        }
        FileStream HoldRead(string path,int maximum) {return HoldRead(path,maximum,false);}
        FileStream HoldRead(string path,int maximum,bool allowMissing) {
            var handle=CreateFile(path,0x80000000|0x20000,1,IntPtr.Zero,3,0x00200000,IntPtr.Zero);
            if(handle.IsInvalid) {int error=Marshal.GetLastWin32Error();handle.Dispose();if(allowMissing&&error==2)return null;throw new Win32Exception(error);}
            held.Add(handle);Authority(handle,true,false,path);
            var stream=new FileStream(handle,FileAccess.Read);held.Add(stream);
            if(stream.Length<1 || stream.Length>maximum) throw new InvalidOperationException("Protected file size");
            return stream;
        }
        static byte[] Bytes(FileStream stream,int maximum) {
            if(stream.Length>maximum) throw new InvalidOperationException("File size changed");
            var b=new byte[(int)stream.Length];int offset=0;
            while(offset<b.Length) {int n=stream.Read(b,offset,b.Length-offset);if(n==0)throw new IOException("Short protected read");offset+=n;}
            if(stream.ReadByte()!=-1)throw new IOException("Protected file grew");return b;
        }
        // Controller pinning is a separate trusted-operator API. Child construction
        // still unconditionally requires a SYSTEM primary token.
        public static ProtectedAttempt PinController(string contractPath,string expectedHash) {
            RequireAdministrator();return new ProtectedAttempt(contractPath,expectedHash,true);
        }
        internal static void RequireAdministrator() {
            using(var identity=WindowsIdentity.GetCurrent()) {
                var principal=new WindowsPrincipal(identity);
                if(identity.ImpersonationLevel!=TokenImpersonationLevel.None ||
                    !principal.IsInRole(WindowsBuiltInRole.Administrator))
                    throw new InvalidOperationException("Primary administrator controller required");
            }
        }
        public static ProtectedAttempt OpenProviderWorker(string path,string hash) {return new ProtectedAttempt(path,hash,false,"provider");}
        public static ProtectedAttempt PinProviderController(string path,string hash) {RequireAdministrator();return new ProtectedAttempt(path,hash,true,"provider");}
        public static ProtectedAttempt OpenDefinitionWorker(string path,string hash) {return new ProtectedAttempt(path,hash,false,"definition");}
        public static ProtectedAttempt PinDefinitionController(string path,string hash) {RequireAdministrator();return new ProtectedAttempt(path,hash,true,"definition");}
        public static ProtectedAttempt OpenLegacyHandoffWorker(string path,string hash) {return new ProtectedAttempt(path,hash,false,"legacy-handoff");}
        public static ProtectedAttempt PinLegacyHandoffController(string path,string hash) {RequireAdministrator();return new ProtectedAttempt(path,hash,true,"legacy-handoff");}
        // Reopen completed records under a CURRENT bounded reader. This never
        // extends the original handoff deadline or restores its write authority.
        internal static ProtectedAttempt OpenCompletedHandoff(string path,string hash,ProtectedAttempt reader) {
            RequireAdministrator();return new ProtectedAttempt(path,hash,reader);
        }
        private ProtectedAttempt(string path,string hash,ProtectedAttempt reader) {
            if(reader==null||reader.evidenceOnly)throw new ArgumentException("Current operation lease required");
            reader.CheckDeadline();Hex(hash,64);LocalPath(path);
            if(reader.Deadline-reader.Origin>30000)throw new ArgumentException("Short reader lease required");
            if(Path.GetFileName(path)!="contract.txt")throw new ArgumentException("Fixed completed contract path");
            accessLease=reader;evidenceOnly=true;recordOwner=SystemSid;LeaseProfile="legacy-handoff";
            Root=Path.GetDirectoryName(path);ContractHash=hash;
            try {
                string current=Path.GetPathRoot(Root);HoldDirectory(current,false);
                string[] segments=Root.Substring(3).Split('\\');
                for(int i=0;i<segments.Length;i++){current=Path.Combine(current,segments[i]);HoldDirectory(current,i==segments.Length-1);}
                byte[] raw=Bytes(HoldRead(path,2048),2048);
                if(Hash(raw)!=hash)throw new InvalidOperationException("Completed contract digest differs");
                string[] f=Utf8.GetString(raw).Split('\n');
                if(f.Length!=9||f[0]!="owned-rpc-legacy-handoff-v1"||f[6]!="legacy-memory-cut-seed-v1"||f[8]!="")throw new InvalidOperationException("Completed cut-seed contract required");
                Nonce=f[1];Boot=f[2];ExecutableHash=f[5];Operation=f[6];PermitHash=f[7];PermitPath=Path.Combine(Root,"handoff.json");
                Hex(Nonce,32);Hex(Boot,32);Hex(ExecutableHash,64);Hex(PermitHash,64);
                Origin=Int64.Parse(f[3],NumberStyles.None,CultureInfo.InvariantCulture);Deadline=Int64.Parse(f[4],NumberStyles.None,CultureInfo.InvariantCulture);
                if(Path.GetFileName(Root)!=Nonce||Boot!=reader.Boot||Boot!=CurrentBoot()||Origin<0||Origin>Int64.MaxValue-30000||
                    Deadline<=Origin||Deadline-Origin>30000||Origin>BoundedWorker.MonotonicMilliseconds())throw new InvalidOperationException("Completed handoff identity/time differs");
                if(Hash(Bytes(HoldRead(Path.Combine(Root,"entry.exe"),262144),262144))!=ExecutableHash)throw new InvalidOperationException("Completed producer image differs");
                if(ReadOnce("pool.complete")!=Hash(Utf8.GetBytes(ReadOnce("pool.activation"))))throw new InvalidOperationException("Completed seed digest differs");
                CheckDeadline();
            }catch{Dispose();throw;}
        }
        public ProtectedAttempt(string contractPath,string expectedHash) : this(contractPath,expectedHash,false) {}
        private ProtectedAttempt(string contractPath,string expectedHash,bool controller) : this(contractPath,expectedHash,controller,"inert") {}
        private ProtectedAttempt(string contractPath,string expectedHash,bool controller,string profile) {
            if(!controller)RequireSystem();Hex(expectedHash,64);LocalPath(contractPath);
            recordOwner=controller?AdminSid:SystemSid;LeaseProfile=profile;
            if(Path.GetFileName(contractPath)!="contract.txt")throw new ArgumentException("Fixed contract filename required");
            Root=Path.GetDirectoryName(contractPath);ContractHash=expectedHash;
            try {
                string current=Path.GetPathRoot(Root);HoldDirectory(current,false);
                string[] segments=Root.Substring(3).Split('\\');
                for(int i=0;i<segments.Length;i++){current=Path.Combine(current,segments[i]);HoldDirectory(current,i==segments.Length-1);}
                byte[] bytes=Bytes(HoldRead(contractPath,2048),2048);
                if(Hash(bytes)!=expectedHash)throw new InvalidOperationException("Contract digest mismatch");
                string[] fields=Utf8.GetString(bytes).Split('\n');
                if(profile=="inert") {
                    if(fields.Length!=8 || fields[0]!="owned-rpc-inert-v1" || fields[6]!="inert-v1" || fields[7]!="")throw new InvalidOperationException("Exact inert contract schema required");
                } else if(profile=="definition") {
                    if(fields.Length!=10||fields[0]!="owned-rpc-definition-worker-v1"||(fields[6]!="define"&&fields[6]!="definition-reconcile"&&fields[6]!="boot"&&fields[6]!="boot-reconcile")||fields[9]!="")throw new InvalidOperationException("Exact definition worker contract required");
                    Operation=fields[6];PermitPath=LocalPath(fields[7]);PermitHash=fields[8];Hex(PermitHash,64);
                    if(Path.GetFileName(PermitPath)!="definition-plan.txt")throw new InvalidOperationException("Fixed definition plan path required");
                } else if(profile=="legacy-handoff") {
                    if(fields.Length!=9||fields[0]!="owned-rpc-legacy-handoff-v1"||(fields[6]!="legacy-memory-cut-v1"&&fields[6]!="legacy-memory-inspect-v1"&&fields[6]!="legacy-memory-cut-seed-v1"&&fields[6]!="legacy-memory-resident-inspect-v1")||fields[8]!="")throw new InvalidOperationException("Exact legacy handoff contract required");
                    Operation=fields[6];PermitPath=Path.Combine(Root,"handoff.json");PermitHash=fields[7];Hex(PermitHash,64);
                } else {
                    if(profile!="provider"||fields.Length!=12||fields[0]!="owned-rpc-provider-worker-v1"||fields[11]!=""||(fields[6]!="start"&&fields[6]!="reconcile"&&fields[6]!="stop"&&fields[6]!="stop-reconcile"))throw new InvalidOperationException("Exact provider worker contract required");
                    Operation=fields[6];PermitPath=LocalPath(fields[7]);PermitHash=fields[8];Hex(PermitHash,64);
                    if(Path.GetFileName(PermitPath)!="vm-permit.txt")throw new InvalidOperationException("Fixed VM permit path required");
                    GuardianPid=UInt32.Parse(fields[9],NumberStyles.None,CultureInfo.InvariantCulture);GuardianCreation=Int64.Parse(fields[10],NumberStyles.None,CultureInfo.InvariantCulture);
                    if((Operation=="start"&&(GuardianPid==0||GuardianCreation<=0))||(Operation!="start"&&(GuardianPid!=0||GuardianCreation!=0)))throw new InvalidOperationException("Exact guardian binding required for start only");
                }
                Nonce=fields[1];Boot=fields[2];ExecutableHash=fields[5];Hex(Nonce,32);Hex(Boot,32);Hex(ExecutableHash,64);
                if(Path.GetFileName(Root)!=Nonce)throw new InvalidOperationException("Attempt namespace differs");
                Origin=Int64.Parse(fields[3],NumberStyles.None,CultureInfo.InvariantCulture);
                Deadline=Int64.Parse(fields[4],NumberStyles.None,CultureInfo.InvariantCulture);
                long now=BoundedWorker.MonotonicMilliseconds();
                if(Origin<0 || Origin>Int64.MaxValue-30000 || Origin>now || now-Origin>=5000 ||
                    Deadline<=now || Deadline-Origin>30000 || Deadline<=Origin)
                    throw new InvalidOperationException("Original inert contract timing invalid");
                if(CurrentBoot()!=Boot)throw new InvalidOperationException("Attempt belongs to another boot");
                if(Hash(Bytes(HoldRead(Path.Combine(Root,"entry.exe"),262144),262144))!=ExecutableHash)
                    throw new InvalidOperationException("Pinned entry executable differs");
            } catch {Dispose();throw;}
        }
        public string Token {get{return Nonce+Boot+ContractHash;}}
        public string Executable {get{return Path.Combine(Root,"entry.exe");}}
        internal long AccessDeadline {get{return accessLease==null?Deadline:accessLease.AccessDeadline;}}
        internal byte[] ReadFenceEvidence() {
            if(!evidenceOnly)throw new InvalidOperationException("Read-only completed evidence required");
            CheckDeadline();return Bytes(HoldRead(Path.Combine(Root,"definition-fence.intent"),65536),65536);
        }
        public void CheckDeadline() {
            if(disposed)throw new ObjectDisposedException("ProtectedAttempt");
            if(accessLease!=null){accessLease.CheckDeadline();return;}
            long now=BoundedWorker.MonotonicMilliseconds();
            if(now<Origin || now>=Deadline)throw new InvalidOperationException("Original deadline expired or clock rolled back");
        }
        static void Name(string name) {
            if(name==null || name.Length>40)throw new ArgumentException("Message name");
            foreach(char c in name) if(!((c>='a'&&c<='z') || c=='.' || c=='-'))throw new ArgumentException("Message name encoding");
        }
        internal static bool DefinitionRecordAllowed(string name,bool reconcile) {
            if(name=="definition.job"||name=="definition.terminal"||name=="definition.system"||name=="definition.off")return true;
            return !reconcile&&(name=="definition.intent"||name=="definition.submit"||name=="definition.native"||name=="definition.invoke"||name=="definition.receipt");
        }
        internal static bool BootRecordAllowed(string name,bool readOnly){
            if(name=="boot.media"||name=="boot.ready")return true;
            foreach(string step in new[]{"scsi","diskdrive","diskmedia","bootorder","seeddrive","seedmedia","nic","port"}){
                string prefix="boot."+step+".";
                if(name==prefix+"job"||name==prefix+"terminal")return true;
                if(!readOnly&&(name==prefix+"intent"||name==prefix+"submit"||name==prefix+"receipt"))return true;
            }return false;
        }
        // CreateNew consumes the role before any work. A crash/partial durable write
        // remains consumed and ambiguous. No delete, overwrite, rename or retry API.
        public void WriteOnce(string name,string value) {
            if(evidenceOnly||LeaseProfile=="startup-staging")throw new InvalidOperationException("Evidence/staging custody is read-only");
            Name(name);CheckDeadline();byte[] bytes=Utf8.GetBytes(value);
            if(startupCleanup) {
                if(name!="cleanup.consumed"&&name!="cleanup.armed"&&name!="cleanup.dispatch"&&name!="cleanup.result"&&name!="cleanup.adoption-refused")throw new InvalidOperationException("Cleanup controller cannot write provider records");
            } else if(guardianOnly) {
                if(name!="guardian.consumed"&&name!="guardian.request"&&name!="guardian.armed"&&name!="guardian.bound"&&name!="guardian.result")
                    throw new InvalidOperationException("Guardian cannot write provider records");
            } else if(definitionJournal) {
                bool boot=accessLease.Operation=="boot"||accessLease.Operation=="boot-reconcile";
                if(boot?!BootRecordAllowed(name,accessLease.Operation=="boot-reconcile"):!DefinitionRecordAllowed(name,accessLease.Operation=="definition-reconcile"))throw new InvalidOperationException("Fixed definition/boot journal record required");
                if((accessLease.Operation=="define"||accessLease.Operation=="boot")&&(BoundedWorker.MonotonicMilliseconds()<Origin||BoundedWorker.MonotonicMilliseconds()>=Deadline))throw new InvalidOperationException("Original definition time expired");
            } else if(accessLease!=null) {
                if(cleanupAccess) {
                    bool observations=name=="start.job"||name=="start.terminal"||name=="stop.job"||name=="stop.terminal";
                    bool stopWrite=accessLease.Operation=="stop"&&(name=="stop.intent"||name=="stop.submit"||name=="stop.native"||name=="stop.receipt");
                    if(!observations&&!stopWrite)throw new InvalidOperationException("Cleanup lease cannot grant a start or resubmit stop");
                } else if(reconciliationOnly) {
                    if(name!="start.job" && name!="start.terminal")throw new InvalidOperationException("Reconciliation cannot grant or acknowledge a start");
                } else {
                    if(BoundedWorker.MonotonicMilliseconds()<Origin || BoundedWorker.MonotonicMilliseconds()>=Deadline)
                        throw new InvalidOperationException("VM start authority expired");
                    if(name!="start.intent" && name!="start.submit" && name!="start.native" && name!="start.receipt" && name!="start.job" && name!="start.terminal")
                        throw new InvalidOperationException("Fixed VM journal record required");
                }
            }
            if(bytes.Length>4096)throw new ArgumentException("Message bound");
            // A primary administrator pin is a distinct trusted-operator path.
            // It cannot assign SYSTEM ownership without SeRestorePrivilege. Both
            // existing authority checks already admit only SYSTEM/Administrators.
            var security=new FileSecurity();security.SetOwner(new SecurityIdentifier(recordOwner));security.SetAccessRuleProtection(true,false);
            security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(SystemSid),FileSystemRights.FullControl,AccessControlType.Allow));
            security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(AdminSid),FileSystemRights.FullControl,AccessControlType.Allow));
            var stream=new FileStream(Path.Combine(Root,name+".pending"),FileMode.CreateNew,FileSystemRights.ReadData|FileSystemRights.WriteData|FileSystemRights.ReadPermissions,
                FileShare.Read,4096,FileOptions.WriteThrough,security);
            FileInfo before;
            using(stream) {
                Authority(stream.SafeFileHandle,true,false,Path.Combine(Root,name+".pending"));
                if(!GetFileInformationByHandle(stream.SafeFileHandle,out before))throw new Win32Exception(Marshal.GetLastWin32Error());
                stream.Write(bytes,0,bytes.Length);stream.Flush(true);
            }
            // Publish only after durable close, without replacing an existing message.
            // A leftover pending file consumes this attempt and forbids a retry.
            File.Move(Path.Combine(Root,name+".pending"),Path.Combine(Root,name));
            var pinned=HoldRead(Path.Combine(Root,name),4096);FileInfo after;
            if(!GetFileInformationByHandle(pinned.SafeFileHandle,out after) || before.Volume!=after.Volume ||
                before.IndexHigh!=after.IndexHigh || before.IndexLow!=after.IndexLow || Hash(Bytes(pinned,4096))!=Hash(bytes))
                throw new InvalidOperationException("Published message incarnation changed");
        }
        // Only CreateFile ERROR_FILE_NOT_FOUND maps to absence. Namespace/ACL,
        // sharing, invalid handles and malformed/empty data remain failures.
        public string ReadOptionalOnce(string name) {
            Name(name);CheckDeadline();var stream=HoldRead(Path.Combine(Root,name),4096,true);
            return stream==null?null:Utf8.GetString(Bytes(stream,4096));
        }
        public string ReadOnce(string name) {
            Name(name);CheckDeadline();return Utf8.GetString(Bytes(HoldRead(Path.Combine(Root,name),4096),4096));
        }
        public byte[] ReadAdmission(string expectedHash) {
            Hex(expectedHash,64);CheckDeadline();byte[] bytes=Bytes(HoldRead(Path.Combine(Root,"admission.json"),262144),262144);
            if(Hash(bytes)!=expectedHash)throw new InvalidOperationException("Reviewed admission digest differs");CheckDeadline();return bytes;
        }
        public byte[] ReadLegacyHandoff() {
            if(LeaseProfile!="legacy-handoff"||(Operation!="legacy-memory-cut-v1"&&Operation!="legacy-memory-inspect-v1"&&Operation!="legacy-memory-cut-seed-v1"&&Operation!="legacy-memory-resident-inspect-v1"))throw new InvalidOperationException("Explicit handoff profile required");
            CheckDeadline();byte[] bytes=Bytes(HoldRead(PermitPath,65536),65536);
            if(Hash(bytes)!=PermitHash)throw new InvalidOperationException("Reviewed handoff digest differs");CheckDeadline();return bytes;
        }
        public void Dispose() {disposed=true;for(int i=held.Count-1;i>=0;i--)held[i].Dispose();held.Clear();}
    }
}

// Conditional ancestor custody; ordinary Authority remains unchanged.
namespace Enclave.OwnedRpc {
 internal sealed class AncestorCustody : IDisposable {
  [StructLayout(LayoutKind.Sequential,Pack=4)] internal struct Info {
   public uint Attributes;public long Created,Accessed,Written;
   public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;
  }
  [StructLayout(LayoutKind.Sequential)] struct UnicodeString {public ushort Length,MaximumLength;public IntPtr Buffer;}
  [StructLayout(LayoutKind.Sequential)] struct ObjectAttributes {public int Length;public IntPtr RootDirectory,ObjectName;public uint Attributes;public IntPtr SecurityDescriptor,SecurityQualityOfService;}
  [StructLayout(LayoutKind.Sequential)] struct IoStatus {public IntPtr Status,Information;}
  [DllImport("ntdll.dll")] static extern int NtCreateFile(out IntPtr handle,uint access,ref ObjectAttributes attributes,out IoStatus status,IntPtr allocation,uint fileAttributes,uint share,uint disposition,uint options,IntPtr ea,uint eaLength);
  [DllImport("ntdll.dll")] static extern uint RtlNtStatusToDosError(int status);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle,out Info info);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetVolumeInformationByHandleW(SafeFileHandle handle,StringBuilder name,uint nameLength,out uint serial,out uint componentLength,out uint flags,StringBuilder filesystem,uint filesystemLength);
  SafeFileHandle parent,child;Info parentInfo,childInfo;bool disposed;
  internal string ParentPath {get;private set;}
  internal SafeFileHandle ParentHandle {get{Recheck();return parent;}}
  internal static Info Identity(SafeFileHandle handle){Info info;if(!GetFileInformationByHandle(handle,out info))throw new Win32Exception(Marshal.GetLastWin32Error());return info;}
  static bool Same(Info a,Info b){return a.Volume==b.Volume&&a.IndexHigh==b.IndexHigh&&a.IndexLow==b.IndexLow;}
  static void DirectoryKind(Info info){if((info.Attributes&0x410)!=0x10)throw new InvalidOperationException("Custody requires a non-reparse directory");}
  internal static SafeFileHandle OpenChild(SafeFileHandle parent,string component){
   if(String.IsNullOrEmpty(component)||component.Length>255||component=="."||component==".."||component.IndexOfAny(new[]{'\\','/',':','\0'})>=0||component.EndsWith(" ")||component.EndsWith("."))throw new ArgumentException("Single exact child component required");
   IntPtr text=IntPtr.Zero,name=IntPtr.Zero;bool retained=false;
   try{
    parent.DangerousAddRef(ref retained);text=Marshal.StringToHGlobalUni(component);
    var value=new UnicodeString{Length=checked((ushort)(component.Length*2)),MaximumLength=checked((ushort)((component.Length+1)*2)),Buffer=text};
    name=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeString)));Marshal.StructureToPtr(value,name,false);
    var attributes=new ObjectAttributes{Length=Marshal.SizeOf(typeof(ObjectAttributes)),RootDirectory=parent.DangerousGetHandle(),ObjectName=name,Attributes=0x40};
    IntPtr raw;IoStatus result;
    // FILE_OPEN, DIRECTORY_FILE, SYNCHRONOUS_IO_NONALERT, OPEN_REPARSE_POINT.
    // RootDirectory + one component binds the actual immediate child, without
    // traversing an absolute prefix that metadata operations could affect.
    int status=NtCreateFile(out raw,0x1200a0,ref attributes,out result,IntPtr.Zero,0,3,1,0x200021,IntPtr.Zero,0);
    if(status<0){if(raw!=IntPtr.Zero&&raw!=new IntPtr(-1))new SafeFileHandle(raw,true).Dispose();throw new Win32Exception((int)RtlNtStatusToDosError(status));}
    var handle=new SafeFileHandle(raw,true);try{DirectoryKind(Identity(handle));return handle;}catch{handle.Dispose();throw;}
   }finally{if(name!=IntPtr.Zero)Marshal.FreeHGlobal(name);if(text!=IntPtr.Zero)Marshal.FreeHGlobal(text);if(retained)parent.DangerousRelease();}
  }
  internal AncestorCustody(SafeFileHandle expectedParent,string parentPath,string immediateChild){
   ParentPath=ProtectedAttempt.LocalPath(parentPath);
   try{
    var expected=Identity(expectedParent);DirectoryKind(expected);
    parent=ProtectedAttempt.CreateFile(parentPath,0x200a0,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
    if(parent.IsInvalid)throw new Win32Exception(Marshal.GetLastWin32Error());
    parentInfo=Identity(parent);DirectoryKind(parentInfo);if(!Same(expected,parentInfo))throw new InvalidOperationException("Custody parent changed");
    uint serial,length,flags;var filesystem=new StringBuilder(32);
    if(new DriveInfo(Path.GetPathRoot(parentPath)).DriveType!=DriveType.Fixed||!GetVolumeInformationByHandleW(parent,null,0,out serial,out length,out flags,filesystem,32)||filesystem.ToString()!="NTFS")throw new InvalidOperationException("Custody requires observed local fixed NTFS");
    child=OpenChild(parent,immediateChild);childInfo=Identity(child);
    if(childInfo.Volume!=parentInfo.Volume)throw new InvalidOperationException("Custody child volume differs");
    // The child cannot be unlinked/replaced by an untrusted user even after
    // handles close. No-delete handles additionally prevent operator races
    // during the relying operation. Deny-delete on the parent alone is not enough.
    ProtectedAttempt.Authority(child,true,true,Path.Combine(parentPath,immediateChild));
    Recheck();ProtectedAttempt.CustodiedAncestorAuthority(this);
   }catch{Dispose();throw;}
  }
  internal void Recheck(){
   if(disposed||parent==null||child==null||parent.IsInvalid||child.IsInvalid)throw new InvalidOperationException("Custody unavailable");
   var p=Identity(parent);var c=Identity(child);DirectoryKind(p);DirectoryKind(c);
   if(!Same(p,parentInfo)||!Same(c,childInfo)||p.Volume!=c.Volume)throw new InvalidOperationException("Custody identity changed");
  }
  public void Dispose(){if(disposed)return;disposed=true;if(child!=null)child.Dispose();if(parent!=null)parent.Dispose();}
 }
}
