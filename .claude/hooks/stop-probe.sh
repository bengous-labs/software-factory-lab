#!/bin/sh
# Records what a Stop hook sees in a Desktop session: PATH, which tools resolve, the names of the
# environment variables (never their values), and the Stop input. Shell only, so it runs even
# when the hook's PATH holds no bun.
log="${CLAUDE_PROJECT_DIR:-.}/.lab/stop-probe.log"
mkdir -p "$(dirname "$log")"
{
  echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "PATH=$PATH"
  for tool in claude bun gh git; do echo "$tool: $(command -v "$tool" || echo MISSING)"; done
  echo "env names: $(env | cut -d= -f1 | sort | tr '\n' ' ')"
  echo "input: $(cat)"
} >>"$log"
exit 0
