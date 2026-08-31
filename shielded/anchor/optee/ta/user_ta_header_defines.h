/* The name of this file must not be modified (ta_dev_kit contract). */
#ifndef USER_TA_HEADER_DEFINES_H
#define USER_TA_HEADER_DEFINES_H

#include <anchor_ta.h>

#define TA_UUID TA_ANCHOR_UUID

#define TA_FLAGS 0

/* The core allocates everything at prepare time; gate|up geometry for a
 * 0.5B model needs ~9.3 MiB (weights + fv vectors + u + y), so 24 MiB
 * leaves room for the 4B shapes the spike also wants to try. This number
 * is itself a finding: it is what the phone TA will have to negotiate
 * from whichever vendor TEE hosts it. */
#define TA_STACK_SIZE (64 * 1024)
#define TA_DATA_SIZE  (24 * 1024 * 1024)

#define TA_VERSION "0.1"
#define TA_DESCRIPTION "Enclave Shielded anchor spike: unmask+Freivalds+remask"

#endif
