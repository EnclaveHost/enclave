/* Guest-local memory accounting. There is deliberately no model-size floor.
 * Trial loading and inference share a kernel-enforced cgroup budget. Keep
 * headroom for init, TLS, networking and the broker outside that group. */
#ifndef ENCLAVE_SHIELD_MEMORY_H
#define ENCLAVE_SHIELD_MEMORY_H
#define SHIELD_MIB (1024ULL * 1024ULL)
static unsigned long long shield_memory_budget(unsigned long long total,
                                               unsigned long long available) {
    unsigned long long reserve = total / 20; /* 5% platform headroom */
    if (reserve < 256 * SHIELD_MIB) reserve = 256 * SHIELD_MIB;
    if (available > total) available = total;
    return available > reserve ? available - reserve : 0;
}
#endif
