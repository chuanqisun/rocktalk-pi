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
const PICC_FAST_READ = 0x3a;
const PICC_GET_VERSION = 0x60;
const PICC_HALT = 0x50;
const NTAG_READ_RESPONSE_LENGTH = 16;
const NTAG_GET_VERSION_RESPONSE_LENGTH = 8;

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

  // Use a longer RF timeout so the debug script behaves more like the working
  // NTAG213 reader implementation in lib/rc522-ntag213.js.
  writeReg(dev, TModeReg, 0x8d);
  writeReg(dev, TPrescalerReg, 0x3e);
  writeReg(dev, TReloadRegL, 0xe8);
  writeReg(dev, TReloadRegH, 0x03);

  writeReg(dev, TxASKReg, 0x40);
  writeReg(dev, ModeReg, 0x3d);

  // Keep 106 kbps defaults explicit while debugging.
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
  // REQA is 7 bits, not a full byte
  writeReg(dev, BitFramingReg, 0x07);
  return transceive(dev, [PICC_REQA], 0x07);
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

function readPagesRaw(dev, page) {
  const frame = [PICC_READ, page];
  const crc = calculateCRC(dev, frame);
  const res = transceive(dev, [...frame, crc[0], crc[1]], 0x00, 30);
  const expectedLengths = new Set([NTAG_READ_RESPONSE_LENGTH, NTAG_READ_RESPONSE_LENGTH + CRC_A_BYTE_LENGTH]);

  if (!expectedLengths.has(res.data.length)) {
    throw new Error(`READ ${page} returned ${res.data.length} bytes`);
  }

  // Some MFRC522 configurations leave the tag's 2-byte CRC_A in the FIFO.
  // NTAG READ payload is still the first bytes before the trailing CRC_A.
  return res.data.slice(0, NTAG_READ_RESPONSE_LENGTH);
}

function fastReadPagesRaw(dev, startPage, endPage) {
  if (endPage < startPage) {
    throw new Error(`FAST_READ range is invalid: ${startPage}..${endPage}`);
  }

  const expectedLength = (endPage - startPage + 1) * 4;
  const frame = [PICC_FAST_READ, startPage, endPage];
  const crc = calculateCRC(dev, frame);
  const res = transceive(dev, [...frame, crc[0], crc[1]], 0x00, 30);
  const expectedLengths = new Set([expectedLength, expectedLength + CRC_A_BYTE_LENGTH]);

  if (!expectedLengths.has(res.data.length)) {
    throw new Error(`FAST_READ ${startPage}..${endPage} returned ${res.data.length} bytes`);
  }

  return res.data.slice(0, expectedLength);
}

function getVersion(dev) {
  const crc = calculateCRC(dev, [PICC_GET_VERSION]);
  const res = transceive(dev, [PICC_GET_VERSION, crc[0], crc[1]], 0x00, 30);
  const expectedLengths = new Set([NTAG_GET_VERSION_RESPONSE_LENGTH, NTAG_GET_VERSION_RESPONSE_LENGTH + CRC_A_BYTE_LENGTH]);

  if (!expectedLengths.has(res.data.length)) {
    throw new Error(`GET_VERSION returned ${res.data.length} bytes`);
  }

  return res.data.slice(0, NTAG_GET_VERSION_RESPONSE_LENGTH);
}

function readCard(dev) {
  const atqa = requestA(dev).data;

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

function decodeText(bytes) {
  return Buffer.from(bytes)
    .toString("utf8")
    .replace(/\0+$/u, "")
    .replace(/[^\x20-\x7E\n\r\t]/g, " ")
    .trim();
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
      const card = readCard(dev);
      const page4to11 = fastReadPagesRaw(dev, 4, 11);
      const decodedText = decodeText(page4to11);

      console.log(`ATQA: ${hex(card.atqa)}`);
      console.log(`SAK: 0x${card.sak.toString(16).padStart(2, "0")}`);
      console.log(`NTAG UID: ${hex(card.uid)}`);

      try {
        const versionBytes = getVersion(dev);
        console.log(`GET_VERSION: ${hex(versionBytes)}`);
      } catch (error) {
        console.log(`GET_VERSION failed: ${error.message}`);
      }

      console.log(`FAST_READ page 4..11: ${hex(page4to11)}`);
      console.log(`FAST_READ text: ${decodedText || "<no printable text>"}`);
      console.log("---");

      haltA(dev);
      lastStatus = "";
      sleepMs(1000);
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
