"""LangChain agent with a native async tool, also usable in a LangGraph tool node."""
import asyncio
import os
from github_tool import read_github_login
from langchain.agents import create_agent
from langchain_core.tools import tool
from langchain_tools import credential_operations


async def main():
    agent = create_agent(os.environ["HARNESS_MODEL"], tools=[credential_operations, tool(read_github_login)])
    result = await agent.ainvoke({"messages": [{"role": "user", "content":
                                 "Use read_github_login to retrieve my approved GitHub account login."}]})
    print(result["messages"][-1].content)


if __name__ == "__main__":
    asyncio.run(main())
