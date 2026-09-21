#ifndef EE_NETDB_H
#define EE_NETDB_H
#include "sys/socket.h"
#ifdef __cplusplus
extern "C" {
#endif
struct addrinfo { int ai_flags, ai_family, ai_socktype, ai_protocol; socklen_t ai_addrlen; struct sockaddr *ai_addr; char *ai_canonname; struct addrinfo *ai_next; };
#define AI_PASSIVE 1
#define AI_NUMERICSERV 0x400
#define EAI_MEMORY -10
#define EAI_NONAME -2
int getaddrinfo(const char *node, const char *service, const struct addrinfo *hints, struct addrinfo **res);
void freeaddrinfo(struct addrinfo *ai); const char *gai_strerror(int e);
#ifdef __cplusplus
}
#endif
#endif
