#ifndef EE_LINUX_VM_SOCKETS_H
#define EE_LINUX_VM_SOCKETS_H
#include "../sys/socket.h"
struct sockaddr_vm { sa_family_t svm_family; unsigned short svm_reserved1; unsigned int svm_port, svm_cid; unsigned char svm_zero[4]; };
#define VMADDR_CID_ANY (-1U)
#define VMADDR_CID_HOST 2
#define VMADDR_PORT_ANY (-1U)
#define SO_VM_SOCKETS_BUFFER_SIZE 0
#define SO_VM_SOCKETS_BUFFER_MIN_SIZE 1
#define SO_VM_SOCKETS_BUFFER_MAX_SIZE 2
#endif
