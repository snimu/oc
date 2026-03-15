/**
 * Custom tool-calling loop for sub-agent execution.
 *
 * When running in verifiers mode (RLM_SUBAGENT_VIA_TOOL_LOOP=true), the OC
 * proxy uses this instead of OpenCode child sessions.  All API calls go
 * through OPENAI_BASE_URL with a configurable model identifier so the
 * verifiers interception proxy can route them concurrently.
 *
 * Bash commands are executed locally via Bun.spawn — the proxy already runs
 * inside the sandbox so it has full filesystem access.
 */

export interface SubAgentOptions {
  prompt: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  maxTurns?: number;
  timeoutMs?: number;
  systemPrompt?: string;
  functionsPath?: string;
  depth?: number;
  maxOutputChars?: number;
  onProgress?: (text: string) => void;
}

export interface SubAgentResult {
  content: string;
  turns: number;
  toolCalls: number;
}

const BASH_TOOL_DEF = {
  type: "function" as const,
  function: {
    name: "bash",
    description: "Execute a bash command. Use for file operations, code execution, searching, etc.",
    parameters: {
      type: "object" as const,
      properties: {
        command: {
          type: "string" as const,
          description: "The bash command to execute",
        },
      },
      required: ["command"],
    },
  },
};

export async function runSubAgent(options: SubAgentOptions): Promise<SubAgentResult> {
  const {
    prompt,
    model,
    baseUrl,
    apiKey,
    maxTurns = 10,
    timeoutMs = 120_000,
    systemPrompt,
    functionsPath,
    depth = 0,
    maxOutputChars = 8192,
    onProgress,
  } = options;

  const messages: any[] = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: prompt });

  let totalToolCalls = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, tools: [BASH_TOOL_DEF] }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`API error (${resp.status}): ${text}`);
    }

    const data = (await resp.json()) as any;
    const message = data.choices?.[0]?.message;
    if (!message) throw new Error("No message in API response");

    if (!message.tool_calls || message.tool_calls.length === 0) {
      return {
        content: message.content || "(empty response)",
        turns: turn + 1,
        toolCalls: totalToolCalls,
      };
    }

    messages.push(message);
    totalToolCalls += message.tool_calls.length;

    for (const toolCall of message.tool_calls) {
      let args: { command?: string };
      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch {
        args = { command: toolCall.function.arguments };
      }
      const command = args.command || "";
      const cmdPreview =
        command.length > 80 ? command.slice(0, 80) + "…" : command;
      onProgress?.(`  ⟳ bash: ${cmdPreview}`);

      const result = await executeBash(command, {
        timeoutMs,
        functionsPath,
        depth,
        maxOutputChars,
      });

      const preview = result.replace(/\n/g, " ").slice(0, 120);
      onProgress?.(
        `  ✓ bash → ${preview}${result.length > 120 ? "…" : ""}`,
      );

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result,
      });
    }
  }

  // Max turns — ask for final answer without tools
  messages.push({
    role: "user",
    content:
      "Maximum tool calls reached. Provide your final answer based on what you have done so far.",
  });

  const finalResp = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages }),
  });

  if (!finalResp.ok) {
    const text = await finalResp.text();
    throw new Error(`API error on final turn (${finalResp.status}): ${text}`);
  }

  const finalData = (await finalResp.json()) as any;
  return {
    content:
      finalData.choices?.[0]?.message?.content || "(empty response)",
    turns: maxTurns + 1,
    toolCalls: totalToolCalls,
  };
}

interface BashExecOptions {
  timeoutMs: number;
  functionsPath?: string;
  depth: number;
  maxOutputChars: number;
}

async function executeBash(
  command: string,
  options: BashExecOptions,
): Promise<string> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    OPENCODE_RLM_DEPTH: String(options.depth + 1),
  };

  const fullCommand = options.functionsPath
    ? `source "${options.functionsPath}"\n${command}`
    : command;

  const proc = Bun.spawn(["bash", "-lc", fullCommand], {
    stdout: "pipe",
    stderr: "pipe",
    env,
  });

  // Race between process completion and timeout
  const timeoutPromise = new Promise<"timeout">((resolve) =>
    setTimeout(() => resolve("timeout"), options.timeoutMs),
  );

  const exitPromise = proc.exited.then((code) => ({ code }));
  const race = await Promise.race([exitPromise, timeoutPromise]);

  if (race === "timeout") {
    proc.kill();
    return "(command timed out)";
  }

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = (race as { code: number }).code;

  let output = stdout;
  if (stderr) output += (output ? "\n" : "") + `stderr: ${stderr}`;
  if (exitCode !== 0) output += `\n(exit code: ${exitCode})`;

  if (
    options.maxOutputChars > 0 &&
    output.length > options.maxOutputChars
  ) {
    output =
      output.slice(0, options.maxOutputChars) + "\n... [output truncated]";
  }

  return output || "(no output)";
}
