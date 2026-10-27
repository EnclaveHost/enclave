# Independent source review and root's operational hold

The independent review found no new unsafe CLEAN path, and confirmed the ten unit cases fit the existing256MiB small lane. Its title saying tests had not run reflects its initial context; root subsequently ran all ten tests successfully, as archived in memory-production-r8-1828.

Root's two operational blockers remain binding: the old stop helper cannot recognize the new runtime, and the production shell ignores failed final checks when the runtime returns zero. An additional admission check must recognize stale instances of the new runtime before any mount is created. The independent review also found telemetry exceptions that can mislabel an interrupted run and imprecise descriptions of the outer job's output bounds.

A new revision is being prepared with narrow fixes and additional cancellation/stop/exit-status tests. Existing r8 and r7 must remain inactive. Unit success, independent review and a synthetic memory measurement do not establish production database validity or RPC readiness.
