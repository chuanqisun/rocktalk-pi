/* @ts-ignore */
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
  TRANSCEIVE: 0x0c,
  RESETPHASE: 0x0f,
  CALC_CRC: 0x03,
};

const PICC = {
  REQIDL: 0x26,
  WUPA: 0x52,

  ANTICOLL_CL1: 0x93,
  ANTICOLL_CL2: 0x95,
  SELECT_CL1: 0x93,
  SELECT_CL2: 0x95,

  READ: 0x30,
  WRITE: 0xa2,
  HALT: 0x50,
  GET_VERSION: 0x60,
};

const STATUS = {
  OK: 0,
  ERR: 2,
};

const NTAG213_USER_START_PAGE = 4;
const NTAG213_USER_PAGE_COUNT = 36;
const NTAG213_USER_END_PAGE = NTAG213_USER_START_PAGE + NTAG213_USER_PAGE_COUNT - 1;

const DEFAULT_OPTIONS = {
  bus: 0,
  device: 0,
  speedHz: 1_000_000,
  mode: SPI.MODE0,

  // Drop-in compatibility:
  // `block` is interpreted as an NTAG213 page.
  block: NTAG213_USER_START_PAGE,

  // `blocks` is interpreted as contiguous NTAG213 pages.
  blocks: [NTAG213_USER_START_PAGE, NTAG213_USER_START_PAGE + 1, NTAG213_USER_START_PAGE + 2],

  // Unused for NTAG213, retained for public API compatibility.
  key: [0xff, 0xff, 0xff, 0xff, 0xff, 0xff],

  pollIntervalMs: 200,

  // Robust-write tuning.
  writeAttempts: 5,
  writeSettleMs: 8,
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

function bufferToText(buffer) {
  return Buffer.from(buffer).toString("utf8").replace(/\0+$/u, "");
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

function assertValidUserPage(page) {
  if (!Number.isInteger(page)) {
    throw new Error("NTAG213 page numbers must be integers");
  }

  if (page < NTAG213_USER_START_PAGE || page > NTAG213_USER_END_PAGE) {
    throw new Error(`NTAG213 page ${page} is outside the user memory range ${NTAG213_USER_START_PAGE}..${NTAG213_USER_END_PAGE}`);
  }
}

function normalizeBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw new Error("NTAG213 pages must be a non-empty array of page numbers");
  }

  const normalized = blocks.map((block) => {
    if (!Number.isInteger(block) || block < 0) {
      throw new Error("NTAG213 page numbers must be non-negative integers");
    }

    assertValidUserPage(block);
    return block;
  });

  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index] !== normalized[index - 1] + 1) {
      throw new Error("NTAG213 text reads and writes require contiguous ascending pages");
    }
  }

  return normalized;
}

function normalizeTextPayload(text, blocks) {
  if (typeof text !== "string") {
    throw new Error("NTAG213 text writes require a UTF-8 string payload");
  }

  const payload = Buffer.from(text, "utf8");
  const capacity = blocks.length * 4;

  if (payload.length > capacity) {
    throw new Error(`Text payload exceeds ${capacity} bytes across pages ${blocks.join(", ")}`);
  }

  const buffer = Buffer.alloc(capacity, 0);
  payload.copy(buffer);
  return buffer;
}

function normalizeKey(key) {
  // Kept only for drop-in compatibility. NTAG213 does not use MIFARE Classic keys.
  if (!Array.isArray(key) && !Buffer.isBuffer(key)) {
    throw new Error("RFID key must be an array or Buffer of 6 bytes");
  }

  if (key.length !== 6) {
    throw new Error("RFID key must be exactly 6 bytes");
  }

  return [...key];
}

function normalizeBlockData(data) {
  // Drop-in compatibility: one public "block" write is one NTAG213 page write.
  if (typeof data === "string") {
    const encoded = Buffer.from(data, "utf8");

    if (encoded.length > 4) {
      throw new Error("NTAG213 page writes cannot exceed 4 UTF-8 bytes");
    }

    const buffer = Buffer.alloc(4, 0);
    encoded.copy(buffer, 0, 0, 4);
    return buffer;
  }

  if (Array.isArray(data) || Buffer.isBuffer(data) || ArrayBuffer.isView(data)) {
    const buffer = ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : Buffer.from(data);

    if (buffer.length !== 4) {
      throw new Error("NTAG213 page writes must be exactly 4 bytes");
    }

    return buffer;
  }

  throw new Error("Write data must be a UTF-8 string, Buffer, or byte array");
}

export default class Rc522 {
  #spi;
  #options;
  #initialized = false;

  /**
   * Create an RC522 reader instance for NTAG213 tags only.
   *
   * Public API is kept compatible with the previous class:
   * - `block` means NTAG213 page.
   * - `blocks` means contiguous NTAG213 pages.
   * - `key` is accepted but unused.
   */
  constructor(options = {}) {
    this.#options = {
      ...DEFAULT_OPTIONS,
      ...options,
      blocks: normalizeBlocks(options.blocks ?? DEFAULT_OPTIONS.blocks),
      key: normalizeKey(options.key ?? DEFAULT_OPTIONS.key),
    };

    assertValidUserPage(this.#options.block);
  }

  /**
   * Wait for an NTAG213 tag and read one 4-byte page.
   *
   * @param {{block?: number, key?: number[] | Buffer, pollIntervalMs?: number, timeoutMs?: number}} [options={}]
   * @returns {Promise<{uid: string, block: number, size: number, data: Buffer, text: string}>}
   */
  async readAsync(options = {}) {
    return this.#withCard(options, async ({ block, uid, size }) => {
      const data = this.#readPage(block);

      if (!data) {
        throw new Error(`Could not read page ${block}`);
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

  /**
   * Wait for an NTAG213 tag, write one 4-byte page, and verify.
   *
   * @param {string | Buffer | number[] | ArrayBufferView} data
   * @param {{block?: number, key?: number[] | Buffer, pollIntervalMs?: number, timeoutMs?: number, writeAttempts?: number}} [options={}]
   * @returns {Promise<{uid: string, block: number, size: number, data: Buffer, text: string}>}
   */
  async writeAsync(data, options = {}) {
    const payload = normalizeBlockData(data);

    return this.#withCard(options, async ({ block, uid, uidBytes, size }) => {
      await this.#writePageRobust(block, payload, uidBytes, {
        attempts: options.writeAttempts ?? this.#options.writeAttempts,
      });

      const verified = this.#readPage(block);

      if (!verified) {
        throw new Error(`Write succeeded but verification read failed for page ${block}`);
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

  /**
   * Wait for an NTAG213 tag and read UTF-8 text across contiguous pages.
   *
   * @param {{blocks?: number[], key?: number[] | Buffer, pollIntervalMs?: number, timeoutMs?: number}} [options={}]
   * @returns {Promise<{uid: string, blocks: number[], size: number, data: Buffer, text: string}>}
   */
  async readTextAsync(options = {}) {
    const blocks = this.#resolveTextBlocks(options);

    return this.#withCard({ ...options, block: blocks[0] }, async ({ uid, size }) => {
      const data = this.#readPages(blocks[0], blocks.length);

      if (!data) {
        throw new Error(`Could not read pages ${blocks.join(", ")}`);
      }

      const buffer = Buffer.from(data);

      return {
        uid,
        blocks,
        size,
        data: buffer,
        text: bufferToText(buffer),
      };
    });
  }

  /**
   * Wait for an NTAG213 tag, write UTF-8 text across contiguous pages, and verify.
   *
   * @param {string} text
   * @param {{blocks?: number[], key?: number[] | Buffer, pollIntervalMs?: number, timeoutMs?: number, writeAttempts?: number}} [options={}]
   * @returns {Promise<{uid: string, blocks: number[], size: number, data: Buffer, text: string}>}
   */
  async writeTextAsync(text, options = {}) {
    const blocks = this.#resolveTextBlocks(options);
    const payload = normalizeTextPayload(text, blocks);

    return this.#withCard({ ...options, block: blocks[0] }, async ({ uid, uidBytes, size }) => {
      const attempts = options.writeAttempts ?? this.#options.writeAttempts;

      for (let index = 0; index < blocks.length; index += 1) {
        const block = blocks[index];
        const chunk = payload.subarray(index * 4, (index + 1) * 4);

        await this.#writePageRobust(block, chunk, uidBytes, { attempts });
      }

      const verified = this.#readPages(blocks[0], blocks.length);

      if (!verified) {
        throw new Error(`Write succeeded but verification read failed for pages ${blocks.join(", ")}`);
      }

      const data = Buffer.from(verified);

      if (!data.equals(payload)) {
        throw new Error(`Write verification failed for pages ${blocks.join(", ")}`);
      }

      return {
        uid,
        blocks,
        size,
        data,
        text: bufferToText(data),
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
        try {
          return await operation({
            block: settings.block,
            size: card.size,
            uid: card.uid,
            uidBytes: card.uidBytes,
          });
        } finally {
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

    // Longer hardware RF timeout. With this prescaler this is roughly tens of ms,
    // giving NTAG EEPROM writes enough time to ACK reliably.
    this.#writeReg(REG.T_RELOAD_L, 0xe8);
    this.#writeReg(REG.T_RELOAD_H, 0x03);

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
    const block = options.block ?? this.#options.block;
    assertValidUserPage(block);

    return {
      block,
      key: normalizeKey(options.key ?? this.#options.key),
      pollIntervalMs: options.pollIntervalMs ?? this.#options.pollIntervalMs,
      timeoutMs: options.timeoutMs ?? 0,
    };
  }

  #resolveTextBlocks(options) {
    return normalizeBlocks(options.blocks ?? this.#options.blocks);
  }

  #findCard() {
    const requestResult = this.#request(PICC.REQIDL);

    if (requestResult.status !== STATUS.OK) {
      return null;
    }

    const selected = this.#selectCardFullUid();

    if (!selected) {
      return null;
    }

    // NTAG213 usually has final SAK 0x00. We intentionally only support
    // Type 2 / NTAG-like tags here.
    if (selected.sak !== 0x00) {
      return null;
    }

    return {
      size: selected.sak,
      uid: bytesToHex(selected.uidBytes),
      uidBytes: selected.uidBytes,
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

  #toCard(command, sendData, { timeoutMs = 50 } = {}) {
    let irqEn = 0x00;
    let waitIrq = 0x00;

    if (command === CMD.TRANSCEIVE) {
      irqEn = 0x77;
      waitIrq = 0x30; // RxIRq | IdleIRq
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

    const deadline = Date.now() + timeoutMs;
    let irqValue = 0;
    let timedOut = false;

    while (true) {
      irqValue = this.#readReg(REG.COM_IRQ);

      if (irqValue & waitIrq) {
        break;
      }

      if (irqValue & 0x01) {
        timedOut = true;
        break;
      }

      if (Date.now() >= deadline) {
        timedOut = true;
        break;
      }
    }

    this.#clearBitMask(REG.BIT_FRAMING, 0x80);

    if (timedOut) {
      this.#writeReg(REG.COMMAND, CMD.IDLE);
      return { status: STATUS.ERR, data: [], backBits: 0, reason: "timeout" };
    }

    const data = [];
    let backBits = 0;
    let fifoLength = 0;
    let lastBits = 0;

    if (command === CMD.TRANSCEIVE) {
      fifoLength = this.#readReg(REG.FIFO_LEVEL);
      lastBits = this.#readReg(REG.CONTROL) & 0x07;
      backBits = lastBits ? (fifoLength - 1) * 8 + lastBits : fifoLength * 8;

      if (fifoLength === 0) {
        fifoLength = 1;
      }

      if (fifoLength > 64) {
        fifoLength = 64;
      }

      for (let index = 0; index < fifoLength; index += 1) {
        data.push(this.#readReg(REG.FIFO_DATA));
      }
    }

    const errReg = this.#readReg(REG.ERROR);

    // For normal byte-aligned frames, keep the classic strict error behavior.
    // For NTAG 4-bit ACK/NAK frames, ProtocolErr can be set by the MFRC522
    // because the response is intentionally short. Ignore ProtocolErr only
    // when a 4-bit frame was actually received.
    const isFourBitResponse = command === CMD.TRANSCEIVE && backBits === 4;
    const fatalMask = isFourBitResponse ? 0x1a : 0x1b;

    if (errReg & fatalMask) {
      this.#writeReg(REG.COMMAND, CMD.IDLE);
      return {
        status: STATUS.ERR,
        data,
        backBits,
        reason: `error:${errReg.toString(16)}`,
      };
    }

    return { status: STATUS.OK, data, backBits };
  }

  #request(requestMode) {
    this.#writeReg(REG.BIT_FRAMING, 0x07);
    const result = this.#toCard(CMD.TRANSCEIVE, [requestMode], { timeoutMs: 25 });

    if (result.status !== STATUS.OK || result.backBits !== 0x10) {
      return { status: STATUS.ERR, data: [] };
    }

    return { status: STATUS.OK, data: result.data };
  }

  #anticollCascade(cascadeCode) {
    this.#writeReg(REG.BIT_FRAMING, 0x00);

    const result = this.#toCard(CMD.TRANSCEIVE, [cascadeCode, 0x20], { timeoutMs: 25 });

    if (result.status !== STATUS.OK || result.data.length !== 5) {
      return null;
    }

    let checksum = 0;

    for (let index = 0; index < 4; index += 1) {
      checksum ^= result.data[index];
    }

    if (checksum !== result.data[4]) {
      return null;
    }

    return result.data;
  }

  #selectCascade(cascadeCode, fiveBytes) {
    const buffer = [cascadeCode, 0x70, ...fiveBytes];
    const crc = this.#calculateCRC(buffer);
    buffer.push(crc[0], crc[1]);

    const result = this.#toCard(CMD.TRANSCEIVE, buffer, { timeoutMs: 25 });

    if (result.status !== STATUS.OK || result.backBits !== 0x18) {
      return null;
    }

    return result.data[0];
  }

  #selectCardFullUid() {
    const cl1 = this.#anticollCascade(PICC.ANTICOLL_CL1);

    if (!cl1) {
      return null;
    }

    const sak1 = this.#selectCascade(PICC.SELECT_CL1, cl1);

    if (sak1 == null) {
      return null;
    }

    if ((sak1 & 0x04) === 0) {
      return {
        uidBytes: cl1.slice(0, 4),
        sak: sak1,
      };
    }

    if (cl1[0] !== 0x88) {
      return null;
    }

    const cl2 = this.#anticollCascade(PICC.ANTICOLL_CL2);

    if (!cl2) {
      return null;
    }

    const sak2 = this.#selectCascade(PICC.SELECT_CL2, cl2);

    if (sak2 == null) {
      return null;
    }

    return {
      uidBytes: [...cl1.slice(1, 4), ...cl2.slice(0, 4)],
      sak: sak2,
    };
  }

  #calculateCRC(data, { timeoutMs = 20 } = {}) {
    this.#writeReg(REG.COMMAND, CMD.IDLE);
    this.#clearBitMask(REG.DIV_IRQ, 0x04);
    this.#setBitMask(REG.FIFO_LEVEL, 0x80);

    for (const byte of data) {
      this.#writeReg(REG.FIFO_DATA, byte);
    }

    this.#writeReg(REG.COMMAND, CMD.CALC_CRC);

    const deadline = Date.now() + timeoutMs;
    let completed = false;

    while (Date.now() < deadline) {
      if (this.#readReg(REG.DIV_IRQ) & 0x04) {
        completed = true;
        break;
      }
    }

    this.#writeReg(REG.COMMAND, CMD.IDLE);

    if (!completed) {
      throw new Error("Timed out calculating RC522 CRC");
    }

    return [this.#readReg(REG.CRC_RESULT_L), this.#readReg(REG.CRC_RESULT_H)];
  }

  #readPage(page) {
    assertValidUserPage(page);

    const block = this.#readPagesRaw(page);

    if (!block) {
      return null;
    }

    return block.slice(0, 4);
  }

  #readPages(startPage, pageCount) {
    const result = [];

    for (let index = 0; index < pageCount; index += 1) {
      const page = startPage + index;
      assertValidUserPage(page);

      const data = this.#readPage(page);

      if (!data) {
        return null;
      }

      result.push(...data);
    }

    return result;
  }

  #readPagesRaw(page) {
    const buffer = [PICC.READ, page];
    const crc = this.#calculateCRC(buffer);
    buffer.push(crc[0], crc[1]);

    const result = this.#toCard(CMD.TRANSCEIVE, buffer, { timeoutMs: 30 });

    if (result.status !== STATUS.OK || result.data.length !== 16) {
      return null;
    }

    return result.data;
  }

  async #writePageRobust(page, data4, uidBytes, { attempts = 5 } = {}) {
    assertValidUserPage(page);

    if (!data4 || data4.length !== 4) {
      throw new Error("NTAG213 page writes require exactly 4 bytes");
    }

    let lastReason = "unknown";

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const writeResult = this.#writePageOnce(page, data4);

      if (writeResult.ok) {
        await delay(this.#options.writeSettleMs);

        const verified = this.#readPage(page);

        if (verified && Buffer.from(verified).equals(Buffer.from(data4))) {
          return true;
        }

        lastReason = "verify-mismatch";
      } else {
        lastReason = writeResult.reason ?? "no-ack";
      }

      await delay(8 + attempt * 5);

      // A failed NTAG command may leave the tag back in IDLE or otherwise not
      // selected. Re-select before the next attempt and verify the UID did not change.
      this.#halt();
      await delay(2);

      const request = this.#request(PICC.REQIDL);

      if (request.status !== STATUS.OK) {
        continue;
      }

      const selected = this.#selectCardFullUid();

      if (!selected) {
        continue;
      }

      if (uidBytes && !arraysEqual(selected.uidBytes, uidBytes)) {
        throw new Error("Different NTAG213 tag detected during write retry");
      }
    }

    throw new Error(`Could not write page ${page}; failed after ${attempts} attempts (${lastReason})`);
  }

  #writePageOnce(page, data4) {
    const buffer = [PICC.WRITE, page, data4[0], data4[1], data4[2], data4[3]];
    const crc = this.#calculateCRC(buffer);
    buffer.push(crc[0], crc[1]);

    // NTAG EEPROM programming needs a longer wait than normal READ.
    const result = this.#toCard(CMD.TRANSCEIVE, buffer, { timeoutMs: 60 });

    if (result.status !== STATUS.OK) {
      return { ok: false, reason: result.reason ?? "transceive-error" };
    }

    if (result.backBits !== 4 || result.data.length === 0) {
      return { ok: false, reason: `bad-ack-frame:${result.backBits}` };
    }

    const ack = result.data[0] & 0x0f;

    if (ack !== 0x0a) {
      return { ok: false, reason: `nak:${ack.toString(16)}` };
    }

    return { ok: true };
  }

  #halt() {
    const buffer = [PICC.HALT, 0x00];
    const crc = this.#calculateCRC(buffer);
    buffer.push(crc[0], crc[1]);
    this.#toCard(CMD.TRANSCEIVE, buffer, { timeoutMs: 10 });
  }
}

export { blockToText, bytesToHex };
