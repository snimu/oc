/**
 * Bash example code blocks used in the RLM system prompt.
 *
 * These are shared between the system prompt (src/index.ts) and the tests
 * (src/system-prompt-examples.test.ts) so the tests run the exact same code
 * the LM sees. Each function returns a bash script string with paths
 * interpolated from the provided arguments.
 *
 * All examples assume cwd is the project root (so `find src` and `grep src/` work).
 */

export function example1Bash(varsDir: string): string {
  return `VARS="${varsDir}"

# 1. Discover files and build per-file review prompts as a JSON array
find src -name "*.ts" -not -name "*.test.ts" | head -10 > "$VARS/files.txt"
PROMPTS='[]'
while IFS= read -r f; do
  PROMPTS=$(echo "$PROMPTS" | jq --arg f "$f" '. + ["Review " + $f + " for bugs and security issues. List each issue as: ISSUE:<severity>:<line>:<description> (one per line). If no issues, output NONE."]')
done < "$VARS/files.txt"

# 2. Fan out — all files reviewed concurrently by separate subagents
subagent_batch "$PROMPTS" > "$VARS/reviews.txt"

# 3. Extract only high-severity issues from all reviews
grep "ISSUE:high:" "$VARS/reviews.txt" > "$VARS/high-issues.txt" || true
COUNT=$(wc -l < "$VARS/high-issues.txt" | tr -d ' ')
echo "Found $COUNT high-severity issues"

# 4. Conditionally spawn fix agents only if there are issues to fix
if [[ "$COUNT" -gt 0 ]]; then
  # Group issues by file path (field 3 in ISSUE:high:<file>:<desc>)
  FIX_PROMPTS='[]'
  for f in $(cat "$VARS/high-issues.txt" | sed 's/ISSUE:high://; s/:.*//' | sort -u); do
    ISSUES=$(grep "$f" "$VARS/high-issues.txt")
    FIX_PROMPTS=$(echo "$FIX_PROMPTS" | jq --arg f "$f" --arg issues "$ISSUES" '. + ["Fix these issues in " + $f + ":\\n" + $issues + "\\nApply fixes directly with sed -i."]')
  done
  subagent_batch "$FIX_PROMPTS"

  # 5. Verify fixes compile and tests pass
  echo "Running tests..."
  if bun test 2>&1 | tail -5; then
    echo "All tests pass after fixes"
  else
    echo "Tests failed — review the changes"
  fi
else
  echo "No high-severity issues found"
fi`;
}

export function example2Bash(varsDir: string): string {
  return `VARS="${varsDir}"

# 1. Find all entry points that could trigger the error
grep -rn "getUser" src/ --include="*.ts" | head -30 > "$VARS/refs.txt"

# 2. Use llm-subcall (fast, no tools) to triage which refs are worth investigating
SUSPECTS=$(llm-subcall --system 'Output ONLY file:line pairs, one per line. No explanation.' <<'PROMPT'
The error is: "TypeError: Cannot read property 'user' of undefined"
Which of these call sites could cause it? (the object before .user is undefined)

$(cat "$VARS/refs.txt")
PROMPT
)
echo "$SUSPECTS" > "$VARS/suspects.txt"
echo "LLM identified $(wc -l < "$VARS/suspects.txt" | tr -d ' ') suspect locations"

# 3. Fan out deep investigation — each suspect gets a subagent with full tool access
PROMPTS='[]'
while IFS= read -r loc; do
  [[ -z "$loc" ]] && continue
  PROMPTS=$(echo "$PROMPTS" | jq --arg loc "$loc" '. + ["Investigate " + $loc + " — trace the data flow to find where the object could be undefined. Read the file, check callers, and determine if this is the root cause. End your response with VERDICT:yes or VERDICT:no"]')
done < "$VARS/suspects.txt"
subagent_batch "$PROMPTS" > "$VARS/investigations.txt"

# 4. Check which investigations found the root cause
if grep -q "VERDICT:yes" "$VARS/investigations.txt"; then
  echo "Root cause found. Spawning fix agent..."
  # Extract the investigation that said yes, pass it as context to a fix agent
  # Use awk to grab the block containing VERDICT:yes
  EVIDENCE=$(awk '/VERDICT:yes/{found=1} found' "$VARS/investigations.txt" | head -50)
  subagent <<FIXPROMPT
Based on this investigation:
$EVIDENCE

Apply a fix for the TypeError. Then run the relevant tests to verify.
FIXPROMPT
else
  echo "No conclusive root cause found. All investigations saved to $VARS/investigations.txt"
  echo "Consider widening the search or investigating manually."
fi`;
}

export function example3Bash(
  varsDir: string,
  trajectoryPath: string,
): string {
  return `VARS="${varsDir}"
TRAJECTORY="${trajectoryPath}"

# Delegate trajectory search to a subagent — it reads the full file so you don't have to
CONTEXT=$(subagent <<SEARCH
Read the trajectory file at $TRAJECTORY and find all discussion about the "parseConfig" function.
Extract:
1. The original implementation (any code blocks or file contents shown)
2. What changes were made and why
3. The final state of the function

Search with: jq -r '.entries[].turns[]? | select(.content | test("parseConfig"; "i")) | "\\(.role) [turn \\(.turnIndex)]:\\n\\(.content[:500])"' $TRAJECTORY

Return a concise summary with the key code snippets.
SEARCH
)

# Save for reference and use in your response
echo "$CONTEXT" > "$VARS/parseConfig-history.txt"
echo "$CONTEXT"`;
}
