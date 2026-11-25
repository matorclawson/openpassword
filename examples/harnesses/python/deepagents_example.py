"""Run with deepagents and langchain-openai installed; --check exercises the tool without inference."""
import argparse
import asyncio
import os
from github_tool import read_github_login
from deepagents import create_deep_agent
from langchain_core.tools import tool
from langchain_tools import credential_operations


async def main(check: bool):
    if check:
        print(await credential_operations.ainvoke({}))
        return
    agent = create_deep_agent(model=os.environ["HARNESS_MODEL"], tools=[credential_operations, tool(read_github_login)])
    result = await agent.ainvoke({"messages": [{"role": "user", "content":
                                 "Use read_github_login to retrieve my approved GitHub account login."}]})
    print(result["messages"][-1].content)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    asyncio.run(main(parser.parse_args().check))
