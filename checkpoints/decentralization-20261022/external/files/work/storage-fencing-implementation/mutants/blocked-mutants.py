#!/usr/bin/env python3
"""PATCH U1-B mutants: apply one to the scratch copy mutants/sia-s3 (refreshed from the candidate first)."""
import sys, subprocess, os, pathlib, time
HERE = os.path.dirname(os.path.abspath(__file__))
CAND = os.path.join(HERE, "..", "sia-s3")
COPY = os.path.join(HERE, "sia-s3")
M = {
  "MB1_blocked_entry_read_as_absent": ("src/store.rs", "                blocked.push(e.id.to_string());", "                // mutant: a blocked entry is simply absent"),
  "MB2_short_page_ends_listing": ("src/store.rs", "            Some(last) => after = Some(last.id),\n            None => break,", "            Some(last) if page.len() >= 500 => after = Some(last.id),\n            _ => break,"),
  "MB3_reread_keeps_old_index": ("src/replica.rs", "            self.exclude(i, Rc::new(fresh), blocked).await;\n            return Err", "            return Err"),
  "MB4_repair_copies_withheld": ("src/replica.rs", " && !self.withheld(&kk.0, &kk.1, &e.ver()) {", " {"),
  "MB5_withheld_served": ("src/replica.rs", "        if self.withheld(&e.b, &e.k, &e.ver()) {\n            return Err(WITHHELD.into());", "        if false {\n            return Err(WITHHELD.into());"),
  "MB6_request_without_blocked_flag": ("vendor/sia-sdk-rs/sia_storage/src/app_client/http.rs", 'let mut query_params = vec![("blocked", "true".to_string())];', "let mut query_params = Vec::new();"),
  "MB7_page_shape_unchecked": ("vendor/sia-sdk-rs/sia_storage/src/sdk.rs", "        crate::app_client::check_current_page(after, &events).map_err(Error::App)?;", "        let _ = after;"),
  "MB8_vouch_ignores_blocked_objects": ("src/store.rs", "self.keys.get(kk).is_some_and(|k| k.entry.ver() >= *v && k.objects().iter().all(|o| self.objs.contains_key(o)))", "self.keys.get(kk).is_some_and(|k| k.entry.ver() >= *v)"),
}
name = sys.argv[1]
subprocess.run(["rsync", "-a", "--delete", "--exclude", "target", CAND + "/", COPY + "/"], check=True)
f, old, new = M[name]
p = os.path.join(COPY, f)
s = open(p).read()
assert s.count(old) == 1, f"{name}: pattern found {s.count(old)} times"
open(p, "w").write(s.replace(old, new))
# touch every source so both crates are rebuilt from exactly this tree (see mutants.py)
now = time.time()
for q in list(pathlib.Path(COPY, "src").rglob("*.rs")) + list(pathlib.Path(COPY, "vendor/sia-sdk-rs/sia_storage/src").rglob("*.rs")):
    os.utime(q, (now, now))
print(f"applied {name} to {f} (sources touched)")
