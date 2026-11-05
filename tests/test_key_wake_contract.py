#!/usr/bin/env python3
"""Static contracts for the deep-sleep key-wake guard wiring in main.c."""

from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]


def read(relative_path: str) -> str:
    return (ROOT / relative_path).read_text(encoding="utf-8")


def function_body(source: str, name: str) -> str:
    match = re.search(rf"\b{re.escape(name)}\s*\([^;]*?\)\s*\{{", source)
    if not match:
        raise AssertionError(f"function not found: {name}")
    start = match.end() - 1
    depth = 0
    for index in range(start, len(source)):
        if source[index] == "{":
            depth += 1
        elif source[index] == "}":
            depth -= 1
            if depth == 0:
                return source[start + 1:index]
    raise AssertionError(f"function is unterminated: {name}")


class KeyWakeGuardWiringTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.main = read("main/main.c")

    def test_on_key_consumes_the_guard_before_dispatch(self) -> None:
        # The application creates its queue before registering button callbacks.
        # Release events must still reach the wake guard before filtering or any
        # queue dispatch; otherwise the waking hold can trigger a later action.
        body = function_body(self.main, "on_key")
        self.assertIn("key_guard_consume(", body)
        self.assertIn("xQueueSend(", body)
        self.assertLess(body.index("key_guard_consume("), body.index("xQueueSend("))
        self.assertLess(body.index("key_guard_consume("), body.index("BSP_BTN_CLICK"))
        startup = function_body(self.main, "app_main")
        self.assertLess(startup.index("xQueueCreate("), startup.index("bsp_button_init("))


if __name__ == "__main__":
    unittest.main()
