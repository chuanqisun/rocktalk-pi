import { cancel, intro, isCancel, log, outro, select } from "@clack/prompts";
import { readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { BehaviorSubject, debounceTime, filter, from, map, merge, share, tap, withLatestFrom } from "rxjs";
import Rc522 from "./lib/rc522.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRACKS_DIR = resolve(__dirname, "tracks");
const TEXT_BLOCKS = [8, 9, 10];
const SCAN_TIMEOUT_MS = 250;
const reader = new Rc522({ blocks: TEXT_BLOCKS, pollIntervalMs: 80 });
const CANCELLED = Symbol("cancelled");

function isTimeoutError(error) {
  return error instanceof Error && error.message === "Timed out waiting for RFID tag";
}

function formatData(value) {
  return value === "" ? "(empty string)" : value;
}

function cancelStep() {
  log.info("Step cancelled.");
}

async function promptSelect(message, options) {
  const value = await select({ message, options });

  if (isCancel(value)) {
    return CANCELLED;
  }

  return value;
}

async function listTracks() {
  const entries = await readdir(TRACKS_DIR, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

async function* infiniteReadText() {
  while (true) {
    try {
      yield reader.readTextAsync({ blocks: TEXT_BLOCKS, timeoutMs: SCAN_TIMEOUT_MS });
    } catch (error) {
      // Scan errors are expected while cards move through the reader field.
    }
  }
}

function createCancellationWatcher() {
  let cleanup = () => {};
  let cancelCurrentStep = () => {};

  const promise = new Promise((resolvePromise) => {
    cancelCurrentStep = () => resolvePromise(CANCELLED);
  });

  if (!process.stdin.isTTY) {
    return { promise, cleanup, cancel: cancelCurrentStep };
  }

  readline.emitKeypressEvents(process.stdin);
  process.stdin.resume();

  const shouldRestoreRawMode = !process.stdin.isRaw;

  if (shouldRestoreRawMode) {
    process.stdin.setRawMode(true);
  }

  const onKeypress = (input, key) => {
    if (key?.ctrl && key.name === "c") {
      cancelCurrentStep();
      return;
    }

    if (key?.name === "escape" || input?.toLowerCase() === "q") {
      cancelCurrentStep();
    }
  };

  process.stdin.on("keypress", onKeypress);

  cleanup = () => {
    process.stdin.off("keypress", onKeypress);

    if (shouldRestoreRawMode && process.stdin.isRaw) {
      process.stdin.setRawMode(false);
    }
  };

  return { promise, cleanup, cancel: cancelCurrentStep };
}

async function waitForCardAction(message, action) {
  log.step(`${message} Press Esc, q, or Ctrl+C to cancel.`);
  const cancellation = createCancellationWatcher();

  try {
    while (true) {
      try {
        const result = await Promise.race([action({ timeoutMs: SCAN_TIMEOUT_MS }), cancellation.promise]);

        if (result === CANCELLED) {
          cancelStep();
          return CANCELLED;
        }

        return result;
      } catch (error) {
        if (error === CANCELLED) {
          cancelStep();
          return CANCELLED;
        }

        if (isTimeoutError(error)) {
          continue;
        }

        throw error;
      }
    }
  } finally {
    cancellation.cleanup();
  }
}

async function programCard(text) {
  while (true) {
    try {
      const written = await waitForCardAction(`Tap and hold a card to write ${formatData(text)}.`, async ({ timeoutMs }) => {
        const writeResult = await reader.writeTextAsync(text, { blocks: TEXT_BLOCKS, timeoutMs });
        const readResult = await reader.readTextAsync({ blocks: TEXT_BLOCKS, timeoutMs });

        if (readResult.uid !== writeResult.uid || readResult.text !== text) {
          throw new Error(
            `Validation failed. Expected ${writeResult.uid} -> ${formatData(text)}, received ${readResult.uid} -> ${formatData(readResult.text)}.`
          );
        }

        return writeResult;
      });

      if (written === CANCELLED) {
        return;
      }

      log.success(`Wrote ${formatData(written.text)} to card ${written.uid}.`);
      return;
    } catch (error) {
      log.error(error instanceof Error ? error.message : String(error));
    }
  }
}

async function runAssignFlow() {
  const tracks = await listTracks();
  const selected = await promptSelect(
    "Choose a track to assign.",
    tracks.map((track) => ({ value: track, label: track }))
  );

  if (selected === CANCELLED) {
    cancelStep();
    return;
  }

  await programCard(selected);
}

async function runUnassignFlow() {
  await programCard("");
}

async function runTestScanFlow() {
  log.step("Test scan is running. Tap cards to inspect UID and stored data.");
  log.info("Press Esc, q, or Ctrl+C to stop test scan.");

  const cancellation = createCancellationWatcher();
  const state$ = new BehaviorSubject({ active: false });
  const rawInput$ = from(infiniteReadText()).pipe(share());
  const detach$ = rawInput$.pipe(
    debounceTime(100),
    tap(() => state$.next({ active: false }))
  );
  const scan$ = rawInput$.pipe(
    withLatestFrom(state$),
    filter(([_, state]) => !state.active),
    tap(() => state$.next({ active: true })),
    map(([result]) => result)
  );

  try {
    const subscription = merge(
      scan$.pipe(tap((result) => log.info(`UID: ${result.uid} | Data: ${formatData(result.text)}`))),
      detach$.pipe(map(() => undefined))
    ).subscribe();

    try {
      const result = await cancellation.promise;

      if (result === CANCELLED) {
        cancelStep();
      }
    } finally {
      subscription.unsubscribe();
      state$.complete();
    }
  } finally {
    cancellation.cleanup();
  }
}

async function main() {
  intro("rock-talk-rpi");
  log.info(`Using RFID data blocks ${TEXT_BLOCKS.join(", ")} for filename storage.`);

  while (true) {
    const action = await promptSelect("Choose an action.", [
      { value: "assign", label: "Assign" },
      { value: "unassign", label: "Unassign" },
      { value: "test-scan", label: "Test scan" },
      { value: "quit", label: "Quit" },
    ]);

    if (action === CANCELLED || action === "quit") {
      break;
    }

    if (action === "assign") {
      await runAssignFlow();
      continue;
    }

    if (action === "unassign") {
      await runUnassignFlow();
      continue;
    }

    await runTestScanFlow();
  }

  outro("RFID setup closed.");
}

main()
  .catch((error) => {
    cancel(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => {
    reader.close();
  });
