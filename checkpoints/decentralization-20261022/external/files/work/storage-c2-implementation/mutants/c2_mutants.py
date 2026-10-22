#!/usr/bin/env python3
"""C2 mutants (negative controls): apply one to the scratch copy mutants/sia-s3 (refreshed from the candidate first).
Each mutant removes ONE C2 guarantee; the C2 tests must then fail."""
import sys, subprocess, os, pathlib, time
HERE = os.path.dirname(os.path.abspath(__file__))
CAND = os.path.join(HERE, "..", "sia-s3")
COPY = os.path.join(HERE, "sia-s3")
SDK = "vendor/sia-sdk-rs/sia_storage/src/"
M = {
  "MC1_indexer_applies_any_head": [(SDK + "app_client/mock.rs", "        if state.seq == sq {\n            return Ok(None);\n        }", "        if true {\n            return Ok(None);\n        }")],
  "MC2_gate_always_open": [("src/store.rs", "if !g.gate.wait().await {", "if false && !g.gate.wait().await {")],
  "MC3_readers_take_tentative": [("src/store.rs", "for e in m.e.iter().filter(|e| !is_tentative(&e.i)) {", "for e in m.e.iter() {")],
  "MC4_freshness_ignores_head": [(SDK + "app_client.rs", "Some(s) if s == head => Ok(C2Check::Confirmed(st)),", "_ if true => Ok(C2Check::Confirmed(st)),")],
  "MC5_resync_onto_another_head": [(SDK + "app_client.rs", "                self.c2_set(crate::fence::C2State::Forked(why.clone()));\n                Ok(C2Check::Forked(why))", "                let _ = why;\n                self.slot().lock().unwrap().c2 = crate::fence::C2State::Ready { head: other.unwrap_or(head) };\n                Ok(C2Check::Confirmed(st))")],
  "MC6_op_reuse_ignores_digest": [(SDK + "app_client/mock.rs", "return if d == digest() { Ok(Some(state.seq)) } else { Err(Error::OpConflict(Some(state.seq))) };", "return { let _ = (d, digest()); Ok(Some(state.seq)) };")],
  "MC7_unknown_outcome_forgotten_not_replayed": [(SDK + "app_client.rs", "            C2State::Pending { head, op } => {\n                let r = self.c2_send(app_key, &op, head).await;", "            C2State::Pending { head, op } => {\n                let _ = op;\n                self.c2_set(C2State::Ready { head });\n                return Ok(head);\n                #[allow(unreachable_code)]\n                let r = self.c2_send(app_key, &op, head).await;")],
  "MC8_no_tentative_cleanup": [("src/store.rs", "let todo = std::mem::take(&mut idx.tentative);", "let todo: Vec<String> = Vec::new();")],
  "MC9_delete_removes_entry_in_phase_one": [("src/store.rs", "        let mut tm = meta.clone();\n        tm.d.push(t.tentative());", "        let mut tm = nm.clone();\n        tm.d.retain(|d| d.q != t.q);\n        tm.d.push(t.tentative());")],
  "MC10_v3_mutation_accepted_when_enrolled": [(SDK + "app_client/mock.rs", "return if state.cas_mode { Err(Error::ModeConflict) } else { Ok(None) };", "return Ok(None);")],
  "MC12_first_send_replay_taken_as_success": [(SDK + "app_client.rs", "            C2Outcome::Applied(Some(a)) if a.replayed && first_send => self.c2_set(C2State::Forked(format!(", "            C2Outcome::Applied(Some(a)) if a.replayed && first_send && false => self.c2_set(C2State::Forked(format!(")],
  "MC13_mixed_indexers_unchecked": [("src/replica.rs", "            if let Some(old) = old_indexers.first() {", "            if let Some(old) = old_indexers.first().filter(|_| false) {")],
  "MC14_op_from_local_rng_only": [(SDK + "app_client.rs", "        Ok(crate::fence::c2_derive_op(&nonce, &local))", "        let _ = nonce;\n        Ok(local)")],
  "MC15_op_nonce_capability_not_required": [(SDK + "fence.rs", "[C2_CAPABILITY, C2_NONCE_CAPABILITY].iter()", "[C2_CAPABILITY].iter()")],
  "MC11_minority_quorum_allowed": [("src/replica.rs", "if 2 * self.write_quorum <= self.members().len() {", "if false {"), ("src/replica.rs", "if 2 * need <= members {", "if false {")],
}
name = sys.argv[1]
subprocess.run(["rsync", "-a", "--delete", "--exclude", "target", CAND + "/", COPY + "/"], check=True)
for f, old, new in M[name]:
    p = os.path.join(COPY, f)
    s = open(p).read()
    assert s.count(old) == 1, f"{name}: pattern found {s.count(old)} times in {f}"
    open(p, "w").write(s.replace(old, new))
# touch every source so both crates are rebuilt from exactly this tree
now = time.time()
for q in list(pathlib.Path(COPY, "src").rglob("*.rs")) + list(pathlib.Path(COPY, SDK).rglob("*.rs")):
    os.utime(q, (now, now))
print(f"applied {name} (sources touched)")
