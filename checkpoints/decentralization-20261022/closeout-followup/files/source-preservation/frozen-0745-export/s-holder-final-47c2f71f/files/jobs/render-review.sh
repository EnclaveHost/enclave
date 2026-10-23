#!/bin/bash
# REVIEW-ONLY render: the real official-binary pin, placeholder (.invalid) L1 endpoints. `run`/`preflight` refuse it.
set -eu
cd "$(dirname "$0")/.."
rm -rf evidence/render-review
python3 -I holder/holder.py validate --review holder/holder.example.json > evidence/render-review.validate.json
python3 -I holder/holder.py render --review holder/holder.example.json evidence/render-review
python3 -I holder/holder.py validate holder/holder.example.json || true
python3 -I holder/holder.py preflight holder/holder.example.json || true
