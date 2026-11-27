"""Run in the Rasa action server's own approved OS account."""
from rasa_sdk import Action
from openpassword_local import OpenPasswordLocal


class ActionCheckGithubAccess(Action):
    def name(self):
        return "action_check_github_access"

    async def run(self, dispatcher, tracker, domain):
        try:
            caps = await OpenPasswordLocal().capabilities()
            allowed = any(op["id"] == "github.user.get" for op in caps["operations"])
            message = "GitHub profile lookup is available." if allowed else "GitHub lookup is unavailable."
        except (OSError, RuntimeError, TimeoutError, ValueError, KeyError):
            message = "I could not verify GitHub access."
        dispatcher.utter_message(text=message)
        return []


class ActionReadGithubLogin(Action):
    def name(self):
        return "action_read_github_login"

    async def run(self, dispatcher, tracker, domain):
        # The dialogue engine supplies message_id. A replay of the same turn uses the same key.
        from hashlib import sha256
        turn = tracker.latest_message.get("message_id")
        if not turn:
            dispatcher.utter_message(text="I could not identify this request.")
            return []
        request_key = sha256(f"{tracker.sender_id}/{turn}/github.user.get".encode()).hexdigest()
        try:
            outcome = await OpenPasswordLocal().github_identity(request_key)
            if outcome["status"] == "confirmed":
                dispatcher.utter_message(text="Connected GitHub account: " + outcome["result"]["login"])
            else:
                dispatcher.utter_message(text="The GitHub lookup has not been confirmed.")
        except (OSError, RuntimeError, TimeoutError, ValueError, KeyError):
            dispatcher.utter_message(text="I could not read the connected GitHub account.")
        return []
