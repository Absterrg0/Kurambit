# python3 -I summ.py <jsonl> [--log]  summary of a Claude transcript (session jsonl or stream-json)
import json, sys, base64, struct, collections
p = sys.argv[1]; log = "--log" in sys.argv
usage = {}; tools = collections.Counter(); images = []; first_user = None; n_assist_msgs = 0
t0 = t1 = None; lines = []
def png_size(b64):
    try:
        raw = base64.b64decode(b64[:200] + "=" * (-len(b64[:200]) % 4))
        if raw[:4] == b"\x89PNG": return struct.unpack(">II", raw[16:24])
        return ("jpeg?", len(b64) * 3 // 4)
    except Exception: return None
for l in open(p):
    try: d = json.loads(l)
    except Exception: continue
    ts = d.get("timestamp")
    if ts: t0 = t0 or ts; t1 = ts
    if d.get("type") == "result": lines.append(("RESULT", json.dumps({k: d.get(k) for k in ("duration_ms","num_turns","total_cost_usd","usage")})[:600]))
    m = d.get("message") or {}
    if d.get("type") == "assistant":
        mid = m.get("id"); u = m.get("usage")
        if mid and u: usage[mid] = u
        for c in m.get("content", []):
            if c.get("type") == "text": lines.append(("T", c["text"][:400].replace("\n", " ")))
            elif c.get("type") == "tool_use":
                tools[c["name"]] += 1
                lines.append(("U", c["name"] + " " + json.dumps(c["input"])[:220]))
    if d.get("type") == "user":
        cont = m.get("content")
        if isinstance(cont, str) and first_user is None: first_user = cont
        if isinstance(cont, list):
            for c in cont:
                if c.get("type") == "text" and first_user is None: first_user = c["text"]
                if c.get("type") == "tool_result" and isinstance(c.get("content"), list):
                    for cc in c["content"]:
                        if cc.get("type") == "image":
                            images.append(png_size(cc["source"].get("data", ""))); lines.append(("IMG", str(images[-1])))
                if c.get("type") == "image": images.append(png_size(c["source"].get("data", ""))); lines.append(("IMG", "user " + str(images[-1])))
tot = collections.Counter()
for u in usage.values():
    for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"): tot[k] += u.get(k, 0) or 0
print("file", p); print("span", t0, "->", t1); print("assistant API messages", len(usage)); print("tokens", dict(tot))
print("tool calls", sum(tools.values()), dict(tools.most_common()))
print("images seen", len(images), images[:40])
print("first user message chars", len(first_user or ""))
if log:
    for k, v in lines: print(k + ":", v)
