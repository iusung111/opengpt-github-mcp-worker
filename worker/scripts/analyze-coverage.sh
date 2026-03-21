#!/bin/bash
echo "=== Registered Tools ==="
grep -A1 "server.registerTool(" worker/src/index.ts | grep "^\t'" | sed "s/.*'\([^']*\).*/\1/" | sort | tail -35 > /tmp/registered.txt
cat /tmp/registered.txt

echo -e "\n=== Tested Tools (in test files) ==="
grep -oE "callTool.*name.*'[^']+'" worker/test/*.ts | sed "s/.*'//" | sed "s/'$//" | sort | uniq > /tmp/tested.txt
cat /tmp/tested.txt

echo -e "\n=== NOT TESTED (Potentially) ==="
comm -23 /tmp/registered.txt /tmp/tested.txt
