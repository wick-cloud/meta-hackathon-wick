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
workspace = None
if data.get("workspaceId"):
    if not re.fullmatch(r"[a-f0-9-]{36}", data["workspaceId"]):
        raise ValueError("Invalid workspace identity")
    mount = Path("/workspace")
    # Never accept a caller-supplied mount path or a symlink into another guest location.
    if not mount.is_dir() or mount.is_symlink():
        raise ValueError("The persistent workspace mount is unavailable")
    workspace = mount / "workspaces" / data["workspaceId"]
    for directory in [mount / "workspaces", workspace]:
        if directory.is_symlink():
            raise ValueError("Unsafe persistent workspace directory")
        directory.mkdir(mode=0o700, exist_ok=True)
    repo = workspace / "repository"
    if repo.is_symlink():
        raise ValueError("Unsafe repository directory")
else:
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


def persist_artifact(name, content):
    if workspace is None:
        return None
    artifacts = workspace / "artifacts"
    if artifacts.is_symlink():
        raise ValueError("Unsafe workspace artifact directory")
    artifacts.mkdir(mode=0o700, exist_ok=True)
    target = artifacts / name
    # A previous VM can leave arbitrary disk content. Do not follow a leaf
    # symlink while exporting a new task's bounded results from the guest.
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW
    descriptor = os.open(target, flags, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())
    return str(target)


def bwrap_path():
    installed = shutil.which("bwrap", path=env["PATH"])
    if installed:
        return installed
    runtime = job / "runtime"
    binary = runtime / "usr/bin/bwrap"
    if not runtime.is_symlink() and binary.is_file() and not binary.is_symlink() and os.access(binary, os.X_OK):
        return str(binary)
    return None


def bootstrap_sandbox():
    if not data.get("allowBootstrap") or (bwrap_path() and shutil.which("git", path=env["PATH"])):
        return
    if not shutil.which("apt-get", path=env["PATH"]):
        raise ValueError("Automatic task setup needs a Debian/Ubuntu guest with apt-get")
    no_new_privileges = re.search(r"^NoNewPrivs:\s*1$", Path("/proc/self/status").read_text(), re.M)
    if os.geteuid() != 0 and no_new_privileges:
        # Mounted E2B commands cannot elevate. Extract only this fixed package
        # from the guest's authenticated APT cache; never run package installers.
        release = dict(line.split("=", 1) for line in Path("/etc/os-release").read_text().splitlines() if "=" in line)
        if release.get("ID", "").strip('"') != "debian" or release.get("VERSION_ID", "").strip('"') != "12" or not shutil.which("git", path=env["PATH"]) or not shutil.which("dpkg-deb", path=env["PATH"]):
            raise ValueError("Unprivileged sandbox setup needs Debian 12 with Git, dpkg-deb and authenticated APT metadata")
        downloads, runtime = job / "package-download", job / "runtime"
        for directory in [downloads, runtime]:
            if directory.is_symlink():
                raise ValueError("Unsafe sandbox runtime directory")
            directory.mkdir(mode=0o700, exist_ok=True)
        setup = execute(["apt-get", "-o", "APT::Get::AllowUnauthenticated=false", "-o", "Acquire::AllowInsecureRepositories=false", "-o", "Acquire::AllowDowngradeToInsecureRepositories=false", "download", "bubblewrap"], cwd=downloads, seconds=40)
        archives = list(downloads.glob("bubblewrap_*.deb"))
        if setup["exitCode"] != 0 or setup["interrupted"] or len(archives) != 1 or archives[0].is_symlink():
            raise ValueError("Authenticated sandbox package download failed; no repository code was executed")
        setup = execute(["dpkg-deb", "-x", str(archives[0]), str(runtime)], seconds=10)
        if setup["exitCode"] != 0 or setup["interrupted"] or not bwrap_path():
            raise ValueError("Unprivileged sandbox package extraction failed; no repository code was executed")
    else:
        prefix = [] if os.geteuid() == 0 else ["sudo", "-n"]
        for command in [["apt-get", "update", "-qq"], ["env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "install", "-y", "-qq", "--no-install-recommends", "git", "bubblewrap", "ca-certificates"]]:
            setup = execute(prefix + command, seconds=40)
            if setup["exitCode"] != 0 or setup["interrupted"]:
                raise ValueError("Task sandbox setup failed; no repository code was executed")


def sandbox(command):
    binary = bwrap_path()
    if not binary:
        raise ValueError("This VM needs bubblewrap with user/PID/network namespaces. No unsandboxed fallback is allowed.")
    args = [binary, "--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL"]
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


def workspace_exceeded():
    """Bound directory enumeration itself, including very large single directories."""
    pending, entries, total = [repo], 0, 0
    while pending:
        directory = pending.pop()
        try:
            with os.scandir(directory) as children:
                for child in children:
                    entries += 1
                    if entries > 4000:
                        return True
                    try:
                        if child.is_dir(follow_symlinks=False):
                            pending.append(child.path)
                        else:
                            total += child.stat(follow_symlinks=False).st_size
                    except FileNotFoundError:
                        continue
                    if total > 64 * 1024**2:
                        return True
        except FileNotFoundError:
            continue
    return False


def execute(args, cwd=None, seconds=90):
    remaining = min(seconds, data["deadline"] - time.time())
    if remaining <= 0 or (job / "stop").exists():
        raise ValueError("Job stopped or deadline reached")
    if workspace_exceeded():
        raise ValueError("Workspace exceeds 64 MB or 4,000 entries; clean the job clone before resuming")
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
    oversized = False
    until = time.monotonic() + remaining
    next_size_check = 0
    try:
        while selector.get_map():
            if time.monotonic() >= until or (job / "stop").exists():
                ended = True
                break
            # Bound even a hostile clone/build that keeps writing its workspace.
            if time.monotonic() > next_size_check:
                oversized = workspace_exceeded()
                ended = ended or oversized
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
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
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
        # Fast writers can finish between periodic scans. Validate after cleanup too.
        oversized = oversized or workspace_exceeded()
        ended = ended or oversized
        return {"output": output.decode("utf-8", "replace"), "exitCode": code,
                "truncated": truncated, "interrupted": ended,
                **({"limitExceeded": "workspace"} if oversized else {})}
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
    if not re.fullmatch(r"\d{1,3}", sequence):
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
            # Task authorization covers preparation of this newly rented, disposable VM.
            # Only fixed packages from the guest's configured OS repositories are installed.
            # No repository script or dependency installer ever runs with privilege.
            bootstrap_sandbox()
            # Probe the actual isolation mechanism before downloading/executing any repository.
            repo.mkdir(exist_ok=True)
            probe = execute(sandbox("test ! -e /root && test ! -e /workspace && printf isolated"), seconds=10)
            if probe["exitCode"] != 0 or probe["output"] != "isolated":
                raise ValueError("VM sandbox isolation preflight failed")
            if not re.fullmatch(r"https://github.com/[A-Za-z0-9-]+/[A-Za-z0-9_.-]+", data["repositoryUrl"]):
                raise ValueError("Only anonymous public GitHub clones are supported")
            if not re.fullmatch(r"[a-f0-9]{40}", data["commitSha"]):
                raise ValueError("A pinned public commit is required")
            if data.get("continuingWorkspace"):
                if workspace is None or not (repo / ".git").is_dir() or (repo / ".git").is_symlink():
                    raise ValueError("The saved repository is unavailable; no files were reset")
                # Inspect Git in the sandbox: prior test code may have modified repository config.
                check = execute(sandbox("git -c core.hooksPath=/dev/null -c core.fsmonitor=false cat-file -e " + data["commitSha"] + "^{commit}"), seconds=10)
                if check["exitCode"] != 0 or check["interrupted"]:
                    raise ValueError("The saved workspace no longer contains its pinned base commit")
            else:
                if any(repo.iterdir()):
                    raise ValueError("The new workspace is not empty; existing files were preserved")
                for args in [git("init", "."), git("fetch", "--depth=1", data["repositoryUrl"], data["commitSha"]),
                             git("checkout", "-b", "muse/" + data["jobId"], "FETCH_HEAD")]:
                    result = execute(args, cwd=repo)
                    if result["exitCode"] != 0 or result["interrupted"]:
                        raise ValueError("Anonymous bounded clone failed")
                (repo / ".git" / "info" / "exclude").write_text("__pycache__/\n.pytest_cache/\n*.py[co]\nnode_modules/\n.venv/\n")
            listed = execute(sandbox("git -c core.hooksPath=/dev/null -c core.fsmonitor=false ls-files --cached --others --exclude-standard"), seconds=10)
            if listed["exitCode"] != 0 or listed["interrupted"]:
                raise ValueError("The current repository files could not be inspected")
            files = listed["output"].splitlines()[:150]
            result = {"files": files, "workspace": str(repo), "commitSha": data["commitSha"], "continuingWorkspace": bool(data.get("continuingWorkspace")), "sandbox": "bubblewrap-no-network"}
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
                if (current is not None or action["path"] in known) and (action["path"] not in known or known[action["path"]] != current):
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
            if workspace is not None:
                result["savedTestReceipt"] = persist_artifact(
                    data["jobId"] + ".test." + sequence + ".json",
                    json.dumps({"jobId": data["jobId"], "testCommand": data["testCommand"], "result": result}),
                )
        elif kind == "diff":
            # Test code can change repo-local Git config; run post-test Git in the sandbox too.
            if not re.fullmatch(r"[a-f0-9]{40}", data["commitSha"]):
                raise ValueError("A pinned diff base is required")
            result = execute(sandbox("git -c core.hooksPath=/dev/null -c core.fsmonitor=false add -N . && git -c core.hooksPath=/dev/null -c core.fsmonitor=false diff --binary --no-ext-diff --no-textconv " + data["commitSha"] + " -- ."), seconds=10)
            if workspace is not None and result["exitCode"] == 0 and not result["truncated"] and not result["interrupted"]:
                patch_name = data["jobId"] + ".patch"
                result["savedPatch"] = persist_artifact(patch_name, result["output"])
                persist_artifact(data["jobId"] + ".json", json.dumps({
                    "jobId": data["jobId"], "summary": str(action.get("summary", ""))[:3000],
                    "baseCommit": data["commitSha"], "patch": patch_name,
                }))
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
