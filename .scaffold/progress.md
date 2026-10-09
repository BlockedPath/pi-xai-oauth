# Execution Progress — v1.7.0 release with Pi 1.1 support

**Branch:** `feature/pi-1.1-release-1.7.0` (from `main` @ 5d60258)

- [x] Pi 1.1.0 review: release notes are additive for extensions (tool-render `durationMs`/`outputPad`, `agent_settled.aborted`, OSC 7501 status); the extension uses none of the changed surfaces. Packed candidate run passed (1095 tests, loader, CLI, typecheck).
- [x] Widened the 1.x peer interval to `>=1.0.0 <1.2.0`; `latest` and exact dev dependencies at 1.1.0; upper sentinel 1.2.0; policy test cases updated.
- [x] `npm audit fix` (lockfile only, dev tree): brace-expansion 5.0.9 -> 5.0.12, source-map-js 1.2.1 -> 1.2.2; `npm audit` reports 0 vulnerabilities. Supersedes Dependabot #236.
- [x] Version 1.7.0 in package.json and lockfile; CHANGELOG Unreleased dated as 1.7.0; README release banner, compatibility, and updating sections.
- [ ] After merge: publish a GitHub Release tagged `v1.7.0` on main; `publish.yml` runs only on `release: published`.

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
- [x] Voice chat duplicate captions (user report: "it sends the voice to text multiple copies"): xAI resends cumulative input-transcription snapshots per item (OpenClaw `realtime-voice-events.ts`), so user captions are keyed by `item_id` or speech turn and revised in place; duplicate assistant finals and late output from finished/cancelled responses are dropped. Regression test fails on the previous code.
- [x] Voice chat replies cut off at the end (user report): system players read stdin in whole blocks (SoX ~170 ms, aplay one period), holding a reply's last syllables until the next reply. Each finished reply that produced audio is followed by 400 ms of silence, counted in the half-duplex playback estimate; interrupted replies are not flushed. Verified the holdback and flush with a real ffmpeg pipe reader.
- [x] Voice chat slow on AirPods (user report): opening the headset microphone switches Bluetooth to the hands-free profile at a lower rate, and a player opened before that (SoX on macOS writes the device's original format) plays slowly. The startup probe player is released once the microphone is on and every reply gets a fresh player whose stdin is ended when the reply finishes, so it opens at the current rate and drains its last block at EOF (replacing the silence pad). README troubleshooting suggests the built-in microphone for full-quality headset output.
- [x] Voice chat still cut off early (user report, AirPods, right earbud only): audio arriving after `response.done` is now played (only cancelled replies, including a finished reply interrupted while playing, drop audio, and trailing audio no longer reopens the reply); a reply's player closes only after 300 ms without audio and 400 ms of trailing silence, since closing a Bluetooth stream can drop queued audio; half-duplex also mutes the microphone while a response is active. One-earbud mono playback is the headset's hands-free profile; README recommends the built-in microphone.
- [x] Voice chat breaking up / stopping mid-reply on AirPods and built-in speakers (user report): root cause was SoX, not the stream or Bluetooth. Node feeds child stdin through a UNIX socket; SoX sizes raw input with `st_mode & S_IFREG` (true for sockets) and macOS `fstat` on a socket reports only the currently buffered bytes, so a player spawned with audio already queued (every reply since the fresh-player change) played ~1.4 s and exited 0, and the next chunk respawned a player that did the same. `--ignore-length` on the SoX player fixes it. Measured live: xAI delivers reply audio 7–8× real time in ~2 s deltas with clean PCM; with the fix a scripted-mic `XaiTalkSession` run used one player per reply that lived for the full reply (38.4 s for 37.7 s of audio) instead of ~2 s. `ffplay` is unaffected. The earlier "cut off early" fixes were partly chasing this bug.
- [x] macOS temp-path test failures (branch `fix/macos-tmpdir-realpath`): `os.tmpdir()` is under `/var` -> `/private/var`, and `resolveNpmCli` and session output storage deliberately return real paths (symlink resolution and containment), so 3 `npm-command` and 2 `speech` tests failed locally. The two suites now realpath their temp roots; production and assertions unchanged. `npm test`, `npm run typecheck`, and `npm run compatibility:boundaries` (Pi 0.80.1 and 1.0.4) pass on macOS.

## Notes

- Local npm 10.9.4 crashes in arborist (`edgesOut`) during the packed boundary install; run boundaries with CI's npm 11.6.2 via `npm_execpath`.
- Live microphone capture and live xAI voice requests were not exercised (no audio device or credentials in the container).

## Follow-ups

- Optional voice-chat tools that hand requests to the Pi agent and speak its results.
- Optional read-aloud of assistant replies via TTS plus a local audio player.
