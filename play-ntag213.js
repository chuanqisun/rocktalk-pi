import { cancel, intro, isCancel, outro, select } from "@clack/prompts";
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BehaviorSubject, concatMap, debounceTime, distinctUntilChanged, filter, from, map, merge, of, share, tap, withLatestFrom } from "rxjs";
import AudioPlayer from "./lib/audio-player.js";
import Rc522 from "./lib/rc522-ntag213.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
const READER_POLL_INTERVAL_MS = 80;

// NTAG213 user memory pages are 4..39. Keep playback aligned with the writer:
// pages 4..11 = 32 bytes of UTF-8 text capacity.
const TEXT_START_PAGE = 4;
const TEXT_PAGE_COUNT = 8;
const TEXT_PAGES = Array.from({ length: TEXT_PAGE_COUNT }, (_, index) => TEXT_START_PAGE + index);

const reader = new Rc522({
  block: TEXT_START_PAGE,
  blocks: TEXT_PAGES,
  pollIntervalMs: READER_POLL_INTERVAL_MS,
});

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
      cardId: cardId.trim(),
      deviceId: deviceId.trim(),
      value: `plughw:${cardNumber},${deviceNumber}`,
      label: `${cardName.trim()} / ${deviceName.trim()}`,
      hint: `card ${cardNumber} (${cardId.trim()}), device ${deviceNumber} (${deviceId.trim()})`,
    });
  }

  return devices;
}

async function getAudioDevices() {
  const { stdout } = await execFileAsync("aplay", ["-l"]);
  const devices = parseAlsaDevices(stdout);

  if (devices.length === 0) {
    throw new Error("No ALSA playback devices were reported by aplay -l.");
  }

  return devices;
}

function parseCliAudioDevice(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg !== "-a") {
      continue;
    }

    const value = argv[index + 1];

    if (!value || value.startsWith("-")) {
      throw new Error("Missing value for -a. Expected an ALSA device such as plughw:2,0.");
    }

    return value;
  }

  return null;
}

async function promptForAudioDevice() {
  const devices = await getAudioDevices();

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
      yield reader.readTextAsync({ blocks: TEXT_PAGES });
    } catch (error) {
      // The chip might be approaching or leaving the reader's field. It's not a fatal error
    }

    await delay(READER_POLL_INTERVAL_MS);
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
    await audioPlayer.play(event.data);
    return;
  }

  audioPlayer.stop();
}

async function main() {
  const requestedDevice = parseCliAudioDevice(process.argv.slice(2));
  const useInteractivePrompt = requestedDevice === null;

  if (useInteractivePrompt) {
    intro("Rock Talk player");
  }

  const selectedDevice = requestedDevice ?? (await promptForAudioDevice());

  if (!selectedDevice) {
    reader.close();

    if (useInteractivePrompt) {
      outro("Rock Talk player cancelled");
    }

    return;
  }

  const audioPlayer = new AudioPlayer({
    baseDir: resolve(__dirname, "tracks"),
    device: selectedDevice,
    loop: true,
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

  if (useInteractivePrompt) {
    outro(`Using audio device ${selectedDevice} with looping`);
    return;
  }

  console.log(`Using audio device ${selectedDevice} with looping`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  const useInteractivePrompt = parseCliAudioDevice(process.argv.slice(2)) === null;

  if (useInteractivePrompt) {
    cancel(message);
  } else {
    console.error(message);
  }

  reader.close();
  process.exitCode = 1;
});
