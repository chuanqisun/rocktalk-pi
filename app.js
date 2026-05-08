import { BehaviorSubject, concatMap, debounceTime, distinctUntilChanged, filter, from, map, merge, of, share, tap, withLatestFrom } from "rxjs";
import Rc522 from "./lib/rc522.js";

const reader = new Rc522({ block: 8, pollIntervalMs: 100 });

process.on("SIGINT", () => {
  console.log("\nExiting...");
  reader.close();
  process.exit(0);
});

async function* infiniteRead() {
  while (true) {
    try {
      yield reader.readAsync();
    } catch (error) {
      // The chip might be approaching or leaving the reader's field. It's not a fatal error
    }
  }
}

const state$ = new BehaviorSubject({ uid: "", state: "idle" });

const rawInput$ = from(infiniteRead()).pipe(share());

const idChange = from(rawInput$).pipe(
  map((result) => result.uid),
  distinctUntilChanged(),
  map((uid) => ({ type: "idChange", uid })),
  tap((event) => console.log(`[id changed] ${event.uid}.`))
);

const detach$ = from(rawInput$).pipe(
  debounceTime(220),
  withLatestFrom(idChange),
  map(([_, identity]) => ({ type: "detach", uid: identity.uid })),
  tap((event) => console.log(`[detached] ${event.uid}.`))
);

const read$ = from(rawInput$).pipe(concatMap((result) => of({ type: "read", ...result })));

const startPlay$ = read$.pipe(
  withLatestFrom(state$),
  filter(([_, state]) => state.state === "idle"),
  tap(([event, _]) => state$.next({ uid: event.uid, state: "playing" })),
  tap(([event, _]) => console.log(`[playing] ${event.uid}...`))
);

const stopPlay$ = merge(idChange, detach$).pipe(
  withLatestFrom(state$),
  filter(([_, state]) => state.state === "playing"),
  tap(([event, _state]) => state$.next({ uid: event.uid, state: "idle" })),
  tap(([event, _]) => console.log(`[stopped] ${event.uid}.`))
);

merge(startPlay$, stopPlay$).subscribe();
