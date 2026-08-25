# shielded ggml backend -- the TEE-side half that lets an ordinary ggml graph
# offload its linear ops to an untrusted GPU.
#
# Built standalone here so the field/wire/tee layers can be tested without the
# engine; the backend object is what gets linked into the ELL build.

CC      ?= cc
CFLAGS  ?= -O2 -Wall -Wextra -fPIC
LDLIBS  += -lm

CORE_SRC := shielded-field.c shielded-wire.c shielded-tee.c
CORE_OBJ := $(CORE_SRC:.c=.o)

all: shielded-probe field-selftest

%.o: %.c
	$(CC) $(CFLAGS) -c $< -o $@

shielded-probe: shielded-probe.c $(CORE_OBJ)
	$(CC) $(CFLAGS) -o $@ $^ $(LDLIBS)

field-selftest: field-selftest.c shielded-field.o
	$(CC) $(CFLAGS) -o $@ $^ $(LDLIBS)

clean:
	rm -f $(CORE_OBJ) shielded-probe field-selftest ggml-shielded.o

.PHONY: all clean
