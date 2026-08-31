# split-harness: the anchor split, native (x86 or aarch64 Linux), against a
# live shielded worker. Reuses wasm/ggml-shielded sources unmodified; the
# SIMD object is the GENERIC build only -- the TA will have no AVX-512, so
# the spike measures what the TA will actually run.
#
#   make                                # native build
#   make CROSS_COMPILE=aarch64-linux-gnu-   # the qemu-user / phone rung

GG      := ../../../wasm/ggml-shielded
CORE    := ../core
CC      := $(CROSS_COMPILE)gcc
CFLAGS  += -O2 -Wall -Wextra -I$(GG) -I$(CORE)

OBJS := split-harness.o worker-client.o anchor-core.o \
        shielded-field.o shielded-simd-generic.o shielded-wire.o

all: split-harness rtt-probe

split-harness: $(OBJS)
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ $(OBJS) -lm

rtt-probe: rtt-probe.o worker-client.o shielded-field.o shielded-wire.o
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ rtt-probe.o worker-client.o shielded-field.o shielded-wire.o -lm

rtt-probe.o: rtt-probe.c fixture.h worker-client.h
	$(CC) $(CFLAGS) -c $< -o $@

split-harness.o: split-harness.c $(CORE)/anchor-core.h fixture.h worker-client.h
	$(CC) $(CFLAGS) -c $< -o $@
worker-client.o: worker-client.c worker-client.h
	$(CC) $(CFLAGS) -c $< -o $@
anchor-core.o: $(CORE)/anchor-core.c $(CORE)/anchor-core.h
	$(CC) $(CFLAGS) -c $< -o $@

# The encoding is pinned cross-language: fp contraction stays OFF (see
# shielded/worker-cuda/Makefile for why).
shielded-field.o: $(GG)/shielded-field.c $(GG)/shielded-field.h
	$(CC) $(CFLAGS) -ffp-contract=off -c $< -o $@
shielded-simd-generic.o: $(GG)/shielded-simd.c $(GG)/shielded-simd.h $(GG)/shielded-field.h
	$(CC) $(CFLAGS) -O3 -c $< -o $@
shielded-wire.o: $(GG)/shielded-wire.c $(GG)/shielded-wire.h
	$(CC) $(CFLAGS) -c $< -o $@

clean:
	rm -f split-harness rtt-probe *.o

.PHONY: all clean
