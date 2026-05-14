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
const FIFODataReg = 0x09;
const FIFOLevelReg = 0x0a;
const ControlReg = 0x0c;
const BitFramingReg = 0x0d;
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
const VersionReg = 0x37;

// MFRC522 commands
const PCD_IDLE = 0x00;
const PCD_TRANSCEIVE = 0x0c;
const PCD_CALCCRC = 0x03;
const PCD_SOFTRESET = 0x0f;

// PICC commands
const PICC_REQA = 0x26;
const PICC_ANTICOLL_CL1 = 0x93;
const PICC_ANTICOLL_CL2 = 0x95;
const PICC_SELECT_CL1 = 0x93;
const PICC_SELECT_CL2 = 0x95;
const PICC_READ = 0x30;
const PICC_WRITE = 0xa2;
const PICC_HALT = 0x50;

// NTAG213 layout
const NTAG213_USER_PAGE_START = 0x04;
const NTAG213_USER_PAGE_END = 0x27;
const NTAG213_USER_BYTES = (NTAG213_USER_PAGE_END - NTAG213_USER_PAGE_START + 1) * 4;
const NTAG_READ_RESPONSE_LENGTH = 16;

// NTAG ACK / NAK
const NTAG_ACK = 0x0a;

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

  writeReg(dev, TModeReg, 0x8d);
  writeReg(dev, TPrescalerReg, 0x3e);
  writeReg(dev, TReloadRegL, 0xe8);
  writeReg(dev, TReloadRegH, 0x03);

  writeReg(dev, TxASKReg, 0x40);
  writeReg(dev, ModeReg, 0x3d);

  writeReg(dev, TxModeReg, 0x00);
  writeReg(dev, RxModeReg, 0x00);

  antennaOn(dev);
}

function calculateBcc(bytes) {
  return bytes.reduce((a, b) => a ^ b, 0);
}

function transceive(dev, data, validBits = 0, timeoutMs = 50) {
  const irqEn = 0x77;
  const waitIrq = 0x30;

  writeReg(dev, ComIEnReg, irqEn | 0x80);
  writeReg(dev, CommandReg, PCD_IDLE);
  clearBitMask(dev, ComIrqReg, 0x80);
  setBitMask(dev, FIFOLevelReg, 0x80);

  for (const b of data) {
    writeReg(dev, FIFODataReg, b);
  }

  writeReg(dev, BitFramingReg, validBits & 0x07);
  writeReg(dev, CommandReg, PCD_TRANSCEIVE);
  setBitMask(dev, BitFramingReg, 0x80);

  const deadline = Date.now() + timeoutMs;
  let timedOut = false;

  while (true) {
    const irq = readReg(dev, ComIrqReg);

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
    throw new Error("Timeout waiting for tag");
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
    throw new Error(`MFRC522 error: 0x${error.toString(16)}`);
  }

  return { data: out, bits };
}

function calculateCRC(dev, data) {
  writeReg(dev, CommandReg, PCD_IDLE);
  clearBitMask(dev, DivIrqReg, 0x04);
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
  throw new Error("Timed out calculating CRC");
}

function requestA(dev) {
  writeReg(dev, BitFramingReg, 0x07);
  return transceive(dev, [PICC_REQA], 0x07);
}

function anticollision(dev, cascadeCmd) {
  writeReg(dev, BitFramingReg, 0x00);

  const res = transceive(dev, [cascadeCmd, 0x20], 0x00);

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
    // HALT usually returns no data.
  }
}

function selectTag(dev) {
  const atqa = requestA(dev).data;

  const cl1 = anticollision(dev, PICC_ANTICOLL_CL1);
  const sak1 = selectCascade(dev, PICC_SELECT_CL1, cl1);

  if (sak1 & 0x04) {
    if (cl1[0] !== 0x88) {
      throw new Error("Cascade bit set in SAK1 but CT marker missing in CL1 response");
    }

    const uid0to2 = cl1.slice(1, 4);
    const cl2 = anticollision(dev, PICC_ANTICOLL_CL2);
    const sak2 = selectCascade(dev, PICC_SELECT_CL2, cl2);
    const uid3to6 = cl2.slice(0, 4);

    return { atqa, uid: uid0to2.concat(uid3to6), sak: sak2 };
  }

  return { atqa, uid: cl1.slice(0, 4), sak: sak1 };
}

function writePageRaw(dev, page, fourBytes) {
  if (fourBytes.length !== 4) {
    throw new Error(`writePage expects 4 bytes, got ${fourBytes.length}`);
  }

  const frame = [PICC_WRITE, page, ...fourBytes];
  const crc = calculateCRC(dev, frame);

  // Increased timeout for clone/marginal NTAGs and EEPROM programming latency.
  const res = transceive(dev, [...frame, crc[0], crc[1]], 0x00, 100);

  if (res.bits !== 4 || res.data.length < 1) {
    throw new Error(`WRITE page ${page} returned unexpected frame (${res.bits} bits, ${res.data.length} bytes)`);
  }

  const ack = res.data[0] & 0x0f;
  if (ack !== NTAG_ACK) {
    throw new Error(`WRITE page ${page} NAK 0x${ack.toString(16)}; tag rejected write`);
  }
}

function writePageWithRetry(dev, page, bytes, retries = 3) {
  let lastErr;

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      writePageRaw(dev, page, bytes);
      return;
    } catch (error) {
      lastErr = error;
      console.log(`  write page 0x${page.toString(16).padStart(2, "0")} attempt ${attempt} failed: ${error.message}`);

      if (attempt <= retries) {
        sleepMs(10);
      }
    }
  }

  throw lastErr;
}

function readPageRaw(dev, page) {
  const frame = [PICC_READ, page];
  const crc = calculateCRC(dev, frame);
  const res = transceive(dev, [...frame, crc[0], crc[1]], 0x00, 30);
  const expected = new Set([NTAG_READ_RESPONSE_LENGTH, NTAG_READ_RESPONSE_LENGTH + CRC_A_BYTE_LENGTH]);

  if (!expected.has(res.data.length)) {
    throw new Error(`READ ${page} returned ${res.data.length} bytes`);
  }

  return res.data.slice(0, 4);
}

function encodeNdefText(text) {
  const lang = Buffer.from("en", "ascii");
  const textBytes = Buffer.from(text, "utf8");
  const statusByte = lang.length & 0x3f;

  const payload = Buffer.concat([Buffer.from([statusByte]), lang, textBytes]);

  if (payload.length > 0xff) {
    throw new Error("Text payload too long for short NDEF record");
  }

  const record = Buffer.from([0xd1, 0x01, payload.length, 0x54, ...payload]);

  const ndefLength = record.length;
  if (ndefLength > 0xfe) {
    throw new Error("NDEF message too long for 1-byte TLV length");
  }

  return Buffer.concat([Buffer.from([0x03, ndefLength]), record, Buffer.from([0xfe])]);
}

function chunkIntoPages(buf) {
  const pages = [];

  for (let i = 0; i < buf.length; i += 4) {
    const page = Buffer.alloc(4, 0x00);
    buf.copy(page, 0, i, Math.min(i + 4, buf.length));
    pages.push([page[0], page[1], page[2], page[3]]);
  }

  return pages;
}

function hex(bytes) {
  return bytes.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(":");
}

const text = process.argv[2];

if (typeof text !== "string" || text.length === 0) {
  console.error("Usage: node writer.js <text>");
  process.exit(1);
}

const ndefBytes = encodeNdefText(text);

if (ndefBytes.length > NTAG213_USER_BYTES) {
  console.error(`Encoded NDEF message is ${ndefBytes.length} bytes, exceeds NTAG213 user memory of ${NTAG213_USER_BYTES} bytes.`);
  process.exit(1);
}

const pages = chunkIntoPages(ndefBytes);

console.log(`Encoded NDEF (${ndefBytes.length} bytes): ${hex([...ndefBytes])}`);
console.log(`Will write ${pages.length} page(s) starting at page 0x${NTAG213_USER_PAGE_START.toString(16).padStart(2, "0")}.`);

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

  while (true) {
    try {
      const card = selectTag(dev);

      console.log(`ATQA: ${hex(card.atqa)}`);
      console.log(`SAK : 0x${card.sak.toString(16).padStart(2, "0")}`);
      console.log(`UID : ${hex(card.uid)}`);

      if (card.uid[0] !== 0x04) {
        console.warn(
          `Warning: UID does not start with 0x04 NXP manufacturer byte; got 0x${card.uid[0]
            .toString(16)
            .padStart(2, "0")}. This may be a clone tag or marginal anticollision read.`
        );
      }

      // Let the tag/RF field settle after SELECT before EEPROM writes.
      sleepMs(5);

      for (let i = 0; i < pages.length; i++) {
        const pageAddr = NTAG213_USER_PAGE_START + i;

        if (pageAddr > NTAG213_USER_PAGE_END) {
          throw new Error(`Refusing to write past NTAG213 user memory at page 0x${pageAddr.toString(16)}`);
        }

        writePageWithRetry(dev, pageAddr, pages[i], 3);

        console.log(`  wrote page 0x${pageAddr.toString(16).padStart(2, "0")}: ${hex(pages[i])}`);

        // Give EEPROM programming time before the next page write.
        sleepMs(10);
      }

      const verify = readPageRaw(dev, NTAG213_USER_PAGE_START);
      console.log(`Verify page 0x${NTAG213_USER_PAGE_START.toString(16)}: ${hex(verify)}`);

      console.log("Write completed successfully.");
      haltA(dev);
      break;
    } catch (error) {
      // Always log attempts; do not suppress repeated timeout messages.
      console.log(`Attempt failed: ${error.message}`);
      sleepMs(150);
    }
  }
} finally {
  dev.closeSync();
}
