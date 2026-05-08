import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BehaviorSubject, concatMap, debounceTime, distinctUntilChanged, filter, from, map, merge, of, share, tap, withLatestFrom } from "rxjs";
import AudioPlayer from "./lib/audio-player.js";
import Rc522 from "./lib/rc522.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const audioPlayer = new AudioPlayer({ baseDir: resolve(__dirname, "tracks") });
const reader = new Rc522({ block: 8, pollIntervalMs: 80 });

process.on("SIGINT", () => {
  console.log("\nExiting...");
  audioPlayer.stop();
  reader.close();
  process.exit(0);
});

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
  map(([event]) => ({
    type: "start",
    uid: event.uid,
    data: event.text,
  }))
);

const hopSwap$ = idChange$.pipe(
  withLatestFrom(state$),
  filter(([idChange, state]) => state.state === "playing" && state.uid !== idChange.uid),
  tap(() => state$.next({ uid: "", state: "idle" })),
  tap(([_, state]) => console.log(`[stopped] ${state.uid}.`)),
  map(() => ({ type: "stop" }))
);

const stopPlay$ = detach$.pipe(
  withLatestFrom(state$),
  filter(([detach, state]) => state.state === "playing" && detach.uid === state.uid),
  tap(() => state$.next({ uid: "", state: "idle" })),
  tap(([_, state]) => console.log(`[stopped] ${state.uid}.`)),
  map(() => ({ type: "stop" }))
);

/**
 * @param {{ type: "start", uid: string, data: string } | { type: "stop" }} event
 */
async function handlePlaybackEvent(event) {
  console.log(`[event] ${JSON.stringify(event)}`);

  if (event.type === "start") {
    await audioPlayer.play(event.data);
    return;
  }

  audioPlayer.stop();
}

merge(startPlay$, hopSwap$, stopPlay$)
  .pipe(
    concatMap((event) => from(handlePlaybackEvent(event.type === "start" ? event : { type: "stop" })))
  )
  .subscribe();
