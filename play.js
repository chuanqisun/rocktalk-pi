import { cancel, intro, isCancel, outro, select } from "@clack/prompts";
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BehaviorSubject, concatMap, debounceTime, distinctUntilChanged, filter, from, map, merge, of, share, tap, withLatestFrom } from "rxjs";
import AudioPlayer from "./lib/audio-player.js";
import Rc522 from "./lib/rc522.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
const reader = new Rc522({ block: 8, pollIntervalMs: 80 });

function createStartEvent(uid, data) {
  return /** @type {{ type: "start", uid: string, data: string }} */ ({ type: "start", uid, data });
}

function createStopEvent() {
  return /** @type {{ type: "stop" }} */ ({ type: "stop" });
}

function parseAlsaDevices(output) {
  const devices = [];
  const lines = output.split(/\r?\n/);

  for (const line of lines) {
    const match = line.match(/^card\s+(\d+):\s+([^\[]+)\[([^\]]+)\],\s+device\s+(\d+):\s+([^\[]+)\[([^\]]+)\]$/);

    if (!match) {
      continue;
    }

    const [, cardNumber, cardId, cardName, deviceNumber, deviceId, deviceName] = match;

    devices.push({
      value: `plughw:${cardNumber},${deviceNumber}`,
      label: `${cardName.trim()} / ${deviceName.trim()}`,
      hint: `card ${cardNumber} (${cardId.trim()}), device ${deviceNumber} (${deviceId.trim()})`,
    });
  }

  return devices;
}

async function promptForAudioDevice() {
  const { stdout } = await execFileAsync("aplay", ["-l"]);
  const devices = parseAlsaDevices(stdout);

  if (devices.length === 0) {
    throw new Error("No ALSA playback devices were reported by aplay -l.");
  }

  const selected = await select({
    message: "Choose an audio device.",
    options: devices,
  });

  if (isCancel(selected)) {
    return null;
  }

  return selected;
}

async function* infiniteRead() {
  while (true) {
    try {
      yield reader.readTextAsync();
    } catch (error) {
      // The chip might be approaching or leaving the reader's field. It's not a fatal error
    }
  }
}

const state$ = new BehaviorSubject({ uid: "", state: "idle" });

const rawInput$ = from(infiniteRead()).pipe(share());

const idChange$ = from(rawInput$).pipe(
  map((result) => result.uid),
  distinctUntilChanged(),
  map((uid) => ({ type: "idChange", uid })),
  tap((event) => console.log(`[id changed] ${event.uid}.`)),
  share()
);

const detach$ = from(rawInput$).pipe(
  debounceTime(100),
  withLatestFrom(idChange$),
  map(([_, identity]) => ({ type: "detach", uid: identity.uid })),
  tap((event) => console.log(`[detached] ${event.uid}.`))
);

const read$ = from(rawInput$).pipe(concatMap((result) => of({ type: "read", ...result })));

const startPlay$ = read$.pipe(
  withLatestFrom(state$),
  filter(([_, state]) => state.state === "idle"),
  tap(([event, _]) => state$.next({ uid: event.uid, state: "playing" })),
  tap(([event, _]) => console.log(`[playing] ${event.uid}...`)),
  map(([event]) => createStartEvent(event.uid, event.text))
);

const hopSwap$ = idChange$.pipe(
  withLatestFrom(state$),
  filter(([idChange, state]) => state.state === "playing" && state.uid !== idChange.uid),
  tap(() => state$.next({ uid: "", state: "idle" })),
  tap(([_, state]) => console.log(`[stopped] ${state.uid}.`)),
  map(() => createStopEvent())
);

const stopPlay$ = detach$.pipe(
  withLatestFrom(state$),
  filter(([detach, state]) => state.state === "playing" && detach.uid === state.uid),
  tap(() => state$.next({ uid: "", state: "idle" })),
  tap(([_, state]) => console.log(`[stopped] ${state.uid}.`)),
  map(() => createStopEvent())
);

/**
 * @param {{ type: "start", uid: string, data: string } | { type: "stop" }} event
 */
async function handlePlaybackEvent(audioPlayer, event) {
  console.log(`[event] ${JSON.stringify(event)}`);

  if (event.type === "start") {
    console.log("will start");
    await audioPlayer.play(event.data);
    console.log("did start");
    return;
  }

  audioPlayer.stop();
}

async function main() {
  intro("Rock Talk player");

  const selectedDevice = await promptForAudioDevice();

  if (!selectedDevice) {
    reader.close();
    outro("Rock Talk player cancelled");
    return;
  }

  const audioPlayer = new AudioPlayer({
    baseDir: resolve(__dirname, "tracks"),
    device: selectedDevice,
  });

  process.on("SIGINT", () => {
    console.log("\nExiting...");
    audioPlayer.stop();
    reader.close();
    process.exit(0);
  });

  merge(startPlay$, hopSwap$, stopPlay$)
    .pipe(concatMap((event) => from(handlePlaybackEvent(audioPlayer, event))))
    .subscribe();

  outro(`Using audio device ${selectedDevice}`);
}

main().catch((error) => {
  cancel(error instanceof Error ? error.message : String(error));
  reader.close();
  process.exitCode = 1;
});
