/* netup — bring up a network interface with a static address + default route,
 * with no iproute2/busybox in the guest. Built statically at image-build time
 * and shipped in the initramfs. The metal guest only ever dials OUT (QEMU
 * user-net / slirp NAT, or a tap on a colo host), so a fixed address is all it
 * needs; there is no inbound at the IP layer (reachability is the fleet tunnel).
 *
 *   netup <iface> <ip> <netmask> <gateway>
 *   netup eth0 10.0.2.15 255.255.255.0 10.0.2.2
 */
#include <arpa/inet.h>
#include <net/if.h>
#include <net/route.h>
#include <netinet/in.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

static void set_addr(struct ifreq *ifr, const char *ip) {
  struct sockaddr_in *sin = (struct sockaddr_in *)&ifr->ifr_addr;
  sin->sin_family = AF_INET;
  inet_pton(AF_INET, ip, &sin->sin_addr);
}

int main(int argc, char **argv) {
  if (argc != 5) { fprintf(stderr, "usage: netup <iface> <ip> <mask> <gw>\n"); return 2; }
  const char *iface = argv[1], *ip = argv[2], *mask = argv[3], *gw = argv[4];

  int s = socket(AF_INET, SOCK_DGRAM, 0);
  if (s < 0) { perror("socket"); return 1; }

  struct ifreq ifr;
  memset(&ifr, 0, sizeof ifr);
  strncpy(ifr.ifr_name, iface, IFNAMSIZ - 1);

  set_addr(&ifr, ip);
  if (ioctl(s, SIOCSIFADDR, &ifr) < 0) { perror("SIOCSIFADDR"); return 1; }
  set_addr(&ifr, mask);
  if (ioctl(s, SIOCSIFNETMASK, &ifr) < 0) { perror("SIOCSIFNETMASK"); return 1; }

  if (ioctl(s, SIOCGIFFLAGS, &ifr) < 0) { perror("SIOCGIFFLAGS"); return 1; }
  ifr.ifr_flags |= IFF_UP | IFF_RUNNING;
  if (ioctl(s, SIOCSIFFLAGS, &ifr) < 0) { perror("SIOCSIFFLAGS"); return 1; }

  struct rtentry rt;
  memset(&rt, 0, sizeof rt);
  struct sockaddr_in *dst = (struct sockaddr_in *)&rt.rt_dst;
  struct sockaddr_in *gwa = (struct sockaddr_in *)&rt.rt_gateway;
  struct sockaddr_in *gmask = (struct sockaddr_in *)&rt.rt_genmask;
  dst->sin_family = gwa->sin_family = gmask->sin_family = AF_INET;
  dst->sin_addr.s_addr = 0;    /* 0.0.0.0 */
  gmask->sin_addr.s_addr = 0;  /* 0.0.0.0 → default route */
  inet_pton(AF_INET, gw, &gwa->sin_addr);
  rt.rt_flags = RTF_UP | RTF_GATEWAY;
  rt.rt_dev = (char *)iface;
  if (ioctl(s, SIOCADDRT, &rt) < 0) { perror("SIOCADDRT"); return 1; }

  close(s);
  return 0;
}
