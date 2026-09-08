#define _GNU_SOURCE
#include "../../shielded/anchor/avf/payload/anchor_header_file.h"
#include <assert.h>

int main(void) {
    uint8_t header[10003], copy[10003];
    for (size_t i = 0; i < sizeof header; i++) header[i] = (uint8_t)(i*31 + 7);
    const uint64_t full = UINT64_C(32) << 30;
    FILE *f = anchor_header_file_open(header, sizeof header, full); assert(f);
    assert(fileno(f) == -1); // no kernel file descriptor exists
    assert(fseeko(f, 0, SEEK_END) == 0 && ftello(f) == (off_t)full);
    assert(fseeko(f, 0, SEEK_SET) == 0 && ftello(f) == 0);
    assert(fread(copy, 1, 11, f) == 11 && ftello(f) == 11);
    assert(fseeko(f, -5, SEEK_CUR) == 0 && ftello(f) == 6);
    assert(fread(copy, 1, sizeof copy, f) == sizeof header - 6);
    assert(!memcmp(copy, header + 6, sizeof header - 6));
    assert(feof(f)); clearerr(f);
    assert(fseeko(f, 0, SEEK_SET) == 0);
    assert(fread(copy, 1, sizeof copy, f) == sizeof copy && !memcmp(copy, header, sizeof copy));
    assert(fseeko(f, full - 1, SEEK_SET) == 0 && fread(copy, 1, 1, f) == 0);
    assert(fseeko(f, -1, SEEK_SET) != 0);
    assert(fseeko(f, 1, SEEK_END) != 0);
    assert(fseeko(f, INT64_MAX, SEEK_END) != 0);
    assert(fseeko(f, 0, SEEK_SET) == 0);
    clearerr(f); assert(fwrite("x", 1, 1, f) == 0 && ferror(f));
    assert(fclose(f) == 0);
    assert(!anchor_header_file_open(header, sizeof header, sizeof header - 1));
    assert(!anchor_header_file_open(header, sizeof header, UINT64_MAX));
    puts("anchor-header-file: private reads, 32 GiB logical seeks, bounded EOF and write refusal passed");
}
