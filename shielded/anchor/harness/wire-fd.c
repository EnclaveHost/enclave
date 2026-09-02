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
