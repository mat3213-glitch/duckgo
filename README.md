# duckgo 🦆

**Duck.ai (DuckDuckGo AI Chat) → OpenAI-совместимый API.**

По аналогии с [kimi-free-api](https://github.com/LLM-Red-Team/kimi-free-api), [qwen-free-api](https://github.com/LLM-Red-Team/qwen-free-api) и [glm-free-api](https://github.com/LLM-Red-Team/glm-free-api): сервис захватывает токен сессии duck.ai и предоставляет стандартный OpenAI-совместимый интерфейс `POST /v1/chat/completions`.

## Как это работает

duck.ai не требует логина, но защищает чат анти-бот челленджем:

1. `GET /duckchat/v1/status` с заголовком `x-vqd-accept: 1` — сервер отвечает заголовком `x-vqd-hash-1`, внутри которого base64-кодированный обфусцированный JS.
2. Сервис исполняет этот JS в эмулированном браузерном окружении (jsdom + мок `navigator`), хеширует `client_hashes` через SHA-256 и собирает ответ обратно в base64.
3. Полученный «токен сессии» отправляется как заголовок `x-vqd-hash-1` в `POST /duckchat/v1/chat`.
4. Ответ апстрима — SSE-поток, который конвертируется в формат OpenAI (стрим или целиком).

При `418/429/400` токен автоматически захватывается заново и запрос повторяется.

## Возможности

- OpenAI-совместимые `/v1/chat/completions` (стрим и не-стрим) и `/v1/models`
- Автоматический захват и кеширование токена сессии (zero-config)
- Ручной режим: закрепите токен из своего браузера (как в kimi-free-api)
- Ротация токена при 418/429, единичный retry
- Защита своего сервиса ключом `TOKEN`
- Определение моделей: старые ID (`gpt-4o-mini`, `claude-3-haiku`, `llama-3.3-70b`, `mixtral-8x7b`, `o3-mini`) автоматически маппятся на актуальные модели duck.ai

## Быстрый старт

```bash
npm install
npm start
# [duckgo] listening on http://localhost:8080
```

### Примеры

```bash
# Список моделей
curl http://localhost:8080/v1/models

# Диалог (не-стрим)
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.6-luna",
    "messages": [{"role": "user", "content": "Reply PONG only"}]
  }'

# Диалог (стрим)
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.4-mini",
    "messages": [{"role": "user", "content": "Привет!"}],
    "stream": true
  }'
```

Работает с любым OpenAI-совместимым клиентом:

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8080/v1", api_key="anything")
resp = client.chat.completions.create(
    model="gpt-5.6-luna",
    messages=[{"role": "user", "content": "Привет!"}],
)
print(resp.choices[0].message.content)
```

## Захват токена сессии вручную

Если авто-захват временно не работает (DuckDuckGo изменил челлендж), можно закрепить токен из своего браузера:

1. Откройте [duck.ai](https://duck.ai) и отправьте любое сообщение.
2. DevTools → Network → найдите запрос `chat` к `/duckchat/v1/chat`.
3. Скопируйте значение заголовка запроса `x-vqd-hash-1`.
4. Закрепите его одним из способов:

```bash
# через переменную окружения
DUCK_HASH="<скопированное значение>" npm start

# или во время работы сервиса
curl -X POST http://localhost:8080/token \
  -H "Content-Type: application/json" \
  -d '{"hash": "<скопированное значение>"}'

# проверить текущий статус токена
curl http://localhost:8080/token
```

Захваченный вручную токен живёт ограниченное время — при ошибке `429` обновите его тем же способом (или уберите закрепление, чтобы вернуться к авто-режиму: `POST /token` с телом `{}`).

## Переменные окружения

| Переменная | Описание | По умолчанию |
| --- | --- | --- |
| `PORT` | Порт HTTP-сервера | `8080` |
| `BASE_URL` | Апстрим (можно свой реверс-прокси) | `https://duck.ai` |
| `TOKEN` | Ключ доступа к сервису (Bearer). Пусто = без авторизации | — |
| `DUCK_HASH` | Закреплённый токен сессии (`x-vqd-hash-1`) | авто-захват |
| `FE_VERSION` | Версия фронтенда для `x-fe-version` | авто (с duck.ai) |
| `DEFAULT_MODEL` | Модель, если модель из запроса неизвестна | `gpt-5.6-luna` |
| `USER_AGENT` | User-Agent для апстрима | Chrome 138 |

## Модели

| ID | Источник |
| --- | --- |
| `gpt-5.6-luna` | OpenAI |
| `gpt-5.4-mini` | OpenAI |
| `gpt-5.4-nano` | OpenAI |
| `claude-haiku-4-5` | Anthropic |
| `mistral-small-4` / `mistral-small` | Mistral AI |
| `gpt-oss-120B` / `tinfoil/gpt-oss-120b` | OpenAI |
| `gemma-4-31B` | Google |

Актуальный список моделей может меняться на стороне duck.ai — код маппинга старых ID хранится в `src/models.js`.

## Docker

```bash
docker compose up -d
# или
docker run -d -p 8080:8080 -e TOKEN=mysecret duckgo
```

## Важно

- Проект **для обучения и исследований**. Использование неофициального API может нарушать [Terms of Service DuckDuckGo](https://duckduckgo.com/terms) — используйте на свой риск и в разумных пределах.
- duck.ai ограничивает частоту запросов по IP и отпечатку (`429 ERR_RATE_LIMIT`). С датацентровых IP/VPN лимиты заметно жёстче, чем с домашних. При регулярных `429` просто подождите — окно сброса ограничено по времени.
- Токен сессии привязан к окружению (User-Agent и др.). Меняйте `USER_AGENT`, если сервис за прокси/облаком блокируется. Сервер принимает отпечатки только популярных реальных браузеров — слишком новый/нестандартный UA даст `400 ERR_BAD_REQUEST`.
- Не публикуйте свои `DUCK_HASH`/`TOKEN` в открытых репозиториях (`.env` в `.gitignore`).
- Включите `DUCKGO_DEBUG=1` для логирования сырых значений челленджа при отладке.

## Благодарности

Алгоритм обхода динамического JS-челленджа основан на исследовании [nekohy/duck2api](https://github.com/nekohy/duck2api), протокольные заметки — [benoitpetit/duckduckgo-chat-cli](https://github.com/benoitpetit/duckduckgo-chat-cli).

## License

[MIT](./LICENSE)
