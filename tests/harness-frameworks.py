"""Optional framework checks called by harness-adapters.test.ts with a real test grant."""
import asyncio
import os
import sys
from pathlib import Path

examples = Path(__file__).resolve().parents[1] / "examples/harnesses"
sys.path[:0] = [str(examples / "python"), str(examples / "rasa")]

from actions import ActionReadGithubLogin
from agno.tools.function import Function, FunctionCall
from agno_example import read_github_login
from agents import function_tool
from agents.tool_context import ToolContext
from deepagents_example import credential_operations
from langchain_example import tool
from rasa_sdk.executor import ActionExecutor


async def check():
    assert "github.user.get" in await credential_operations.ainvoke({})
    os.environ["OPENPASSWORD_REQUEST_KEY"] = "langchain-test"
    assert await tool(read_github_login).ainvoke({}) == "fixture"
    os.environ["OPENPASSWORD_REQUEST_KEY"] = "agno-test"
    result = await FunctionCall(function=Function.from_callable(read_github_login), arguments={}).aexecute()
    assert result.result == "fixture", result
    os.environ["OPENPASSWORD_REQUEST_KEY"] = "openai-agents-test"
    assert await function_tool(read_github_login).on_invoke_tool(ToolContext(context=None, tool_name="read_github_login", tool_call_id="fixture", tool_arguments="{}"), "{}") == "fixture"
    from unittest.mock import patch
    from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
    from langchain_core.messages import AIMessage
    import deepagents_example
    import langchain_example

    class ToolCallingFixture(FakeMessagesListChatModel):
        def _generate(self, messages, *args, **kwargs):
            if messages[-1].type == "tool":
                assert messages[-1].content == "fixture", messages[-1].content
            return super()._generate(messages, *args, **kwargs)


        def bind_tools(self, tools, **kwargs):
            assert any(getattr(t, "name", None) == "read_github_login" or
                       (isinstance(t, dict) and t.get("function", {}).get("name") == "read_github_login")
                       for t in tools)
            return self

    for module, factory in [(deepagents_example, "create_deep_agent"), (langchain_example, "create_agent")]:
        original = getattr(module, factory)
        model = ToolCallingFixture(responses=[
            AIMessage(content="", tool_calls=[{"name": "read_github_login", "args": {}, "id": "call-1"}]),
            AIMessage(content="completed"),
        ])
        def create(*args, **kwargs):
            kwargs["model"] = model
            return original(**kwargs)
        os.environ["HARNESS_MODEL"] = "fixture"
        os.environ["OPENPASSWORD_REQUEST_KEY"] = module.__name__
        with patch.object(module, factory, create):
            if module is deepagents_example:
                await module.main(False)
            else:
                await module.main()

    actions = ActionExecutor()
    actions.register_action(ActionReadGithubLogin)
    outcome = await actions.run({"next_action": "action_read_github_login", "sender_id": "test",
                                 "tracker": {"sender_id": "test", "latest_message": {"message_id": "turn-1"}},
                                 "domain": {}, "version": "3.1.0"})
    assert outcome.responses[0]["text"] == "Connected GitHub account: fixture", outcome
    print("framework checks passed")


asyncio.run(check())
