"""Offline regressions: synthetic data only, no CLI, Cargo, socket or database calls."""
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import Mock, patch


SPEC = importlib.util.spec_from_file_location(
    "model_acceptance", Path(__file__).resolve().parents[1] / "run_ai_model_acceptance.py"
)
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)

ANSWER = '{"interpretations":[],"unknowns":["Synthetic answer; business meaning unknown"]}'
USAGE = {"input_tokens": 10, "output_tokens": 5}
BODY = {"model": "synthetic", "messages": [
    {"role": "system", "content": "Return JSON only"},
    {"role": "user", "content": "Synthetic metadata question"},
]}


def completed_events(text=ANSWER):
    return [
        {"type": "thread.started", "thread_id": "synthetic-thread"},
        {"type": "turn.started"},
        {"type": "item.completed", "item": {"type": "agent_message", "text": text}},
        {"type": "turn.completed", "usage": USAGE},
    ]


def contents(directory):
    return {str(path.relative_to(directory)): path.read_bytes()
            for path in directory.rglob("*") if path.is_file()}


class ModelAcceptanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="nodal-model-runner-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.preview = self.root / "approved.json"
        self.preview.write_text(json.dumps([{"preview": {"requestBody": BODY}}]))
        self.cases = self.root / "cases.json"
        self.cases.write_text('[{"id":"synthetic"}]')
        self.output = self.root / "run"

    def run_bridge(self, *, answer=ANSWER, events=None, returncode=0,
                   request=None, timeout=False, preexisting_answer=False):
        """Exercise main + the real request handler; replace only external boundaries."""
        captured = {"cli_calls": 0}

        def server_factory(_address, handler):
            captured["handler"] = handler
            return Mock(server_port=12345)

        def fake_run(command, **kwargs):
            if command[1:3] == ["login", "status"]:
                return types.SimpleNamespace(returncode=0)
            if command[1] == "exec":
                captured["cli_calls"] += 1
                if timeout:
                    raise subprocess.TimeoutExpired(command, 150)
                if answer is not None:
                    Path(command[command.index("--output-last-message") + 1]).write_text(answer)
                # Mixed stderr diagnostics must not hide a missing successful turn.
                kwargs["stdout"].write("synthetic CLI diagnostic\n")
                for event in completed_events() if events is None else events:
                    kwargs["stdout"].write(json.dumps(event) + "\n")
                return types.SimpleNamespace(returncode=returncode)
            if command[0] == "cargo":
                if preexisting_answer:
                    (self.output / "answer-01.json").write_text("OLD_SYNTHETIC_ANSWER")
                handler = object.__new__(captured["handler"])
                raw = json.dumps(BODY if request is None else request).encode()
                handler.path = "/v1/chat/completions"
                handler.headers = {"Authorization": "Bearer local-acceptance-bridge", "Content-Length": str(len(raw))}
                handler.rfile = io.BytesIO(raw)
                handler.wfile = io.BytesIO()
                handler.send_response = lambda status: captured.update(status=status)
                handler.send_header = lambda *_: None
                handler.end_headers = lambda: None
                handler.send_error = lambda status, *_: captured.update(status=status)
                handler.do_POST()
                captured["response"] = handler.wfile.getvalue()
                accepted = captured["status"] == 200
                (self.output / "results.json").write_text(json.dumps([{"accepted": accepted}]))
                return types.SimpleNamespace(returncode=0 if accepted else 101)
            raise AssertionError(f"Unexpected subprocess: {command[0]}")

        previous_umask = os.umask(0o077)
        self.addCleanup(os.umask, previous_umask)
        argv = ["runner", "--cases", str(self.cases), "--approved-preview", str(self.preview),
                "--output", str(self.output)]
        with patch.object(runner, "HTTPServer", side_effect=server_factory), \
                patch.object(runner.threading, "Thread"), \
                patch.object(runner.subprocess, "run", side_effect=fake_run) as process, \
                patch.object(runner.shutil, "which", return_value="/fake/codex"), \
                patch.object(sys, "argv", argv), patch("sys.stdout", new_callable=io.StringIO):
            with self.assertRaises(SystemExit) as exited:
                runner.main()
        captured["exit_code"] = exited.exception.code
        captured["process_calls"] = process.call_count
        return captured

    def assert_rejected(self, **kwargs):
        outcome = self.run_bridge(**kwargs)
        self.assertEqual(outcome["exit_code"], 101)
        self.assertEqual(outcome["status"], 502)
        self.assertEqual(outcome["response"], b"")
        exchange = json.loads((self.output / "exchanges.json").read_text())
        self.assertEqual(len(exchange), 1)
        self.assertFalse(exchange[0]["accepted"])
        self.assertIn("error", exchange[0])
        self.assertFalse(json.loads((self.output / "results.json").read_text())[0]["accepted"])
        return outcome

    def test_matching_current_answer_succeeds_in_new_directory(self):
        outcome = self.run_bridge(answer=ANSWER + "\n")
        self.assertEqual(outcome["exit_code"], 0)
        self.assertEqual(outcome["status"], 200)
        self.assertEqual(outcome["cli_calls"], 1)
        reply = json.loads(outcome["response"])["choices"][0]["message"]["content"]
        self.assertEqual(reply, ANSWER + "\n")
        self.assertEqual(json.loads((self.output / "exchanges.json").read_text())[0]["usage"], USAGE)
        self.assertEqual(self.output.stat().st_mode & 0o777, 0o700)
        self.assertTrue(all(path.stat().st_mode & 0o777 == 0o600 for path in self.output.iterdir()))

    def test_existing_empty_directory_is_allowed(self):
        self.output.mkdir(mode=0o755)
        self.assertEqual(self.run_bridge()["exit_code"], 0)
        self.assertEqual(self.output.stat().st_mode & 0o777, 0o700)

    def test_nonempty_evidence_directory_is_unchanged_before_any_subprocess(self):
        self.output.mkdir()
        for name in ("answer-01.json", "events-01.jsonl", "request-01.json", "results.json",
                     "summary.json", "authorization.json", "answer-02.json"):
            (self.output / name).write_text("OLD_SYNTHETIC_EVIDENCE")
        before = contents(self.output)
        outcome = self.run_bridge()
        self.assertIn("must be empty", outcome["exit_code"])
        self.assertEqual(outcome["process_calls"], 0)
        self.assertEqual(contents(self.output), before)

    def test_hidden_files_and_subdirectories_also_prevent_reuse(self):
        for entry in (".hidden", "subdirectory"):
            with self.subTest(entry=entry):
                self.output = self.root / entry
                self.output.mkdir()
                path = self.output / entry
                path.mkdir() if entry == "subdirectory" else path.write_text("preserve")
                outcome = self.run_bridge()
                self.assertIn("must be empty", outcome["exit_code"])
                self.assertEqual(outcome["process_calls"], 0)
                self.assertEqual(list(self.output.iterdir()), [path])

    def test_successful_run_cannot_be_reused(self):
        self.assertEqual(self.run_bridge()["exit_code"], 0)
        before = contents(self.output)
        outcome = self.run_bridge()
        self.assertIn("must be empty", outcome["exit_code"])
        self.assertEqual(outcome["process_calls"], 0)
        self.assertEqual(contents(self.output), before)

    def test_failed_run_cannot_be_reused(self):
        self.assert_rejected(returncode=1)
        before = contents(self.output)
        outcome = self.run_bridge()
        self.assertIn("must be empty", outcome["exit_code"])
        self.assertEqual(outcome["process_calls"], 0)
        self.assertEqual(contents(self.output), before)

    def test_only_one_concurrent_runner_can_claim_empty_directory(self):
        self.output.mkdir()
        barrier = threading.Barrier(2)
        outcomes = []

        def claim():
            barrier.wait()
            try:
                runner.claim_output_directory(self.output)
                outcomes.append("claimed")
            except SystemExit:
                outcomes.append("rejected")

        threads = [threading.Thread(target=claim) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=5)
        self.assertCountEqual(outcomes, ["claimed", "rejected"])

    def test_zero_exit_without_any_final_output_is_rejected(self):
        self.assert_rejected(answer=None, events=[])

    def test_event_answer_without_answer_file_is_rejected(self):
        self.assert_rejected(answer=None)

    def test_empty_answer_file_is_rejected(self):
        for answer in ("", " \n\t"):
            with self.subTest(answer=repr(answer)):
                self.output = self.root / ("empty" if answer == "" else "whitespace")
                self.assert_rejected(answer=answer)

    def test_empty_event_answer_is_rejected(self):
        self.assert_rejected(events=completed_events(" \n"))

    def test_answer_file_must_match_current_event(self):
        self.assert_rejected(answer='{"interpretations":[],"unknowns":["OLD_SYNTHETIC_ANSWER"]}')

    def test_missing_answer_event_is_rejected(self):
        self.assert_rejected(events=[event for event in completed_events() if event["type"] != "item.completed"])

    def test_missing_turn_completion_is_rejected(self):
        self.assert_rejected(events=completed_events()[:-1])

    def test_failed_turn_is_rejected_even_with_zero_exit(self):
        events = completed_events()
        events.append({"type": "turn.failed", "error": {"message": "synthetic failure"}})
        self.assert_rejected(events=events)

    def test_multiple_turns_are_rejected(self):
        self.assert_rejected(events=completed_events() + completed_events())

    def test_completion_before_answer_is_rejected(self):
        events = completed_events()
        events[2], events[3] = events[3], events[2]
        self.assert_rejected(events=events)

    def test_tool_use_is_rejected_even_when_answer_matches(self):
        events = completed_events()
        events.insert(2, {"type": "item.started", "item": {"type": "command_execution"}})
        self.assert_rejected(events=events)

    def test_nonzero_cli_exit_is_rejected_even_with_matching_files(self):
        self.assert_rejected(returncode=1)

    def test_cli_timeout_is_rejected_without_fallback(self):
        self.assert_rejected(timeout=True)

    def test_unapproved_request_never_reaches_cli(self):
        outcome = self.assert_rejected(request={**BODY, "messages": [{"role": "user", "content": "outside approved scope"}]})
        self.assertEqual(outcome["cli_calls"], 0)
        self.assertFalse((self.output / "request-01.json").exists())

    def test_answer_collision_after_start_is_not_reused_or_overwritten(self):
        outcome = self.assert_rejected(preexisting_answer=True)
        self.assertEqual(outcome["cli_calls"], 0)
        self.assertEqual((self.output / "answer-01.json").read_text(), "OLD_SYNTHETIC_ANSWER")


if __name__ == "__main__":
    unittest.main()
