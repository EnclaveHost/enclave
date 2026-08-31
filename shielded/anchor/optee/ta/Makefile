CFG_TEE_TA_LOG_LEVEL ?= 2

# The UUID for the Trusted Application
BINARY = 6e3f9c52-8d41-4c07-9ab2-5ed01a847c33

-include $(TA_DEV_KIT_DIR)/mk/ta_dev_kit.mk

ifeq ($(wildcard $(TA_DEV_KIT_DIR)/mk/ta_dev_kit.mk), )
clean:
	@echo 'Note: $$(TA_DEV_KIT_DIR)/mk/ta_dev_kit.mk not found, cannot clean TA'
endif
