# Rejected build admission proposal: do not run

The source-only admission wrapper is preserved to prevent loss or accidental reuse without its review. It has never been executed or qualified. Compilation is deferred until multipart preservation completes: initial capacity checks do not enforce the space reserved for the unfinished recovery during compilation. The original build also lacks an enforced bound on root logs, temporary files and final binary output. The existing eight GiB native reservation is not available to this build.

No new build is queued. Recovery continues unchanged. A future build requires fresh capacity and resource coordination, reviewed bounds, then actual compilation and fixture tests. Source review or a successful build does not validate production database or canonical chain state.
