-- =====================================================================
-- 010: pulihkan tipe konfigurasi yang sempat tertimpa 'string' oleh
--      penyimpanan tanpa value_type (bug diperbaiki di repo Configs.Upsert).
-- =====================================================================
UPDATE app_configs SET value_type = 'secret' WHERE key LIKE 'ai.%.api_key' AND value_type <> 'secret';
UPDATE app_configs SET value_type = 'int'
 WHERE value_type = 'string' AND key IN ('app.map_zoom','auth.session_hours','auth.max_login_attempts','auth.captcha_ttl_seconds',
   'loading.tile_cache_ttl_seconds','loading.max_features_per_tile','loading.density_max_zoom','loading.density_refresh_seconds',
   'loading.max_bbox_features','loading.realtime_debounce_ms','trace.max_depth','trace.max_result_features','monitoring.interval_seconds',
   'monitoring.default_daya_va','monitoring.power_refresh_seconds','ai.max_tokens');
UPDATE app_configs SET value_type = 'float'
 WHERE value_type = 'string' AND key IN ('loading.simplify_tolerance_px','topology.snap_tolerance_m');
UPDATE app_configs SET value_type = 'bool'
 WHERE value_type = 'string' AND key IN ('topology.auto_split_edges','topology.auto_junction','app.basemap_dark_invert');
