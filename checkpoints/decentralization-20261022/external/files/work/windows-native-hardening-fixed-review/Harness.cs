// test/windows-native/Harness.cs -- the C# half of the native harness (test/windows-native/run.ps1 builds and runs it).
//
// run.ps1 copies EnclaveSetup.cs's ReleaseChannel class, unchanged, in place of the marker line below and compiles the
// result with Windows' own .NET Framework 4 csc (C# 5). Nothing is installed, elevated or written outside the work folder
// run.ps1 gives it.
//   Harness.exe verdicts <fixtures.json>          one line per case: "verdict<TAB>index<TAB>accept|refuse<TAB>detail"
//   Harness.exe transport <fixtures.json> <dir>   bounded transfer tests of ReleaseChannel.Fetch / Download / Resolve against
//                                                 an in-process loopback mirror that misbehaves: "PASS|FAIL<TAB>name<TAB>detail"
//   Harness.exe serve <fixtures.json> <portfile>  the same loopback mirror for cli/host.ps1's tests, until <portfile>.stop exists
// The mirror's scenarios (the first path segment): ok (the fixture's live envelope and setup), announce (Content-Length
// 50 GiB, one byte, then silence), flood (no length, 64 KiB chunks without end), trickle* (a length, then one byte every
// 200 ms), short (half the setup, then close), corrupt (the setup with one byte changed), nothing (404).
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

namespace Enclave.Native
{
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
        const int MaxEnvelope = 64 * 1024;
        // Hard deadlines over a whole exchange (connect, headers AND body), as in release-channel.mjs: a pointer gets
        // EnvelopeDeadlineMs; a file 60 s plus its signed size at MinRate bytes/s, at most AttemptCapMs per mirror, and all
        // mirrors together DownloadDeadlineMs. HttpWebRequest's Timeout and ReadWriteTimeout bound single waits only, so a
        // timer aborts the request when the deadline passes. Settable for the native harness.
        public static int EnvelopeDeadlineMs = 20000, AttemptCapMs = 3600000, DownloadDeadlineMs = 2 * 3600000;
        public const long MinRate = 128 * 1024;

        public sealed class Key { public string Id; public byte[] Blob; }
        public sealed class Policy { public string Channel; public int Threshold; public List<Key> Keys = new List<Key>(); public List<string> Mirrors = new List<string>(); }
        public sealed class Release { public string Version, File, Sha256, StatementSha256; public long Bytes; public int Signers; public List<string> ServedBy = new List<string>(); }

        static string Hex(byte[] b) { return BitConverter.ToString(b).Replace("-", "").ToLowerInvariant(); }
        static byte[] Sha(byte[] b) { using (var h = SHA256.Create()) return h.ComputeHash(b); }
        static Dictionary<string, object> Obj(object o, string what) { var d = o as Dictionary<string, object>; if (d == null) throw new Exception(what + " is not a JSON object"); return d; }
        static void Exact(Dictionary<string, object> d, string what, params string[] allowed)
        {
            foreach (var k in d.Keys) if (Array.IndexOf(allowed, k) < 0) throw new Exception(what + " has an unknown field: " + k);
        }
        static string Str(Dictionary<string, object> d, string k) { object v; return d.TryGetValue(k, out v) ? v as string : null; }
        // .NET's $ also matches before a final newline and its \d matches every script's digits; JavaScript's do neither.
        // \z and [0-9] make these patterns mean what they mean in release-channel.mjs.
        static bool Is(string s, string pattern) { return s != null && Regex.IsMatch(s, pattern, RegexOptions.CultureInvariant); }
        static byte[] B64(string s, string what)
        {
            if (!Is(s, @"^[A-Za-z0-9+/]+={0,2}\z")) throw new Exception(what + " is not base64");
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
        // A mirror's host is judged as WRITTEN, before Uri reads it: .NET's Uri.Host spells an IPv6 literal its own way (so
        // "[::1]" never matched it; native run 2026-10-20, fixture 29), and WHATWG URL in release-channel.mjs reads 127.1,
        // 2130706433 and 0x7f000001 as IPv4. The same three rules hold in all three verifiers: a name is a strict DNS name
        // (a canonical dotted quad if its last label looks numeric); an IPv6 literal must parse to exactly ::1 (compressed
        // or in full) and is written [::1]; plain http only for localhost, 127.0.0.1 or [::1].
        static readonly Regex RawHost = new Regex(@"^[A-Za-z][A-Za-z0-9+.-]*://(\[[^\]]*\]|[^/:]*)(:[0-9]{1,5})?(/|\z)", RegexOptions.CultureInvariant);   // the whole authority: host[:digits]
        const string DnsHost = @"^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*\z";
        const string NumericLastLabel = @"(^|\.)([0-9]+|0[xX][0-9A-Fa-f]*)\z";
        const string DottedQuad = @"^(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])){3}\z";
        /// <summary>A mirror: printable ASCII without \ ? # @ % (no spelling .NET's Uri and Node's URL normalise differently),
        /// https (http only on localhost, 127.0.0.1 or [::1], exactly as release-channel.mjs), ending in "/".</summary>
        public static string Mirror(string m)
        {
            Uri u;
            if (!Is(m, @"^[!-~]+\z") || m.IndexOfAny(new[] { '\\', '?', '#', '@', '%' }) >= 0 || !Uri.TryCreate(m, UriKind.Absolute, out u)) throw new Exception("mirror " + m + " is not a plain URL");
            string raw = RawHost.Match(m).Groups[1].Value;
            bool v6 = raw.StartsWith("[", StringComparison.Ordinal);
            IPAddress a;
            bool hostOk = v6 ? u.HostNameType == UriHostNameType.IPv6 && IPAddress.TryParse(raw.Substring(1, raw.Length - 2), out a) && a.Equals(IPAddress.IPv6Loopback)
                             : Is(raw, DnsHost) && !(Is(raw, NumericLastLabel) && !Is(raw, DottedQuad)) && string.Equals(u.Host, raw, StringComparison.OrdinalIgnoreCase);
            if (!hostOk) throw new Exception("mirror " + m + " must name a DNS host, a dotted quad or [::1], written plainly");
            string host = raw.ToLowerInvariant();
            bool loop = u.Scheme == "http" && (v6 || host == "localhost" || host == "127.0.0.1");
            if (u.Scheme != "https" && !loop) throw new Exception("mirror " + m + " must be https");
            if (u.UserInfo.Length > 0 || u.Query.Length > 0 || u.Fragment.Length > 0) throw new Exception("mirror " + m + " must not carry credentials, a query or a fragment");
            string s = v6 ? u.Scheme + "://[::1]" + (u.IsDefaultPort ? "" : ":" + u.Port.ToString(CultureInfo.InvariantCulture)) + u.AbsolutePath : u.AbsoluteUri;
            return s.EndsWith("/") ? s : s + "/";
        }
        public static Policy LoadPolicy(string path)
        {
            var info = new FileInfo(path);
            if (!info.Exists || info.Length > 4 * 16 * 1024) throw new Exception("the release policy " + path + " is missing or too large");
            return ParsePolicy(Encoding.UTF8.GetString(File.ReadAllBytes(path)));
        }
        public static Policy ParsePolicy(string json)
        {
            var d = Obj(new System.Web.Script.Serialization.JavaScriptSerializer().DeserializeObject(json.TrimStart('﻿')), "the release policy");
            Exact(d, "the release policy", "format", "channel", "keys", "threshold", "mirrors");
            if (Str(d, "format") != PolicyFormat) throw new Exception("the release policy's format must be " + PolicyFormat);
            var p = new Policy { Channel = Str(d, "channel") };
            if (!Is(p.Channel, @"^[a-z0-9][a-z0-9._-]{0,31}\z")) throw new Exception("the release policy's channel is not valid");
            var keys = d.ContainsKey("keys") ? d["keys"] as System.Collections.IList : null; var mirrors = d.ContainsKey("mirrors") ? d["mirrors"] as System.Collections.IList : null;
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
            if (!Is(s, @"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z\z") ||
                !DateTime.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out t)) throw new Exception(what + " is not an ISO-8601 UTC time");
            return t;
        }
        /// <summary>1.2 and 1.2.0 are one Version: two different statements for it are equivocation (release-channel.mjs).</summary>
        public static string VersionKey(string v) { var x = Version.Parse(v); return Math.Max(0, x.Major) + "." + Math.Max(0, x.Minor) + "." + Math.Max(0, x.Build) + "." + Math.Max(0, x.Revision); }
        public static Release Verify(string envelopeJson, Policy p) { return Verify(Encoding.UTF8.GetBytes(envelopeJson), p, DateTime.UtcNow); }
        /// <summary>Verify one mirror's envelope: the signatures first (to the threshold, by distinct pinned keys), then the statement.</summary>
        public static Release Verify(byte[] raw, Policy p, DateTime nowUtc)
        {
            if (raw.Length > MaxEnvelope) throw new Exception("the envelope is too large");
            var js = new System.Web.Script.Serialization.JavaScriptSerializer();
            var env = Obj(js.DeserializeObject(Encoding.UTF8.GetString(raw).TrimStart('﻿')), "the envelope");
            Exact(env, "the envelope", "format", "statement", "signatures");
            if (Str(env, "format") != EnvelopeFormat) throw new Exception("not a signed release envelope");
            byte[] statement = B64(Str(env, "statement"), "the statement");
            if (statement.Length > 16 * 1024) throw new Exception("the statement is too large");
            byte[] ctx = Encoding.ASCII.GetBytes(Context), msg = new byte[ctx.Length + statement.Length];
            ctx.CopyTo(msg, 0); statement.CopyTo(msg, ctx.Length);
            var sigs = env.ContainsKey("signatures") ? env["signatures"] as System.Collections.IList : null;
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
            if (!Is(v, @"^[0-9]{1,9}(\.[0-9]{1,9}){1,3}\z")) throw new Exception("the signed statement's version is not valid");
            if (When(Str(st, "issuedAt"), "issuedAt") > nowUtc.AddDays(1)) throw new Exception("the signed statement is issued in the future");
            if (st.ContainsKey("expiresAt") && When(Str(st, "expiresAt"), "expiresAt") <= nowUtc) throw new Exception("the signed statement expired at " + Str(st, "expiresAt"));
            string[,] art = { { "file", "sha256", "bytes", "enclave-host-" + v + ".zip" }, { "setup", "setupSha256", "setupBytes", "EnclaveSetup-" + v + ".exe" },
                              { "manifest", "manifestSha256", "manifestBytes", "manifest-" + v + ".json" } };
            long[] max = { MaxZip, 64L * 1024 * 1024, 16L * 1024 * 1024 };
            for (int i = 0; i < 3; i++)
            {
                if (Str(st, art[i, 0]) != art[i, 3]) throw new Exception("the signed statement's " + art[i, 0] + " must be " + art[i, 3]);
                if (!Is(Str(st, art[i, 1]), @"^[0-9a-f]{64}\z")) throw new Exception("the signed statement's " + art[i, 1] + " is not a sha256");
                Size(st, art[i, 2], max[i]);
            }
            return new Release { Version = v, File = Str(st, "file"), Sha256 = Str(st, "sha256"), Bytes = Size(st, "bytes", MaxZip),
                                 StatementSha256 = Hex(Sha(statement)), Signers = signed.Count };
        }
        /// <summary>
        /// GET url, handing each chunk to sink, bounded in bytes and time: an announced length over max (or other than expect,
        /// when expect is not negative) is refused before the body is read, a body longer than either at the first byte over,
        /// and the whole exchange is aborted at deadlineMs however slowly the bytes come. The request is aborted (not drained)
        /// on any failure, so a body that never ends cannot hold the dispose either. -> the bytes received.
        /// </summary>
        public static long Fetch(string url, long max, long expect, int deadlineMs, Action<byte[], int> sink)
        {
            var q = (HttpWebRequest)WebRequest.Create(url);
            q.Timeout = deadlineMs; q.ReadWriteTimeout = deadlineMs; q.KeepAlive = false;
            q.CachePolicy = new System.Net.Cache.RequestCachePolicy(System.Net.Cache.RequestCacheLevel.NoCacheNoStore);
            var clock = System.Diagnostics.Stopwatch.StartNew();
            bool late = false;
            using (new System.Threading.Timer(delegate { late = true; try { q.Abort(); } catch { } }, null, deadlineMs, System.Threading.Timeout.Infinite))
            {
                try
                {
                    using (var resp = q.GetResponse())
                    using (var src = resp.GetResponseStream())
                    {
                        try
                        {
                            if (resp.ContentLength > max) throw new Exception("announces " + resp.ContentLength + " bytes, more than " + max);
                            if (expect >= 0 && resp.ContentLength >= 0 && resp.ContentLength != expect) throw new Exception("announces " + resp.ContentLength + " bytes, the signed size is " + expect);
                            long got = 0; var buf = new byte[1 << 16]; int n;
                            while ((n = src.Read(buf, 0, buf.Length)) > 0)
                            {
                                got += n;
                                if (got > max) throw new Exception("sent more than " + max + " bytes");
                                if (expect >= 0 && got > expect) throw new Exception("sent more than the signed " + expect + " bytes");
                                if (clock.ElapsedMilliseconds > deadlineMs) throw new Exception("did not finish within " + deadlineMs / 1000 + " s");
                                sink(buf, n);
                            }
                            if (expect >= 0 && got != expect) throw new Exception("sent " + got + " bytes, the signed size is " + expect);
                            return got;
                        }
                        catch { try { q.Abort(); } catch { } throw; }
                    }
                }
                catch (Exception e)
                {
                    if (late || clock.ElapsedMilliseconds > deadlineMs) throw new Exception("did not finish within " + deadlineMs / 1000 + " s", e);
                    throw;
                }
            }
        }
        /// <summary>Every mirror's signed pointer; the highest version any of them proves. A mirror that serves nothing valid is
        /// noted and outvoted; two different signed statements for one version stop setup.</summary>
        public static Release Resolve(Policy p, Action<string> note)
        {
            Release best = null; var seen = new Dictionary<string, Release>(); var why = new List<string>();
            foreach (var m in p.Mirrors)
            {
                Release r;
                try
                {
                    using (var buf = new MemoryStream())
                    {
                        Fetch(m + EnvelopeName, MaxEnvelope, -1, EnvelopeDeadlineMs, delegate (byte[] b, int n) { buf.Write(b, 0, n); });
                        r = Verify(buf.ToArray(), p, DateTime.UtcNow);
                    }
                }
                catch (Exception e) { why.Add(m + ": " + e.Message); note(m + ": " + e.Message); continue; }
                Release other; string key = VersionKey(r.Version);
                if (seen.TryGetValue(key, out other))
                {
                    if (other.StatementSha256 != r.StatementSha256) throw new Exception("two different signed statements for version " + r.Version + ": not installing until the publisher explains");
                    other.ServedBy.Add(m); continue;
                }
                r.ServedBy.Add(m); seen[key] = r;
                if (best == null || Version.Parse(r.Version) > Version.Parse(best.Version)) best = r;
            }
            if (best == null) throw new Exception("no mirror served a release signed by the pinned key(s): " + string.Join("; ", why.ToArray()));
            return best;
        }
        /// <summary>A file the signed statement names, accepted only with the signed size and sha256, from the mirrors that served
        /// the statement first and then the others. An existing outPath with the signed size is hashed as a stream (never read
        /// whole) and kept if it matches. The part file has a random name and is created new; only a verified one becomes outPath.</summary>
        public static void Download(Policy p, string name, string sha, long bytes, string outPath, Action<long, long> progress, Action<string> note)
        {
            Download(p, null, name, sha, bytes, outPath, progress, note);
        }
        public static void Download(Policy p, Release servedBy, string name, string sha, long bytes, string outPath, Action<long, long> progress, Action<string> note)
        {
            var why = new List<string>();
            if (File.Exists(outPath) && (File.GetAttributes(outPath) & FileAttributes.ReparsePoint) == 0 && new FileInfo(outPath).Length == bytes)
                using (var f = File.OpenRead(outPath)) using (var h = SHA256.Create()) if (Hex(h.ComputeHash(f)) == sha) return;
            var order = new List<string>();
            if (servedBy != null) order.AddRange(servedBy.ServedBy);
            foreach (var m in p.Mirrors) if (!order.Contains(m)) order.Add(m);
            var clock = System.Diagnostics.Stopwatch.StartNew();
            foreach (var m in order)
            {
                long left = DownloadDeadlineMs - clock.ElapsedMilliseconds;
                if (left <= 0) { why.Add("the " + DownloadDeadlineMs / 1000 + " s deadline passed"); break; }
                int deadline = (int)Math.Min(left, Math.Min(AttemptCapMs, 60000 + (bytes * 1000 + MinRate - 1) / MinRate));
                string part = outPath + ".partial-" + Guid.NewGuid().ToString("N");
                try
                {
                    using (var h = SHA256.Create())
                    {
                        using (var dst = new FileStream(part, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                        {
                            long got = 0;
                            Fetch(m + name, bytes, bytes, deadline, delegate (byte[] b, int n)
                            {
                                dst.Write(b, 0, n); h.TransformBlock(b, 0, n, null, 0); got += n;
                                if (progress != null) progress(got, bytes);
                            });
                        }
                        h.TransformFinalBlock(new byte[0], 0, 0);
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



    static class Harness
    {
        static int failed;
        static Dictionary<string, object> fx;
        static byte[] liveEnvelope, liveSetup;
        static long floodSent;

        static void Check(string name, bool ok, string detail)
        {
            Console.WriteLine((ok ? "PASS" : "FAIL") + "\t" + name + "\t" + (detail ?? "").Replace("\r", " ").Replace("\n", " "));
            if (!ok) failed++;
        }
        static string Hex(byte[] b) { return BitConverter.ToString(b).Replace("-", "").ToLowerInvariant(); }
        static DateTime Utc(string s) { return DateTime.Parse(s, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal); }

        static int Main(string[] args)
        {
            var js = new JavaScriptSerializer { MaxJsonLength = 64 * 1024 * 1024 };
            fx = (Dictionary<string, object>)js.DeserializeObject(File.ReadAllText(args[1]));
            var live = (Dictionary<string, object>)fx["live"];
            liveEnvelope = Convert.FromBase64String((string)live["envelope"]);
            liveSetup = new byte[(int)live["setupBytes"]];
            for (int i = 0; i < liveSetup.Length; i++) liveSetup[i] = (byte)((i * 31 + 7) & 0xff);
            if (args[0] == "verdicts") return Verdicts();
            if (args[0] == "serve")
            {
                int port = StartMirror();
                File.WriteAllText(args[2], port.ToString(CultureInfo.InvariantCulture));
                // until run.ps1 writes <portfile>.stop (or kills it), and never more than ten minutes
                var up = Stopwatch.StartNew();
                while (!File.Exists(args[2] + ".stop") && up.ElapsedMilliseconds < 600000) Thread.Sleep(200);
                return 0;
            }
            if (args[0] == "transport") return Transport(args[2]);
            Console.Error.WriteLine("verdicts | transport | serve");
            return 2;
        }

        // ---- verdicts: every fixture through ParsePolicy and Verify, as setup runs them ----
        static int Verdicts()
        {
            var cases = (IList)fx["cases"];   // JavaScriptSerializer may give object[] or ArrayList
            for (int i = 0; i < cases.Count; i++)
            {
                var c = (Dictionary<string, object>)cases[i];
                string verdict, detail;
                try
                {
                    var p = ReleaseChannel.ParsePolicy((string)c["policyJson"]);
                    if (!c.ContainsKey("envelope")) { verdict = "accept"; detail = string.Join(" ", p.Mirrors.ToArray()); }
                    else
                    {
                        var r = ReleaseChannel.Verify(Convert.FromBase64String((string)c["envelope"]), p, Utc((string)c["now"]));
                        verdict = "accept"; detail = r.Version + " " + r.Signers + " " + r.StatementSha256;
                    }
                }
                catch (Exception e) { verdict = "refuse"; detail = e.GetType().Name + ": " + e.Message; }
                Console.WriteLine("verdict\t" + i + "\t" + verdict + "\t" + detail.Replace("\t", " ").Replace("\r", " ").Replace("\n", " "));
            }
            return 0;
        }

        // ---- the misbehaving loopback mirror ----
        static int StartMirror()
        {
            var l = new TcpListener(IPAddress.Loopback, 0);
            l.Start();
            var t = new Thread(delegate ()
            {
                for (;;)
                {
                    TcpClient cl;
                    try { cl = l.AcceptTcpClient(); } catch { return; }
                    ThreadPool.QueueUserWorkItem(delegate { Serve(cl); });
                }
            }) { IsBackground = true };
            t.Start();
            return ((IPEndPoint)l.LocalEndpoint).Port;
        }
        static void Serve(TcpClient cl)
        {
            try
            {
                using (cl)
                using (var s = cl.GetStream())
                {
                    var head = new StringBuilder(); int b;
                    while (!head.ToString().EndsWith("\r\n\r\n") && head.Length < 8192 && (b = s.ReadByte()) >= 0) head.Append((char)b);
                    string path = head.ToString().Split(' ')[1];
                    string[] seg = path.Trim('/').Split('/');
                    string scenario = Regex.Replace(seg[0], "[0-9]+$", ""), file = seg[seg.Length - 1];
                    byte[] body = file == "latest.signed.json" ? liveEnvelope : liveSetup;
                    Action<string> send = delegate (string h) { var x = Encoding.ASCII.GetBytes(h); s.Write(x, 0, x.Length); };
                    var deadline = Stopwatch.StartNew();
                    if (scenario == "ok") { send("HTTP/1.1 200 OK\r\nContent-Length: " + body.Length + "\r\nConnection: close\r\n\r\n"); s.Write(body, 0, body.Length); }
                    else if (scenario == "corrupt") { var x = (byte[])body.Clone(); x[x.Length / 2] ^= 1; send("HTTP/1.1 200 OK\r\nContent-Length: " + x.Length + "\r\nConnection: close\r\n\r\n"); s.Write(x, 0, x.Length); }
                    else if (scenario == "short") { send("HTTP/1.1 200 OK\r\nContent-Length: " + body.Length + "\r\nConnection: close\r\n\r\n"); s.Write(body, 0, body.Length / 2); }
                    else if (scenario == "announce") { send("HTTP/1.1 200 OK\r\nContent-Length: 53687091200\r\nConnection: close\r\n\r\nx"); while (deadline.ElapsedMilliseconds < 30000 && cl.Connected) Thread.Sleep(200); }
                    else if (scenario == "flood")
                    {
                        send("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n");
                        var chunk = new byte[65536];
                        while (deadline.ElapsedMilliseconds < 30000) { s.Write(chunk, 0, chunk.Length); Interlocked.Add(ref floodSent, chunk.Length); }
                    }
                    else if (scenario == "trickle")
                    {
                        send("HTTP/1.1 200 OK\r\nContent-Length: " + body.Length + "\r\nConnection: close\r\n\r\n");
                        while (deadline.ElapsedMilliseconds < 30000) { s.WriteByte(body[0]); s.Flush(); Thread.Sleep(200); }
                    }
                    else send("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                }
            }
            catch { }   // the client hung up: that is what most scenarios are for
        }

        // ---- transport: ReleaseChannel.Fetch, Download and Resolve against the mirror ----
        static ReleaseChannel.Policy PolicyFor(string baseUrl, params string[] scenarios)
        {
            var live = (Dictionary<string, object>)fx["live"];
            var d = (Dictionary<string, object>)new JavaScriptSerializer().DeserializeObject((string)live["policyJson"]);
            var mirrors = new List<string>(); foreach (var s in scenarios) mirrors.Add(baseUrl + s + "/");
            d["mirrors"] = mirrors;
            return ReleaseChannel.ParsePolicy(new JavaScriptSerializer().Serialize(d));
        }
        static string Fails(Action a) { try { a(); return null; } catch (Exception e) { return e.Message + (e.InnerException != null ? " / " + e.InnerException.Message : ""); } }

        static int Transport(string dir)
        {
            int port = StartMirror();
            string b = "http://127.0.0.1:" + port + "/";
            var live = (Dictionary<string, object>)fx["live"];
            string setupName = (string)live["setupName"], setupSha = (string)live["setupSha256"]; long setupBytes = liveSetup.Length;
            Directory.CreateDirectory(dir);

            // Fetch: the bounds hold during the transfer
            var sw = Stopwatch.StartNew(); var got = new MemoryStream();
            long n = ReleaseChannel.Fetch(b + "ok/" + setupName, setupBytes, setupBytes, 10000, delegate (byte[] x, int k) { got.Write(x, 0, k); });
            Check("Fetch: the signed bytes from a good mirror", n == setupBytes && Hex(SHA256.Create().ComputeHash(got.ToArray())) == setupSha, n + " bytes");
            sw.Restart(); string why = Fails(delegate { ReleaseChannel.Fetch(b + "announce/" + setupName, setupBytes, setupBytes, 10000, delegate { }); });
            Check("Fetch: an announced 50 GiB refused before the body", why != null && why.Contains("announces") && sw.ElapsedMilliseconds < 3000, sw.ElapsedMilliseconds + " ms: " + why);
            long memBefore = GC.GetTotalMemory(true); long floodBefore = Interlocked.Read(ref floodSent);
            sw.Restart(); why = Fails(delegate { ReleaseChannel.Fetch(b + "flood/latest.signed.json", 65536, -1, 10000, delegate { }); });
            Check("Fetch: an endless body refused at the first byte over 64 KiB", why != null && why.Contains("more than") && sw.ElapsedMilliseconds < 5000, sw.ElapsedMilliseconds + " ms: " + why);
            Thread.Sleep(500);
            Check("Fetch: the endless mirror was cut off (not drained) and nothing was buffered",
                  Interlocked.Read(ref floodSent) - floodBefore < 64L * 1024 * 1024 && GC.GetTotalMemory(true) - memBefore < 32L * 1024 * 1024,
                  (Interlocked.Read(ref floodSent) - floodBefore) + " bytes sent by the mirror");
            sw.Restart(); why = Fails(delegate { ReleaseChannel.Fetch(b + "trickle/" + setupName, setupBytes, setupBytes, 1500, delegate { }); });
            Check("Fetch: a trickle is cut off at the hard deadline", why != null && sw.ElapsedMilliseconds >= 1400 && sw.ElapsedMilliseconds < 4000, sw.ElapsedMilliseconds + " ms: " + why);
            why = Fails(delegate { ReleaseChannel.Fetch(b + "short/" + setupName, setupBytes, setupBytes, 10000, delegate { }); });
            Check("Fetch: a short body is refused", why != null, why);

            // Download: failover past every kind of bad mirror; no part files; the deadline over all mirrors
            ReleaseChannel.AttemptCapMs = 1500;
            string outPath = Path.Combine(dir, setupName);
            var notes = new List<string>();
            sw.Restart();
            why = Fails(delegate { ReleaseChannel.Download(PolicyFor(b, "trickle", "corrupt", "short", "announce", "flood", "nothing", "ok"), setupName, setupSha, setupBytes, outPath, null, delegate (string m) { notes.Add(m); }); });
            Check("Download: past trickle, corrupt, short, announce, flood and 404 to the good mirror",
                  why == null && File.Exists(outPath) && Hex(SHA256.Create().ComputeHash(File.ReadAllBytes(outPath))) == setupSha && notes.Count == 6 && sw.ElapsedMilliseconds < 15000,
                  sw.ElapsedMilliseconds + " ms, " + notes.Count + " refused" + (why != null ? ": " + why : ""));
            Check("Download: no part file left behind", Directory.GetFiles(dir).Length == 1, string.Join(", ", Directory.GetFiles(dir)));
            why = Fails(delegate { ReleaseChannel.Download(PolicyFor(b, "nothing"), setupName, setupSha, setupBytes, outPath, null, delegate { }); });
            Check("Download: a file already there with the signed bytes is kept", why == null, why);
            File.WriteAllBytes(outPath, new byte[setupBytes]);
            why = Fails(delegate { ReleaseChannel.Download(PolicyFor(b, "corrupt", "short"), setupName, setupSha, setupBytes, outPath, null, delegate { }); });
            Check("Download: with no good mirror, a wrong file already there is left as it was (never replaced by unverified bytes)",
                  why != null && new FileInfo(outPath).Length == setupBytes && File.ReadAllBytes(outPath)[1] == 0 && Directory.GetFiles(dir).Length == 1, why);
            ReleaseChannel.AttemptCapMs = 1000; ReleaseChannel.DownloadDeadlineMs = 2500;
            sw.Restart();
            why = Fails(delegate { ReleaseChannel.Download(PolicyFor(b, "trickle1", "trickle2", "trickle3", "trickle4", "ok"), setupName, setupSha, setupBytes, Path.Combine(dir, "x.exe"), null, delegate { }); });
            Check("Download: one deadline over all mirrors (four trickling mirrors cannot take a second each and then some)",
                  why != null && why.Contains("deadline") && sw.ElapsedMilliseconds < 5000 && !File.Exists(Path.Combine(dir, "x.exe")), sw.ElapsedMilliseconds + " ms: " + why);
            ReleaseChannel.AttemptCapMs = 3600000; ReleaseChannel.DownloadDeadlineMs = 2 * 3600000;

            // Resolve: a trickling or flooding pointer does not stop the good one
            ReleaseChannel.EnvelopeDeadlineMs = 1500;
            ReleaseChannel.Release rel = null; var rnotes = new List<string>(); sw.Restart();
            why = Fails(delegate { rel = ReleaseChannel.Resolve(PolicyFor(b, "trickle", "flood", "announce", "ok"), delegate (string m) { rnotes.Add(m); }); });
            Check("Resolve: the good mirror's signed release, past trickle, flood and announce",
                  why == null && rel.Version == (string)live["version"] && rnotes.Count == 3 && rel.ServedBy.Count == 1 && rel.ServedBy[0].Contains("/ok/") && sw.ElapsedMilliseconds < 6000,
                  sw.ElapsedMilliseconds + " ms" + (why != null ? ": " + why : ""));
            Console.WriteLine("transport: " + failed + " failure(s)");
            return failed == 0 ? 0 : 1;
        }
    }
}
