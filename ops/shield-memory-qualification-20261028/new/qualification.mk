include Makefile
shielded-tee.pack24-test.o: shielded-tee.c shielded-pack24.h
	$(CC) $(CFLAGS) -DSHIELDED_PACK24_TESTHOOKS -c $< -o $@
pack24-link-selftest: pack24-link-selftest.o $(filter-out shielded-tee.o,$(CORE_OBJ)) shielded-tee.pack24-test.o
	$(CC) $(CFLAGS) $^ $(LDLIBS) -o $@
