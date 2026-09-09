# CPU pool polling experiment

`ANCHOR_CPU_POLL` overrides the ggml worker pool's polling count for the
target, batch and MTP head pools. It accepts canonical decimal integers
from `0` through `100`. Unset preserves the linked library's default.
An invalid value, missing persistent pool API, or failed pool allocation
with an explicit override refuses the run instead of ignoring the setting.

In the current Android ggml build, the default is `50`, and each idle
worker can execute up to `1024 * 128 * poll` relax iterations before
parking. Those workers can compete with the app's bridge and pad delivery
threads for the phone's cores while the main VM thread waits on the link.
Reducing polling may free CPU time for that work, at the cost of more
thread wakeups. The effect on end-to-end throughput is unmeasured.

The payload forwards this knob through the existing `shenv` allowlist.
For a controlled comparison, keep the APK, model, prompt, MTP settings,
transport and pad policy fixed and compare unset/default, `10`, and `0`.
The engine reports the effective requested poll value and whether it is
the library default or an explicit override. Compare actual whole and
steady decode times with the existing text, verification and replenishment
checks. This changes thread scheduling; it changes no arithmetic or
verification requirements.
