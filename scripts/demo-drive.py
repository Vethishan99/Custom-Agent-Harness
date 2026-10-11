#!/usr/bin/env python3
"""Drive agent-harness while docs/demo.tape records it.

Runs the command given as arguments in a terminal, types $DEMO_TASK like a
person would, then approves each action as the agent asks for it. VHS can't
react to the screen, and the number of approvals changes from run to run,
so this script does the reacting. Exits once the reply has finished.
"""
import fcntl
import os
import pty
import select
import struct
import sys
import termios
import time

TASK = os.environ["DEMO_TASK"]
APPROVE = b"Approve> "
# The placeholder's first letter is drawn as a cursor, so match the rest.
READY = b"ype a message"
TIMEOUT = 300

size = fcntl.ioctl(sys.stdout.fileno(), termios.TIOCGWINSZ, b"\0" * 8)
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, size)  # Same size as the recording.
    os.execvp(sys.argv[1], sys.argv[1:])

seen = b""  # Output since the last thing we typed.


def pump(seconds):
    """Show the child's output for this long, remembering what was seen."""
    global seen
    end = time.time() + seconds
    while time.time() < end:
        ready, _, _ = select.select([fd], [], [], 0.05)
        if not ready:
            continue
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            sys.exit(0)  # The agent exited.
        os.write(sys.stdout.fileno(), chunk)
        seen += chunk


def type_text(text, delay=0.07):
    for char in text:
        os.write(fd, char.encode())
        pump(delay)


def press_enter():
    # Forget what's on screen now (the answered prompt), but keep everything
    # printed after Enter: the next prompt can appear almost at once.
    global seen
    seen = b""
    os.write(fd, b"\r")
    pump(0.3)


start = time.time()
while READY not in seen:
    pump(0.1)
    if time.time() - start > 30:
        sys.exit("agent-harness never showed its input box")
pump(2)  # Let viewers take in the header first.
type_text(TASK)
pump(1)
press_enter()

while time.time() - start < TIMEOUT:
    pump(0.2)
    if APPROVE in seen:
        pump(3)  # Give viewers time to read the request.
        type_text("y")
        pump(0.6)
        press_enter()
    elif READY in seen:
        pump(10)  # Hold the finished reply on screen.
        break

os.write(fd, b"\x03")  # Ctrl+C exits the agent.
pump(1)
