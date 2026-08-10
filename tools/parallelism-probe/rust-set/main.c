#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
uint64_t set_demo_run(uint32_t n);
int main(int argc, char **argv) {
    uint32_t n = argc > 1 ? (uint32_t)atoi(argv[1]) : 8;
    uint64_t r = set_demo_run(n);
    printf("rust-on-SET: %u threads, shared accumulator = %llu\n", n,
           (unsigned long long)r);
    return 0;
}
