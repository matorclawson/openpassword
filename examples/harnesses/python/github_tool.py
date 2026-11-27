"""Task-specific function shared by the framework examples."""
import os
from openpassword_local import OpenPasswordLocal


async def read_github_login() -> str:
    """Read the GitHub login through this agent's approved GitHub connection."""
    outcome = await OpenPasswordLocal().github_identity(os.environ["OPENPASSWORD_REQUEST_KEY"])
    if outcome["status"] != "confirmed":
        raise RuntimeError("OpenPassword returned " + outcome["status"])
    return outcome["result"]["login"]
