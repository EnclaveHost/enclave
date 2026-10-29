/* Local no-CRT compiler support; volatile stores prohibit recursive builtin lowering. */
void *memset(void *dst, int value, unsigned long long count) {
  volatile unsigned char *p = (volatile unsigned char *)dst;
  while (count--) *p++ = (unsigned char)value;
  return dst;
}
