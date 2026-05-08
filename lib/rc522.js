import SPI from "spi-device";

const REG = {
  COMMAND: 0x01,
  COM_I_EN: 0x02,
  COM_IRQ: 0x04,
  DIV_IRQ: 0x05,
  ERROR: 0x06,
  STATUS2: 0x08,
  FIFO_DATA: 0x09,
  FIFO_LEVEL: 0x0a,
  CONTROL: 0x0c,
  BIT_FRAMING: 0x0d,
  MODE: 0x11,
  TX_CONTROL: 0x14,
  TX_ASK: 0x15,
  CRC_RESULT_H: 0x21,
  CRC_RESULT_L: 0x22,
  T_MODE: 0x2a,
  T_PRESCALER: 0x2b,
  T_RELOAD_H: 0x2c,
  T_RELOAD_L: 0x2d,
  VERSION: 0x37,
};

const CMD = {
  IDLE: 0x00,
  AUTHENT: 0x0e,
  TRANSCEIVE: 0x0c,
  RESETPHASE: 0x0f,
  CALC_CRC: 0x03,
};

const PICC = {
  REQIDL: 0x26,
  ANTICOLL: 0x93,
  SELECTTAG: 0x93,
  AUTHENT1A: 0x60,
  READ: 0x30,
  WRITE: 0xa0,
  HALT: 0x50,
};

const STATUS = {
  OK: 0,
  ERR: 2,
};

const DEFAULT_KEY = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const DEFAULT_OPTIONS = {
  bus: 0,
  device: 0,
  speedHz: 1_000_000,
  mode: SPI.MODE0,
  block: 8,
  key: DEFAULT_KEY,
  pollIntervalMs: 50,
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bytesToHex(bytes) {
  return bytes.map((value) => value.toString(16).padStart(2, "0")).join(":");
}

function blockToText(block) {
  return Buffer.from(block).toString("utf8").replace(/\0/g, "").trim();
}

function normalizeKey(key) {
  if (!Array.isArray(key) && !Buffer.isBuffer(key)) {
    throw new Error("RFID key must be an array or Buffer of 6 bytes");
  }

  if (key.length !== 6) {
    throw new Error("RFID key must be exactly 6 bytes");
  }

  return [...key];
}

function normalizeBlockData(data) {
  if (typeof data === "string") {
    const buffer = Buffer.alloc(16, 0);
    Buffer.from(data, "utf8").copy(buffer, 0, 0, 16);
    return buffer;
  }

  if (Array.isArray(data) || Buffer.isBuffer(data) || ArrayBuffer.isView(data)) {
    const buffer = Buffer.from(data);

    if (buffer.length !== 16) {
      throw new Error("MIFARE Classic block writes must be exactly 16 bytes");
    }

    return buffer;
  }

  throw new Error("Write data must be a UTF-8 string, Buffer, or byte array");
}

export default class Rc522 {
  #spi;
  #options;
  #initialized = false;

  constructor(options = {}) {
    this.#options = {
      ...DEFAULT_OPTIONS,
      ...options,
      key: normalizeKey(options.key ?? DEFAULT_OPTIONS.key),
    };
  }

  async readAsync(options = {}) {
    return this.#withCard(options, async ({ block, uid, size }) => {
      const data = this.#readBlock(block);

      if (!data) {
        throw new Error(`Could not read block ${block}`);
      }

      return {
        uid,
        block,
        size,
        data: Buffer.from(data),
        text: blockToText(data),
      };
    });
  }

  async writeAsync(data, options = {}) {
    const payload = normalizeBlockData(data);

    return this.#withCard(options, async ({ block, uid, size }) => {
      const written = this.#writeBlock(block, payload);

      if (!written) {
        throw new Error(`Could not write block ${block}`);
      }

      const verified = this.#readBlock(block);

      if (!verified) {
        throw new Error(`Write succeeded but verification read failed for block ${block}`);
      }

      return {
        uid,
        block,
        size,
        data: Buffer.from(verified),
        text: blockToText(verified),
      };
    });
  }

  close() {
    if (!this.#spi) {
      return;
    }

    this.#antennaOff();
    this.#spi.closeSync();
    this.#spi = null;
    this.#initialized = false;
  }

  async #withCard(options, operation) {
    const settings = this.#resolveOperationOptions(options);
    await this.#ensureInitialized();

    const startedAt = Date.now();

    while (true) {
      const card = this.#findCard();

      if (card) {
        const authenticated = this.#authenticate(PICC.AUTHENT1A, settings.block, settings.key, card.uidBytes);

        if (!authenticated) {
          this.#stopCrypto();
          this.#halt();
          throw new Error(`Authentication failed for block ${settings.block}`);
        }

        try {
          return await operation({
            block: settings.block,
            size: card.size,
            uid: card.uid,
          });
        } finally {
          this.#stopCrypto();
          this.#halt();
        }
      }

      if (settings.timeoutMs > 0 && Date.now() - startedAt >= settings.timeoutMs) {
        throw new Error("Timed out waiting for RFID tag");
      }

      await delay(settings.pollIntervalMs);
    }
  }

  async #ensureInitialized() {
    if (this.#initialized) {
      return;
    }

    this.#spi = SPI.openSync(this.#options.bus, this.#options.device, {
      mode: this.#options.mode,
      maxSpeedHz: this.#options.speedHz,
    });

    this.#reset();
    this.#writeReg(REG.T_MODE, 0x8d);
    this.#writeReg(REG.T_PRESCALER, 0x3e);
    this.#writeReg(REG.T_RELOAD_L, 30);
    this.#writeReg(REG.T_RELOAD_H, 0);
    this.#writeReg(REG.TX_ASK, 0x40);
    this.#writeReg(REG.MODE, 0x3d);
    this.#antennaOn();

    const version = this.#readReg(REG.VERSION);

    if (version === 0x00 || version === 0xff) {
      this.close();
      throw new Error("RC522 not detected. Check wiring, SPI, power, and CE0.");
    }

    this.#initialized = true;
  }

  #resolveOperationOptions(options) {
    return {
      block: options.block ?? this.#options.block,
      key: normalizeKey(options.key ?? this.#options.key),
      pollIntervalMs: options.pollIntervalMs ?? this.#options.pollIntervalMs,
      timeoutMs: options.timeoutMs ?? 0,
    };
  }

  #findCard() {
    const requestResult = this.#request(PICC.REQIDL);

    if (requestResult.status !== STATUS.OK) {
      return null;
    }

    const antiCollision = this.#anticoll();

    if (antiCollision.status !== STATUS.OK) {
      return null;
    }

    const size = this.#selectTag(antiCollision.uid);

    if (!size) {
      return null;
    }

    return {
      size,
      uid: bytesToHex(antiCollision.uid.slice(0, 4)),
      uidBytes: antiCollision.uid,
    };
  }

  #transfer(bytes) {
    const message = [
      {
        sendBuffer: Buffer.from(bytes),
        receiveBuffer: Buffer.alloc(bytes.length),
        byteLength: bytes.length,
        speedHz: this.#options.speedHz,
      },
    ];

    this.#spi.transferSync(message);
    return message[0].receiveBuffer;
  }

  #writeReg(reg, value) {
    this.#transfer([(reg << 1) & 0x7e, value]);
  }

  #readReg(reg) {
    return this.#transfer([((reg << 1) & 0x7e) | 0x80, 0x00])[1];
  }

  #setBitMask(reg, mask) {
    this.#writeReg(reg, this.#readReg(reg) | mask);
  }

  #clearBitMask(reg, mask) {
    this.#writeReg(reg, this.#readReg(reg) & ~mask);
  }

  #reset() {
    this.#writeReg(REG.COMMAND, CMD.RESETPHASE);
  }

  #antennaOn() {
    const value = this.#readReg(REG.TX_CONTROL);

    if ((value & 0x03) !== 0x03) {
      this.#setBitMask(REG.TX_CONTROL, 0x03);
    }
  }

  #antennaOff() {
    this.#clearBitMask(REG.TX_CONTROL, 0x03);
  }

  #toCard(command, sendData) {
    let irqEn = 0x00;
    let waitIrq = 0x00;

    if (command === CMD.AUTHENT) {
      irqEn = 0x12;
      waitIrq = 0x10;
    } else if (command === CMD.TRANSCEIVE) {
      irqEn = 0x77;
      waitIrq = 0x30;
    }

    this.#writeReg(REG.COM_I_EN, irqEn | 0x80);
    this.#clearBitMask(REG.COM_IRQ, 0x80);
    this.#setBitMask(REG.FIFO_LEVEL, 0x80);
    this.#writeReg(REG.COMMAND, CMD.IDLE);

    for (const byte of sendData) {
      this.#writeReg(REG.FIFO_DATA, byte);
    }

    this.#writeReg(REG.COMMAND, command);

    if (command === CMD.TRANSCEIVE) {
      this.#setBitMask(REG.BIT_FRAMING, 0x80);
    }

    let retries = 2000;
    let irqValue;

    do {
      irqValue = this.#readReg(REG.COM_IRQ);
      retries -= 1;
    } while (retries !== 0 && !(irqValue & 0x01) && !(irqValue & waitIrq));

    this.#clearBitMask(REG.BIT_FRAMING, 0x80);

    if (retries === 0 || this.#readReg(REG.ERROR) & 0x1b) {
      return { status: STATUS.ERR, data: [], backBits: 0 };
    }

    let backBits = 0;
    const data = [];

    if (command === CMD.TRANSCEIVE) {
      let fifoLength = this.#readReg(REG.FIFO_LEVEL);
      const lastBits = this.#readReg(REG.CONTROL) & 0x07;

      backBits = lastBits ? (fifoLength - 1) * 8 + lastBits : fifoLength * 8;

      if (fifoLength === 0) {
        fifoLength = 1;
      }

      if (fifoLength > 16) {
        fifoLength = 16;
      }

      for (let index = 0; index < fifoLength; index += 1) {
        data.push(this.#readReg(REG.FIFO_DATA));
      }
    }

    return { status: STATUS.OK, data, backBits };
  }

  #request(requestMode) {
    this.#writeReg(REG.BIT_FRAMING, 0x07);
    const result = this.#toCard(CMD.TRANSCEIVE, [requestMode]);

    if (result.status !== STATUS.OK || result.backBits !== 0x10) {
      return { status: STATUS.ERR, data: [] };
    }

    return { status: STATUS.OK, data: result.data };
  }

  #anticoll() {
    this.#writeReg(REG.BIT_FRAMING, 0x00);
    const result = this.#toCard(CMD.TRANSCEIVE, [PICC.ANTICOLL, 0x20]);

    if (result.status !== STATUS.OK || result.data.length !== 5) {
      return { status: STATUS.ERR, uid: [] };
    }

    let checksum = 0;

    for (let index = 0; index < 4; index += 1) {
      checksum ^= result.data[index];
    }

    if (checksum !== result.data[4]) {
      return { status: STATUS.ERR, uid: [] };
    }

    return { status: STATUS.OK, uid: result.data };
  }

  #calculateCRC(data) {
    this.#clearBitMask(REG.DIV_IRQ, 0x04);
    this.#setBitMask(REG.FIFO_LEVEL, 0x80);

    for (const byte of data) {
      this.#writeReg(REG.FIFO_DATA, byte);
    }

    this.#writeReg(REG.COMMAND, CMD.CALC_CRC);

    let retries = 255;
    while (retries > 0) {
      if (this.#readReg(REG.DIV_IRQ) & 0x04) {
        break;
      }

      retries -= 1;
    }

    return [this.#readReg(REG.CRC_RESULT_L), this.#readReg(REG.CRC_RESULT_H)];
  }

  #selectTag(uid) {
    const buffer = [PICC.SELECTTAG, 0x70, ...uid.slice(0, 5)];
    const crc = this.#calculateCRC(buffer);
    buffer.push(crc[0], crc[1]);

    const result = this.#toCard(CMD.TRANSCEIVE, buffer);
    return result.status === STATUS.OK && result.backBits === 0x18 ? result.data[0] : 0;
  }

  #authenticate(authMode, blockAddr, key, uid) {
    const result = this.#toCard(CMD.AUTHENT, [authMode, blockAddr, ...key, ...uid.slice(0, 4)]);

    if (result.status !== STATUS.OK) {
      return false;
    }

    return Boolean(this.#readReg(REG.STATUS2) & 0x08);
  }

  #stopCrypto() {
    this.#clearBitMask(REG.STATUS2, 0x08);
  }

  #readBlock(blockAddr) {
    const buffer = [PICC.READ, blockAddr];
    const crc = this.#calculateCRC(buffer);
    buffer.push(crc[0], crc[1]);

    const result = this.#toCard(CMD.TRANSCEIVE, buffer);

    if (result.status !== STATUS.OK || result.data.length !== 16) {
      return null;
    }

    return result.data;
  }

  #writeBlock(blockAddr, data16) {
    let buffer = [PICC.WRITE, blockAddr];
    let crc = this.#calculateCRC(buffer);
    buffer.push(crc[0], crc[1]);

    let result = this.#toCard(CMD.TRANSCEIVE, buffer);

    if (result.status !== STATUS.OK || result.backBits !== 4 || (result.data[0] & 0x0f) !== 0x0a) {
      return false;
    }

    buffer = [...data16];
    crc = this.#calculateCRC(buffer);
    buffer.push(crc[0], crc[1]);

    result = this.#toCard(CMD.TRANSCEIVE, buffer);

    return result.status === STATUS.OK && result.backBits === 4 && (result.data[0] & 0x0f) === 0x0a;
  }

  #halt() {
    const buffer = [PICC.HALT, 0x00];
    const crc = this.#calculateCRC(buffer);
    buffer.push(crc[0], crc[1]);
    this.#toCard(CMD.TRANSCEIVE, buffer);
  }
}

export { blockToText, bytesToHex };
