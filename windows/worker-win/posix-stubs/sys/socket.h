/* posix-stubs/sys/socket.h -- intentionally empty.
 *
 * worker.cu includes the POSIX headers unconditionally. On Windows the symbols
 * it wants from this one (sockets, byte order, pollfd, iovec) are supplied by
 * <winsock2.h>/<ws2tcpip.h> and win-compat.h, which the build force-includes
 * ahead of everything. This file exists only so the #include resolves, which is
 * what lets worker.cu stay byte-identical across the two platforms.
 */
