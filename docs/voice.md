# Voice input

`/voice` records your microphone and sends audio to Shisa's realtime speech recognition service. It previews transcription above the prompt, then inserts final text into the editor when you stop. **It never sends the prompt to the coding model automatically.**

## Setup

Set `SHISA_API_KEY` in the environment before starting Jouzu. The key must have `shisa/asr-realtime` access; chat or batch transcription access alone is not enough.

Capture uses the microphone on the machine running Jouzu. Over SSH, that is the remote machine, not your laptop. Allow microphone access for the terminal or Node.js when your operating system asks.

## Commands

| Command | Action |
| --- | --- |
| `/voice` | Start recording, or stop an active recording |
| `/voice start` | Start recording |
| `/voice stop` | Stop the microphone, wait for final transcription, and insert text |
| `/voice cancel` | Release the microphone and discard this recording's text |
| `/voice devices` | Choose a microphone on this machine |
| `/voice language auto` | Detect the spoken language (default) |
| `/voice language ja` | Japanese |
| `/voice language en` | English |
| `/voice language zh` | Chinese |

Device and language choices last until the session runtime is replaced or reloaded. Change them before recording. `/voice` requires an interactive terminal; it does not capture audio in print, JSON, or RPC mode.

You can keep editing while recording. On a successful stop, Jouzu pastes the final transcription at the current cursor, adding a newline first when the draft is nonempty. It does not restore an older draft or insert provisional text. Review the result before pressing Enter. If transcription is incomplete, finalized text is inserted with `[garbled]` in place of each unfinished or failed chunk. A startup failure with no transcript leaves the draft unchanged.

## Preview and finalization

The preview labels each speech chunk:

- **Live:** provisional text that may change.
- **Pending:** a later speech chunk has started, the service reported a stop, or you stopped recording; final text is still awaited.
- **Final:** text received in the service's final-result event.
- **Failed:** finalization failed or the connection ended before the chunk was finalized.

Final results replace the matching chunks using their identifiers and logical audio ranges. Earlier finalized text remains in the transcript while later chunks are processed. The widget shows the last six chunks and reports how many earlier chunks are retained; stop uses the full bounded transcript. Jouzu does not remove repeated words by comparing text across chunks.

Stopping inserts finalized text and `[garbled]` markers directly into the prompt, without a confirmation dialog. Provisional text is replaced by a marker, not treated as final. If the connection fails, Jouzu stops recording and inserts the available finalized text with markers for missing speech; an interrupted tail with no known unfinished chunk gets a trailing marker. Edit the prompt if needed, then press Enter to send.

## Optional shortcut

No shortcut is assigned by default. Set `jouzu.voice.toggle` to an unused modified key in Jouzu's `agent/keybindings.json`, then run `/reload`. For example, if `Alt+R` is free in your terminal and extensions:

```json
{
  "jouzu.voice.toggle": "alt+r"
}
```

The shortcut starts or stops recording just like `/voice`. Bare keys are ignored so they remain available for typing. `/voice cancel` is always the explicit discard route.

## Privacy and limits

- Audio is sent to `wss://api.shisa.ai/ws/asr/realtime` only after you start recording. The API key is sent in the authentication header, not in the URL or to the capture helper.
- Jouzu keeps audio in bounded memory and writes no recording files. Audio already sent to Shisa cannot be recalled by cancelling. Shisa's service policies apply to that data.
- Recording stops after ten minutes and attempts to finalize the transcript. Network connection and microphone startup each time out after ten seconds; final transcription times out after thirty seconds.
- A slow upload, oversized response, or transcript above the bounded text limit stops recording rather than accumulating audio indefinitely. Available finalized text is inserted with `[garbled]` markers after a failure.
- Reloading, switching sessions, or exiting releases the microphone and discards uninserted transcription.

## Platform checks

Capture uses PvRecorder 1.2.9 in a separate process so a blocking native read cannot freeze the editor. Its package includes binaries for Linux x64, macOS Intel and Apple Silicon, Windows x64 and ARM64, and specific Raspberry Pi targets. Generic Linux ARM compatibility is not guaranteed.

Protocol and process-lifecycle tests use a local service and a simulated capture helper. They do not establish real-microphone behavior or operating-system permission handling on macOS, Windows, or Linux. If capture fails, check `/voice devices`, microphone permissions, and the supported binary for your platform.
