#!/usr/bin/env python3
"""Switch the supplied systemd services between trusted, prebuilt release directories."""
import argparse
import fcntl
import json
import os
import pwd
from pathlib import Path
import signal
import subprocess
import tempfile
import time
import urllib.request

UNITS = ("openpassword-broker.service", "openpassword-web.service")
STORE = Path("/opt/openpassword-releases")
ORIGINAL = Path("/opt/openpassword")


def atomic_text(path, text):
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as out:
        out.write(text)
        out.flush()
        os.fsync(out.fileno())
    os.chmod(out.name, 0o644)
    os.replace(out.name, path)


def point(link, target):
    temp = link.with_suffix(".next")
    temp.unlink(missing_ok=True)
    temp.symlink_to(target)
    os.replace(temp, link)


def validate(release):
    for file in ("server/main.ts", ".next/BUILD_ID", "node_modules/next/dist/bin/next"):
        if not (release / file).is_file():
            raise RuntimeError(f"Incomplete build at {release}: missing {file}")


def probe(url, deadline=40):
    end = time.monotonic() + deadline
    while True:
        try:
            with urllib.request.urlopen(url + "/api/health", timeout=2) as res:
                if json.load(res)["status"] != "ok":
                    raise ValueError("Broker is unavailable")
            with urllib.request.urlopen(url + "/", timeout=2) as res:
                if b"OpenPassword" not in res.read(512000):
                    raise ValueError("Console is unavailable")
            return
        except (OSError, ValueError, KeyError) as error:
            if time.monotonic() >= end:
                raise RuntimeError(f"Readiness failed at {url}") from error
            time.sleep(0.3)


def preflight(release):
    # Use a disposable vault with a real key, database, listener, and HTTP request.
    js = """
      import {service} from './server/service.ts';
      const api = service(process.env.OPENPASSWORD_HOME);
      try {
        const url = await api.listen({host:'127.0.0.1', port:0});
        if ((await (await fetch(url+'/health')).json()).status !== 'ok') process.exitCode=1;
      } finally { await api.close(); }
    """
    with tempfile.TemporaryDirectory(prefix="openpassword-preflight-") as home:
        options = {}
        if os.geteuid() == 0:
            account = pwd.getpwnam("nobody")
            os.chown(home, account.pw_uid, account.pw_gid)
            options = dict(user=account.pw_uid, group=account.pw_gid, extra_groups=[])
        subprocess.run(["node", "--import", "tsx", "--input-type=module", "-e", js],
                       cwd=release, env={**os.environ, "OPENPASSWORD_HOME": home},
                       timeout=30, check=True, **options)


class Services:
    def __init__(self, root, url):
        self.root = root
        self.url = url

    def prepare(self):
        for unit in UNITS:
            path = Path("/etc/systemd/system") / (unit + ".d") / "90-openpassword-release.conf"
            path.parent.mkdir(parents=True, exist_ok=True)
            text = f"[Service]\nWorkingDirectory={self.root}/current\nTimeoutStopSec=120s\n"
            if path.exists() and path.read_text() != text:
                raise RuntimeError(f"Existing override differs: {path}")
            if not path.exists():
                atomic_text(path, text)
        subprocess.run(["systemctl", "daemon-reload"], check=True)
        for unit in UNITS:
            wd = subprocess.check_output(["systemctl", "show", "-p", "WorkingDirectory",
                                          "--value", unit], text=True).strip()
            if wd != str(self.root / "current"):
                raise RuntimeError(f"{unit} has a conflicting working directory: {wd}")

    def signal_drain(self):
        subprocess.run(["systemctl", "kill", "--kill-who=main", "--signal=SIGUSR2", UNITS[0]], check=True)

    def drain(self):
        def state():
            with urllib.request.urlopen(self.url + "/api/health", timeout=2) as res:
                return json.load(res)
        try:
            initial = state()
        except (OSError, ValueError, KeyError):
            print("Broker health unavailable; proceeding with service shutdown.", flush=True)
            return
        if not initial.get("drain_supported"):
            print("Previous broker uses its existing shutdown behavior.", flush=True)
            return
        self.signal_drain()
        until = time.monotonic() + 90
        while time.monotonic() < until:
            status = state()
            if status["status"] == "draining" and status["in_flight"] == 0:
                return
            time.sleep(.2)
        print("90-second request drain elapsed; continuing with service shutdown.", flush=True)

    def stop(self):
        # systemd orders both stops according to the installed service dependencies.
        subprocess.run(["systemctl", "stop", *reversed(UNITS)], check=True)

    def start(self):
        subprocess.run(["systemctl", "start", *UNITS], check=True)
        probe(self.url)
        release = (self.root / "current").resolve(strict=True)
        for unit in UNITS:
            pid = subprocess.check_output(["systemctl", "show", "-p", "MainPID", "--value", unit],
                                          text=True).strip()
            if Path(f"/proc/{pid}/cwd").resolve(strict=True) != release:
                raise RuntimeError(f"{unit} is running a different release")


def activate(root, original, requested, services, rollback=False):
    current, previous, pending = (root / name for name in ("current", "previous", "pending"))
    if not current.is_symlink():
        validate(original)
        point(current, original)
    services.prepare()
    if pending.exists():
        # A killed updater may have switched code or stopped either service.
        old = Path(pending.read_text())
        services.stop()
        point(current, old)
        services.start()
        pending.unlink()
        print(f"Recovered interrupted activation at {old}", flush=True)
    old = current.resolve(strict=True)
    target = previous.resolve(strict=True) if rollback else requested.resolve(strict=True)
    validate(target)
    if old == target:
        probe(services.url)
        print(f"Already active: {target}")
        return
    preflight(target)
    atomic_text(pending, str(old))
    try:
        if not rollback:
            services.drain()
        else:
            # An unhealthy release must still be eligible for rollback.
            try:
                services.drain()
            except (OSError, ValueError, KeyError, subprocess.SubprocessError):
                print("Could not drain unhealthy release; continuing rollback.", flush=True)
        services.stop()
        point(current, target)
        services.start()
    except BaseException:
        print(f"Restoring {old} after failed activation", flush=True)
        services.stop()
        point(current, old)
        services.start()
        pending.unlink()
        raise
    point(previous, old)
    pending.unlink()
    print(f"Ready: {target}\nRollback release: {old}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--upgrade", type=Path, metavar="BUILT_RELEASE")
    mode.add_argument("--rollback", action="store_true")
    parser.add_argument("--web-port", type=int, default=3000)
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error("Activation of system services requires sudo.")
    STORE.mkdir(exist_ok=True)
    if args.upgrade:
        target = args.upgrade.resolve(strict=True)
        if target.parent != STORE or target.name in {"current", "previous", "pending"}:
            parser.error(f"Put each trusted build in its own release directory under {STORE}.")
    def interrupted(*_):
        raise InterruptedError("Activation interrupted")
    signal.signal(signal.SIGTERM, interrupted)
    with (STORE / "upgrade.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        activate(STORE, ORIGINAL, args.upgrade, Services(STORE, f"http://127.0.0.1:{args.web_port}"),
                 args.rollback)
