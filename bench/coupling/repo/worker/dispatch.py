# A fourth language on the same key. `os.environ.get` rather than `os.getenv` on purpose — both forms exist in
# the wild and both must resolve, or the adapter is only as multi-language as the one idiom it was tested on.
import os


def target() -> str:
    return os.environ.get("NOTIFY_WEBHOOK_URL", "")
