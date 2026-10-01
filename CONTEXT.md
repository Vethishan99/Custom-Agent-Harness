# Agent Harness TUI

A starter interface for learners to connect a conversational agent to a terminal user experience.

## Language

**Message**:
Text submitted by the user as one turn of a conversation.
_Avoid_: Prompt, query, command

**Response**:
Text returned by the agent for a message.
_Avoid_: Answer, completion, output

**Agent**:
The learner-provided conversational capability that receives a message and produces a response.
_Avoid_: Bot, model, backend

**Session**:
The messages and responses exchanged during one run of the application. A starter session exists only until the process exits.
_Avoid_: Chat, thread, history
