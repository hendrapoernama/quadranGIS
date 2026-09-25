-- =====================================================================
-- 009: menu AI Assistant (LLM: Claude, ChatGPT, Kimi, OpenRouter).
--      API key disimpan sebagai konfigurasi bertipe 'secret': tidak pernah
--      dikirim ke klien, dan nilai kosong saat simpan tidak menimpa kunci lama.
-- =====================================================================
UPDATE roles SET permissions = permissions || '["ai.use"]'::jsonb
 WHERE name IN ('admin','editor','viewer') AND NOT permissions ? 'ai.use';

INSERT INTO menus (id, parent_id, title, title_en, path, icon, sort_order) VALUES
 ('a0000000-0000-0000-0000-000000000010', NULL, 'AI Assistant', 'AI Assistant', '/ai', 'sparkles', 30)
ON CONFLICT (id) DO NOTHING;
INSERT INTO role_menus (role_id, menu_id)
SELECT r.id, 'a0000000-0000-0000-0000-000000000010' FROM roles r WHERE r.name IN ('admin','editor','viewer')
ON CONFLICT DO NOTHING;

INSERT INTO app_configs (key, value, value_type, "group", description) VALUES
 ('ai.default_provider',     'anthropic', 'string', 'ai', 'Penyedia AI bawaan: anthropic | openai | kimi | openrouter'),
 ('ai.max_tokens',           '2048',      'int',    'ai', 'Batas token jawaban AI'),
 ('ai.system_prompt',        '',          'string', 'ai', 'Instruksi tambahan untuk asisten AI (opsional)'),
 ('ai.anthropic.api_key',    '',          'secret', 'ai', 'API key Anthropic (Claude)'),
 ('ai.anthropic.model',      'claude-sonnet-5', 'string', 'ai', 'Model Claude'),
 ('ai.anthropic.base_url',   'https://api.anthropic.com', 'string', 'ai', 'URL API Anthropic'),
 ('ai.openai.api_key',       '',          'secret', 'ai', 'API key OpenAI (ChatGPT)'),
 ('ai.openai.model',         'gpt-5-mini', 'string', 'ai', 'Model ChatGPT'),
 ('ai.openai.base_url',      'https://api.openai.com/v1', 'string', 'ai', 'URL API OpenAI'),
 ('ai.kimi.api_key',         '',          'secret', 'ai', 'API key Moonshot AI (Kimi)'),
 ('ai.kimi.model',           'kimi-k2-0905-preview', 'string', 'ai', 'Model Kimi'),
 ('ai.kimi.base_url',        'https://api.moonshot.ai/v1', 'string', 'ai', 'URL API Moonshot (api.moonshot.cn untuk wilayah Tiongkok)'),
 ('ai.openrouter.api_key',   '',          'secret', 'ai', 'API key OpenRouter'),
 ('ai.openrouter.model',     'openrouter/auto', 'string', 'ai', 'Model OpenRouter (mis. anthropic/claude-sonnet-4.5)'),
 ('ai.openrouter.base_url',  'https://openrouter.ai/api/v1', 'string', 'ai', 'URL API OpenRouter')
ON CONFLICT (key) DO NOTHING;
