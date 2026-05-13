/* @ts-ignore */
import SPI from "spi-device";

const SPI_BUS = 0;
const SPI_DEVICE = 0;
const SPEED_HZ = 1_000_000;

// MFRC522 registers
const CommandReg = 0x01;
const ComIEnReg = 0x02;
const ComIrqReg = 0x04;
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
const TModeReg = 0x2a;
const TPrescalerReg = 0x2b;
const TReloadRegH = 0x2c;
const TReloadRegL = 0x2d;
const VersionReg = 0x37;

// MFRC522 commands
const PCD_IDLE = 0x00;
const PCD_TRANSCEIVE = 0x0c;
const PCD_SOFTRESET = 0x0f;

// PICC commands
const PICC_REQA = 0x26;
const PICC_ANTICOLL_CL1 = 0x93;
const PICC_ANTICOLL_CL2 = 0x95;

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

  // Timer settings commonly used by MFRC522 examples
  writeReg(dev, TModeReg, 0x8d);
  writeReg(dev, TPrescalerReg, 0x3e);
  writeReg(dev, TReloadRegL, 30);
  writeReg(dev, TReloadRegH, 0);

  writeReg(dev, TxASKReg, 0x40);
  writeReg(dev, ModeReg, 0x3d);

  antennaOn(dev);
}

function calculateBcc(bytes) {
  return bytes.reduce((a, b) => a ^ b, 0);
}

function transceive(dev, data, validBits = 0) {
  writeReg(dev, CommandReg, PCD_IDLE);
  writeReg(dev, ComIrqReg, 0x7f); // clear IRQ flags
  setBitMask(dev, FIFOLevelReg, 0x80); // flush FIFO

  for (const b of data) {
    writeReg(dev, FIFODataReg, b);
  }

  writeReg(dev, BitFramingReg, validBits & 0x07);
  writeReg(dev, CommandReg, PCD_TRANSCEIVE);
  setBitMask(dev, BitFramingReg, 0x80); // StartSend

  let i = 2000;
  let irq;
  do {
    irq = readReg(dev, ComIrqReg);
    i--;
  } while (i && !(irq & 0x30)); // RxIRq or IdleIRq

  clearBitMask(dev, BitFramingReg, 0x80);

  if (i === 0) {
    throw new Error("Timeout waiting for tag");
  }

  const error = readReg(dev, ErrorReg);
  if (error & 0x13) {
    throw new Error(`MFRC522 error: 0x${error.toString(16)}`);
  }

  const len = readReg(dev, FIFOLevelReg);
  const lastBits = readReg(dev, ControlReg) & 0x07;
  const out = [];

  for (let j = 0; j < len; j++) {
    out.push(readReg(dev, FIFODataReg));
  }

  return { data: out, bits: lastBits ? (len - 1) * 8 + lastBits : len * 8 };
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

function readUid(dev) {
  requestA(dev);

  const cl1 = anticollision(dev, PICC_ANTICOLL_CL1);

  // 7-byte UID uses cascade tag 0x88 in CL1
  if (cl1[0] === 0x88) {
    const uid0to2 = cl1.slice(1, 4);

    const cl2 = anticollision(dev, PICC_ANTICOLL_CL2);
    const uid3to6 = cl2.slice(0, 4);

    return uid0to2.concat(uid3to6);
  }

  // 4-byte UID
  return cl1.slice(0, 4);
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

  console.log("Place NTAG213 near the reader...");

  while (true) {
    try {
      const uid = readUid(dev);
      console.log(`NTAG UID: ${hex(uid)}`);
      sleepMs(1000);
    } catch (_) {
      // No tag present or transient read error.
      sleepMs(100);
    }
  }
} finally {
  dev.closeSync();
}
