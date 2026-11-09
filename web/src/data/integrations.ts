// How each tool talks to the router. Taken from the README and `orrery connect`; Codex, Claude Code and the MCP server
// are also exercised in the rehearsal (node/devtools/e2e.ts).

export type Integration = { id: string; name: string; kind: string; rehearsed?: boolean; steps: string[]; code: string; lang: string };

export const ROUTER_CMD = 'npx -y orrery-node router --wallet ~/.config/solana/id.json';

export const INTEGRATIONS: Integration[] = [
  {
    id: 'python', name: 'OpenAI Python', kind: 'SDK',
    steps: ['Point the SDK at your router. Any API key works.', 'Add :cheap, :fast, :trusted or :private to a model name to pick the route.'],
    lang: 'python',
    code: `from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:7171/v1", api_key="unused")
reply = client.chat.completions.create(
    model="llama-3.3-70b:cheap",
    messages=[{"role": "user", "content": "Hello from the network"}],
)
print(reply.choices[0].message.content)
print(reply.usage)  # tokens, and cost: what this answer cost in USDC`,
  },
  {
    id: 'typescript', name: 'OpenAI TypeScript', kind: 'SDK',
    steps: ['Same client, streaming. The stream ends with the billed usage when you ask for it.'],
    lang: 'ts',
    code: `import OpenAI from 'openai';

const client = new OpenAI({ baseURL: 'http://127.0.0.1:7171/v1', apiKey: 'unused' });
const stream = await client.chat.completions.create({
  model: 'deepseek-v3:fast',
  stream: true,
  stream_options: { include_usage: true },
  messages: [{ role: 'user', content: 'Explain payment channels in two lines' }],
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? '');`,
  },
  {
    id: 'curl', name: 'curl', kind: 'HTTP',
    steps: ['Every answer says who served it and what you paid, in headers and in usage.cost.'],
    lang: 'bash',
    code: `curl http://127.0.0.1:7171/v1/chat/completions -i \\
  -H 'content-type: application/json' \\
  -d '{"model":"gpt-oss-120b:cheap","messages":[{"role":"user","content":"hi"}]}'

x-orrery-provider: 76Udba…
x-orrery-route: price
x-orrery-cost: 0.000018`,
  },
  {
    id: 'codex', name: 'Codex CLI', kind: 'Coding agent', rehearsed: true,
    steps: ['One command writes a profile next to your own config and leaves config.toml alone.', 'Codex speaks the Responses API; the router serves it.'],
    lang: 'bash',
    code: `orrery connect codex --write   # writes ~/.codex/orrery.config.toml
codex --profile orrery`,
  },
  {
    id: 'claude-code', name: 'Claude Code', kind: 'Coding agent', rehearsed: true,
    steps: ['Start the router with an alias so Claude Code’s model names are answered by a network model.', 'Then two variables point Claude Code at it.'],
    lang: 'bash',
    code: `orrery router --wallet ~/.config/solana/id.json --alias 'claude-*=gpt-oss-120b'

ANTHROPIC_BASE_URL=http://127.0.0.1:7171 ANTHROPIC_API_KEY=orrery claude`,
  },
  {
    id: 'mcp', name: 'MCP server', kind: 'Agents', rehearsed: true,
    steps: ['Tools for any MCP client: ask, embed, quote, models and status.', 'quote prices a job at every node before the agent spends on it.'],
    lang: 'bash',
    code: `claude mcp add orrery -- npx -y orrery-node mcp --router http://127.0.0.1:7171

# any other MCP client: run
npx -y orrery-node mcp --router http://127.0.0.1:7171`,
  },
  {
    id: 'cursor', name: 'Cursor', kind: 'Editor',
    steps: ['Settings → Models → OpenAI API key: any string.', 'Override OpenAI Base URL: http://127.0.0.1:7171/v1, then add a model such as llama-3.3-70b:cheap.'],
    lang: 'text',
    code: `OpenAI API Key:            unused
Override OpenAI Base URL:  http://127.0.0.1:7171/v1
Model:                     llama-3.3-70b:cheap`,
  },
  {
    id: 'continue', name: 'Continue', kind: 'Editor',
    steps: ['A model with provider openai and your router as the base.'],
    lang: 'yaml',
    code: `models:
  - name: Orrery deepseek
    provider: openai
    apiBase: http://127.0.0.1:7171/v1
    apiKey: unused
    model: deepseek-v3`,
  },
  {
    id: 'aider', name: 'Aider', kind: 'Coding agent',
    steps: ['One environment variable and an openai/ model name.'],
    lang: 'bash',
    code: `OPENAI_API_BASE=http://127.0.0.1:7171/v1 aider --model openai/llama-3.3-70b:cheap`,
  },
  {
    id: 'open-webui', name: 'Open WebUI', kind: 'Chat app',
    steps: ['Admin → Connections → OpenAI API.', 'Every network model shows up in the model list.'],
    lang: 'text',
    code: `URL:  http://127.0.0.1:7171/v1
Key:  any`,
  },
  {
    id: 'langchain', name: 'LangChain', kind: 'Framework',
    steps: ['ChatOpenAI with the router as base_url.'],
    lang: 'python',
    code: `from langchain_openai import ChatOpenAI

llm = ChatOpenAI(base_url="http://127.0.0.1:7171/v1", api_key="unused", model="qwen3-235b")
print(llm.invoke("Hello from the network").content)`,
  },
];
