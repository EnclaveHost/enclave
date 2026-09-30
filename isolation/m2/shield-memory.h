/* Measured startup admission. total is usable guest RAM, never host free RAM.
 * MemTotal excludes kernel reservations and SNP metadata: the 72 GiB
 * production guest reports 72,158 MiB usable. Keep a conservative 70 GiB
 * usable minimum for that model and 7 GiB for the 8 GiB small-model guest. */
#ifndef ENCLAVE_SHIELD_MEMORY_H
#define ENCLAVE_SHIELD_MEMORY_H
#define SHIELD_MIB (1024ULL * 1024ULL)
static int shield_memory_fits(unsigned long long total, int large) {
    return total >= (large ? 71680ULL : 7168ULL) * SHIELD_MIB;
}
static unsigned long long shield_serve_budget(unsigned long long total, int large, int fits) {
    unsigned long long available = total > 1024 * SHIELD_MIB ? total - 1024 * SHIELD_MIB : 1;
    unsigned long long profile = (large ? 32768ULL : 2048ULL) * SHIELD_MIB;
    /* A non-fitting model has no graph registered, regardless of app estimates. */
    return fits && available > profile ? profile : available;
}
#endif
