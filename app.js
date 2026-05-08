import { concatMap, debounceTime, from, map, of, share, tap } from "rxjs";
import Rc522 from "./lib/rc522.js";

const reader = new Rc522({ block: 8, pollIntervalMs: 100 });
const args = process.argv.slice(2);
const [command, ...commandArgs] = args;
const isWriteMode = command === "write";

if (command && !isWriteMode) {
  console.error("Usage: node 300-read-write.js [write <content>]");
  process.exit(1);
}

const writeContent = isWriteMode ? commandArgs.join(" ").trim() : "";

if (isWriteMode && !writeContent) {
  console.error("Usage: node 300-read-write.js write <content>");
  process.exit(1);
}

function logResult(result) {
  console.log("");
  console.log(`Card UID: ${result.uid}`);
  console.log(`Selected tag size/code: ${result.size}`);
  console.log(
    `Block ${result.block} raw:  ${result.data
      .toString("hex")
      .match(/.{1,2}/g)
      .join(":")}`
  );
  console.log(`Block ${result.block} text: "${result.text}"`);
}

console.log(isWriteMode ? `Hold a MIFARE Classic tag near the reader to write \"${writeContent}\"...` : "Hold a MIFARE Classic tag near the reader...");

process.on("SIGINT", () => {
  console.log("\nExiting...");
  reader.close();
  process.exit(0);
});

async function* infinite() {
  while (true) yield true;
}

async function* infiniteRead() {
  while (true) {
    try {
      yield reader.readAsync();
    } catch (error) {
      // The chip might be approaching or leaving the reader's field. It's not a fatal error
    }
  }
}

const read$ = from(infiniteRead()).pipe(share());
const detach$ = from(read$).pipe(
  debounceTime(220),
  map(() => ({ type: "detach" }))
);

const identify$ = from(read$).pipe(concatMap((result) => of({ type: "read", ...result })));

const uidChange$ = from(read$).pipe(
  map((result) => result.uid),
  distinctUntilChanged()
);

merge(identify$, detach$).pipe(tap(console.log)).subscribe();
