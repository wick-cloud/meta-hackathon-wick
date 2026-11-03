import type { DemoReceiptFacts } from './receipt.js';

/**
 * Fixed operator-authored example. Muse first explains the visitor's own receipt, then answers
 * one question. The script and disk never contain a credential.
 *
 * Input sizing mirrors the gateway's request-sized reservation (see `inputReservation`):
 * 4,096 framing tokens per call, 32 per message, plus each message's largest UTF-8 size
 * across Unicode normal forms. The demo batch has 5,000 input tokens, so every prompt is
 * fitted to the live remaining balance instead of relying on a fixed size.
 */
export function demoPythonScript(appUrl: string): string {
  return `#!/usr/bin/env python3
"""Meta Muse explains this demo, then answers one question. Uses only this demo's token batch."""
import getpass
import json
import os
import pathlib
import platform
import shutil
import unicodedata
import urllib.error
import urllib.request
import uuid

BASE_URL = ${JSON.stringify(appUrl.replace(/\/$/, '') + '/api')}
RECEIPT = pathlib.Path("/workspace/receipt.json")
FRAME, PER_MESSAGE, MAX_OUTPUT = 4096, 32, 1024
# Low reasoning leaves the shared 1,024-token output cap for the answer itself.
EXPLAIN = ("Reasoning strength: 8.\\nYou are Meta Muse in a Wick Broker demo. Using only the JSON "
           "facts, tell the user in 3 short plain sentences what this VM is and why each auction "
           "winner won (lowest price wins; Modal wins a 1-cent tie; the demo operator pays any "
           "sponsor credit). Then give one safe shell command to try, on its own line starting "
           "with '$ '. No markdown.")
ANSWER = ("Reasoning strength: 8.\\nYou are Meta Muse on a Wick Broker demo VM. Answer in at most 3 "
          "short plain sentences. Put any shell command alone on a line starting with '$ '. "
          "No markdown.")


def envelope(text):
    """Largest UTF-8 size across Unicode normal forms, the same bound the gateway reserves."""
    forms = [unicodedata.normalize(form, text) for form in ("NFC", "NFD", "NFKC", "NFKD")]
    return max(len(value.encode()) for value in [text] + forms)


def spare(available, messages):
    return available - FRAME - sum(PER_MESSAGE + envelope(m["content"]) for m in messages)


def count(value):
    return value if isinstance(value, int) and value >= 0 else 0


def machine():
    facts = {"os": (platform.system() + " " + platform.release())[:40], "cpus": os.cpu_count()}
    try:
        with open("/proc/meminfo") as meminfo:
            kib = next(int(line.split()[1]) for line in meminfo if line.startswith("MemTotal:"))
        facts["memGiB"] = round(kib / 1048576, 1)
    except (OSError, ValueError, IndexError, StopIteration):
        pass
    try:
        facts["diskFreeGiB"] = round(shutil.disk_usage("/workspace").free / 1073741824, 1)
    except OSError:
        pass
    return facts


def receipt():
    try:
        value = json.loads(RECEIPT.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def balance(key):
    """Remaining batch allowance. Reading it is free and is not a Muse request."""
    req = urllib.request.Request(BASE_URL + "/inference/packs",
                                 headers={"Authorization": "Bearer " + key})
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            pack = json.loads(response.read(65536))["items"][0]
        used = count(pack["consumedOutputTokens"]) + count(pack["heldOutputTokens"]) > 0
        return count(pack["availableInputTokens"]), count(pack["availableOutputTokens"]), used
    except (OSError, ValueError, KeyError, IndexError, TypeError):
        return None


def ask(key, messages, available_out):
    request_id = str(uuid.uuid4())
    body = json.dumps({"model": "meta/muse-spark-open", "messages": messages,
                       "max_tokens": min(MAX_OUTPUT, available_out), "stream": False}).encode()
    req = urllib.request.Request(BASE_URL + "/v1/chat/completions", data=body,
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json",
                 "Idempotency-Key": request_id}, method="POST")
    print("Calling Meta Muse. Request:", request_id)
    try:
        with urllib.request.urlopen(req, timeout=110) as response:
            result = json.loads(response.read(262144))
    except urllib.error.HTTPError as error:
        try:
            print("Broker response:", json.loads(error.read(16384)).get("error", "Request was rejected."))
        except (ValueError, AttributeError):
            print("Broker response:", error.code)
        return None
    except (TimeoutError, OSError, ValueError):
        print("Outcome unconfirmed. No automatic retry was sent. Inspect the demo receipt before another call.")
        return None
    answer = ((result.get("choices") or [{}])[0].get("message") or {}).get("content")
    print(answer.strip() if answer else "The output allowance ended before a final text answer. See the usage receipt.")
    usage = result.get("usage") or {}
    print("Usage:", json.dumps(usage))
    if answer and any(line.strip().startswith("$ ") for line in answer.splitlines()):
        print("Muse suggested a command. Nothing was run; type it yourself if you want to try it.")
    return usage


def explain(key, available_in, available_out):
    full = {"vm": machine(), **receipt()}
    lean = json.loads(json.dumps(full))
    (lean.get("compute") or {}).pop("bids", None)
    print()
    print("1/2  Muse explains what you just bought")
    for facts in (full, lean, {"vm": full["vm"]}):
        messages = [{"role": "system", "content": EXPLAIN},
                    {"role": "user", "content": json.dumps(facts, separators=(",", ":"))}]
        if spare(available_in, messages) >= 0:
            return ask(key, messages, available_out)
    print("Not enough input allowance is left for the explanation.")
    return None


def question(key, available_in, available_out, facts):
    print()
    print("2/2  Your turn")
    try:
        text = input("Ask Muse one question about this VM, the auctions or Wick (Enter to skip): ")
    except EOFError:
        text = ""
    text = " ".join(text.split())[:300]
    if not text:
        print("No question sent. Run this script again to ask one before the lease ends.")
        return
    if available_out <= 0:
        print("No output allowance is left for another answer.")
        return
    compute = facts.get("compute") or {}
    context = "Question: "
    if compute.get("winner") and compute.get("leaseMinutes"):
        context = "This VM: %s %s, %s-minute lease. Question: " % (
            compute["winner"], compute.get("size", ""), compute["leaseMinutes"])
    for prefix in (context, "Question: "):
        messages = [{"role": "system", "content": ANSWER}, {"role": "user", "content": prefix}]
        room = spare(available_in, messages)
        if room >= min(envelope(text), 60):
            trimmed = text
            while envelope(trimmed) > room:
                trimmed = trimmed[:-1]
            if trimmed != text:
                print("Your question was shortened to fit the remaining input allowance.")
            messages[1]["content"] = prefix + trimmed
            ask(key, messages, available_out)
            return
    print("Not enough input allowance is left for a question. The terminal stays yours until the lease ends.")


def main(key):
    known = balance(key)
    available_in, available_out, used = known or (5000, 2048, False)
    if used:
        print("Muse already explained this demo, so this run goes straight to your question.")
    else:
        usage = explain(key, available_in, available_out)
        if usage is None:
            return
        refreshed = balance(key)
        if refreshed:
            available_in, available_out = refreshed[0], refreshed[1]
        else:
            available_in -= count(usage.get("prompt_tokens"))
            available_out -= count(usage.get("completion_tokens"))
    question(key, available_in, available_out, receipt())


print("Hello Muse — Meta Muse Spark Open, served by " + ((receipt().get("tokens") or {}).get("seller") or "the winning token seller"))
print("Muse explains what you just bought, then answers one question from you.")
print("Paste the demo batch key. It is hidden, held only in memory, and never saved.")
key = getpass.getpass("Batch key: ").strip()
if not key.startswith("wbk_"):
    raise SystemExit("Use the batch key from this demo's Get demo key button.")
try:
    main(key)
finally:
    key = ""
`;
}
const TERMINAL_README = `Wick live demo

This is your private Modal Micro workspace.
Run: python3 /workspace/hello_muse.py
Select Get demo key on /demos, then Copy key, to use the Muse token batch you won.
Paste it at the hidden prompt. No provider credentials are needed.
Muse first explains your VM and auction receipt (receipt.json), then answers one question.
The batch allows at most two requests and 1,024 output tokens per request.
Muse may suggest a shell command. Nothing runs unless you type it yourself.
The demo VM expires after its fixed lease; End demo closes the VM. Demo disks may be retained and cleared before reuse.
`;

const b64 = (value: string) => Buffer.from(value).toString('base64');

/** Terminal runs write the script, README and public receipt, each verified byte-for-byte. */
export function demoBootstrapCommand(
  appUrl: string,
  kind: 'terminal' | 'studio' = 'terminal',
  resetDisk = false,
  receipt: DemoReceiptFacts | null = null,
): string {
  // Archil exposes .archil as a reserved, client-local mount control entry.
  // Never traverse or delete it; it is not persisted customer workspace data.
  const reset = resetDisk
    ? `python3 -I -S -c 'import os,shutil; root="/workspace"; entries=[e for e in os.scandir(root) if e.name!=".archil"]; [(os.unlink(e.path) if e.is_symlink() or not e.is_dir(follow_symlinks=False) else shutil.rmtree(e.path)) for e in entries]; assert not [name for name in os.listdir(root) if name!=".archil"]' && `
    : '';
  if (kind === 'studio') {
    const readme = Buffer.from(
      'Wick guided Muse Studio demo\n\nMuse generates a fixed Hello World Python program. The guided runner validates its allowed syntax, executes it, and checks the exact output.\nAfter the verified result appears on /demos, rerun it here: python3 /workspace/hello_world.py\nThe generated source and execution receipt are on this private disk. No key is needed: the guided worker owns this demo token pack.\nThe terminal remains available until the original 15-minute VM lease expires, even after both model calls are used. End demo closes the VM. Demo disks may be retained and cleared before reuse.\n',
    ).toString('base64');
    return (
      reset +
      `python3 -I -S -c 'import base64,pathlib; p=pathlib.Path("/workspace/README.txt"); source=base64.b64decode("${readme}"); p.write_bytes(source); assert p.read_bytes()==source; print("WICK_DEMO_SCRIPT_READY")'`
    );
  }
  const script = b64(demoPythonScript(appUrl));
  const readme = b64(TERMINAL_README);
  const facts = b64(JSON.stringify(receipt ?? {}));
  return (
    reset +
    `python3 -I -S -c 'import base64,os,pathlib; p=pathlib.Path("/workspace/hello_muse.py"); source=base64.b64decode("${script}"); compile(source,"hello_muse.py","exec"); t=p.with_suffix(".tmp"); t.write_bytes(source); os.chmod(t,0o600); os.replace(t,p); r=pathlib.Path("/workspace/README.txt"); r.write_bytes(base64.b64decode("${readme}")); f=pathlib.Path("/workspace/receipt.json"); f.write_bytes(base64.b64decode("${facts}")); assert p.read_bytes()==source; assert r.read_bytes()==base64.b64decode("${readme}"); assert f.read_bytes()==base64.b64decode("${facts}"); print("WICK_DEMO_SCRIPT_READY")'`
  );
}
