export const MODELS = {
  'gpt-5.6-luna': { owner: 'openai', description: 'GPT-5.6 Luna' },
  'gpt-5.4-mini': { owner: 'openai', description: 'GPT-5.4 Mini' },
  'gpt-5.4-nano': { owner: 'openai', description: 'GPT-5.4 Nano' },
  'claude-haiku-4-5': { owner: 'anthropic', description: 'Claude Haiku 4.5' },
  'mistral-small-4': { owner: 'mistralai', description: 'Mistral Small 4' },
  'mistral-small': { owner: 'mistralai', description: 'Mistral Small' },
  'gpt-oss-120B': { owner: 'openai', description: 'GPT OSS 120B' },
  'tinfoil/gpt-oss-120b': { owner: 'openai', description: 'GPT OSS 120B (Tinfoil)' },
  'gemma-4-31B': { owner: 'google', description: 'Gemma 4 31B' },
};

const ALIASES = {
  'gpt-4o-mini': 'gpt-5.4-mini',
  'o3-mini': 'gpt-5.4-mini',
  'claude-3-haiku': 'claude-haiku-4-5',
  'claude-3-haiku-20240307': 'claude-haiku-4-5',
  'mistral-small-3': 'mistral-small-4',
  'mixtral-8x7b': 'mistral-small-4',
  'mistralai/Mixtral-8x7B-Instruct-v0.1': 'mistral-small-4',
  'llama-3.3-70b': 'gpt-oss-120B',
  'llama-3.1-70b': 'gpt-oss-120B',
  'meta-llama/Meta-Llama-3.3-70B-Instruct-Turbo': 'gpt-oss-120B',
  'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo': 'gpt-oss-120B',
  'gpt-5.4': 'gpt-5.6-luna',
};

export function resolveModel(name) {
  if (!name || typeof name !== 'string') return null;
  const requested = name.trim();
  if (MODELS[requested]) return requested;
  const alias = ALIASES[requested] || ALIASES[requested.toLowerCase()];
  if (alias && MODELS[alias]) return alias;
  return null;
}

export function listModels() {
  return Object.entries(MODELS).map(([id, meta]) => ({
    id,
    object: 'model',
    created: 1700000000,
    owned_by: meta.owner,
    description: meta.description,
  }));
}
