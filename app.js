import { concatMap, debounceTime, distinctUntilChanged, distinctUntilKeyChanged, from, map, merge, of, share, tap, withLatestFrom } from "rxjs";
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

let segment = 0;
const rawInput$ = from(infiniteRead()).pipe(share());

const idChange = from(rawInput$).pipe(
  map((result) => result.uid),
  distinctUntilChanged(),
  map((uid) => ({ type: "idChange", uid }))
);

const detach$ = from(rawInput$).pipe(
  debounceTime(220),
  withLatestFrom(idChange),
  map(([_, identity]) => ({ type: "detach", uid: identity.uid }))
);

const read$ = from(rawInput$).pipe(
  concatMap((result) => of({ type: "read", ...result, segment })),
  distinctUntilKeyChanged("segment")
);

const interrupt$ = merge(idChange, detach$).pipe(
  distinctUntilKeyChanged("uid"),
  map(({ uid }) => ({ type: "interrupt", uid, segment })),
  tap(() => segment++)
);

merge(read$, interrupt$).pipe(tap(console.log)).subscribe();
