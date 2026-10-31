// Finite Windows SYSTEM inert qualification contract. No VM/provider authority.
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
    public sealed class ProtectedAttempt : IDisposable {
        public readonly string Root,Nonce,Boot,ContractHash,ExecutableHash;
        public readonly long Origin,Deadline;
        readonly List<IDisposable> held=new List<IDisposable>();
        readonly List<SafeFileHandle> directories=new List<SafeFileHandle>();
        const string SystemSid="S-1-5-18",AdminSid="S-1-5-32-544";
        static readonly UTF8Encoding Utf8=new UTF8Encoding(false,true);
        [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]
        static extern SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr attributes,
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
        static string LocalPath(string path) {
            if(path==null || path.Length>240 || path.Length<4 || path[1]!=':' || path[2]!='\\' ||
                !Char.IsLetter(path[0]) || path.IndexOf(':',2)>=0 || path.IndexOf('/')>=0 || path.IndexOf('\0')>=0 ||
                path.IndexOf('"')>=0 || path.IndexOf('\r')>=0 || path.IndexOf('\n')>=0 ||
                !String.Equals(Path.GetFullPath(path),path,StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("Canonical local drive path required");
            foreach(string segment in path.Substring(3).Split('\\'))
                if(segment.Length==0 || segment.EndsWith(".") || segment.EndsWith(" ")) throw new ArgumentException("Ambiguous path segment");
            return path;
        }
        static void Authority(SafeFileHandle handle,bool strict,bool directory,string label) {
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
                if(sd.DiscretionaryAcl==null || (strict && (sd.ControlFlags&ControlFlags.DiscretionaryAclProtected)==0))
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
                    int danger=strict?leafDanger:ancestorDanger;
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
            using(var identity=WindowsIdentity.GetCurrent()) {
                var principal=new WindowsPrincipal(identity);
                if(identity.ImpersonationLevel!=TokenImpersonationLevel.None ||
                    !principal.IsInRole(WindowsBuiltInRole.Administrator))
                    throw new InvalidOperationException("Primary administrator controller required");
            }
            return new ProtectedAttempt(contractPath,expectedHash,true);
        }
        public ProtectedAttempt(string contractPath,string expectedHash) : this(contractPath,expectedHash,false) {}
        private ProtectedAttempt(string contractPath,string expectedHash,bool controller) {
            if(!controller)RequireSystem();Hex(expectedHash,64);LocalPath(contractPath);
            if(Path.GetFileName(contractPath)!="contract.txt")throw new ArgumentException("Fixed contract filename required");
            Root=Path.GetDirectoryName(contractPath);ContractHash=expectedHash;
            try {
                string current=Path.GetPathRoot(Root);HoldDirectory(current,false);
                string[] segments=Root.Substring(3).Split('\\');
                for(int i=0;i<segments.Length;i++){current=Path.Combine(current,segments[i]);HoldDirectory(current,i==segments.Length-1);}
                byte[] bytes=Bytes(HoldRead(contractPath,2048),2048);
                if(Hash(bytes)!=expectedHash)throw new InvalidOperationException("Contract digest mismatch");
                string[] fields=Utf8.GetString(bytes).Split('\n');
                if(fields.Length!=8 || fields[0]!="owned-rpc-inert-v1" || fields[6]!="inert-v1" || fields[7]!="")
                    throw new InvalidOperationException("Exact inert contract schema required");
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
        public void CheckDeadline() {if(BoundedWorker.MonotonicMilliseconds()>=Deadline)throw new InvalidOperationException("Original deadline expired");}
        static void Name(string name) {
            if(name==null || name.Length>40)throw new ArgumentException("Message name");
            foreach(char c in name) if(!((c>='a'&&c<='z') || c=='.' || c=='-'))throw new ArgumentException("Message name encoding");
        }
        // CreateNew consumes the role before any work. A crash/partial durable write
        // remains consumed and ambiguous. No delete, overwrite, rename or retry API.
        public void WriteOnce(string name,string value) {
            Name(name);CheckDeadline();byte[] bytes=Utf8.GetBytes(value);
            if(bytes.Length>4096)throw new ArgumentException("Message bound");
            var security=new FileSecurity();security.SetOwner(new SecurityIdentifier(SystemSid));security.SetAccessRuleProtection(true,false);
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
        public void Dispose() {for(int i=held.Count-1;i>=0;i--)held[i].Dispose();held.Clear();}
    }
}
