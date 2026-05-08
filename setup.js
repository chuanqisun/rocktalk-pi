const { readdir } = require("node:fs/promises");
const { resolve } = require("node:path");
const readline = require("node:readline");
const { BehaviorSubject, debounceTime, filter, from, map, merge, share, tap, withLatestFrom } = require("rxjs");
const Rc522 = require("./lib/rc522.js");

const TRACKS_DIR = resolve(__dirname, "tracks");
const TEXT_BLOCKS = [8, 9, 10];
const SCAN_TIMEOUT_MS = 250;
const reader = new Rc522({ blocks: TEXT_BLOCKS, pollIntervalMs: 80 });
const CANCELLED = Symbol("cancelled");
const BACK_TO_MENU = Symbol("back-to-menu");
let clackPromptsPromise;

async function loadClackPrompts() {
  clackPromptsPromise ??= import("@clack/prompts");
  return clackPromptsPromise;
}

function isTimeoutError(error) {
  return error instanceof Error && error.message === "Timed out waiting for RFID tag";
}

function formatData(value) {
  return value === "" ? "(empty string)" : value;
}

function cancelStep() {
  return loadClackPrompts().then(({ log }) => {
    log.info("Step cancelled.");
  });
}

async function promptSelect(select, isCancel, message, options) {
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

async function* infiniteReadText(signal) {
  while (!signal.aborted) {
    try {
      yield reader.readTextAsync({ blocks: TEXT_BLOCKS, timeoutMs: SCAN_TIMEOUT_MS });
    } catch (error) {
      if (signal.aborted) {
        return;
      }

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
  const shouldPauseOnCleanup = process.stdin.isPaused();
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

    if (shouldPauseOnCleanup && !process.stdin.isPaused()) {
      process.stdin.pause();
    }
  };

  return { promise, cleanup, cancel: cancelCurrentStep };
}

async function waitForCardAction(message, action) {
  const { log } = await loadClackPrompts();
  log.step(`${message} Press Esc, q, or Ctrl+C to cancel.`);
  const cancellation = createCancellationWatcher();

  try {
    while (true) {
      try {
        const result = await Promise.race([action({ timeoutMs: SCAN_TIMEOUT_MS }), cancellation.promise]);

        if (result === CANCELLED) {
          await cancelStep();
          return CANCELLED;
        }

        return result;
      } catch (error) {
        if (error === CANCELLED) {
          await cancelStep();
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
  const { log } = await loadClackPrompts();
  try {
    const written = await waitForCardAction(`Tap and hold a rock to write ${formatData(text)}.`, async ({ timeoutMs }) => {
      const writeResult = await reader.writeTextAsync(text, { blocks: TEXT_BLOCKS, timeoutMs });
      const readResult = await reader.readTextAsync({ blocks: TEXT_BLOCKS, timeoutMs });

      if (readResult.uid !== writeResult.uid || readResult.text !== text) {
        throw new Error(`Validation failed. Expected ${writeResult.uid} -> ${formatData(text)}, received ${readResult.uid} -> ${formatData(readResult.text)}.`);
      }

      return writeResult;
    });

    if (written === CANCELLED) {
      return CANCELLED;
    }

    log.success(`Wrote ${formatData(written.text)} to rock ${written.uid}.`);
    return written;
  } catch (error) {
    log.error(error instanceof Error ? error.message : String(error));
    return null;
  }
}

async function runAssignFlow() {
  const { isCancel, select } = await loadClackPrompts();

  while (true) {
    const tracks = await listTracks();
    const selected = await promptSelect(select, isCancel, "Choose a track to assign.", [
      ...tracks.map((track) => ({ value: track, label: track })),
      { value: BACK_TO_MENU, label: "Back to main menu" },
    ]);

    if (selected === CANCELLED || selected === BACK_TO_MENU) {
      return;
    }

    await programCard(selected);
  }
}

async function runUnassignFlow() {
  await programCard("");
}

async function runTestScanFlow() {
  const { log } = await loadClackPrompts();
  log.step("Test scan is running. Tap cards to inspect UID and stored data.");
  log.info("Press Esc, q, or Ctrl+C to stop test scan.");

  const cancellation = createCancellationWatcher();
  const scanAbortController = new AbortController();
  const state$ = new BehaviorSubject({ active: false });
  const rawInput$ = from(infiniteReadText(scanAbortController.signal)).pipe(share());
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
        await cancelStep();
      }
    } finally {
      scanAbortController.abort();
      subscription.unsubscribe();
      state$.complete();
    }
  } finally {
    cancellation.cleanup();
  }
}

async function main() {
  const { cancel, intro, isCancel, outro, select } = await loadClackPrompts();
  intro("Rock Talk: in Japanese Garden, there is a distinction between myōseki (named rocks) and mumyōseki (nameless rocks).");

  while (true) {
    const action = await promptSelect(select, isCancel, "Choose an action.", [
      { value: "assign", label: "Assign track rock" },
      { value: "unassign", label: "Clear track from rock" },
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

  outro("Rock Talk setup complete");
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);

    return loadClackPrompts()
      .then(({ cancel }) => {
        cancel(message);
      })
      .catch(() => {
        console.error(message);
      })
      .finally(() => {
        process.exitCode = 1;
      });
  })
  .finally(() => {
    reader.close();

    if (process.stdin.isTTY && !process.stdin.isPaused()) {
      process.stdin.pause();
    }
  });
