---
name: diagnose
description: Diagnose a terminal or host problem using the bounded context supplied by the user.
disable-model-invocation: true
---

Diagnose from the supplied bounded context. State uncertainty, identify likely
causes, and propose ordered checks. In chat mode only explain the checks. In work
mode use workspace_exec with one relevant command per turn. Runtime reviews safe
commands automatically and waits for confirmation on dangerous commands. Continue
the diagnosis from actual tool results until done or Runtime stops the task.
Never claim execution before a tool result. Never request passwords or credentials.
