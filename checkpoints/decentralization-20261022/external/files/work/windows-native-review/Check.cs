using System;using System.Collections;using System.Collections.Generic;using System.Globalization;using System.IO;using System.Net;using System.Security.Cryptography;using System.Text;using System.Text.RegularExpressions;using System.Web.Script.Serialization;
    static class ReleaseChannel
    {
        public const string PolicyFormat = "enclave-windows-release-policy/v1";
        public const string StatementFormat = "enclave-windows-release/v1";
        public const string EnvelopeFormat = "enclave-windows-release-envelope/v1";
        public const string EnvelopeName = "latest.signed.json";
        public const string Context = "enclave-windows-release-signature/v1\n";
        public const string P256SpkiPrefixHex = "3059301306072a8648ce3d020106082a8648ce3d03010703420004";
        const int BcryptEcdsaPublicP256Magic = 0x31534345;   // "ECS1"
        const long MaxZip = 2L * 1024 * 1024 * 1024;

        public sealed class Key { public string Id; public byte[] Blob; }
        public sealed class Policy { public string Channel; public int Threshold; public List<Key> Keys = new List<Key>(); public List<string> Mirrors = new List<string>(); }
        public sealed class Release { public string Version, File, Sha256, StatementSha256; public long Bytes; public int Signers; }

        static string Hex(byte[] b) { return BitConverter.ToString(b).Replace("-", "").ToLowerInvariant(); }
        static byte[] Sha(byte[] b) { using (var h = SHA256.Create()) return h.ComputeHash(b); }
        static Dictionary<string, object> Obj(object o, string what) { var d = o as Dictionary<string, object>; if (d == null) throw new Exception(what + " is not a JSON object"); return d; }
        static void Exact(Dictionary<string, object> d, string what, params string[] allowed)
        {
            foreach (var k in d.Keys) if (Array.IndexOf(allowed, k) < 0) throw new Exception(what + " has an unknown field: " + k);
        }
        static string Str(Dictionary<string, object> d, string k) { object v; return d.TryGetValue(k, out v) ? v as string : null; }
        static byte[] B64(string s, string what)
        {
            if (s == null || !Regex.IsMatch(s, "^[A-Za-z0-9+/]+={0,2}$")) throw new Exception(what + " is not base64");
            var b = Convert.FromBase64String(s);
            if (Convert.ToBase64String(b) != s) throw new Exception(what + " is not canonical base64");
            return b;
        }

        public static Key ParseKey(string spec)
        {
            if (spec == null || !spec.StartsWith("ecdsa-p256:", StringComparison.Ordinal)) throw new Exception("a release key must be ecdsa-p256:<base64 SPKI>");
            byte[] der = B64(spec.Substring(11), "release key"), prefix = new byte[27];
            for (int i = 0; i < 27; i++) prefix[i] = Convert.ToByte(P256SpkiPrefixHex.Substring(i * 2, 2), 16);
            if (der.Length != 91) throw new Exception("a release key must be an uncompressed P-256 public key");
            for (int i = 0; i < 27; i++) if (der[i] != prefix[i]) throw new Exception("a release key must be an uncompressed P-256 public key");
            // BCRYPT_ECCKEY_BLOB: magic, key length (32), then X and Y, which are the SPKI's last 64 bytes
            var blob = new byte[8 + 64];
            BitConverter.GetBytes(BcryptEcdsaPublicP256Magic).CopyTo(blob, 0);
            BitConverter.GetBytes(32).CopyTo(blob, 4);
            Array.Copy(der, 27, blob, 8, 64);
            using (var k = CngKey.Import(blob, CngKeyBlobFormat.EccPublicBlob)) { }   // refuses a point that is not on the curve
            return new Key { Id = Hex(Sha(der)), Blob = blob };
        }
        static string Mirror(string m)
        {
            Uri u;
            if (!Uri.TryCreate(m, UriKind.Absolute, out u)) throw new Exception("mirror " + m + " is not a URL");
            bool loop = u.IsLoopback && u.Scheme == "http";
            if (u.Scheme != "https" && !loop) throw new Exception("mirror " + m + " must be https");
            if (u.UserInfo.Length > 0 || u.Query.Length > 0 || u.Fragment.Length > 0) throw new Exception("mirror " + m + " must not carry credentials, a query or a fragment");
            string s = u.AbsoluteUri; return s.EndsWith("/") ? s : s + "/";
        }
        public static Policy LoadPolicy(string path)
        {
            var d = Obj(new JavaScriptSerializer().DeserializeObject(File.ReadAllText(path).TrimStart('\uFEFF')), "the release policy");
            Exact(d, "the release policy", "format", "channel", "keys", "threshold", "mirrors");
            if (Str(d, "format") != PolicyFormat) throw new Exception("the release policy's format must be " + PolicyFormat);
            var p = new Policy { Channel = Str(d, "channel") };
            if (p.Channel == null || !Regex.IsMatch(p.Channel, "^[a-z0-9][a-z0-9._-]{0,31}$")) throw new Exception("the release policy's channel is not valid");
            var keys = d.ContainsKey("keys") ? d["keys"] as IList : null; var mirrors = d.ContainsKey("mirrors") ? d["mirrors"] as IList : null;
            if (keys == null || keys.Count < 1 || keys.Count > 8) throw new Exception("the release policy needs 1 to 8 keys");
            foreach (var k in keys) { var key = ParseKey(k as string); foreach (var x in p.Keys) if (x.Id == key.Id) throw new Exception("the release policy lists a key twice"); p.Keys.Add(key); }
            object t; if (!d.TryGetValue("threshold", out t) || !(t is int) || (int)t < 1 || (int)t > p.Keys.Count) throw new Exception("the release policy's threshold must be 1 to the number of keys");
            p.Threshold = (int)t;
            if (mirrors == null || mirrors.Count < 1 || mirrors.Count > 8) throw new Exception("the release policy needs 1 to 8 mirrors");
            foreach (var m in mirrors) { var n = Mirror(m as string); if (p.Mirrors.Contains(n)) throw new Exception("the release policy lists a mirror twice"); p.Mirrors.Add(n); }
            return p;
        }
        static readonly string[] StatementFields = { "format", "channel", "version", "issuedAt", "expiresAt", "file", "sha256", "bytes",
                                                     "setup", "setupSha256", "setupBytes", "manifest", "manifestSha256", "manifestBytes" };
        static long Size(Dictionary<string, object> s, string k, long max)
        {
            object v; if (!s.TryGetValue(k, out v) || !(v is int || v is long)) throw new Exception("the signed statement's " + k + " is not a size");
            long n = Convert.ToInt64(v, CultureInfo.InvariantCulture); if (n < 1 || n > max) throw new Exception("the signed statement's " + k + " is out of range");
            return n;
        }
        static DateTime When(string s, string what)
        {
            DateTime t;
            if (s == null || !Regex.IsMatch(s, @"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$") ||
                !DateTime.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out t)) throw new Exception(what + " is not an ISO-8601 UTC time");
            return t;
        }
        /// <summary>Verify one mirror's envelope: the signatures first (to the threshold, by distinct pinned keys), then the statement.</summary>
        public static Release Verify(string envelopeJson, Policy p)
        {
            if (envelopeJson.Length > 64 * 1024) throw new Exception("the envelope is too large");
            var js = new JavaScriptSerializer();
            var env = Obj(js.DeserializeObject(envelopeJson.TrimStart('\uFEFF')), "the envelope");
            Exact(env, "the envelope", "format", "statement", "signatures");
            if (Str(env, "format") != EnvelopeFormat) throw new Exception("not a signed release envelope");
            byte[] statement = B64(Str(env, "statement"), "the statement");
            if (statement.Length > 16 * 1024) throw new Exception("the statement is too large");
            byte[] ctx = Encoding.ASCII.GetBytes(Context), msg = new byte[ctx.Length + statement.Length];
            ctx.CopyTo(msg, 0); statement.CopyTo(msg, ctx.Length);
            var sigs = env.ContainsKey("signatures") ? env["signatures"] as IList : null;
            if (sigs == null || sigs.Count > 16) throw new Exception("the envelope's signatures are not a list of at most 16");
            var signed = new List<string>();
            foreach (var o in sigs)
            {
                var s = Obj(o, "a signature"); Exact(s, "a signature", "keyId", "sig");
                string id = Str(s, "keyId"); Key key = null;
                foreach (var k in p.Keys) if (k.Id == id) key = k;
                if (key == null || signed.Contains(id)) continue;
                byte[] sig = B64(Str(s, "sig"), "a signature");
                if (sig.Length != 64) continue;
                using (var ck = CngKey.Import(key.Blob, CngKeyBlobFormat.EccPublicBlob))
                using (var ec = new ECDsaCng(ck))
                {
                    ec.HashAlgorithm = CngAlgorithm.Sha256;
                    if (ec.VerifyData(msg, sig)) signed.Add(id);
                }
            }
            if (signed.Count < p.Threshold) throw new Exception(signed.Count + " valid signature(s) by pinned keys; the policy requires " + p.Threshold);
            var st = Obj(js.DeserializeObject(Encoding.UTF8.GetString(statement)), "the signed statement");
            Exact(st, "the signed statement", StatementFields);
            if (Str(st, "format") != StatementFormat) throw new Exception("the signed statement's format is not " + StatementFormat);
            if (Str(st, "channel") != p.Channel) throw new Exception("the signed statement is for channel " + Str(st, "channel") + ", not " + p.Channel);
            string v = Str(st, "version");
            if (v == null || !Regex.IsMatch(v, @"^\d{1,9}(\.\d{1,9}){1,3}$")) throw new Exception("the signed statement's version is not valid");
            if (When(Str(st, "issuedAt"), "issuedAt") > DateTime.UtcNow.AddDays(1)) throw new Exception("the signed statement is issued in the future");
            if (st.ContainsKey("expiresAt") && When(Str(st, "expiresAt"), "expiresAt") <= DateTime.UtcNow) throw new Exception("the signed statement expired at " + Str(st, "expiresAt"));
            string[,] art = { { "file", "sha256", "bytes", "enclave-host-" + v + ".zip" }, { "setup", "setupSha256", "setupBytes", "EnclaveSetup-" + v + ".exe" },
                              { "manifest", "manifestSha256", "manifestBytes", "manifest-" + v + ".json" } };
            long[] max = { MaxZip, 64L * 1024 * 1024, 16L * 1024 * 1024 };
            for (int i = 0; i < 3; i++)
            {
                if (Str(st, art[i, 0]) != art[i, 3]) throw new Exception("the signed statement's " + art[i, 0] + " must be " + art[i, 3]);
                if (Str(st, art[i, 1]) == null || !Regex.IsMatch(Str(st, art[i, 1]), "^[0-9a-f]{64}$")) throw new Exception("the signed statement's " + art[i, 1] + " is not a sha256");
                Size(st, art[i, 2], max[i]);
            }
            return new Release { Version = v, File = Str(st, "file"), Sha256 = Str(st, "sha256"), Bytes = Size(st, "bytes", MaxZip),
                                 StatementSha256 = Hex(Sha(statement)), Signers = signed.Count };
        }
        static HttpWebRequest Get(string url, int timeoutMs)
        {
            var q = (HttpWebRequest)WebRequest.Create(url);
            q.Timeout = timeoutMs; q.ReadWriteTimeout = timeoutMs; q.CachePolicy = new System.Net.Cache.RequestCachePolicy(System.Net.Cache.RequestCacheLevel.NoCacheNoStore);
            return q;
        }
        /// <summary>Every mirror's signed pointer; the highest version any of them proves. A mirror that serves nothing valid is
        /// noted and outvoted; two different signed statements for one version stop setup.</summary>
        public static Release Resolve(Policy p, Action<string> note)
        {
            Release best = null; var seen = new Dictionary<string, string>(); var why = new List<string>();
            foreach (var m in p.Mirrors)
            {
                Release r;
                try
                {
                    string text;
                    using (var resp = Get(m + EnvelopeName, 20000).GetResponse())
                    using (var rd = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                    {
                        var buf = new char[64 * 1024 + 1]; int n = rd.ReadBlock(buf, 0, buf.Length);
                        if (n > 64 * 1024) throw new Exception("the envelope is too large");
                        text = new string(buf, 0, n);
                    }
                    r = Verify(text, p);
                }
                catch (Exception e) { why.Add(m + ": " + e.Message); note(m + ": " + e.Message); continue; }
                string other;
                if (seen.TryGetValue(r.Version, out other) && other != r.StatementSha256)
                    throw new Exception("two different signed statements for version " + r.Version + ": not installing until the publisher explains");
                seen[r.Version] = r.StatementSha256;
                if (best == null || Version.Parse(r.Version) > Version.Parse(best.Version)) best = r;
            }
            if (best == null) throw new Exception("no mirror served a release signed by the pinned key(s): " + string.Join("; ", why.ToArray()));
            return best;
        }
        /// <summary>The release zip from the mirrors in turn, accepted only with the signed size and sha256.</summary>
        public static void Download(Policy p, string name, string sha, long bytes, string outPath, Action<long, long> progress, Action<string> note)
        {
            var why = new List<string>();
            if (File.Exists(outPath) && new FileInfo(outPath).Length == bytes)
                using (var f = File.OpenRead(outPath)) using (var h = SHA256.Create()) if (Hex(h.ComputeHash(f)) == sha) return;
            foreach (var m in p.Mirrors)
            {
                string part = outPath + ".partial";
                try
                {
                    using (var resp = Get(m + name, 600000).GetResponse())
                    using (var src = resp.GetResponseStream())
                    using (var h = SHA256.Create())
                    {
                        if (resp.ContentLength >= 0 && resp.ContentLength != bytes) throw new Exception("announces " + resp.ContentLength + " bytes, the signed size is " + bytes);
                        long got = 0; var buf = new byte[1 << 16]; int n;
                        using (var dst = File.Create(part))
                            while ((n = src.Read(buf, 0, buf.Length)) > 0)
                            {
                                got += n; if (got > bytes) throw new Exception("sent more than the signed " + bytes + " bytes");
                                dst.Write(buf, 0, n); h.TransformBlock(buf, 0, n, null, 0); progress(got, bytes);
                            }
                        h.TransformFinalBlock(new byte[0], 0, 0);
                        if (got != bytes) throw new Exception("sent " + got + " bytes, the signed size is " + bytes);
                        if (Hex(h.Hash) != sha) throw new Exception("hashes differently from the signed sha256");
                    }
                    if (File.Exists(outPath)) File.Delete(outPath);
                    File.Move(part, outPath);
                    return;
                }
                catch (Exception e) { try { File.Delete(part); } catch { } why.Add(m + ": " + e.Message); note(name + " from " + m + ": " + e.Message); }
            }
            throw new Exception(name + ": no mirror served the signed bytes (" + string.Join("; ", why.ToArray()) + ")");
        }
    }

public static class Check { public static int Main(string[] args) { var p=ReleaseChannel.LoadPolicy(Path.Combine(args[0],"policy.json")); int passed=0; foreach(var n in new string[]{"valid","threshold","foreign","tampered","expired","channel"}) { bool accepted=false; try { var r=ReleaseChannel.Verify(File.ReadAllText(Path.Combine(args[0],n+".json")),p); accepted=r.Version=="1.2.3"; } catch(Exception) {} bool ok=accepted==(n=="valid"); Console.WriteLine(n+":"+(ok?"PASS":"FAIL")); if(ok)passed++; } return passed==6?0:1; } }