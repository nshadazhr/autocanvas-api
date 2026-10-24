# Documentation rules

After every code change:
- Check whether existing documentation needs updating before completing the task.
- Update affected docs when behavior, APIs, auth, configuration, database,
  storage, or setup changes. Keep documentation consistent with the final code.
- Reuse existing documentation; avoid duplicate documents and unnecessary edits.
- Clearly separate implemented and planned features.
- Never include secrets, tokens, or real credentials.
- Verify links and commands in updated documentation. Report any commands that
  could not be verified; do not claim they were tested.
- In the final response, mention which docs changed. If documentation needs no
  changes, briefly explain why.

Start with README.md for the documentation index. Update the relevant existing
guide in docs/ and update the index if documentation is added or moved.
