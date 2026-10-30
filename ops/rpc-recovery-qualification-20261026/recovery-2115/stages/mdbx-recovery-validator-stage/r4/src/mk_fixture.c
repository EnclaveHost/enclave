/* mdbx-recovery-validator-stage/r1 fixture builder (PREPARED by Claude; NOT compiled or run by Claude).
 * Creates a SMALL test database with the official libmdbx v0.13.12 API (linked against the same official mdbx-static.o the
 * jobs build): pagesize 4096 (like the production Base DB's metas), a main table plus one named table, N records each.
 *   mk_fixture DIR N      (DIR must exist and be empty; subdirectory mode like reth's db/ directory) */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "mdbx.h"

#define CK(x) do { int rc_ = (x); if (rc_ != MDBX_SUCCESS) { fprintf(stderr, "%s: %s\n", #x, mdbx_strerror(rc_)); return 1; } } while (0)

int main(int argc, char **argv) {
  if (argc != 3) { fprintf(stderr, "usage: mk_fixture DIR N\n"); return 2; }
  long n = strtol(argv[2], NULL, 10);
  if (n < 1 || n > 1000000) { fprintf(stderr, "N must be 1..1000000\n"); return 2; }
  MDBX_env *env = NULL; MDBX_txn *txn = NULL; MDBX_dbi main_dbi, named_dbi;
  CK(mdbx_env_create(&env));
  CK(mdbx_env_set_maxdbs(env, 4));
  CK(mdbx_env_set_geometry(env, -1, -1, 64 << 20, -1, -1, 4096));
  CK(mdbx_env_open(env, argv[1], MDBX_NOSTICKYTHREADS, 0600));
  CK(mdbx_txn_begin(env, NULL, MDBX_TXN_READWRITE, &txn));
  CK(mdbx_dbi_open(txn, NULL, MDBX_DB_DEFAULTS, &main_dbi));
  CK(mdbx_dbi_open(txn, "named", MDBX_CREATE, &named_dbi));
  char k[32], v[128];
  for (long i = 0; i < n; i++) {
    snprintf(k, sizeof k, "key-%08ld", i);
    memset(v, 'a' + (int)(i % 26), sizeof v);
    MDBX_val key = {k, strlen(k)}, val = {v, sizeof v};
    CK(mdbx_put(txn, main_dbi, &key, &val, MDBX_UPSERT));
    CK(mdbx_put(txn, named_dbi, &key, &val, MDBX_UPSERT));
  }
  CK(mdbx_txn_commit(txn));
  int sync_rc = mdbx_env_sync_ex(env, true, false);
  if (sync_rc != MDBX_SUCCESS && sync_rc != MDBX_RESULT_TRUE) {
    fprintf(stderr, "mdbx_env_sync_ex: %s\n", mdbx_strerror(sync_rc)); return 1;
  }                     /* a STEADY meta, like the production DB */
  CK(mdbx_env_close_ex(env, false));
  printf("fixture %s records=%ld\n", argv[1], n);
  return 0;
}
