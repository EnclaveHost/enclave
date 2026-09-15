# gemma-4-E2B-it-en-code

A vocabulary-trimmed copy of `google/gemma-4-E2B-it` (snapshot `3e22461f`) that keeps only the
tokens needed for English text and source code. Nothing was trained or fine-tuned; the transformer,
vision and audio weights are byte-identical to the original. Only the two vocab-sized tables
(`embed_tokens`, `embed_tokens_per_layer`; the output head is tied to `embed_tokens`) had rows
removed, and the tokenizer was rebuilt with contiguous IDs in the original order.

| | original | trimmed |
|---|---|---|
| vocab size | 262,144 | 166,810 |
| parameters (total) | 5,104,297,504 | 4,103,671,840 |
| parameters (embedding tables) | 2,751,463,424 | 1,750,837,760 |
| on-disk size (bf16 safetensors + configs) | 10.28 GB | 8.27 GB |

## How the keep set was built

1. Streamed 2.40 GB of text (1.15 GB English: FineWeb, FineWeb-Edu, StackExchange, UltraChat, SmolTalk,
   Tulu 3, OASST2, OpenWebMath, Cosmopedia; 1.26 GB code: GitHub (Python, JS, TS, Rust, Go, C, shell,
   Markdown, Makefile, SQL, ...), Rust/Go/Python corpora, Kubernetes YAML, JSON Schema, tool-call JSON,
   Magicoder, Glaive code assistant, Jupyter). Documents with more than 2% non-Latin-script characters
   were dropped at the document level (foreign-language leakage); tokens were never filtered by script.
2. Tokenized with the original tokenizer (635M tokens) and kept every token with frequency >= 5.
3. Union: every piece made only of printable ASCII (this also keeps the 6,227 reserved `<unusedN>`
   pieces), all 256 `<0xNN>` byte-fallback pieces, and every special/control token referenced by
   `tokenizer_config.json`, `config.json`, `generation_config.json`, `processor_config.json` and the
   chat template.
4. Closed under BPE merge parents: any merge that produces a kept piece keeps both of its parents, so
   text whose original tokenization uses only kept tokens tokenizes identically (verified).

`trim_artifacts/` holds the token frequency table (`token_frequency.tsv.gz`: id, piece, total,
english, code), the old-to-new ID map (`id_map_old_to_new.json`), the keep-set summary with the
per-script histogram, and the corpus count summary.

## Tokenizer

`tokenizer.json` is the trimmed `tokenizers` BPE model (389,293 merges) with the original normalizer,
byte fallback, decoder and 24 added tokens re-numbered. Gemma 4 ships no SentencePiece file, so
`tokenizer.model` is a reconstructed SentencePiece BPE model (scores derived from merge rank); it
reproduced the `tokenizers` output exactly on 726 held-out documents. `tokenizer_config.json` and
`chat_template.jinja` are unchanged (they reference tokens by string).

## Loading

```python
from transformers import AutoProcessor, Gemma4ForConditionalGeneration
m = Gemma4ForConditionalGeneration.from_pretrained("gemma-4-E2B-it-en-code", dtype="bfloat16")
p = AutoProcessor.from_pretrained("gemma-4-E2B-it-en-code")
```

## Verification (2026-09-14, two V100 32 GB, transformers 5.15.0, torch 2.14+cu126)

- Tokenizer round trip `decode(encode(x)) == x`: 1000/1000 English and 1000/1000 code documents.
  Tokenization is identical to the original (after ID mapping) on 974/1000 English and 993/1000 code
  documents; every difference is a document containing foreign-language text whose original tokens were
  dropped (those now go through byte fallback). Zero differences otherwise, as the merge closure guarantees.
- Chat template renders identically (plain, `enable_thinking`, tools) and every special token string
  maps to the ID in `config.json` / `generation_config.json`. The processor runs text-only, image
  (280 placeholders) and audio turns with all tensors equal to the original's.
- Logits over the kept vocabulary, both models on the SAME GPU in fp16, 200 English + 200 code prompts
  (122k positions): final hidden states bit-identical on 400/400 prompts; logits exactly equal on
  399/400, max abs diff 0.023 on the remaining prompt (one fp16 rounding step from the different
  output-head GEMM shape); argmax agreement 100%. In fp32 across the two GPUs: max abs diff 0.004.
  Note: fp16 across the two different V100 boards shows max diffs of ~3.6 even for the ORIGINAL model
  compared with itself (cuBLAS kernel selection differs by board, amplified through 35 fp16 layers).
- Greedy generation, thinking disabled, 64 new tokens, 50 prompts, same GPU: 50/50 identical.
- Held-out perplexity (120 English + 120 code documents, each model with its own tokenizer, fp16):

  | set | original | trimmed |
  |---|---|---|
  | English, all docs | 38.21 | 38.51 (6 docs contain dropped foreign-language tokens) |
  | English, docs with no dropped tokens (114) | 38.157 | 38.148 |
  | code, all docs | 7.966 | 7.972 |
  | code, docs with no dropped tokens (119) | 7.953 | 7.951 |
