from langchain_core.tools import tool
from openpassword_local import OpenPasswordLocal


@tool
async def credential_operations() -> list[str]:
    """List the provider operations authorized for this agent."""
    caps = await OpenPasswordLocal().capabilities()
    return [op["id"] for op in caps["operations"]]
