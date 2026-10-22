# Native fix: fixture 29 (`http://[::1]:9/w/`) and mirror-host parity (2026-10-20)

**Repository:** `enclave`, working tree only.

**Not done:** no commits, Wine, SSH, GUI, installs, execution-policy changes or production changes.

**Nothing Windows was executed by me.** The C# and PowerShell changes were reviewed statically. The coordinator needs
to rerun the native harness. The coordinator's native run (`windows-native-hardening-review/`) executed the C# verifier
and the C# transfer tests only. It did not execute the PowerShell scripts or functions, and this report does not claim
that it did.

## The cause

The native run gave 119 of 120 verdicts matching. The miss was fixture 29: EnclaveSetup.cs refused
`http://[::1]:9/w/` with "must be https", while Node accepts it.

The C# check was `u.Host == "[::1]"`. .NET Framework's `Uri.Host` does not spell an IPv6 literal that way, so the
comparison never matched and an IPv6 loopback mirror fell through to "must be https". Comparing a parsed host to a
fixed string is fragile in general: WHATWG URL in Node also rewrites hosts (`127.1`, `2130706433` and `0x7f000001`
all become `127.0.0.1`), and .NET may not.

**`cli/host.ps1` had the same bug.** It used `@("localhost", "127.0.0.1", "[::1]") -ccontains $u.Host`, the same
comparison, so it would have refused `[::1]` exactly as C# did.

## The fix: one rule, applied in all three verifiers

The host is now judged **as written**, using the whole authority (`host[:1-5 digits]`, followed by `/` or the end).
This is applied in `release-channel.mjs` (`normalizeMirror`), `EnclaveSetup.cs` (`ReleaseChannel.Mirror`) and
`cli/host.ps1` (`ConvertTo-ReleaseMirror`). The existing printable-ASCII and no-`\ ? # @ %` rules still apply before
it.

- **A name** must be a strict DNS name: letters, digits and inner hyphens; no `_`, no empty label, no trailing dot.
  - If its last label looks numeric (all digits, or `0x` and hex), it must be a canonical dotted quad.
  - The parsed host must equal the written one, ignoring case.
- **An IPv6 literal** must parse to exactly `::1`, and is always written back as `[::1]`.
  - C# and PowerShell check this with `UriHostNameType.IPv6`, then `IPAddress.TryParse` on the bracket's contents, then
    equality with `IPAddress.IPv6Loopback`.
  - Equality is used rather than `IsLoopback`, so nothing beyond `::1` can be accepted (for example IPv4-mapped
    addresses).
  - Node requires WHATWG URL's hostname to be `[::1]`, which is how it writes a literal that is `::1`.
  - The result is built from the scheme, `[::1]`, the port when it is not the default, and `AbsolutePath`. `Uri.Host` is
    never used for it.
- **Plain http** is allowed only for `localhost`, `127.0.0.1` or `[::1]`, exactly.
  - Other 127/8 addresses and names like `localhost.localdomain`, `sub.localhost` or `localhost.` are refused.
  - An empty port (`http://localhost:/`) is refused everywhere; Node accepted it before.

Everything else is unchanged: the signature protocol, thresholds, pinned-key trust, no unsigned fallback, the bounded
transfers and deadlines, `SecureWorkDir` and the coordinator's `${installed}:` fix. Shield, host, secrets, domains and
agent files were not touched.

## New fixture cases

There are 157 cases now (120 before). The new ones are:

- **Accepted:**
  - `http://[::1]/` gives `http://[::1]/`;
  - `http://[0:0:0:0:0:0:0:1]:9/w/` gives `http://[::1]:9/w/`;
  - `http://[0000:...:0001]/w` gives `http://[::1]/w/`;
  - `HTTP://[::1]:8080/A/../w` gives `http://[::1]:8080/w/`;
  - `https://[::1]:443/w/` gives `https://[::1]/w/`;
  - `http://[::1]:80/` gives `http://[::1]/`;
  - `HTTP://LOCALHOST/w`, `http://localhost:80/w/`, `http://127.0.0.1:65535/` and `https://192.0.2.1/w/`.
- **Refused, IPv6:** `[::2]`, `[::]`, `[::ffff:127.0.0.1]`, `[::ffff:7f00:1]`, `[fe80::1]`, `https://[2001:db8::1]/`,
  `[0:0:0:0:0:0:0:2]` and `http://[::1/`.
- **Refused, IPv4 and names:**
  - `127.1`, `2130706433`, `0x7f000001`, `0x7f.0.0.1`, `127.0.0.01`, `127.000.000.001`, `127.0.0.2` and
    `127.255.255.255`;
  - `localhost.localdomain`, `localhost.`, `sub.localhost` and `localhost:` (empty port);
  - port `65536`, `256.0.0.1`, `m.example.`, `m..example`, `-m.example`, `m_x.example` and `m.example.123`.

Fixture 29 (`http://[::1]:9/w/`) is unchanged and still expects accept with `http://[::1]:9/w/`. Indexes after the
mirror block have shifted, because cases are matched by index and name.

## Tests run (focused only, Linux, Node v22.23.3)

```
node test/windows-native/make-fixtures.mjs           # wrote 157 cases; Node gives every expected verdict
node test/windows-native/make-fixtures.mjs --check test/windows-native/fixtures.json   # Node agrees with all 157
node --test test/windows-release-channel.test.mjs test/windows-installer-independence.test.mjs test/windows-publish-host.test.mjs
# pass 27, fail 0 (the release-channel policy test now includes the IPv6, numeric-host and loopback cases above)
```

The C# and PowerShell files had only a crude brace and paren balance check here. The broad repository suite was not
rerun.

## Files changed in this pass

| File | Change |
| --- | --- |
| `windows/installer/EnclaveSetup.cs` | `ReleaseChannel.Mirror` uses the as-written host rules, with `IPAddress` parsing for `[::1]`. |
| `cli/host.ps1` | `ConvertTo-ReleaseMirror`: the same rules (the same bug was here). |
| `windows/node/release-channel.mjs` | `normalizeMirror`: the same rules. Node now also refuses `127.1`-style hosts and an empty port. |
| `test/windows-native/make-fixtures.mjs`, `fixtures.json`, `node-verdicts.json` | 37 new mirror cases, regenerated. |
| `test/windows-release-channel.test.mjs` | IPv6 compressed and full forms, non-loopback IPv6, numeric hosts, loopback names. |
| `test/windows-native/run.ps1` | The usage line no longer uses `-ExecutionPolicy Bypass`. It states the precondition: the machine's execution policy must already allow the script; nothing bypasses or changes it. |
| `docs/network/independent-windows.md` | The harness command without Bypass, the precondition, and the mirror host rules. |

`docs/network/independent-windows.md` line 70 still shows the original author's `install-host.ps1` example with
`-ExecutionPolicy Bypass`. That line is about installation, not this harness, so I left it.

My earlier `claude-windows-hardening-result.md` also gives a Bypass command for `run.ps1`. That command is superseded by
this report and should not be used.

## For the coordinator (native rerun)

Copy the updated tree, including `test/windows-native/` with the regenerated `fixtures.json` and `node-verdicts.json`.
Then, where the execution policy already permits it, run:

```
powershell -NoProfile -File test\windows-native\run.ps1
```

**Expected:** all 157 C# verdicts match, and the C# transfer tests pass as before.

The PowerShell verdict, transfer, lock and SecureWorkDir sections of `run.ps1` would run for the first time. If the
policy does not permit the script, the C# half can be run the same way as last time: extract `ReleaseChannel`, compile it
with `Harness.cs`, then run `Harness.exe verdicts` and `Harness.exe transport`.

**Still unverified natively:**

- what `.NET Uri` does with spellings Node rejects (`127.1`, `localhost:`): the raw rule refuses them first, so this
  should not matter;
- whether every new case passes in C#;
- all PowerShell behaviour.
