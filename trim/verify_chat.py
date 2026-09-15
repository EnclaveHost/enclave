"""Chat template + special-token id mapping + processor (text / image / audio) checks."""
import os, sys, glob, json, numpy as np
from PIL import Image
from transformers import AutoTokenizer, AutoProcessor, AutoConfig
HERE = os.path.dirname(os.path.abspath(__file__))
SNAP = glob.glob(os.path.expanduser("~/.cache/huggingface/hub/models--google--gemma-4-E2B-it/snapshots/*/"))[0]
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "gemma-4-E2B-it-en-code")
id_map = {int(k): v for k, v in json.load(open(os.path.join(HERE, "artifacts", "id_map_old_to_new.json"))).items()}
ok = True
def check(cond, msg):
    global ok
    print(("PASS " if cond else "FAIL ") + msg); ok &= bool(cond)
to, tt = AutoTokenizer.from_pretrained(SNAP), AutoTokenizer.from_pretrained(OUT)
co, ct = AutoConfig.from_pretrained(SNAP), AutoConfig.from_pretrained(OUT)
tc = json.load(open(os.path.join(OUT, "tokenizer_config.json")))
# every *_token string is one token in the trimmed tokenizer and maps from the original id
for k, v in tc.items():
    if k.endswith("_token") and isinstance(v, str) or k == "extra_special_tokens":
        for s in (v if isinstance(v, list) else [v]):
            io, it = to.convert_tokens_to_ids(s), tt.convert_tokens_to_ids(s)
            check(len(tt.encode(s, add_special_tokens=False)) == 1 and id_map[io] == it, f"{k} {s!r}: {io} -> {it}")
# config id fields agree with the trimmed tokenizer
fields = {"bos_token_id": "bos_token", "pad_token_id": "pad_token", "image_token_id": "image_token", "audio_token_id": "audio_token",
          "boi_token_id": "boi_token", "eoi_token_id": "eoi_token", "boa_token_id": "boa_token", "eoa_token_id": "eoa_token"}
for f, tk in fields.items():
    if hasattr(ct, f): check(getattr(ct, f) == tt.convert_tokens_to_ids(tc[tk]), f"config.{f}={getattr(ct, f)} == id({tc[tk]!r})")
check(ct.video_token_id == tt.convert_tokens_to_ids("<|video|>"), f"config.video_token_id={ct.video_token_id}")
check([id_map[i] for i in co.eos_token_id] == ct.eos_token_id, f"config.eos_token_id {co.eos_token_id} -> {ct.eos_token_id}")
check(ct.text_config.vocab_size == len(tt) == ct.text_config.vocab_size_per_layer_input, f"vocab_size {ct.text_config.vocab_size} == len(tokenizer) {len(tt)}")
gen = json.load(open(os.path.join(OUT, "generation_config.json")))
check(gen["eos_token_id"] == [id_map[i] for i in json.load(open(os.path.join(SNAP, "generation_config.json")))["eos_token_id"]], f"generation_config eos {gen['eos_token_id']}")
# chat template renders identically and tokenizes to the mapped ids (text-only, thinking on, tools)
tools = [{"type": "function", "function": {"name": "get_weather", "description": "Weather", "parameters": {"type": "object", "properties": {"city": {"type": "string", "description": "City"}}, "required": ["city"]}}}]
convs = [[{"role": "user", "content": "Write a Python function that reverses a string."}],
         [{"role": "system", "content": "Be brief."}, {"role": "user", "content": "Hi"}, {"role": "assistant", "content": "Hello!"}, {"role": "user", "content": "What is 2+2?"}]]
for i, c in enumerate(convs):
    for kw in ({}, {"enable_thinking": True}, {"tools": tools}):
        so = to.apply_chat_template(c, tokenize=False, add_generation_prompt=True, **kw); st = tt.apply_chat_template(c, tokenize=False, add_generation_prompt=True, **kw)
        io = to.apply_chat_template(c, tokenize=True, add_generation_prompt=True, return_dict=True, **kw)["input_ids"]
        it = tt.apply_chat_template(c, tokenize=True, add_generation_prompt=True, return_dict=True, **kw)["input_ids"]
        check(so == st and [id_map[x] for x in io] == it, f"chat template conv{i} {list(kw) or 'plain'}: same text, ids map ({len(it)} tokens)")
print(repr(st[:200]))
# processor: text-only, image, audio
po, pt = AutoProcessor.from_pretrained(SNAP), AutoProcessor.from_pretrained(OUT)
img = Image.fromarray((np.random.RandomState(0).rand(224, 320, 3) * 255).astype(np.uint8))
audio = np.random.RandomState(0).randn(16000 * 2).astype(np.float32) * 0.1
cases = {"text": [{"role": "user", "content": [{"type": "text", "text": "Hello there."}]}],
         "image": [{"role": "user", "content": [{"type": "image", "image": img}, {"type": "text", "text": "Describe the image."}]}],
         "audio": [{"role": "user", "content": [{"type": "audio", "audio": audio}, {"type": "text", "text": "Transcribe this."}]}]}
for name, msgs in cases.items():
    outs = []
    for p in (po, pt):
        kw = {"images": [img]} if name == "image" else {"audio": [audio]} if name == "audio" else {}
        text = p.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)
        outs.append(p(text=[text], return_tensors="pt", **kw))
    o, t = outs
    same_ids = [id_map[int(x)] for x in o["input_ids"][0]] == [int(x) for x in t["input_ids"][0]]
    extra = {k: (bool((o[k] == t[k]).all()) if hasattr(o[k], "shape") else o[k] == t[k]) for k in o if k != "input_ids"}
    check(same_ids and all(extra.values()), f"processor {name}: {len(t['input_ids'][0])} tokens, keys {sorted(o.keys())}, ids map, other tensors equal {extra}")
    if name == "image": check(int((t["input_ids"] == ct.image_token_id).sum()) == ct.vision_soft_tokens_per_image, f"image placeholder count == {ct.vision_soft_tokens_per_image}")
    if name == "audio": check(int((t["input_ids"] == ct.audio_token_id).sum()) > 0, f"audio placeholders present ({int((t['input_ids'] == ct.audio_token_id).sum())})")
print("ALL PASS" if ok else "SOME CHECKS FAILED")
json.dump({"all_pass": ok}, open(os.path.join(HERE, "artifacts", "verify_chat.json"), "w"))
