/*
 * wire-fd.c -- shielded-wire.c, plus the one constructor a protected VM needs.
 *
 * Inside a Microdroid pVM there is no network and the guest cannot reach the
 * host over vsock on its own (the host's app domain may not listen). What the
 * VM's owner can do is connectVsock() INTO the guest, so the worker socket
 * arrives as an accepted fd. sh_pipe_open() only knows how to dial; this
 * wraps an existing fd. It is built as a wrapper translation unit so the
 * shipped shielded-wire.c stays byte-identical (it is in the measured image).
 */
#include "shielded-wire.c"

sh_pipe *sh_pipe_open_fd(int fd) {
    sh_pipe *p = (sh_pipe *)calloc(1, sizeof *p);
    if (!p) return NULL;
    p->fd = fd;
    return p;
}

/* Step 5 of the port (shielded/anchor/PLAN.md phase 3): the COMPLETE trusted
 * half's link, sh_link_start(), dials the worker itself (tcp, or "vsock" to
 * the host when /dev/vsock exists -- the CVM's shape). A Microdroid guest can
 * do neither: its worker socket is ACCEPTED from the owner's connectVsock().
 * So the pVM build compiles shielded-tee.c with
 *     -Dsh_pipe_open=sh_pipe_open_hook
 * and the hook hands out a fd the payload adopted beforehand, falling back to
 * the real dial otherwise. shielded-tee.c itself is not touched; this file is
 * built WITHOUT the define, so it defines both the real function and the hook. */
static int g_adopt_fd = -1;
void sh_pipe_adopt_fd(int fd) { g_adopt_fd = fd; }
sh_pipe *sh_pipe_open_hook(const char *host, int port, int *err) {
    if (g_adopt_fd >= 0) {
        int fd = g_adopt_fd; g_adopt_fd = -1;
        sh_pipe *p = sh_pipe_open_fd(fd);
        if (!p) { close(fd); if (err) *err = SH_ERR_NOMEM; return NULL; }
        if (err) *err = SH_OK;
        return p;
    }
    return sh_pipe_open(host, port, err);
}
