# Stopped experiment: unfinished source preservation

The user stopped the experiment and then requested a handoff and source-control commit. The thread goal remains paused and its recurring automation is deleted. This commit preserves the three unfinished broker edits and the handoff prompt; it does not resume implementation or authorize activation.

Baseline `f4705ec216d2569aaad7c3a105d955fc593368f6` contains the last tested exporter integration. This delta adds a proposed broker serving cutoff and proposed tests. It has been formatted and checked for whitespace only, **not compiled or tested**. No build, native experiment, deployment or production action was run for this delta.

The broker command still has an original-deadline exit timer; the monitor acquisition client still ends at that deadline; outer transports, units and Windows lifecycle also require integration. The new field alone does not provide a coherent serving lifecycle. Review the handoff before using this patch.

Normal commit/push hooks and secret scanning are retained. Private credentials, media, journals and binaries are excluded.
