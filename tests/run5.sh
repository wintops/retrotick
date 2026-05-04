#!/bin/bash
for i in $(seq 1 10); do
  echo "=== Run $i ==="
  timeout 20 npx tsx tests/test-emul5.mjs 2>&1 | grep -E "HALT|DONE" | head -2
done
