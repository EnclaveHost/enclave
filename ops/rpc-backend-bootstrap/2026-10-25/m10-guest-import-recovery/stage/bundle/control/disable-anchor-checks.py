#!/usr/bin/env python3
"""NEGATIVE CONTROL: in a COPY of the patched tree (argv[1]) disable exactly (a) the two M10 precondition checks and
(b) the safe-head reset call of the anchored SafeDB wipe. Everything still compiles."""
import sys
p = sys.argv[1] + "/crates/consensus/engine/src/sync/anchor.rs"; s = open(p).read()
A = '        if head.block_info.id() != self.num_hash() {'; B = '            if let Some(block) = get_block_compat(engine_client, tag.into()).await? &&\n                block.header.number > self.number'
assert s.count(A) == 1 and s.count(B) == 1, "control anchors not found"
s = s.replace(A, A.replace("if head", "if false && head")).replace(B, B.replace("block.header.number > self.number", "false && block.header.number > self.number"))
open(p, "w").write(s)

q = sys.argv[1] + "/crates/consensus/service/src/service/anchor_safedb.rs"; t = open(q).read()
C = '        listener\n            .safe_head_reset(L2BlockInfo::default())\n            .await\n            .map_err(BootstrapSafeDbWipeError::Reset)?;\n'
assert t.count(C) == 1, "safedb control anchor not found"
t = t.replace(C, "        let _ = (listener, L2BlockInfo::default());\n")
open(q, "w").write(t)
