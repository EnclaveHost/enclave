# accepted-image-enrollment-stage/r7 provenance (prepared; NOT run by Claude)

**Tree `1cc32f1c9ce6fd5eeb16808c08f77568f17c3e3a`** = r6 `e72ebae2` (frozen, SUMS `fbbc2136…`) + `patches/accepted-image-enrollment-r7-vs-r6.patch` (2 test files, +30/−17).
- I reproduced it from the full chain in a clean repo.
- **No production source change since r5:** the B1/B2/M1–M4 fixes, the role, replica, adapter and KVM r3 are all unchanged.

**Evidence:** root 1447 (`inputs/root-1447/`, terminal): KVM unit 22/22, replica 8/8, composition 4/6, role 16/19.

**Corrections (logs/claude-enrollment-r7.md):**
1. **Composition 2 and 5:** the committer receives the adapter-MAPPED canonical relative names, which are the IPC wire contract. The tests now assert BOTH layers with exact order and count:
   - KVM's canonical absolute RAM paths, recorded at the KVM→adapter boundary;
   - the relative wire names.
2. **Role 13 (B2):** the failover test leaves 2 live members, so partitioning the primary leaves no majority and no successor. The test now asserts:
   - the stale term composes and seeds nothing, and no other primary exists without a majority;
   - it ALWAYS heals in `finally`;
   - then the healed group's primary seeds exactly its committed scan, and every live member agrees.
   
   Role 14 and 15 only cascaded from B2's unhealed partition.
3. **Role 15 (in-flight):** it kills the child once the role has demonstrably written the bytes, i.e. the commit is in flight.

**Job:** `jobs/root-accepted-image-enrollment-r7.sh` (slice / check / image). The counts are unchanged (role 19, composition 6, replica 8, KVM 22 + 65). It never sets HOME, CODEX_HOME, TMPDIR or TEST_TMP.
