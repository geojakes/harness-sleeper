#!/bin/sh
# Example `run` action target. sleeper runs this with cwd = the config file's
# directory, and $1 is whatever {{relpath}} expanded to.
echo "check.sh: nothing failed for $1"
