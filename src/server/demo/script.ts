/** Fixed operator-authored bootstrap. The script and disk never contain a credential. */
export function demoPythonScript(appUrl: string): string {
  return `#!/usr/bin/env python3
"""Two bounded Muse calls using only this demo's purchased token batch."""
import getpass
import json
import urllib.error
import urllib.request
import uuid

BASE_URL = ${JSON.stringify(appUrl.replace(/\/$/, '') + '/api/v1')}
print("Hello Muse — Meta Muse Spark Open, served by Baseten")
print("Paste the demo batch key. It is hidden, held only in memory, and never saved.")
key = getpass.getpass("Batch key: ").strip()
if not key.startswith("wbk_"):
    raise SystemExit("Use the batch key from this demo's Get demo key button.")
request_id = str(uuid.uuid4())
body = json.dumps({"model": "meta/muse-spark-open", "messages": [
    {"role": "user", "content": "Say hello in one friendly sentence and mention that you are Meta Muse."}
], "max_tokens": 1024, "stream": False}).encode()
req = urllib.request.Request(BASE_URL + "/chat/completions", data=body,
    headers={"Authorization": "Bearer " + key, "Content-Type": "application/json",
             "Idempotency-Key": request_id}, method="POST")
print("Calling Meta Muse. Request:", request_id)
try:
    with urllib.request.urlopen(req, timeout=110) as response:
        result = json.loads(response.read(262144))
    answer = result["choices"][0]["message"].get("content")
    print(answer or "The output allowance ended before a final text answer. See the usage receipt.")
    print("Usage:", json.dumps(result.get("usage", {})))
except urllib.error.HTTPError as error:
    try:
        detail = json.loads(error.read(16384))
        message = detail.get("error", "Request was rejected.")
        print("Broker response:", message)
    except (ValueError, KeyError):
        print("Broker response:", error.code)
except (TimeoutError, OSError):
    print("Outcome unconfirmed. No automatic retry was sent. Inspect the demo receipt before another call.")
finally:
    key = ""
`;
}
export function demoBootstrapCommand(
  appUrl: string,
  kind: 'terminal' | 'studio' = 'terminal',
  resetDisk = false,
): string {
  const reset = resetDisk
    ? `python3 -I -S -c 'import os,shutil; root="/workspace"; entries=list(os.scandir(root)); [(os.unlink(e.path) if e.is_symlink() or not e.is_dir(follow_symlinks=False) else shutil.rmtree(e.path)) for e in entries]; assert not os.listdir(root)' && `
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
  const script = Buffer.from(demoPythonScript(appUrl)).toString('base64');
  const readme = Buffer.from(
    'Wick live demo\n\nThis is your private Modal Micro workspace.\nRun: python3 /workspace/hello_muse.py\nSelect Get demo key on /demos, then Copy key, to use the purchased Baseten batch.\nPaste it at the hidden prompt. No provider credentials are needed.\nThe batch allows at most two requests and 1,024 output tokens per request.\nThe demo VM expires after its fixed lease; End demo closes the VM. Demo disks may be retained and cleared before reuse.\n',
  ).toString('base64');
  return (
    reset +
    `python3 -I -S -c 'import base64,os,pathlib; p=pathlib.Path("/workspace/hello_muse.py"); source=base64.b64decode("${script}"); compile(source,"hello_muse.py","exec"); t=p.with_suffix(".tmp"); t.write_bytes(source); os.chmod(t,0o600); os.replace(t,p); r=pathlib.Path("/workspace/README.txt"); r.write_bytes(base64.b64decode("${readme}")); assert p.read_bytes()==source; assert r.read_bytes()==base64.b64decode("${readme}"); print("WICK_DEMO_SCRIPT_READY")'`
  );
}
