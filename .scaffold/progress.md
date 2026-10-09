# Execution Progress — Grok voice

**Branch:** `feature/grok-voice` (from `main` @ 1aa4676)

## Completed

- [x] Researched evidence: Grok Build `xai-grok-voice` (streaming STT at `api.x.ai/v1/stt`, OAuth + API-key bearers accepted, Linux recorder walk, 20 MiB clip cap, 25-language catalog) and `@ai-sdk/xai` 5.0.20 (TTS `POST /v1/tts` JSON, batch STT `POST /v1/stt` multipart, voices eve/ara/rex/sal/leo).
- [x] Shared primitives: pinned TTS/STT routes, voice header contracts, `readBoundedResponseBytes` (shared streaming core with the text reader), generic `readBoundedWorkspaceFile` (image reader delegates with identical messages), session `audio/` output root.
- [x] `extensions/xai/voice/`: audio sniffing/WAV/silence, TTS client with byte verification and private storage, STT client and workspace-file transcription, system recorder walk, `/xai-voice` + Ctrl+Space/F8 dictation (TUI overlay, RPC select, session language, reset on session start/shutdown).
- [x] Opt-in `xai_text_to_speech` and `xai_transcribe_audio` tools in `/xai-tools`.
- [x] Tests: `tests/voice/*` (audio, speech, transcription, recorder incl. real subprocess, dictation), `tests/tools/custom-tools-voice.test.ts`, updated registration/routing/commands/custom-tools tables, loader smoke asserts tools/command/shortcuts.
- [x] `npm test` (69 files / 1004 tests + loader + CLI), `npm run typecheck`, coverage above all floors, pack and GitHub-mirror checks.
- [x] README, CHANGELOG (Unreleased), AGENTS.md, wire-protocol matrix.
- [x] Live voice (user request: "it will also be through oauth / there is also live voice"): live dictation is the default and streams to `wss://api.x.ai/v1/stt` with the OAuth bearer on the WebSocket handshake (Node's built-in WebSocket sends headers since undici 6.13), mirroring Grok Build's query, readiness, partial/final assembly, and `audio.done`; clip fallback on any stream failure; `/xai-voice clip` keeps audio local until Enter.
- [x] Independent review fixes: single recorder per trigger burst (slot claimed before awaits, generation guard on reset), second shortcut press stops dictation, wall-clock recorder cap, Kitty/modifyOtherKeys Ctrl+Space and F8 in the overlay with auto-repeat debounce, no insert after cancel or reset, RPC dialog dismissed via signal and RPC editor semantics documented, MP4/WebM sniffing limited to audio brands/doctype.

## Notes

- `node scripts/verify-compatibility.js registry` fails on `main` too: Pi 1.0.4 is published inside the supported range while `policy.latest` is 1.0.0. Reviewing and adopting 1.0.4 is a separate compatibility task.
- Local npm 10.9.4 crashes in arborist (`edgesOut`) during the packed boundary install; run boundaries with CI's npm 11.6.2 via `npm_execpath`.
- Live microphone capture and live xAI voice requests were not exercised (no audio device or credentials in the container).

## Follow-ups

- Optional Grok Voice Agent (speech-to-speech conversation over `wss://api.x.ai/v1/realtime`); OAuth acceptance on that route is not yet evidenced by Grok Build.
- Optional read-aloud of assistant replies via TTS plus a local audio player.
