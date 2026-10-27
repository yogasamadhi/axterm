#!/usr/bin/env python3
"""Axterm desktop development launcher.

Starts the Electron development environment for `apps/desktop` and forwards the
Axterm command line to it. The launcher is intentionally a plain Python script:
it must not require a TypeScript runtime, a bundler or an experimental Node
loader. The command-line help text and the product version are read from the
same sources the packaged Desktop uses, so the launcher cannot drift from the
application:

- help: `apps/desktop/src/main/command-line-help.json` (inlined into the
  Desktop Main build),
- version: the root `package.json` version, which the version-consistency
  regression keeps equal to the shared product version.
"""

import json
import os
import shutil
import signal
import subprocess
import sys
import threading
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parent
DESKTOP_DIRECTORY = REPOSITORY_ROOT / "apps" / "desktop"
DESKTOP_MANIFEST = DESKTOP_DIRECTORY / "package.json"
DESKTOP_ICON = DESKTOP_DIRECTORY / "build" / "icon.png"
HELP_RESOURCE = REPOSITORY_ROOT / "apps/desktop/src/main/command-line-help.json"
ROOT_MANIFEST = REPOSITORY_ROOT / "package.json"
FORWARDED_SIGNALS = ("SIGHUP", "SIGINT", "SIGTERM")
SIGNAL_EXIT_CODES = {"SIGHUP": 129, "SIGINT": 130, "SIGTERM": 143}
FORCE_KILL_DELAY_SECONDS = 5.0


def fail(message: str) -> "None":
    print(message, file=sys.stderr)
    raise SystemExit(1)


def product_version() -> str:
    try:
        manifest = json.loads(ROOT_MANIFEST.read_text(encoding="utf-8"))
    except OSError as error:
        fail(f"Failed to read {ROOT_MANIFEST}: {error}")
    except ValueError as error:
        fail(f"Failed to parse {ROOT_MANIFEST}: {error}")
    version = manifest.get("version")
    if not isinstance(version, str) or not version:
        fail(f"{ROOT_MANIFEST} does not declare a product version")
    return version


def command_line_help() -> str:
    try:
        document = json.loads(HELP_RESOURCE.read_text(encoding="utf-8"))
    except OSError as error:
        fail(f"Failed to read {HELP_RESOURCE}: {error}")
    except ValueError as error:
        fail(f"Failed to parse {HELP_RESOURCE}: {error}")
    lines = document.get("lines")
    if not isinstance(lines, list) or not all(isinstance(line, str) for line in lines):
        fail(f"{HELP_RESOURCE} does not declare the command-line help lines")
    return "\n".join(lines)


def package_manager_command() -> list:
    """Resolves the workspace package manager that started this launcher."""
    entry_point = os.environ.get("npm_execpath", "")
    normalized = entry_point.replace("\\", "/")
    if "pnpm" in normalized and normalized.endswith((".cjs", ".js", ".mjs")):
        node = shutil.which("node") or "node"
        return [node, entry_point]
    executable = shutil.which("pnpm")
    if executable:
        return [executable]
    if sys.platform == "win32":
        fallback = shutil.which("pnpm.cmd")
        if fallback:
            return [fallback]
    fail("pnpm was not found on PATH; install pnpm 11.x to run the desktop development environment")


def start_desktop(forwarded_arguments: list) -> subprocess.Popen:
    environment = dict(os.environ)
    environment["AXTERM_DESKTOP_ICON"] = str(DESKTOP_ICON)
    if forwarded_arguments:
        environment["ELECTRON_CLI_ARGS"] = json.dumps(forwarded_arguments)
    command = package_manager_command() + ["run", "dev"]
    print("[Axterm] Starting the desktop development environment...")
    if sys.platform == "win32":
        creation_flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        return subprocess.Popen(
            command,
            cwd=str(DESKTOP_DIRECTORY),
            env=environment,
            creationflags=creation_flags,
        )
    return subprocess.Popen(
        command,
        cwd=str(DESKTOP_DIRECTORY),
        env=environment,
        start_new_session=True,
    )


def signal_desktop_tree(desktop: subprocess.Popen, group_id, signal_number: int) -> None:
    """Signals the whole development process tree, not only the direct child."""
    if group_id is not None:
        try:
            os.killpg(group_id, signal_number)
            return
        except (OSError, ProcessLookupError):
            pass
    if desktop.poll() is not None:
        return
    try:
        desktop.send_signal(signal_number)
    except (OSError, ProcessLookupError):
        pass


def force_kill_desktop(desktop: subprocess.Popen, group_id) -> None:
    """Escalates to SIGKILL so a surviving dev server cannot keep the port."""
    if group_id is not None:
        try:
            os.killpg(group_id, signal.SIGKILL)
            return
        except (OSError, ProcessLookupError):
            pass
    try:
        desktop.kill()
    except (OSError, ProcessLookupError):
        pass


def run_desktop() -> int:
    if not DESKTOP_MANIFEST.is_file():
        fail(f"Desktop workspace not found: {DESKTOP_MANIFEST}")
    if not DESKTOP_ICON.is_file():
        fail(f"Desktop icon not found: {DESKTOP_ICON}")

    forwarded_arguments = sys.argv[1:]
    if forwarded_arguments and forwarded_arguments[0] == "--":
        forwarded_arguments = forwarded_arguments[1:]
    if any(argument in ("--help", "-h") for argument in forwarded_arguments):
        print(command_line_help())
        return 0
    if any(argument in ("--version", "-V") for argument in forwarded_arguments):
        print(product_version())
        return 0

    desktop = start_desktop(forwarded_arguments)
    group_id = None
    if sys.platform != "win32":
        try:
            group_id = os.getpgid(desktop.pid)
        except OSError:
            group_id = None
    requested_signal = {"name": None}

    def request_shutdown(signal_name: str, _frame) -> None:
        if requested_signal["name"] is not None:
            return
        requested_signal["name"] = signal_name
        signal_number = getattr(signal, signal_name)
        signal_desktop_tree(desktop, group_id, signal_number)
        force_kill = threading.Timer(
            FORCE_KILL_DELAY_SECONDS, force_kill_desktop, args=(desktop, group_id)
        )
        force_kill.daemon = True
        force_kill.start()

    handlers_installed = []
    for signal_name in FORWARDED_SIGNALS:
        signal_number = getattr(signal, signal_name, None)
        if signal_number is None:
            continue
        try:
            signal.signal(signal_number, request_shutdown)
            handlers_installed.append(signal_number)
        except (OSError, ValueError):
            continue

    try:
        return_code = desktop.wait()
    finally:
        # The development server can outlive the package-manager child; the
        # whole group is terminated so a stale dev server never keeps the
        # renderer port or the single-instance lock.
        force_kill_desktop(desktop, group_id)
        for signal_number in handlers_installed:
            try:
                signal.signal(signal_number, signal.SIG_DFL)
            except (OSError, ValueError):
                continue
    if requested_signal["name"] is not None:
        return SIGNAL_EXIT_CODES.get(requested_signal["name"], 1)
    if return_code is None:
        return 1
    return return_code


if __name__ == "__main__":
    try:
        raise SystemExit(run_desktop())
    except KeyboardInterrupt:
        raise SystemExit(130)
    except SystemExit:
        raise
    except OSError as error:
        fail(f"Failed to start the desktop: {error}")
    except Exception as error:  # noqa: BLE001 - the launcher reports every failure
        fail(f"Failed to start the desktop: {error}")
