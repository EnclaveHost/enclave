For the measured 27B Q8 / MTP5 workload, sustained 20 tok/s requires at least **888.2 MB/s into the phone**: 444.1 MB/s of inference replies plus 444.1 MB/s of consumed pad values. Outgoing requests are counted separately.

The connected Pixel 8 Pro reports a 5,000 Mb/s USB link, whose raw upper bound is 625 MB/s before overhead. Thus sustained 20 tok/s does not fit this unchanged workload, data format and path. This does not rule out preloaded bursts or improved acceptance that reduces bytes per output token.

Actual per-group counters show 118,425,088 consumed u elements in each 16-token trial; shielded-pads.c:126,327–334 serializes three bytes per element plus authentication tags. The budget omits tags, framing and unused shipment values, so it understates incoming demand. A remote pad generator alone does not remove the transfer requirement if the phone still receives those pads over this connection.

This is a bandwidth constraint, not a prediction of an attainable token rate. See the accompanying JSON for inputs and provenance.
