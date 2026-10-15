"""Fast lifecycle guards; Docker smoke tests verify the real services separately."""
import base64
import json
import importlib.util
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("desktop", Path(__file__).with_name("browser.py"))
desktop = importlib.util.module_from_spec(spec)
spec.loader.exec_module(desktop)


prompt_spec = importlib.util.spec_from_file_location("prompt", Path(__file__).with_name("prompt.py"))
prompt = importlib.util.module_from_spec(prompt_spec)
prompt_spec.loader.exec_module(prompt)


class LifecycleTests(unittest.TestCase):
    def test_only_established_vnc_connections_count(self):
        for address, state, expected in [
            ("0100007F:170C", "01", True),
            ("00000000000000000000000001000000:170C", "01", True),
            ("0100007F:170C", "0A", False),
            ("0100007F:170C", "06", False),
            ("0100007F:2406", "01", False),
        ]:
            with self.subTest(address=address, state=state):
                with patch.object(Path, "read_text", return_value=f"header\n0: {address} 0100007F:ABCD {state}\n"):
                    self.assertEqual(desktop.viewers_connected(), expected)

    def test_socket_inspection_failure_keeps_desktop_alive(self):
        with patch.object(Path, "read_text", side_effect=OSError("unavailable")):
            self.assertTrue(desktop.viewers_connected())

    def test_stop_waits_for_idle_monitor_to_release_task_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(Path, "home", return_value=root), patch.object(desktop, "STATE", root / "state"):
                lock = desktop.prompt_lock()
                release = threading.Timer(0.05, lock.close)
                release.start()
                try:
                    with patch.object(desktop.sys, "argv", ["driftverk-browser", "stop"]), patch.object(desktop, "running_pid", return_value=None):
                        desktop.main()
                finally:
                    release.join()

    def test_prompt_tolerates_monitor_lock_but_rejects_active_task(self):
        for transient in (True, False):
            with self.subTest(transient=transient), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                with patch.object(Path, "home", return_value=root), patch.object(prompt, "ROOT", root / ".local/share/driftverk/runs"), patch.object(prompt.shutil, "which", return_value="fixture"), patch.object(prompt, "supervise") as supervise:
                    lock = desktop.prompt_lock()
                    payload = base64.b64encode(json.dumps({"id": "a" * 48, "prompt": "test", "cwd": directory, "record": False}).encode()).decode()
                    release = threading.Timer(0.05, lock.close) if transient else None
                    if release:
                        release.start()
                    try:
                        if transient:
                            prompt.run(payload)
                            supervise.assert_called_once()
                        else:
                            with self.assertRaisesRegex(RuntimeError, "Another prompt"):
                                prompt.run(payload)
                            supervise.assert_not_called()
                    finally:
                        if release:
                            release.join()
                        else:
                            lock.close()

    def test_live_task_prevents_stop_and_lock_is_released(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(Path, "home", return_value=root), patch.object(desktop, "STATE", root / "state"):
                lock = desktop.prompt_lock()
                self.assertIsNotNone(lock)
                self.assertIsNone(desktop.prompt_lock())
                with patch.object(desktop.sys, "argv", ["driftverk-browser", "stop"]), patch.object(desktop.os, "kill") as kill:
                    with self.assertRaisesRegex(SystemExit, "prompt or recording is active"):
                        desktop.main()
                    kill.assert_not_called()
                lock.close()
                released = desktop.prompt_lock()
                self.assertIsNotNone(released)
                released.close()


if __name__ == "__main__":
    unittest.main()
