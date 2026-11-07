"""How the kit answers the server: one KURAMBIT_RESULT line on success, one KURAMBIT_REFUSED line
for an expected refusal; anything else raises and its traceback becomes the tool error."""
import functools
import json


class Refused(Exception):
    """An expected refusal; reason is a GameOperationError reason ("invalid-input", "tool-missing")."""

    def __init__(self, reason, text):
        super().__init__(text)
        self.reason = reason
        self.text = text


def entry(fn):
    """Wraps an entry point: prints its result (or its refusal) as the one line the server reads,
    and still returns the result, so scripts can call entries directly."""

    @functools.wraps(fn)
    def run(*args, **kwargs):
        try:
            result = fn(*args, **kwargs)
        except Refused as refused:
            print("KURAMBIT_REFUSED " + json.dumps({"reason": refused.reason, "text": refused.text}), flush=True)
            return None
        print("KURAMBIT_RESULT " + json.dumps(result, separators=(",", ":")), flush=True)
        return result

    return run
