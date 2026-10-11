# Records docs/demo.gif. Needs vhs (brew install vhs), python3, a built
# dist/cli.js, and a provider set up with `agent-harness login`:
#   npm run build && vhs docs/demo.tape
Output docs/demo.gif

Set Shell "bash"
# Looks like VS Code's terminal: its Dark+ theme and default macOS font.
Set Theme "Dark+"
Set FontFamily "Menlo"
Set FontSize 16
Set Width 1440
Set Height 860
Set Padding 28
Set TypingSpeed 70ms
# A modest frame rate lets VHS keep up, so the video plays in real time.
Set Framerate 24

Hide
Type `export ROOT=$PWD DEMO_TASK='The discount tests fail. Find the bug, fix it, then run npm test.' PS1='$ ' && ./scripts/demo-setup.sh /tmp/shop && cd /tmp/shop && alias agent-harness='python3 $ROOT/scripts/demo-drive.py node $ROOT/dist/cli.js' && clear`
Enter
Sleep 1s
Show

Sleep 1s
Type "npm test 2>&1 | grep -E '^ℹ (pass|fail)'"
Enter
Sleep 3s

# scripts/demo-drive.py types the task and approves each action, however
# many the agent asks for. The reply plus the returned input box means the
# run is done; hold that screen, then stop.
Type "agent-harness"
Enter
Wait+Screen@300s /Agent:[\s\S]*ype a message/
Sleep 8s
