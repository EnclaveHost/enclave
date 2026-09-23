/* PID 1 for the M4a adversary guest: the same environment dominit.c gives a real app domain - mounts,
 * vsock, and the SNP report interface - then native code with root instead of the app, and a power-off when
 * it is done. Purpose-built rather than a flag on dominit.c, so nothing an app domain relies on changes.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/reboot.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

static void insmod(const char *p) {
    int fd = open(p, O_RDONLY | O_CLOEXEC);
    if (fd < 0) { printf("ADV insmod %s: %s\n", p, strerror(errno)); return; }
    if (syscall(SYS_finit_module, fd, "", 4 /* MODULE_INIT_COMPRESSED_FILE */) != 0 && errno != EEXIST)
        printf("ADV insmod %s failed: %s\n", p, strerror(errno));
    close(fd);
}

int main(void) {
    mount("proc", "/proc", "proc", 0, 0);
    mount("sysfs", "/sys", "sysfs", 0, 0);
    mount("devtmpfs", "/dev", "devtmpfs", 0, 0);
    mount("tmpfs", "/tmp", "tmpfs", 0, "size=64m");
    mkdir("/sys/kernel/config", 0755);
    mount("configfs", "/sys/kernel/config", "configfs", 0, 0);
    insmod("/vsock.ko.zst");
    insmod("/vmw_vsock_virtio_transport_common.ko.zst");
    insmod("/vmw_vsock_virtio_transport.ko.zst");
    insmod("/tsm_report.ko.zst");
    insmod("/sev-guest.ko.zst");
    printf("ADV init: root in my own SNP guest, going after the other one\n");
    fflush(stdout);
    pid_t pid = fork();
    if (pid == 0) {
        char *argv[] = {"/advprobe", NULL}, *envp[] = {NULL};
        execve(argv[0], argv, envp);
        printf("ADV ERROR exec /advprobe: %s\n", strerror(errno));
        _exit(127);
    }
    int st = 0;
    waitpid(pid, &st, 0);
    printf("ADV probe exited status=%d\n", st);
    fflush(stdout);
    sync();
    reboot(RB_POWER_OFF);
    for (;;) pause();
}
