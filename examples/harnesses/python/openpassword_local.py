"""Async client for an enrolled OpenPassword agent executable. Requires Python 3.11+."""
import asyncio
import json
import os
from pathlib import Path


class OpenPasswordLocal:
    def __init__(self, executable: str | None = None):
        path = Path(executable or os.environ["OPENPASSWORD_ADAPTER"])
        if not path.is_absolute() or not path.is_file() or not os.access(path, os.X_OK):
            raise ValueError("Set OPENPASSWORD_ADAPTER to the absolute prepared executable")
        self.executable = path

    async def _call(self, *args: str, data: bytes = b""):
        child = await asyncio.create_subprocess_exec(
            self.executable, *args, stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(child.communicate(data), timeout=120)
        finally:
            if child.returncode is None:
                child.kill()
                await child.wait()
        if child.returncode:
            # CLI errors describe grant and transport state. Never echo request data.
            raise RuntimeError(stderr.decode(errors="replace").strip() or "OpenPassword CLI failed")
        return json.loads(stdout)

    async def whoami(self):
        return await self._call("whoami")

    async def capabilities(self):
        return await self._call("capabilities")

    async def models(self):
        return await self._call("models")

    async def chat(self, model: str, prompt: str, max_tokens: int, request_key: str):
        return await self._call("chat", model, str(max_tokens), request_key, data=prompt.encode())

    async def invoke(self, connection_id: str, operation_id: str, arguments: dict,
                     request_key: str, *, expect: dict | None = None):
        payload = dict(connection_id=connection_id, operation_id=operation_id,
                       arguments=arguments, idempotency_key=request_key)
        if expect is not None:
            payload["expect"] = expect
        return await self._call("invoke-json", data=json.dumps(payload).encode())

    async def operation(self, operation_id: str, arguments: dict, request_key: str):
        """Resolve this grant's connection and send its expected identity and revision."""
        return await self._call("operation", operation_id, request_key, data=json.dumps(arguments).encode())

    async def github_identity(self, request_key: str):
        return await self.operation("github.user.get", {}, request_key)
