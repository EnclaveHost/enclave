/* The three TPM core entry points enclave_openhcl_tpm.c uses, as the kernel's private drivers/char/tpm/tpm.h declares
 * them (the same from v6.4 through v6.8). A distribution's header package does not ship that private header, so a
 * module built against one includes this instead; an in-tree build uses the kernel's own. */
#include <linux/tpm.h>
struct tpm_chip *tpmm_chip_alloc(struct device *pdev, const struct tpm_class_ops *ops);
int tpm_chip_bootstrap(struct tpm_chip *chip);
int tpm_chip_register(struct tpm_chip *chip);
