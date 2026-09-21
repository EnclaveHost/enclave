# shielded/lane -- how narrow can the card's weight lane get?

`lane_error.py` prices the one term REPORT 15.3 left open: the cards hold the
int8 field encoding at 1 byte per weight, so a 27B q4 file becomes 21.6 GB and
every decode token reads all of it (24 ms of a 78 ms token on two V100s).

It encodes real tensors of the deployed 27B into candidate lanes -- today's
int8 with one power-of-two exponent per output column, and int6/int5/int4 with
a per-32-block scale that is either a power of two or an arbitrary integer --
and reports the relative error of `W.x` against the f32 product of the same
weights, plus the bytes each lane costs.

```
python3 shielded/lane/lane_error.py --rows 256 --cols 2048
```

The answer is in REPORT 15.5: an integer block scale keeps the field
arithmetic exact and is worth a bit and a half over a power-of-two one, but a
4-bit lane still costs seven times the present encoding error. int6 with an
integer block scale (0.81 B/weight, 1.6x the error) is the only width worth
considering, and it is worth about 6 ms of a 78 ms token.
