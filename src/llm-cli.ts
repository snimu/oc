#!/usr/bin/env bun
/**
 * Standalone CLI for making single LLM calls.
 * Usage: llm-subcall [--system "system prompt"] "prompt"
 *
 * Reads model/provider context from the RLM_LLM_CONTEXT env var,
 * which points to a JSON file written by the plugin's chat.params hook.
 */

import { readFileSync } from "fs";

interface LLMContext {
  modelId: string;
  apiId: string;
  apiUrl: string;
  apiKey: string;
}

// Parse args
const argv = process.argv.slice(2);
let system: string | undefined;
let prompt = "";

for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--system" && i + 1 < argv.length) {
    system = argv[++i];
  } else {
    prompt = argv[i];
  }
}

if (!prompt) {
  process.stderr.write(
    'Usage: llm-subcall [--system "system prompt"] "prompt"\n',
  );
  process.exit(1);
}

// --- Proxy mode: route through OPENAI_BASE_URL for verifiers integration ---
if (process.env.RLM_LLM_SUBCALL_VIA_PROXY) {
  const baseUrl = process.env.OPENAI_BASE_URL;
  const modelId = process.env.RLM_SUB_MODEL_ID || "sub";
  const apiKey = process.env.OPENAI_API_KEY || "intercepted";

  if (!baseUrl) {
    process.stderr.write(
      "Error: proxy mode (RLM_LLM_SUBCALL_VIA_PROXY) requires OPENAI_BASE_URL\n",
    );
    process.exit(1);
  }

  const messages: Array<{ role: string; content: string }> = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });

  try {
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: modelId, messages }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      process.stderr.write(`LLM API error (${resp.status}): ${text}\n`);
      process.exit(1);
    }

    const data = (await resp.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    const result =
      data.choices?.[0]?.message?.content || "(empty response)";
    process.stdout.write(result);
  } catch (err: any) {
    process.stderr.write(`LLM proxy call failed: ${err.message}\n`);
    process.exit(1);
  }
  process.exit(0);
}
// --- End proxy mode ---

const contextPath = process.env.RLM_LLM_CONTEXT;
if (!contextPath) {
  process.stderr.write(
    "Error: RLM_LLM_CONTEXT env var not set. Is the RLM plugin active?\n",
  );
  process.exit(1);
}

let ctx: LLMContext;
try {
  ctx = JSON.parse(readFileSync(contextPath, "utf-8"));
} catch (err: any) {
  process.stderr.write(
    `Error reading LLM context from ${contextPath}: ${err.message}\n`,
  );
  process.exit(1);
}

if (!ctx.apiKey) {
  process.stderr.write("Error: no API key found in LLM context\n");
  process.exit(1);
}

try {
  if (ctx.apiId.includes("anthropic")) {
    const body: Record<string, unknown> = {
      model: ctx.modelId,
      max_tokens: 16384,
      messages: [{ role: "user", content: prompt }],
    };
    if (system) {
      body.system = system;
    }

    const resp = await fetch(`${ctx.apiUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ctx.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      process.stderr.write(`LLM API error (${resp.status}): ${text}\n`);
      process.exit(1);
    }

    const data = (await resp.json()) as {
      content: Array<{ type: string; text?: string }>;
    };
    const result =
      data.content
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("") || "(empty response)";
    process.stdout.write(result);
  } else {
    // OpenAI-compatible
    const messages: Array<{ role: string; content: string }> = [];
    if (system) {
      messages.push({ role: "system", content: system });
    }
    messages.push({ role: "user", content: prompt });

    const resp = await fetch(`${ctx.apiUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ctx.apiKey}`,
      },
      body: JSON.stringify({
        model: ctx.modelId,
        messages,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      process.stderr.write(`LLM API error (${resp.status}): ${text}\n`);
      process.exit(1);
    }

    const data = (await resp.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    const result =
      data.choices?.[0]?.message?.content || "(empty response)";
    process.stdout.write(result);
  }
} catch (err: any) {
  process.stderr.write(`LLM call failed: ${err.message}\n`);
  process.exit(1);
}
