"""Register a local CLI-backed function tool with the OpenAI Agents SDK."""
import asyncio
import os
from github_tool import read_github_login
from agents import Agent, Runner, function_tool
from openpassword_local import OpenPasswordLocal


@function_tool
async def available_operations() -> list[str]:
    """Return operation IDs permitted by the agent's current grant."""
    return [item["id"] for item in (await OpenPasswordLocal().capabilities())["operations"]]


async def main():
    agent = Agent(name="Credential assistant", model=os.environ["HARNESS_MODEL"],
                  tools=[available_operations, function_tool(read_github_login)])
    result = await Runner.run(agent, "Use read_github_login to retrieve my approved GitHub account login.")
    print(result.final_output)


if __name__ == "__main__":
    asyncio.run(main())
