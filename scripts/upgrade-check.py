"""Exercise a built old and new release with real broker/web processes on disposable state."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import sqlite3
import selectors
import time
import subprocess
import sys
import tempfile
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor

spec = importlib.util.spec_from_file_location("upgrade", Path(__file__).resolve().parents[1] / "deploy/upgrade.py")
u = importlib.util.module_from_spec(spec)
spec.loader.exec_module(u)
old, new = (Path(p).resolve() for p in sys.argv[1:])
url = "http://127.0.0.1:3399"


class LocalServices(u.Services):
    """Replace only systemd process control. Use the production activation and readiness logic."""
    broker = web = None
    fail_once = False

    def prepare(self):
        pass

    def start(self):
        release = (self.root / "current").resolve()
        env = {**os.environ, "OPENPASSWORD_HOME": str(self.root / "state"),
               "OPENPASSWORD_WEB_ORIGIN": url, "NODE_ENV": "production"}
        self.broker = subprocess.Popen(["node", "--import", "tsx", "server/main.ts"], cwd=release, env=env)
        self.web = subprocess.Popen(["node", "node_modules/next/dist/bin/next", "start",
                                     "-H", "127.0.0.1", "-p", "3399"], cwd=release, env=env)
        u.probe(self.url)
        if self.fail_once:
            self.fail_once = False
            raise RuntimeError("simulated post-switch readiness failure")

    def signal_drain(self):
        self.broker.send_signal(signal.SIGUSR2)

    def stop(self):
        for process in [self.web, self.broker]:
            if process and process.poll() is None:
                process.terminate()
                process.wait(timeout=30)


def req(path, body=None, headers=None):
    request = urllib.request.Request(url + path, data=None if body is None else json.dumps(body).encode(),
                                     headers={"Content-Type":"application/json", **(headers or {})})
    with urllib.request.urlopen(request, timeout=25) as res:
        return json.load(res), res.headers


with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    services = LocalServices(root, url)
    u.point(root / "current", old)
    try:
        services.start()
        token = (root / "state/operator.token").read_text().strip()
        _, headers = req("/api/auth/setup", {"token":token,"username":"operator","password":"upgrade-fixture-password"})
        cookie = {"Cookie":headers["Set-Cookie"].split(";")[0]}
        c, _ = req("/api/admin/connections", {"provider":"github_read","label":"Fixture",
                        "external_identity":"fixture","secret":"offline-fixture"}, cookie)
        g, _ = req("/api/admin/grants", {"connection_id":c["connection_id"],"label":"Check",
                        "operations":["github.user.get"],"hours":1,"enrollment":True}, cookie)
        env = {**os.environ,"HOME":temp,"OPENPASSWORD_BROKER":url,"OPENPASSWORD_AGENT":"test"}
        binary = root / ".local/bin/openpassword"
        binary.parent.mkdir(parents=True)
        binary.write_bytes((old / "public/openpassword-cli.cjs").read_bytes())
        binary.chmod(0o755)
        subprocess.run([binary,"connect"],env=env,input=g["enrollment_token"]+"\n",text=True,check=True)
        def check():
            assert req("/api/admin/workspace",headers=cookie)[0]["connections"][0]["id"] == c["connection_id"]
            assert json.loads(subprocess.check_output([binary,"whoami"],env=env))["device_id"] == g["device_id"]
        u.activate(root,old,new,services)
        check()
        subprocess.run(["sh",new/"deploy/update-client.sh"],env=env,check=True)
        subprocess.run(["sh",new/"deploy/update-client.sh"],env=env,check=True)
        check()
        cursor=req("/api/admin/activity",headers=cookie)[0]["cursor"]
        with ThreadPoolExecutor(1) as pool:
            waiting=pool.submit(req, "/api/admin/activity?after="+str(cursor), None, cookie)
            until=time.monotonic()+4
            while req("/api/health")[0]["in_flight"] < 1:
                assert time.monotonic()<until
                time.sleep(.025)
            services.drain()
            assert waiting.result(timeout=2)[0]["cursor"] == cursor
            try:
                req("/api/admin/workspace",headers=cookie)
                raise AssertionError("Expected a drain response")
            except urllib.error.HTTPError as e:
                assert e.code==503 and e.headers["Retry-After"]=="1"
        # Keep one CLI process alive while the web proxy and broker change binaries.
        watcher = subprocess.Popen([binary, "watch", str(cursor)], env=env, stdout=subprocess.PIPE)
        try:
            u.activate(root,old,None,services,rollback=True)
            check()
            with sqlite3.connect(root/"state/vault.sqlite") as db:
                db.execute("INSERT INTO events(tenant,actor,action,subject,at) VALUES(?,?,?,?,?)",
                           ("default",g["device_id"],"Upgrade test",g["device_id"],int(time.time()*1000)))
            with selectors.DefaultSelector() as ready:
                ready.register(watcher.stdout, selectors.EVENT_READ)
                assert ready.select(timeout=25), "CLI watch failed to resume"
                row=json.loads(watcher.stdout.readline())
                assert row["action"]=="Upgrade test" and row["id"]>cursor
        finally:
            watcher.terminate()
            watcher.wait(timeout=5)
        services.fail_once=True
        try:
            u.activate(root,old,new,services)
            raise AssertionError("Candidate unexpectedly activated")
        except RuntimeError as e:
            assert "simulated" in str(e)
        assert (root/"current").resolve()==old and not (root/"pending").exists()
        check()
        print("PASS upgrade, client replacement, idle poll drain, retry hint, explicit rollback, failed activation rollback, cookie and grant continuity, CLI watch resumed across restart")
    finally:
        services.stop()
