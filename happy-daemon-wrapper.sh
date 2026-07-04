#!/bin/bash
# Wrapper to keep happy daemon running
while true; do
  happy daemon start
  # Wait for daemon to die
  sleep 30
  # Check if still running
  if happy daemon status > /dev/null 2>&1; then
    # Still running, wait and check again
    while happy daemon status > /dev/null 2>&1; do
      sleep 60
    done
  fi
  echo "$(date): Happy daemon died, restarting..." >&2
done
