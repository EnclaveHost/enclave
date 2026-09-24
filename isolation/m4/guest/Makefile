# Build appidmod against the GUEST kernel, not the host's: the domain runs the guest kernel from
# ../../m1/domain.env, and a module built against the wrong release will not load.
obj-m += appidmod.o
KREL ?= $(shell . $(CURDIR)/../../m1/domain.env && echo $$GUEST_KREL)
all:
	$(MAKE) -C /lib/modules/$(KREL)/build M=$(CURDIR) modules
clean:
	$(MAKE) -C /lib/modules/$(KREL)/build M=$(CURDIR) clean
