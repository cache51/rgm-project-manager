/**
 * Translation providers.
 *
 * `runBugTranslations` only needs `{ name, model, translate({text, from, to, glossary}) }`,
 * so a real service plugs into the same seam the stub does. Two are implemented:
 *
 *   OpenAiCompatibleProvider  any /v1/chat/completions server (OpenAI, Together,
 *                             Groq, a local llama.cpp) — uses the glossary in the
 *                             prompt, which is what makes garment terminology
 *                             survive
 *   DeepLProvider             DeepL's /v2/translate — the glossary is a DeepL
 *                             glossary ID rather than inline text, so it is passed
 *                             through as `glossary_id` and omitted when unset
 *
 * Both throw on a non-2xx response with the provider's own message attached; the
 * worker records that per language, so one failing language does not stop the
 * others and the developer is told which one failed.
 */

/** The language names a model understands, and the codes a service needs. */
const LLM_LANGUAGE = { vi: 'Vietnamese', zh: 'Traditional Chinese', en: 'English' };
const DEEPL_LANGUAGE = { vi: 'VI', zh: 'ZH-HANT', en: 'EN-US' };

export function buildTranslationPrompt({ text, from, to, glossary }) {
  const target = LLM_LANGUAGE[to] ?? to;
  const source = LLM_LANGUAGE[from] ?? from;
  const lines = [
    `Translate the following ${source} software bug report into ${target}.`,
    '',
    'Rules:',
    `- Output ONLY the ${target} translation. No preamble, no notes, no quotes.`,
    '- Preserve line breaks, numbers, units and product codes exactly.',
    // The glossaries exist because generic MT mangles this domain: a "carton" is
    // a shipping carton, not a cardboard box in the abstract.
    '- Use this glossary for domain terms, which overrides your own preference:'
  ];
  const terms = Object.entries(glossary ?? {});
  lines.push(...(terms.length
    ? terms.map(([term, vi]) => `    ${term} => ${vi}`)
    : ['    (none supplied)']));
  lines.push('', 'Text to translate:', '<<<TEXT>>>', text, '<<<END TEXT>>>');
  return lines.join('\n');
}

export function OpenAiCompatibleProvider({
  baseUrl,
  apiKey,
  model = 'gpt-4o-mini',
  path = '/v1/chat/completions',
  fetchImpl = fetch,
  temperature = 0,
  // Extra fields for the request body — server-side knobs that are not part of
  // the OpenAI schema and differ per deployment (vLLM's chat_template_kwargs to
  // switch a reasoning model's thinking off, guided decoding, and so on). They
  // are merged before `messages`, so they can never displace the text we send.
  extraBody = {},
  // No response is worth waiting for indefinitely: a provider that never answers
  // holds the worker's single queue. Matches the SMTP mailer's own default of
  // bounding a network call.
  timeoutMs = 120000,
  headers: extraHeaders = {}
}) {
  if (!baseUrl) throw new Error('OpenAiCompatibleProvider needs a baseUrl');

  return {
    name: 'openai-compatible',
    model,
    // Exposed for the same reason SmtpMailer exposes `requireTls`: a setting that
    // silently fails to reach the request is a configuration bug nobody sees, so
    // the contract has to be assertable.
    extraBody,
    timeoutMs,

    async translate({ text, from = 'vi', to, glossary }) {
      const res = await fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}${path}`, {
        method: 'POST',
        signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          ...extraHeaders
        },
        body: JSON.stringify({
          model,
          temperature,
          ...extraBody,
          // One user message: the text is delimited inside it, so the model is not
          // given a separate "system" slot an injected payload could try to fill.
          messages: [{ role: 'user', content: buildTranslationPrompt({ text, from, to, glossary }) }]
        })
      });

      if (!res.ok) {
        throw new Error(`translation provider ${res.status}: ${await res.text().catch(() => '')}`.slice(0, 500));
      }

      const body = await res.json();
      const content = body?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        throw new Error('translation provider returned no content');
      }
      return content.trim();
    }
  };
}

export function DeepLProvider({
  endpoint = 'https://api-free.deepl.com/v2/translate',
  apiKey,
  fetchImpl = fetch,
  glossaryIds = {}
}) {
  if (!apiKey) throw new Error('DeepLProvider needs an apiKey');

  const name = 'deepl';
  return {
    name,
    model: 'deepl',

    async translate({ text, from = 'vi', to, glossaryId }) {
      const target = DEEPL_LANGUAGE[to] ?? to;
      const source = DEEPL_LANGUAGE[from] ?? from;
      const id = glossaryId ?? glossaryIds[to];

      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `DeepL-Auth-Key ${apiKey}`
        },
        body: JSON.stringify({
          text: [text],
          source_lang: source,
          target_lang: target,
          ...(id ? { glossary_id: id } : {})
        })
      });

      if (!res.ok) {
        throw new Error(`deepl ${res.status}: ${await res.text().catch(() => '')}`.slice(0, 500));
      }

      const body = await res.json();
      const translated = body?.translations?.[0]?.text;
      if (typeof translated !== 'string') {
        throw new Error('deepl returned no translation');
      }
      return translated;
    }
  };
}

/**
 * Wrap a provider so one language's failure cannot take down the batch, and so a
 * retry is bounded. `runBugTranslations` already isolates failures per language;
 * this adds the transport-level retry that a flaky HTTP call deserves.
 */
export function withRetry(provider, { attempts = 3, delayMs = 250, sleep = null } = {}) {
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  return {
    ...provider,
    async translate(input) {
      let lastError;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          return await provider.translate(input);
        } catch (err) {
          lastError = err;
          // 4xx other than 429 will not improve on a retry.
          if (/\b(400|401|403|404|422)\b/.test(String(err.message))) break;
          if (attempt < attempts) await wait(delayMs * attempt);
        }
      }
      throw lastError;
    }
  };
}
