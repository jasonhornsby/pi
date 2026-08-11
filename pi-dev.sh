#!/usr/bin/env bash
# Dev wrapper for the pi fork (jasonhornsby/pi).
#
# Runs pi in a loop: the /restart command inside pi rebuilds the fork and exits
# with code 42; this wrapper catches that code and relaunches pi, resuming the
# same session. Because this wrapper stays the shell's foreground job, the shell
# never observes pi exiting, so the tty/job-control state is preserved.
#
# Resume semantics:
#   - /restart writes the resume args to $PI_RESTART_ARGS_FILE and exits 42;
#     this wrapper relaunches with those args, resuming the same session.
#   - The resume args own --session/--session-dir: once a restart file exists,
#     any such flags from the original launch are dropped in favor of it.
#   - A stale restart file (left behind by a hard kill, e.g. SIGKILL or a
#     dropped SSH connection) silently wins over explicit args on the next
#     launch. Pass --no-resume to ignore and clear it and start fresh.
#   - On a crash (non-zero exit) the restart file is kept so the session can be
#     picked up again on the next launch; on a clean quit it is removed.
#
# Overrides:
#   PI_CLI_PATH          path to the pi CLI (default: fork dist/cli.js)
#   PI_RESTART_ARGS_FILE path to the resume-args file (default: ~/.pi/pi-restart-args)
set -u

export PI_RESTART_LOOP=1
export PI_RESTART_ARGS_FILE="${PI_RESTART_ARGS_FILE:-$HOME/.pi/pi-restart-args}"
CLI="${PI_CLI_PATH:-/Users/Work/pi/packages/coding-agent/dist/cli.js}"

# --no-resume: ignore any saved resume args (and clear the file) so the given
# arguments, including explicit --session/--session-dir, take effect.
NO_RESUME=0
LAUNCH_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --no-resume) NO_RESUME=1 ;;
    *) LAUNCH_ARGS+=("$arg") ;;
  esac
done
set -- "${LAUNCH_ARGS[@]}"

while true; do
  if [ "$NO_RESUME" -eq 1 ]; then
    rm -f "$PI_RESTART_ARGS_FILE"
  fi

  EXTRA=()
  if [ "$NO_RESUME" -eq 0 ] && [ -f "$PI_RESTART_ARGS_FILE" ]; then
    PI_RESTART_ARGS=()
    # shellcheck source=/dev/null
    . "$PI_RESTART_ARGS_FILE"
    EXTRA=("${PI_RESTART_ARGS[@]}")
    # The resume args own --session/--session-dir; drop any from the original launch.
    FILTERED=()
    skip=0
    for arg in "$@"; do
      if [ "$skip" -eq 1 ]; then skip=0; continue; fi
      case "$arg" in
        --session|--session-dir) skip=1; continue ;;
        --session=*|--session-dir=*) continue ;;
      esac
      FILTERED+=("$arg")
    done
    set -- "${FILTERED[@]}"
  fi

  node "$CLI" "${EXTRA[@]}" "$@"
  code=$?
  if [ "$code" -eq 42 ]; then
    # /restart requested a relaunch; loop with the resume args (if any).
    continue
  fi
  if [ "$code" -ne 0 ] && [ "$NO_RESUME" -eq 0 ]; then
    # Crash/error exit: keep the resume file so the session can be picked up on
    # the next launch. Exit non-zero so the caller sees the failure.
    exit "$code"
  fi
  rm -f "$PI_RESTART_ARGS_FILE"
  exit "$code"
done
