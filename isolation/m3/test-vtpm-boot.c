#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include "vtpm-boot.h"

static int checks;
static void expect(const char *label, int actual, int wanted) {
    checks++;
    if (actual != wanted) {
        fprintf(stderr, "FAIL %s: got %d wanted %d\n", label, actual, wanted);
        exit(1);
    }
}
static void file(const char *name, const char *data, size_t len, mode_t mode) {
    int fd = open(name, O_CREAT | O_EXCL | O_WRONLY, mode);
    if (fd < 0 || write(fd, data, len) != (ssize_t)len || close(fd)) { perror("fixture write"); exit(1); }
    if (chmod(name, mode)) { perror("fixture chmod"); exit(1); }
}
#define SELECT(snp, host, required) enclave_vtpm_boot_mode("builtin", "module", snp, host, required)

int main(void) {
    if (getuid() != 0) { fprintf(stderr, "Run inside unshare --map-root-user; fixture ownership must match guest root\n"); return 2; }
    char dir[] = "vtpm-boot-test-XXXXXX";
    if (!mkdtemp(dir) || chdir(dir)) { perror("fixture directory"); return 1; }
    expect("unchanged legacy image", SELECT(0, 1, 0), ENCLAVE_VTPM_NONE);
    expect("desktop cannot omit transport", SELECT(0, 1, 1), ENCLAVE_VTPM_ERROR);
    expect("missing TPM device", enclave_vtpm_device_ready("absent"), 0);
    file("builtin", ENCLAVE_VTPM_BUILTIN_MARKER, sizeof ENCLAVE_VTPM_BUILTIN_MARKER - 1, 0444);
    expect("builtin selected", SELECT(0, 1, 1), ENCLAVE_VTPM_BUILTIN);
    expect("builtin rejects SNP", SELECT(1, 1, 1), ENCLAVE_VTPM_ERROR);
    expect("builtin requires report host", SELECT(0, 0, 1), ENCLAVE_VTPM_ERROR);
    expect("regular file is not TPM", enclave_vtpm_device_ready("builtin"), 0);
    if (chmod("builtin", 0666)) return 1;
    expect("writable marker rejected", SELECT(0, 1, 1), ENCLAVE_VTPM_ERROR);
    unlink("builtin");
    file("builtin", ENCLAVE_VTPM_BUILTIN_MARKER, sizeof ENCLAVE_VTPM_BUILTIN_MARKER, 0444);
    expect("trailing NUL rejected", SELECT(0, 1, 1), ENCLAVE_VTPM_ERROR);
    unlink("builtin");
    file("builtin", "", 0, 0444);
    expect("empty marker rejected", SELECT(0, 1, 1), ENCLAVE_VTPM_ERROR);
    unlink("builtin");
    file("builtin", "ENCLAVE-OPENHCL-TPM/2\n", sizeof ENCLAVE_VTPM_BUILTIN_MARKER - 1, 0444);
    expect("unknown marker version rejected", SELECT(0, 1, 1), ENCLAVE_VTPM_ERROR);
    unlink("builtin");
    if (symlink("absent", "builtin")) return 1;
    expect("dangling marker symlink rejected", SELECT(0, 1, 1), ENCLAVE_VTPM_ERROR);
    unlink("builtin");
    if (mkdir("builtin", 0755)) return 1;
    expect("marker directory rejected", SELECT(0, 1, 1), ENCLAVE_VTPM_ERROR);
    rmdir("builtin");
    file("module", "fixture, not a loadable module", 29, 0644);
    expect("legacy module selected", SELECT(0, 1, 0), ENCLAVE_VTPM_MODULE);
    expect("module requires report host", SELECT(0, 0, 0), ENCLAVE_VTPM_ERROR);
    file("builtin", ENCLAVE_VTPM_BUILTIN_MARKER, sizeof ENCLAVE_VTPM_BUILTIN_MARKER - 1, 0444);
    expect("ambiguous transport rejected", SELECT(0, 1, 1), ENCLAVE_VTPM_ERROR);
    unlink("builtin");
    if (chmod("module", 0666)) return 1;
    expect("writable module rejected", SELECT(0, 1, 0), ENCLAVE_VTPM_ERROR);
    unlink("module");
    if (symlink("absent", "module")) return 1;
    expect("module symlink rejected", SELECT(0, 1, 0), ENCLAVE_VTPM_ERROR);
    unlink("module");
    if (chdir("..") || rmdir(dir)) return 1;
    printf("TPM boot selection: %d filesystem checks passed; actual TPM report requires hardware validation\n", checks);
    return 0;
}
