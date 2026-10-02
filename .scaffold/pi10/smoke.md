# Live smoke — user's Pi 1.0.0, branch extension only (`pi --no-extensions -e ./extensions/xai-oauth.ts`)

- The stale `xai-auth` credential (expired 2026-09-04; refresh rejected with 400) was replaced by the user via `/login xai-auth` on Pi 1.0 with this branch's login flow. ✅
- Entitled catalog via `--list-models xai-auth`: grok-4.3, 4.5 (+4.5-latest), 4.6, 4.7, 4.7-build-fast, build-latest, composer-2.5-fast. All have a 256K context (authenticated bound). grok-4.7 uses conservative defaults (16.4K max output, text-only) because no known metadata exists yet (follow-up).
1. Plain turn on grok-4.6 → `SMOKE-OK-1` ✅
2. Tool turn (`read_file` → our Grok-native adapter) → `SMOKE-OK-2 1.5.1` ✅
3. Same-model continue without tools (history + encrypted reasoning replay) → `SMOKE-OK-3 1.5.1` ✅
4. Switch to grok-4.7 mid-session → `SMOKE-OK-4 1.5.1` ✅
5. grok-4.3 with `--thinking minimal` (clamped to low) → `SMOKE-OK-5` ✅
