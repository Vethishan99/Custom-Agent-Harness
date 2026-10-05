# Records docs/demo.gif. Needs vhs (brew install vhs), a built dist/cli.js,
# and OPENROUTER_API_KEY in the environment:
#   npm run build && OPENROUTER_API_KEY=... vhs docs/demo.tape
Output docs/demo.gif

Set Shell "bash"
Set FontSize 15
Set Width 1500
Set Height 820
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms

Hide
Type "export DEMO=$PWD/dist/cli.js PS1='$ ' && ./scripts/demo-setup.sh .demo/shop && cd .demo/shop && alias agent-harness='node $DEMO' && clear"
Enter
Sleep 1s
Show

Type "npm test 2>&1 | grep -E '^ℹ (pass|fail)'"
Enter
Sleep 2s

Type "agent-harness"
Enter
Wait+Screen@20s /Type a message/
Sleep 1s

Type "The discount tests fail. Find the bug, fix it, then run npm test."
Sleep 500ms
Enter

# Approve the edit, then the test run.
Wait+Screen@300s /Approve>/
Sleep 2s
Type "y"
Enter
Wait+Screen@300s /Approve>/
Sleep 2s
Type "y"
Enter

Wait+Screen@300s /Agent:/
Sleep 6s
