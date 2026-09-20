export const config = {
  port: parseInt(process.env.PORT || '8080', 10),
  baseUrl: (process.env.BASE_URL || 'https://duck.ai').replace(/\/+$/, ''),
  token: process.env.TOKEN || '',
  pinnedHash: process.env.DUCK_HASH || process.env.DUCK_TOKEN || '',
  feVersion: process.env.FE_VERSION || '',
  defaultModel: process.env.DEFAULT_MODEL || 'gpt-5.6-luna',
  userAgent:
    process.env.USER_AGENT ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
};
