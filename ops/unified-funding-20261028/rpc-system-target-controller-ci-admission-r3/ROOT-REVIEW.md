Parent-clock binding revision

The controller now requires caller-origin and absolute deadline in both explicit modes. ArmOwnerObserver enforces the original 5-second admission cutoff and 30-second deadline; late native creation cannot reset either. CI passes the same-boot monotonic parent clock and asserts returned equality. Existing target mode resource/namespace/identity gates are unchanged. Peer narrow review found no clock binding defect. One changed integration run is authorized; no previous job rerun. This is not RPC startup or target admission.
