# The CA. Needs libteec (optee_client) headers/libs: point TEEC_EXPORT at a
# sysroot that has them, e.g. the QEMUv8 buildroot sysroot:
#   make CROSS_COMPILE=.../aarch64-none-linux-gnu- \
#        TEEC_EXPORT=$OPTEE/out-br/host/aarch64-buildroot-linux-gnu/sysroot/usr

CROSS_COMPILE ?= aarch64-linux-gnu-
CC      := $(CROSS_COMPILE)gcc
GG      := ../../../../wasm/ggml-shielded
HARNESS := ../../harness
TEEC_EXPORT ?= ../../../../../optee/out-br/host/aarch64-buildroot-linux-gnu/sysroot/usr

CFLAGS += -O2 -Wall -I../ta/include -I$(GG) -I$(HARNESS) -I$(TEEC_EXPORT)/include
LDADD  += -L$(TEEC_EXPORT)/lib -lteec -lm

OBJS = main.o worker-client.o shielded-wire.o shielded-field.o

all: anchor-ca

anchor-ca: $(OBJS)
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ $(OBJS) $(LDADD)

main.o: main.c ../ta/include/anchor_ta.h $(HARNESS)/fixture.h $(HARNESS)/worker-client.h
	$(CC) $(CFLAGS) -c $< -o $@
worker-client.o: $(HARNESS)/worker-client.c $(HARNESS)/worker-client.h
	$(CC) $(CFLAGS) -c $< -o $@
shielded-wire.o: $(GG)/shielded-wire.c $(GG)/shielded-wire.h
	$(CC) $(CFLAGS) -c $< -o $@
# encoding: fp contraction off, always (see shielded/worker-cuda/Makefile)
shielded-field.o: $(GG)/shielded-field.c $(GG)/shielded-field.h
	$(CC) $(CFLAGS) -ffp-contract=off -c $< -o $@

clean:
	rm -f anchor-ca *.o

.PHONY: all clean
