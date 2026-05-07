// rc522-read-tag.js
//
// Raspberry Pi 5 + RC522 over hardware SPI
// Uses /dev/spidev0.0 and NO GPIO library.
// Wire RC522 RST pin directly to 3.3V.
//
// Install:
//   npm install spi-device
//
// Enable SPI:
//   sudo raspi-config
//   Interface Options -> SPI -> Enable
//
// Run:
//   node rc522-read-tag.js

const SPI = require("spi-device");

// -----------------------------------------------------------------------------
// MFRC522 registers
// -----------------------------------------------------------------------------

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

// -----------------------------------------------------------------------------
// MFRC522 commands
// -----------------------------------------------------------------------------

const PCD_IDLE = 0x00;
const PCD_AUTHENT = 0x0e;
const PCD_RECEIVE = 0x08;
const PCD_TRANSMIT = 0x04;
const PCD_TRANSCEIVE = 0x0c;
const PCD_RESETPHASE = 0x0f;
const PCD_CALCCRC = 0x03;

// -----------------------------------------------------------------------------
// PICC commands
// -----------------------------------------------------------------------------

const PICC_REQIDL = 0x26;
const PICC_REQALL = 0x52;
const PICC_ANTICOLL = 0x93;
const PICC_SELECTTAG = 0x93;
const PICC_AUTHENT1A = 0x60;
const PICC_AUTHENT1B = 0x61;
const PICC_READ = 0x30;
const PICC_WRITE = 0xa0;
const PICC_HALT = 0x50;

const MI_OK = 0;
const MI_NOTAGERR = 1;
const MI_ERR = 2;

// -----------------------------------------------------------------------------
// SPI setup
// -----------------------------------------------------------------------------

const SPI_BUS = 0;
const SPI_DEVICE = 0;
const SPI_SPEED = 1_000_000;

const spi = SPI.openSync(SPI_BUS, SPI_DEVICE, {
  mode: SPI.MODE0,
  maxSpeedHz: SPI_SPEED,
});

function transfer(bytes) {
  const message = [
    {
      sendBuffer: Buffer.from(bytes),
      receiveBuffer: Buffer.alloc(bytes.length),
      byteLength: bytes.length,
      speedHz: SPI_SPEED,
    },
  ];

  spi.transferSync(message);
  return message[0].receiveBuffer;
}

// RC522 SPI protocol:
// Write: address byte = (reg << 1) & 0x7E
// Read:  address byte = ((reg << 1) & 0x7E) | 0x80

function writeReg(reg, value) {
  transfer([(reg << 1) & 0x7e, value]);
}

function readReg(reg) {
  return transfer([((reg << 1) & 0x7e) | 0x80, 0x00])[1];
}

function setBitMask(reg, mask) {
  writeReg(reg, readReg(reg) | mask);
}

function clearBitMask(reg, mask) {
  writeReg(reg, readReg(reg) & ~mask);
}

// -----------------------------------------------------------------------------
// MFRC522 functions
// -----------------------------------------------------------------------------

function reset() {
  // No physical RST pin used.
  // RC522 RST is tied to 3.3V.
  // This is a soft reset over SPI.
  writeReg(CommandReg, PCD_RESETPHASE);
}

function antennaOn() {
  const value = readReg(TxControlReg);
  if ((value & 0x03) !== 0x03) {
    setBitMask(TxControlReg, 0x03);
  }
}

function antennaOff() {
  clearBitMask(TxControlReg, 0x03);
}

function initRC522() {
  reset();

  writeReg(TModeReg, 0x8d);
  writeReg(TPrescalerReg, 0x3e);
  writeReg(TReloadRegL, 30);
  writeReg(TReloadRegH, 0);

  writeReg(TxASKReg, 0x40);
  writeReg(ModeReg, 0x3d);

  antennaOn();
}

function toCard(command, sendData) {
  let irqEn = 0x00;
  let waitIRq = 0x00;

  if (command === PCD_AUTHENT) {
    irqEn = 0x12;
    waitIRq = 0x10;
  } else if (command === PCD_TRANSCEIVE) {
    irqEn = 0x77;
    waitIRq = 0x30;
  }

  writeReg(ComIEnReg, irqEn | 0x80);
  clearBitMask(ComIrqReg, 0x80);
  setBitMask(FIFOLevelReg, 0x80);

  writeReg(CommandReg, PCD_IDLE);

  for (const byte of sendData) {
    writeReg(FIFODataReg, byte);
  }

  writeReg(CommandReg, command);

  if (command === PCD_TRANSCEIVE) {
    setBitMask(BitFramingReg, 0x80);
  }

  let i = 2000;
  let n;

  do {
    n = readReg(ComIrqReg);
    i--;
  } while (i !== 0 && !(n & 0x01) && !(n & waitIRq));

  clearBitMask(BitFramingReg, 0x80);

  if (i === 0) {
    return {
      status: MI_ERR,
      data: [],
      backBits: 0,
    };
  }

  if (readReg(ErrorReg) & 0x1b) {
    return {
      status: MI_ERR,
      data: [],
      backBits: 0,
    };
  }

  let backBits = 0;
  let data = [];

  if (command === PCD_TRANSCEIVE) {
    let fifoLen = readReg(FIFOLevelReg);
    const lastBits = readReg(ControlReg) & 0x07;

    if (lastBits) {
      backBits = (fifoLen - 1) * 8 + lastBits;
    } else {
      backBits = fifoLen * 8;
    }

    if (fifoLen === 0) fifoLen = 1;
    if (fifoLen > 16) fifoLen = 16;

    for (let j = 0; j < fifoLen; j++) {
      data.push(readReg(FIFODataReg));
    }
  }

  return {
    status: MI_OK,
    data,
    backBits,
  };
}

function request(reqMode = PICC_REQIDL) {
  writeReg(BitFramingReg, 0x07);

  const result = toCard(PCD_TRANSCEIVE, [reqMode]);

  if (result.status !== MI_OK || result.backBits !== 0x10) {
    return {
      status: MI_ERR,
      data: [],
    };
  }

  return {
    status: MI_OK,
    data: result.data,
  };
}

function anticoll() {
  writeReg(BitFramingReg, 0x00);

  const result = toCard(PCD_TRANSCEIVE, [PICC_ANTICOLL, 0x20]);

  if (result.status !== MI_OK) {
    return {
      status: MI_ERR,
      uid: [],
    };
  }

  if (result.data.length !== 5) {
    return {
      status: MI_ERR,
      uid: [],
    };
  }

  let checksum = 0;
  for (let i = 0; i < 4; i++) {
    checksum ^= result.data[i];
  }

  if (checksum !== result.data[4]) {
    return {
      status: MI_ERR,
      uid: [],
    };
  }

  return {
    status: MI_OK,
    uid: result.data,
  };
}

function calculateCRC(data) {
  clearBitMask(DivIrqReg, 0x04);
  setBitMask(FIFOLevelReg, 0x80);

  for (const byte of data) {
    writeReg(FIFODataReg, byte);
  }

  writeReg(CommandReg, PCD_CALCCRC);

  let i = 255;
  while (i--) {
    const n = readReg(DivIrqReg);
    if (n & 0x04) break;
  }

  return [readReg(CRCResultRegL), readReg(CRCResultRegH)];
}

function selectTag(uid) {
  const buffer = [PICC_SELECTTAG, 0x70];

  for (let i = 0; i < 5; i++) {
    buffer.push(uid[i]);
  }

  const crc = calculateCRC(buffer);
  buffer.push(crc[0]);
  buffer.push(crc[1]);

  const result = toCard(PCD_TRANSCEIVE, buffer);

  if (result.status === MI_OK && result.backBits === 0x18) {
    return result.data[0];
  }

  return 0;
}

function authenticate(authMode, blockAddr, key, uid) {
  const buffer = [authMode, blockAddr, ...key, ...uid.slice(0, 4)];

  const result = toCard(PCD_AUTHENT, buffer);

  if (result.status !== MI_OK) {
    return false;
  }

  if (!(readReg(Status2Reg) & 0x08)) {
    return false;
  }

  return true;
}

function stopCrypto() {
  clearBitMask(Status2Reg, 0x08);
}

function readBlock(blockAddr) {
  const buffer = [PICC_READ, blockAddr];
  const crc = calculateCRC(buffer);

  buffer.push(crc[0]);
  buffer.push(crc[1]);

  const result = toCard(PCD_TRANSCEIVE, buffer);

  if (result.status !== MI_OK) {
    return null;
  }

  if (result.data.length !== 16) {
    return null;
  }

  return result.data;
}

function writeBlock(blockAddr, data16) {
  if (!Array.isArray(data16) && !Buffer.isBuffer(data16)) {
    throw new Error("data16 must be Array or Buffer");
  }

  if (data16.length !== 16) {
    throw new Error("MIFARE Classic block writes must be exactly 16 bytes");
  }

  let buffer = [PICC_WRITE, blockAddr];
  let crc = calculateCRC(buffer);

  buffer.push(crc[0]);
  buffer.push(crc[1]);

  let result = toCard(PCD_TRANSCEIVE, buffer);

  if (result.status !== MI_OK || result.backBits !== 4 || (result.data[0] & 0x0f) !== 0x0a) {
    return false;
  }

  buffer = [...data16];
  crc = calculateCRC(buffer);

  buffer.push(crc[0]);
  buffer.push(crc[1]);

  result = toCard(PCD_TRANSCEIVE, buffer);

  if (result.status !== MI_OK || result.backBits !== 4 || (result.data[0] & 0x0f) !== 0x0a) {
    return false;
  }

  return true;
}

function halt() {
  const buffer = [PICC_HALT, 0x00];
  const crc = calculateCRC(buffer);

  buffer.push(crc[0]);
  buffer.push(crc[1]);

  toCard(PCD_TRANSCEIVE, buffer);
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function bytesToHex(bytes) {
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join(":");
}

function blockToText(block) {
  return Buffer.from(block).toString("utf8").replace(/\0/g, "").trim();
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

initRC522();

const version = readReg(VersionReg);
console.log(`MFRC522 VersionReg: 0x${version.toString(16)}`);

if (version === 0x00 || version === 0xff) {
  console.log("RC522 not detected. Check wiring, SPI, power, and CE0.");
}

console.log("Hold a MIFARE Classic tag near the reader...");

let lastUid = null;

setInterval(() => {
  const req = request(PICC_REQIDL);

  if (req.status !== MI_OK) {
    lastUid = null;
    return;
  }

  const anti = anticoll();

  if (anti.status !== MI_OK) {
    return;
  }

  const uid = anti.uid;
  const uidHex = bytesToHex(uid.slice(0, 4));

  if (uidHex === lastUid) {
    return;
  }

  lastUid = uidHex;

  console.log("");
  console.log(`Card UID: ${uidHex}`);

  const size = selectTag(uid);
  console.log(`Selected tag size/code: ${size}`);

  // Default MIFARE Classic key
  const key = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

  // Safe-ish demo block.
  // Avoid:
  //   block 0: manufacturer data
  //   blocks 3,7,11,15,...: sector trailers
  const blockAddr = 8;

  const authed = authenticate(PICC_AUTHENT1A, blockAddr, key, uid);

  if (!authed) {
    console.log("Authentication failed.");
    stopCrypto();
    halt();
    return;
  }

  const block = readBlock(blockAddr);

  if (!block) {
    console.log(`Could not read block ${blockAddr}`);
  } else {
    console.log(`Block ${blockAddr} raw:  ${bytesToHex(block)}`);
    console.log(`Block ${blockAddr} text: "${blockToText(block)}"`);
  }

  // Uncomment this section if you want to write.
  // WARNING: Do not write to block 0 or sector trailer blocks.
  /*
  const text = "Hello Pi 5!";
  const data = Buffer.alloc(16, 0);
  Buffer.from(text, "utf8").copy(data);

  const ok = writeBlock(blockAddr, [...data]);
  console.log(`Write block ${blockAddr}: ${ok ? "OK" : "FAILED"}`);

  const reread = readBlock(blockAddr);
  if (reread) {
    console.log(`After write: "${blockToText(reread)}"`);
  }
  */

  stopCrypto();
  halt();
}, 250);

process.on("SIGINT", () => {
  console.log("\nExiting...");
  antennaOff();
  spi.closeSync();
  process.exit(0);
});
