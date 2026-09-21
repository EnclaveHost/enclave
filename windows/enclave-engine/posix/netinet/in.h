#ifndef EE_NETINET_IN_H
#define EE_NETINET_IN_H
#include "../sys/socket.h"
#include <stdint.h>
struct in_addr { uint32_t s_addr; };
struct sockaddr_in { sa_family_t sin_family; uint16_t sin_port; struct in_addr sin_addr; char sin_zero[8]; };
#define INADDR_ANY 0
#define INADDR_LOOPBACK 0x7f000001
static __inline uint16_t htons(uint16_t v) { return (uint16_t)((v << 8) | (v >> 8)); }
static __inline uint16_t ntohs(uint16_t v) { return htons(v); }
static __inline uint32_t htonl(uint32_t v) { return (v << 24) | ((v & 0xff00) << 8) | ((v >> 8) & 0xff00) | (v >> 24); }
static __inline uint32_t ntohl(uint32_t v) { return htonl(v); }
#endif
