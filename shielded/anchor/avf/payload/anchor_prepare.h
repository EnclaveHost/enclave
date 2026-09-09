/* PREPARE control parsing and the bounded wait for the owner's STOP (anchor_payload.c run_prepare). Pure: a host fixture drives both. */
#ifndef ANCHOR_PREPARE_H
#define ANCHOR_PREPARE_H
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
/* "PREPARE" (default 300) or "PREPARE <seconds>" with a canonical decimal 1..600 (no sign, no leading zero, nothing else on
 * the line). 1 = ok with *seconds set; 0 = malformed (the run is refused, never clamped or guessed). */
int anchor_prepare_parse(const char *line, int *seconds);
/* "ARTIFACT_PROFILE 0" | "ARTIFACT_PROFILE 1": the owner's explicit per-run artifact receive profiler switch (anchor_payload.c
 * artifact_receive_conn prints one ARTIFACT PROFILE line per completed reception when on). Exactly that text, nothing else on the
 * line: 1 = ok with *on set to 0/1; 0 = malformed (the run is refused). Default when the line is absent: off. This is the only
 * way PREPARE (which carries no ENGINE environment) can turn the profiler on; it is not a general environment command. */
int anchor_artifact_profile_parse(const char *line, int *on);
/* The profiler decision at receive time: an explicit control line (0 or 1) wins; with none (-1) the ENGINE environment value
 * ANCHOR_ARTIFACT_PROFILE decides ("1" = on, anything else or NULL = off). Returns 1 = profile, 0 = plain receive. */
int anchor_artifact_profile_effective(int explicit_setting, const char *env_value);
enum { ANCHOR_PREPARE_STOP = 1, ANCHOR_PREPARE_EOF = 2, ANCHOR_PREPARE_DEADLINE = 3, ANCHOR_PREPARE_ERROR = 4, ANCHOR_PREPARE_OVERLONG = 5 };
/* Waits on the owner's control descriptor until a complete "STOP" line, EOF, a read error, the monotonic deadline, or a line
 * longer than 64 bytes. Reads are non-blocking (poll, then one read of what is available; a partial line then silence ends at
 * the deadline, never in a blocking read). Other complete lines are ignored. `deadline_ms` is on the CLOCK_MONOTONIC ms scale. */
int anchor_prepare_wait_stop(int fd, uint64_t deadline_ms);
uint64_t anchor_prepare_mono_ms(void);
#ifdef __cplusplus
}
#endif
#endif
