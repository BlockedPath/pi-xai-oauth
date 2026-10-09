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

- [x] Talk-back voice chat (user request: "I want a feature for it to talk back to me ... through OAuth"): `/xai-talk` on `wss://api.x.ai/v1/realtime` with the OAuth bearer, following OpenClaw's OAuth-authenticated xAI realtime bridge; system audio player walk; non-retaining 24 kHz mic stream; half-duplex default, duplex barge-in with truncation, Space interrupt, captions, Enter inserts transcript, opt-in `context`.
- [x] Pi 1.0.4 review (PR #235 registry gate): 1.0.1–1.0.4 changelog needs no extension migration; packed candidate run passed (tests, loader, CLI, typecheck). `policy.latest`, exact dev dependencies, lockfile, policy test, README, and CHANGELOG moved to 1.0.4; peer range unchanged.

## Notes

- Local npm 10.9.4 crashes in arborist (`edgesOut`) during the packed boundary install; run boundaries with CI's npm 11.6.2 via `npm_execpath`.
- Live microphone capture and live xAI voice requests were not exercised (no audio device or credentials in the container).

## Follow-ups

- Optional voice-chat tools that hand requests to the Pi agent and speak its results.
- Optional read-aloud of assistant replies via TTS plus a local audio player.
