const SPI = require("spi-device");
const { Gpio } = require("onoff"); // onoff works on Pi 5 via /sys/class/gpio or use 'rpi-gpio'-replacement

// MFRC522 register definitions (subset)
const CommandReg = 0x01;
const ComIrqReg = 0x04;
const DivIrqReg = 0x05;
const ErrorReg = 0x06;
const FIFODataReg = 0x09;
const FIFOLevelReg = 0x0a;
const ControlReg = 0x0c;
const BitFramingReg = 0x0d;
const ModeReg = 0x11;
const TxControlReg = 0x14;
const TxASKReg = 0x15;
const CRCResultRegH = 0x21;
const CRCResultRegL = 0x22;
const TModeReg = 0x2a;
const TPrescalerReg = 0x2b;
const TReloadRegH = 0x2c;
const TReloadRegL = 0x2d;

const PCD_IDLE = 0x00;
const PCD_TRANSCEIVE = 0x0c;
const PCD_RESETPHASE = 0x0f;
const PCD_CALCCRC = 0x03;

const PICC_REQIDL = 0x26;
const PICC_ANTICOLL = 0x93;

const rstPin = new Gpio(25, "out"); // BCM 25

const dev = SPI.openSync(0, 0, { maxSpeedHz: 1_000_000, mode: SPI.MODE0 });

function transfer(bytes) {
  const msg = [{ sendBuffer: Buffer.from(bytes), receiveBuffer: Buffer.alloc(bytes.length), byteLength: bytes.length, speedHz: 1_000_000 }];
  dev.transferSync(msg);
  return msg[0].receiveBuffer;
}

// MFRC522 SPI protocol: address byte = (reg << 1) & 0x7E; MSB=1 means read
function writeReg(reg, val) {
  transfer([(reg << 1) & 0x7e, val]);
}
function readReg(reg) {
  return transfer([((reg << 1) & 0x7e) | 0x80, 0])[1];
}
function setBit(reg, mask) {
  writeReg(reg, readReg(reg) | mask);
}
function clrBit(reg, mask) {
  writeReg(reg, readReg(reg) & ~mask);
}

function antennaOn() {
  setBit(TxControlReg, 0x03);
}

function reset() {
  rstPin.writeSync(0);
  setTimeout(() => {}, 5);
  rstPin.writeSync(1);
  writeReg(CommandReg, PCD_RESETPHASE);
}

function init() {
  reset();
  writeReg(TModeReg, 0x8d);
  writeReg(TPrescalerReg, 0x3e);
  writeReg(TReloadRegL, 30);
  writeReg(TReloadRegH, 0);
  writeReg(TxASKReg, 0x40);
  writeReg(ModeReg, 0x3d);
  antennaOn();
}

function toCard(cmd, sendData) {
  let irqEn = 0x77,
    waitIRq = 0x30; // for transceive
  writeReg(0x02, irqEn | 0x80); // ComIEnReg
  clrBit(ComIrqReg, 0x80);
  setBit(FIFOLevelReg, 0x80); // flush FIFO
  writeReg(CommandReg, PCD_IDLE);

  for (const b of sendData) writeReg(FIFODataReg, b);
  writeReg(CommandReg, cmd);
  if (cmd === PCD_TRANSCEIVE) setBit(BitFramingReg, 0x80); // StartSend

  let i = 2000,
    n;
  do {
    n = readReg(ComIrqReg);
    i--;
  } while (i && !(n & 0x01) && !(n & waitIRq));
  clrBit(BitFramingReg, 0x80);
  if (!i) return { status: false };

  if (readReg(ErrorReg) & 0x1b) return { status: false };

  const fifoLen = readReg(FIFOLevelReg);
  const back = [];
  for (let k = 0; k < fifoLen; k++) back.push(readReg(FIFODataReg));
  return { status: true, data: back };
}

function request() {
  writeReg(BitFramingReg, 0x07);
  return toCard(PCD_TRANSCEIVE, [PICC_REQIDL]);
}

function anticoll() {
  writeReg(BitFramingReg, 0x00);
  const res = toCard(PCD_TRANSCEIVE, [PICC_ANTICOLL, 0x20]);
  if (res.status && res.data.length === 5) {
    let chk = 0;
    for (let i = 0; i < 4; i++) chk ^= res.data[i];
    if (chk !== res.data[4]) return { status: false };
  }
  return res;
}

// --- main loop ---
init();
setInterval(() => {
  const r = request();
  if (!r.status) return;
  const a = anticoll();
  if (a.status) {
    console.log(
      "UID:",
      a.data
        .slice(0, 4)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(":")
    );
  }
}, 200);
