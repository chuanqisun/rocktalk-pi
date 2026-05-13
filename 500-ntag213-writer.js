/* @ts-ignore */
import SPI from "spi-device";

const SPI_BUS = 0;
const SPI_DEVICE = 0;
const SPEED_HZ = 1_000_000;
const CRC_A_BYTE_LENGTH = 2;

// MFRC522 registers
const CommandReg = 0x01;
const ComIEnReg = 0x02;
const ComIrqReg = 0x04;
const DivIrqReg = 0x05;
const ErrorReg = 0x06;
const Status2Reg = 0x08;
const FIFODataReg = 0x09;
const FIFOLevelReg = 0x0a;
const ControlReg = 0x0c;
const BitFramingReg = 0x0d;
const CollReg = 0x0e;
const ModeReg = 0x11;
const TxModeReg = 0x12;
const RxModeReg = 0x13;
const TxControlReg = 0x14;
const TxASKReg = 0x15;
const CRCResultRegH = 0x21;
const CRCResultRegL = 0x22;
const TModeReg = 0x2a;
const TPrescalerReg = 0x2b;
const TReloadRegH = 0x2c;
const TReloadRegL = 0x2d;
const TCounterValueRegH = 0x2e;
const TCounterValueRegL = 0x2f;
const VersionReg = 0x37;

// MFRC522 commands
const PCD_IDLE = 0x00;
const PCD_TRANSCEIVE = 0x0c;
const PCD_CALCCRC = 0x03;
const PCD_SOFTRESET = 0x0f;

// PICC commands
const PICC_REQA = 0x26;
const PICC_WUPA = 0x52;
const PICC_ANTICOLL_CL1 = 0x93;
const PICC_ANTICOLL_CL2 = 0x95;
const PICC_SELECT_CL1 = 0x93;
const PICC_SELECT_CL2 = 0x95;
const PICC_READ = 0x30;
const PICC_COMPATIBILITY_WRITE = 0xa0;
const PICC_WRITE = 0xa2;
const PICC_GET_VERSION = 0x60;
const PICC_HALT = 0x50;
const NTAG_READ_RESPONSE_LENGTH = 16;
const NTAG_GET_VERSION_RESPONSE_LENGTH = 8;

const TEXT_PAYLOAD = "hello-world-123";
const USER_START_PAGE = 4;
const WRITE_ATTEMPTS = 5;
const WRITE_SETTLE_MS = 12;
const INTER_COMMAND_SETTLE_MS = 3;
const WRITE_ACK_TIMEOUT_MS = 20;
const WRITE_RECOVERY_RESELECT_ATTEMPTS = 3;
const DEBUG = process.env.NTAG_DEBUG === "1";

// SPI address format:
// write: ((reg << 1) & 0x7E)
// read:  ((reg << 1) & 0x7E) | 0x80
function writeReg(dev, reg, val) {
  const tx = Buffer.from([(reg << 1) & 0x7e, val]);
  const rx = Buffer.alloc(2);

  dev.transferSync([
    {
      sendBuffer: tx,
      receiveBuffer: rx,
      byteLength: 2,
      speedHz: SPEED_HZ,
    },
  ]);
}

function readReg(dev, reg) {
  const tx = Buffer.from([((reg << 1) & 0x7e) | 0x80, 0x00]);
  const rx = Buffer.alloc(2);

  dev.transferSync([
    {
      sendBuffer: tx,
      receiveBuffer: rx,
      byteLength: 2,
      speedHz: SPEED_HZ,
    },
  ]);

  return rx[1];
}

function setBitMask(dev, reg, mask) {
  writeReg(dev, reg, readReg(dev, reg) | mask);
}

function clearBitMask(dev, reg, mask) {
  writeReg(dev, reg, readReg(dev, reg) & ~mask);
}

function readDebugState(dev) {
  return {
    command: readReg(dev, CommandReg),
    comIrq: readReg(dev, ComIrqReg),
    divIrq: readReg(dev, DivIrqReg),
    error: readReg(dev, ErrorReg),
    status2: readReg(dev, Status2Reg),
    fifoLevel: readReg(dev, FIFOLevelReg),
    control: readReg(dev, ControlReg),
    bitFraming: readReg(dev, BitFramingReg),
    coll: readReg(dev, CollReg),
    timer: (readReg(dev, TCounterValueRegH) << 8) | readReg(dev, TCounterValueRegL),
  };
}

function formatDebugState(state) {
  return Object.entries(state)
    .map(([key, value]) => `${key}=0x${value.toString(16).padStart(2, "0")}`)
    .join(" ");
}

function debugLog(message) {
  if (DEBUG) {
    console.log(`[debug] ${message}`);
  }
}

/**
 * @typedef {ReturnType<typeof readDebugState>} DebugState
 */

/**
 * @typedef {Error & { debugState: DebugState }} DeviceError
 */

function makeDeviceError(message, dev) {
  /** @type {DeviceError} */
  const error = Object.assign(new Error(message), {
    debugState: readDebugState(dev),
  });
  return error;
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function reset(dev) {
  writeReg(dev, CommandReg, PCD_SOFTRESET);
  sleepMs(50);
}

function antennaOn(dev) {
  const v = readReg(dev, TxControlReg);
  if ((v & 0x03) !== 0x03) {
    setBitMask(dev, TxControlReg, 0x03);
  }
}

function init(dev) {
  reset(dev);

  // Use a longer RF timeout so short tag response timing is still captured
  // reliably when the field coupling is marginal.
  writeReg(dev, TModeReg, 0x8d);
  writeReg(dev, TPrescalerReg, 0x3e);
  writeReg(dev, TReloadRegL, 0xe8);
  writeReg(dev, TReloadRegH, 0x03);

  writeReg(dev, TxASKReg, 0x40);
  writeReg(dev, ModeReg, 0x3d);

  // Keep 106 kbps defaults explicit while debugging.
  writeReg(dev, TxModeReg, 0x00);
  writeReg(dev, RxModeReg, 0x00);
  writeReg(dev, CollReg, 0x80);

  antennaOn(dev);
}

function calculateBcc(bytes) {
  return bytes.reduce((a, b) => a ^ b, 0);
}

function arraysEqual(a, b) {
  if (!a || !b || a.length !== b.length) {
    return false;
  }

  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) {
      return false;
    }
  }

  return true;
}

function transceive(dev, data, validBits = 0, timeoutMs = 50) {
  const irqEn = 0x77;
  const waitIrq = 0x30;

  writeReg(dev, ComIEnReg, irqEn | 0x80);
  writeReg(dev, CommandReg, PCD_IDLE);
  writeReg(dev, ComIrqReg, 0x7f);
  setBitMask(dev, FIFOLevelReg, 0x80); // flush FIFO

  for (const b of data) {
    writeReg(dev, FIFODataReg, b);
  }

  writeReg(dev, BitFramingReg, validBits & 0x07);
  writeReg(dev, CommandReg, PCD_TRANSCEIVE);
  setBitMask(dev, BitFramingReg, 0x80); // StartSend

  const deadline = Date.now() + timeoutMs;
  let irq = 0;
  let timedOut = false;

  while (true) {
    irq = readReg(dev, ComIrqReg);

    if (irq & waitIrq) {
      break;
    }

    if (irq & 0x01 || Date.now() >= deadline) {
      timedOut = true;
      break;
    }
  }

  clearBitMask(dev, BitFramingReg, 0x80);

  if (timedOut) {
    writeReg(dev, CommandReg, PCD_IDLE);

    const error = makeDeviceError("Timeout waiting for tag", dev);

    if (DEBUG) {
      debugLog(`Transceive timeout data=${hex(data)} bits=${validBits} ${formatDebugState(error.debugState)}`);
    }

    throw error;
  }

  let len = readReg(dev, FIFOLevelReg);
  const lastBits = readReg(dev, ControlReg) & 0x07;
  const bits = lastBits ? (len - 1) * 8 + lastBits : len * 8;
  const out = [];

  if (len === 0) {
    len = 1;
  }

  if (len > 64) {
    len = 64;
  }

  for (let j = 0; j < len; j++) {
    out.push(readReg(dev, FIFODataReg));
  }

  const error = readReg(dev, ErrorReg);
  const isFourBitResponse = bits === 4;
  const fatalMask = isFourBitResponse ? 0x1a : 0x1b;

  if (error & fatalMask) {
    const deviceError = makeDeviceError(`MFRC522 error: 0x${error.toString(16)}`, dev);

    if (DEBUG) {
      debugLog(`Transceive error data=${hex(data)} bits=${validBits} ${formatDebugState(deviceError.debugState)}`);
    }

    throw deviceError;
  }

  return { data: out, bits };
}

function calculateCRC(dev, data) {
  writeReg(dev, CommandReg, PCD_IDLE);
  writeReg(dev, DivIrqReg, 0x04);
  setBitMask(dev, FIFOLevelReg, 0x80);

  for (const b of data) {
    writeReg(dev, FIFODataReg, b);
  }

  writeReg(dev, CommandReg, PCD_CALCCRC);

  const deadline = Date.now() + 20;
  while (Date.now() < deadline) {
    if (readReg(dev, DivIrqReg) & 0x04) {
      writeReg(dev, CommandReg, PCD_IDLE);
      return [readReg(dev, CRCResultRegL), readReg(dev, CRCResultRegH)];
    }
  }

  writeReg(dev, CommandReg, PCD_IDLE);

  const error = makeDeviceError("Timed out calculating CRC", dev);

  if (DEBUG) {
    debugLog(`CRC timeout data=${hex(data)} ${formatDebugState(error.debugState)}`);
  }

  throw error;
}

function request(dev, command) {
  // REQA/WUPA are 7 bits, not a full byte
  writeReg(dev, BitFramingReg, 0x07);
  return transceive(dev, [command], 0x07);
}

function requestA(dev) {
  return request(dev, PICC_REQA);
}

function wakeupA(dev) {
  return request(dev, PICC_WUPA);
}

function anticollision(dev, cascadeCmd) {
  writeReg(dev, BitFramingReg, 0x00);

  // NVB = 0x20 means anticollision, no UID bits known yet
  const res = transceive(dev, [cascadeCmd, 0x20], 0x00);

  // Expected: 5 bytes = 4 UID/BCC bytes + BCC
  if (res.data.length < 5) {
    throw new Error(`Anticollision failed, got ${res.data.length} bytes`);
  }

  const block = res.data.slice(0, 5);
  const bcc = calculateBcc(block.slice(0, 4));

  if (bcc !== block[4]) {
    throw new Error("UID BCC check failed");
  }

  return block;
}

function selectCascade(dev, cascadeCmd, fiveBytes) {
  const frame = [cascadeCmd, 0x70, ...fiveBytes];
  const crc = calculateCRC(dev, frame);
  const res = transceive(dev, [...frame, crc[0], crc[1]], 0x00, 25);

  if (res.bits !== 0x18 || res.data.length < 1) {
    throw new Error(`SELECT failed on cascade 0x${cascadeCmd.toString(16)} (${res.bits} bits)`);
  }

  return res.data[0];
}

function haltA(dev) {
  const frame = [PICC_HALT, 0x00];
  const crc = calculateCRC(dev, frame);

  try {
    transceive(dev, [...frame, crc[0], crc[1]], 0x00, 10);
  } catch (_) {
    // HALT commonly returns no data; ignore while debugging.
  }
}

function readExpectedPayload(res, expectedLength, label) {
  const expectedLengths = new Set([expectedLength, expectedLength + CRC_A_BYTE_LENGTH]);

  if (!expectedLengths.has(res.data.length)) {
    throw new Error(`${label} returned ${res.data.length} bytes`);
  }

  // Some MFRC522 configurations leave the tag's trailing CRC_A in the FIFO.
  // The payload is still the leading bytes before the optional CRC_A suffix.
  return res.data.slice(0, expectedLength);
}

function readPagesRaw(dev, page) {
  const frame = [PICC_READ, page];
  const crc = calculateCRC(dev, frame);
  const res = transceive(dev, [...frame, crc[0], crc[1]], 0x00, 30);

  return readExpectedPayload(res, NTAG_READ_RESPONSE_LENGTH, `READ ${page}`);
}

function readPage(dev, page) {
  return readPagesRaw(dev, page).slice(0, 4);
}

function readPages(dev, startPage, pageCount) {
  const out = [];

  for (let index = 0; index < pageCount; index += 1) {
    out.push(...readPage(dev, startPage + index));
  }

  return out;
}

function decodeAck(res, label) {
  if (res.bits !== 4 || res.data.length < 1) {
    return { ok: false, reason: `${label} bad ACK frame (${res.bits} bits)` };
  }

  const ack = res.data[0] & 0x0f;

  if (ack !== 0x0a) {
    return { ok: false, reason: `${label} tag returned NAK 0x${ack.toString(16)}` };
  }

  return { ok: true };
}

function writePageOnce(dev, page, data4) {
  writeReg(dev, BitFramingReg, 0x00);

  const frame = [PICC_WRITE, page, data4[0], data4[1], data4[2], data4[3]];
  const crc = calculateCRC(dev, frame);
  const res = transceive(dev, [...frame, crc[0], crc[1]], 0x00, WRITE_ACK_TIMEOUT_MS);

  return decodeAck(res, `WRITE ${page}`);
}

function compatibilityWritePageOnce(dev, page, data4) {
  writeReg(dev, BitFramingReg, 0x00);

  const requestFrame = [PICC_COMPATIBILITY_WRITE, page];
  const requestCrc = calculateCRC(dev, requestFrame);
  const requestRes = transceive(dev, [...requestFrame, requestCrc[0], requestCrc[1]], 0x00, WRITE_ACK_TIMEOUT_MS);
  const requestAck = decodeAck(requestRes, `COMPATIBILITY_WRITE ${page} part 1`);

  if (!requestAck.ok) {
    return requestAck;
  }

  const paddedData = Buffer.alloc(16, 0x00);
  Buffer.from(data4).copy(paddedData, 0, 0, 4);

  const dataFrame = [...paddedData];
  const dataCrc = calculateCRC(dev, dataFrame);
  const dataRes = transceive(dev, [...dataFrame, dataCrc[0], dataCrc[1]], 0x00, WRITE_ACK_TIMEOUT_MS);

  return decodeAck(dataRes, `COMPATIBILITY_WRITE ${page} part 2`);
}

function verifyPageData(dev, page, data4) {
  return arraysEqual(readPage(dev, page), [...data4]);
}

function recoverCard(dev, uid, attempts = WRITE_RECOVERY_RESELECT_ATTEMPTS) {
  let lastError = new Error("Unable to wake NTAG213");

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const card = readCard(dev, PICC_WUPA);

      if (uid && !arraysEqual(card.uid, uid)) {
        throw new Error("Different NTAG213 tag detected during write recovery");
      }

      return card;
    } catch (error) {
      lastError = error;
      sleepMs(INTER_COMMAND_SETTLE_MS + attempt * 3);
    }
  }

  throw lastError;
}

function verifyPageAfterWrite(dev, page, data4, uid) {
  sleepMs(WRITE_SETTLE_MS);

  try {
    if (verifyPageData(dev, page, data4)) {
      return { ok: true };
    }
  } catch (error) {
    if (error.debugState) {
      debugLog(`Direct verify failed page=${page} reason=${error.message} ${formatDebugState(error.debugState)}`);
    }
  }

  try {
    recoverCard(dev, uid);
    sleepMs(INTER_COMMAND_SETTLE_MS);

    if (verifyPageData(dev, page, data4)) {
      return { ok: true, recovered: true };
    }

    return { ok: false, reason: "Verification mismatch after wakeup" };
  } catch (error) {
    if (error.debugState) {
      debugLog(`Wakeup verify failed page=${page} reason=${error.message} ${formatDebugState(error.debugState)}`);
    }

    return { ok: false, reason: error.message };
  }
}

function writePageWithVerification(dev, page, data4, uid, methodName, writeFn) {
  let writeReason = null;

  try {
    const result = writeFn(dev, page, data4);

    if (!result.ok) {
      writeReason = result.reason;
    }
  } catch (error) {
    if (error.debugState) {
      debugLog(`${methodName} command failed page=${page} reason=${error.message} ${formatDebugState(error.debugState)}`);
    }

    writeReason = error.message;
  }

  const verification = verifyPageAfterWrite(dev, page, data4, uid);

  if (verification.ok) {
    if (writeReason) {
      debugLog(`${methodName} page=${page} committed despite missed ACK (${writeReason})`);
    }

    return { ok: true };
  }

  return {
    ok: false,
    reason: verification.reason || writeReason || `${methodName} failed`,
  };
}

function writePageRobust(dev, page, data4, uid, attempts = WRITE_ATTEMPTS) {
  let lastReason = "Unknown write failure";

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    debugLog(`Write attempt ${attempt + 1}/${attempts} page=${page} data=${hex([...data4])}`);

    const writeResult = writePageWithVerification(dev, page, data4, uid, "WRITE", writePageOnce);

    if (writeResult.ok) {
      return;
    }

    lastReason = writeResult.reason;
    debugLog(`WRITE did not verify page=${page} reason=${lastReason}`);

    const compatibilityResult = writePageWithVerification(dev, page, data4, uid, "COMPATIBILITY_WRITE", compatibilityWritePageOnce);

    if (compatibilityResult.ok) {
      return;
    }

    lastReason = compatibilityResult.reason;
    debugLog(`COMPATIBILITY_WRITE did not verify page=${page} reason=${lastReason}`);

    sleepMs(WRITE_SETTLE_MS + attempt * 5);

    try {
      haltA(dev);
    } catch (error) {
      if (error.debugState) {
        debugLog(`Retry halt failed page=${page} reason=${error.message} ${formatDebugState(error.debugState)}`);
      }
    }

    sleepMs(INTER_COMMAND_SETTLE_MS);

    try {
      recoverCard(dev, uid);
      sleepMs(INTER_COMMAND_SETTLE_MS);
    } catch (error) {
      if (error.debugState) {
        debugLog(`Retry wakeup failed page=${page} reason=${error.message} ${formatDebugState(error.debugState)}`);
      }

      lastReason = error.message;
    }
  }

  throw new Error(`Could not write page ${page}: ${lastReason}`);
}

function buildPayloadPages(text) {
  const encoded = Buffer.from(text, "utf8");
  const pageCount = Math.ceil(encoded.length / 4);
  const payload = Buffer.alloc(pageCount * 4, 0x00);

  encoded.copy(payload);

  return {
    payload,
    pageCount,
  };
}

function writeText(dev, card, startPage, text) {
  const { payload, pageCount } = buildPayloadPages(text);

  sleepMs(INTER_COMMAND_SETTLE_MS);

  for (let index = 0; index < pageCount; index += 1) {
    const page = startPage + index;
    const chunk = payload.subarray(index * 4, (index + 1) * 4);
    writePageRobust(dev, page, chunk, card.uid);
  }

  const verified = Buffer.from(readPages(dev, startPage, pageCount));

  if (!verified.equals(payload)) {
    throw new Error(`Verification failed for pages ${startPage}..${startPage + pageCount - 1}`);
  }

  return {
    payload,
    pageCount,
    verified,
  };
}

function getVersion(dev) {
  const crc = calculateCRC(dev, [PICC_GET_VERSION]);
  const res = transceive(dev, [PICC_GET_VERSION, crc[0], crc[1]], 0x00, 30);

  return readExpectedPayload(res, NTAG_GET_VERSION_RESPONSE_LENGTH, "GET_VERSION");
}

function readCard(dev, requestCommand = PICC_WUPA) {
  const atqa = request(dev, requestCommand).data;

  const cl1 = anticollision(dev, PICC_ANTICOLL_CL1);
  const sak1 = selectCascade(dev, PICC_SELECT_CL1, cl1);

  // 7-byte UID uses cascade tag 0x88 in CL1
  if (sak1 & 0x04) {
    if (cl1[0] !== 0x88) {
      throw new Error("Cascade bit set in SAK1 but CT marker missing in CL1 response");
    }

    const uid0to2 = cl1.slice(1, 4);

    const cl2 = anticollision(dev, PICC_ANTICOLL_CL2);
    const sak2 = selectCascade(dev, PICC_SELECT_CL2, cl2);
    const uid3to6 = cl2.slice(0, 4);

    return {
      atqa,
      uid: uid0to2.concat(uid3to6),
      sak: sak2,
    };
  }

  // 4-byte UID
  return {
    atqa,
    uid: cl1.slice(0, 4),
    sak: sak1,
  };
}

function hex(bytes) {
  return bytes.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(":");
}

const dev = SPI.openSync(SPI_BUS, SPI_DEVICE, {
  mode: SPI.MODE0,
  maxSpeedHz: SPEED_HZ,
});

try {
  init(dev);

  const version = readReg(dev, VersionReg);
  console.log(`MFRC522 VersionReg: 0x${version.toString(16).padStart(2, "0")}`);

  if (version === 0x00 || version === 0xff) {
    throw new Error("RC522 did not respond correctly over SPI");
  }

  console.log("Place NTAG213 near the reader...");

  let lastStatus = "";

  while (true) {
    try {
      const card = readCard(dev, PICC_WUPA);
      const writeResult = writeText(dev, card, USER_START_PAGE, TEXT_PAYLOAD);

      console.log(`ATQA: ${hex(card.atqa)}`);
      console.log(`SAK: 0x${card.sak.toString(16).padStart(2, "0")}`);
      console.log(`NTAG UID: ${hex(card.uid)}`);

      try {
        const versionBytes = getVersion(dev);
        console.log(`GET_VERSION: ${hex(versionBytes)}`);
      } catch (error) {
        console.log(`GET_VERSION failed: ${error.message}`);
      }

      console.log(`Wrote text: ${JSON.stringify(TEXT_PAYLOAD)}`);
      console.log(`Wrote pages ${USER_START_PAGE}..${USER_START_PAGE + writeResult.pageCount - 1}: ${hex([...writeResult.verified])}`);

      haltA(dev);
      break;
    } catch (error) {
      if (error.message !== lastStatus) {
        console.log(`Waiting: ${error.message}`);
        lastStatus = error.message;
      }

      sleepMs(100);
    }
  }
} finally {
  dev.closeSync();
}
