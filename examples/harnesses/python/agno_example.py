"""Register a native Python function on an Agno Agent."""
import asyncio
import os
from github_tool import read_github_login
from agno.agent import Agent
from agno.models.openai import OpenAIChat
from openpassword_local import OpenPasswordLocal


async def available_operations() -> list[str]:
    """Inspect the current agent's allowed provider operations."""
    return [item["id"] for item in (await OpenPasswordLocal().capabilities())["operations"]]


async def main():
    agent = Agent(model=OpenAIChat(id=os.environ["HARNESS_MODEL"]), tools=[available_operations, read_github_login])
    await agent.aprint_response("Use read_github_login to retrieve my approved GitHub account login.")


if __name__ == "__main__":
    asyncio.run(main())
