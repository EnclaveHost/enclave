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

# The ggml backend needs ggml's headers and libraries. They are NOT a build
# dependency of the core above, on purpose: the field/wire/tee layers are what
# the reference can be checked against, and they must stay testable on a machine
# with no engine checkout at all (CI is one).
GGML_SRC ?= $(HOME)/Projects/llama.cpp
GGML_LIB ?= $(HOME)/Projects/llamacpp-lib
GGML_INC := -I$(GGML_SRC)/ggml/include -I$(GGML_SRC)/ggml/src
CXX      ?= c++
CXXFLAGS ?= -O2 -std=c++17 -Wall -Wextra -fPIC

all: shielded-probe field-selftest prepare-selftest half-selftest

# Built only where an engine checkout exists; `make ggml` opts in.
ggml: ggml-test

%.o: %.c
	$(CC) $(CFLAGS) -c $< -o $@

shielded-probe: shielded-probe.c $(CORE_OBJ)
	$(CC) $(CFLAGS) -o $@ $^ $(LDLIBS)

field-selftest: field-selftest.c shielded-field.o
	$(CC) $(CFLAGS) -o $@ $^ $(LDLIBS)

prepare-selftest: prepare-selftest.c shielded-field.o
	$(CC) $(CFLAGS) -o $@ $^ $(LDLIBS)

half-selftest: half-selftest.c shielded-field.o
	$(CC) $(CFLAGS) -o $@ $^ $(LDLIBS)

ggml-shielded.o: ggml-shielded.cpp ggml-shielded.h shielded-tee.h shielded-field.h
	$(CXX) $(CXXFLAGS) $(GGML_INC) -c $< -o $@

ggml-test: ggml-test.cpp ggml-shielded.o $(CORE_OBJ)
	$(CXX) $(CXXFLAGS) $(GGML_INC) -o $@ $^ \
	  -L$(GGML_LIB) -lggml -lggml-base -lggml-cpu $(LDLIBS) -Wl,-rpath,$(GGML_LIB)

clean:
	rm -f $(CORE_OBJ) shielded-probe field-selftest prepare-selftest half-selftest ggml-shielded.o ggml-test

.PHONY: all clean ggml
