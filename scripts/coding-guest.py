"""Bounded VM-side coding steps. No provider credentials or Broker tokens enter this process."""
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import selectors
import shutil
import signal
import subprocess
import sys
import time

data = json.loads(base64.b64decode(sys.argv[1]))
if not re.fullmatch(r"[a-f0-9-]{36}", data["jobId"]):
    raise ValueError("Invalid job identity")
root = Path("/tmp/wick-broker-coding")
root.mkdir(mode=0o700, exist_ok=True)
job = root / data["jobId"]
job.mkdir(mode=0o700, exist_ok=True)
if root.is_symlink() or job.is_symlink():
    raise ValueError("Unsafe job directory")
repo = job / "repository"
env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(job),
       "LANG": "C.UTF-8", "GIT_TERMINAL_PROMPT": "0", "GIT_CONFIG_NOSYSTEM": "1",
       "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_LFS_SKIP_SMUDGE": "1"}


def save(path, value):
    temp = path.with_suffix(".tmp")
    with open(temp, "w", encoding="utf-8") as stream:
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, path)


def sandbox(command):
    if not shutil.which("bwrap", path=env["PATH"]):
        raise ValueError("This VM needs bubblewrap with user/PID/network namespaces. No unsandboxed fallback is allowed.")
    args = ["bwrap", "--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL"]
    for directory in ["/usr", "/bin", "/sbin", "/lib", "/lib64"]:
        if Path(directory).exists():
            args += ["--ro-bind", directory, directory]
    args += ["--dir", "/etc"]
    for name in ["ld.so.cache", "passwd", "group"]:
        if Path("/etc/" + name).exists():
            args += ["--ro-bind", "/etc/" + name, "/etc/" + name]
    args += ["--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
             "--bind", str(repo), "/repo", "--chdir", "/repo", "--clearenv",
             "--setenv", "PATH", env["PATH"], "--setenv", "HOME", "/tmp",
             "--setenv", "LANG", "C.UTF-8", "--remount-ro", "/", "--", "/bin/sh", "-c", command]
    return args


def execute(args, cwd=None, seconds=90):
    remaining = min(seconds, data["deadline"] - time.time())
    if remaining <= 0 or (job / "stop").exists():
        raise ValueError("Job stopped or deadline reached")
    def limits():
        resource.setrlimit(resource.RLIMIT_CPU, (90, 90))
        resource.setrlimit(resource.RLIMIT_AS, (2 * 1024**3, 2 * 1024**3))
        resource.setrlimit(resource.RLIMIT_FSIZE, (32 * 1024**2, 32 * 1024**2))
        resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
        resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))
    process = subprocess.Popen(args, cwd=cwd, env=env, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, start_new_session=True, preexec_fn=limits)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    output = bytearray()
    truncated = False
    ended = False
    until = time.monotonic() + remaining
    next_size_check = 0
    try:
        while selector.get_map():
            if time.monotonic() >= until or (job / "stop").exists():
                ended = True
                break
            # Bound even a hostile clone/build that keeps writing its workspace.
            if time.monotonic() > next_size_check:
                total, entries = 0, 0
                for directory, dirs, files in os.walk(repo, followlinks=False):
                    entries += len(dirs) + len(files)
                    for filename in files:
                        try:
                            total += os.lstat(os.path.join(directory, filename)).st_size
                        except FileNotFoundError:
                            pass
                    if total > 64 * 1024**2 or entries > 4000:
                        ended = True
                        break
                next_size_check = time.monotonic() + 0.5
                if ended:
                    break
            for key, _ in selector.select(0.2):
                chunk = os.read(key.fileobj.fileno(), 8192)
                if not chunk:
                    selector.unregister(key.fileobj)
                else:
                    spare = max(0, 16000 - len(output))
                    output.extend(chunk[:spare])
                    truncated = truncated or len(chunk) > spare
        if ended:
            os.killpg(process.pid, signal.SIGKILL)
        try:
            code = process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            code = process.wait(timeout=2)
        # No background process may survive a completed step.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        return {"output": output.decode("utf-8", "replace"), "exitCode": code,
                "truncated": truncated, "interrupted": ended}
    finally:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=2)
        selector.close()
        process.stdout.close()


def git(*args):
    return ["git", "-c", "core.hooksPath=/dev/null", "-c", "credential.helper=",
            "-c", "protocol.file.allow=never", "-c", "http.followRedirects=false", *args]


def safe_file(name):
    path = Path(name)
    if path.is_absolute() or not path.parts or any(p in ("..", ".git") for p in path.parts):
        raise ValueError("File path must stay inside the job clone and outside .git")
    target = repo / path
    for parent in [target, *target.parents]:
        if parent == repo:
            break
        if parent.is_symlink():
            raise ValueError("Symlink paths are not editable")
    if not target.resolve().is_relative_to(repo.resolve()):
        raise ValueError("File path escapes job clone")
    return target


def digest(path):
    if not path.exists():
        return None
    if not path.is_file() or path.stat().st_size > 12000:
        raise ValueError("Choose a text file under 12 KB")
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    action = data["action"]
    if action["action"] == "stop":
        (job / "stop").touch()
        return {"stopRequested": True}
    if action["action"] == "inspect":
        file = job / (str(data["sequence"]) + ".json")
        return json.loads(file.read_text()) if file.exists() else {"state": "not_started"}
    if time.time() >= data["deadline"] or (job / "stop").exists():
        return {"state": "failed", "error": "Job stopped or deadline reached"}
    sequence = str(data["sequence"])
    if not re.fullmatch(r"\d{1,2}", sequence):
        raise ValueError("Invalid step identity")
    journal = job / (sequence + ".json")
    lock = open(job / (sequence + ".lock"), "a")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return {"state": "running"}
    if journal.exists():
        return json.loads(journal.read_text())
    save(journal, {"state": "unknown", "sequence": data["sequence"]})
    try:
        kind = action["action"]
        if kind == "clone":
            # Probe the actual isolation mechanism before downloading/executing any repository.
            repo.mkdir(exist_ok=True)
            probe = execute(sandbox("test ! -e /root && test ! -e /workspace && printf isolated"), seconds=10)
            if probe["exitCode"] != 0 or probe["output"] != "isolated":
                raise ValueError("VM sandbox isolation preflight failed")
            if not re.fullmatch(r"https://github.com/[A-Za-z0-9-]+/[A-Za-z0-9_.-]+", data["repositoryUrl"]):
                raise ValueError("Only anonymous public GitHub clones are supported")
            if not re.fullmatch(r"[a-f0-9]{40}", data["commitSha"]):
                raise ValueError("A pinned public commit is required")
            for args in [git("init", "."), git("fetch", "--depth=1", data["repositoryUrl"], data["commitSha"]),
                         git("checkout", "-b", "muse/" + data["jobId"], "FETCH_HEAD")]:
                result = execute(args, cwd=repo)
                if result["exitCode"] != 0:
                    raise ValueError("Anonymous bounded clone failed")
            (repo / ".git" / "info" / "exclude").write_text("__pycache__/\n.pytest_cache/\n*.py[co]\nnode_modules/\n.venv/\n")
            files = execute(git("ls-files"), cwd=repo)["output"].splitlines()[:150]
            result = {"files": files, "workspace": str(repo), "commitSha": data["commitSha"], "sandbox": "bubblewrap-no-network"}
        elif kind in ("read", "write"):
            file = safe_file(action["path"])
            manifest = job / "manifest.json"
            known = json.loads(manifest.read_text()) if manifest.exists() else {}
            current = digest(file)
            if kind == "read":
                known[action["path"]] = current
                save(manifest, known)
                result = {"path": action["path"], "content": file.read_text() if current else None}
            else:
                if current is not None and (action["path"] not in known or known[action["path"]] != current):
                    raise ValueError("Read the current file before writing; external edits must be reviewed")
                if len(action["content"].encode()) > 12000 or "\x00" in action["content"]:
                    raise ValueError("Use UTF-8 text under 12 KB")
                file.parent.mkdir(parents=True, exist_ok=True)
                temp = file.with_name(file.name + ".muse-tmp")
                if temp.exists() or temp.is_symlink():
                    raise ValueError("Conflicting temporary file")
                temp.write_text(action["content"])
                os.replace(temp, file)
                known[action["path"]] = digest(file)
                save(manifest, known)
                result = {"path": action["path"], "written": True}
        elif kind == "test":
            result = execute(sandbox(data["testCommand"]))
        elif kind == "diff":
            # Test code can change repo-local Git config; run post-test Git in the sandbox too.
            if not re.fullmatch(r"[a-f0-9]{40}", data["commitSha"]):
                raise ValueError("A pinned diff base is required")
            result = execute(sandbox("git -c core.hooksPath=/dev/null -c core.fsmonitor=false add -N . && git -c core.hooksPath=/dev/null -c core.fsmonitor=false diff --binary --no-ext-diff --no-textconv " + data["commitSha"] + " -- ."), seconds=10)
        else:
            raise ValueError("Unsupported coding action")
        receipt = {"state": "completed", "sequence": data["sequence"], "action": kind, "result": result}
    except Exception as error:
        receipt = {"state": "failed", "sequence": data["sequence"], "error": str(error)[:500]}
    save(journal, receipt)
    return receipt


try:
    print(json.dumps(main()))
except Exception:
    print(json.dumps({"state": "unknown", "error": "Guest step could not be reconciled"}))
