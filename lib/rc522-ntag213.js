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

// NTAG213 user memory: pages 4..39 = 36 pages = 144 bytes
const NTAG213_USER_START_PAGE = 4;
const NTAG213_USER_PAGE_COUNT = 36;
const NTAG213_USER_CAPACITY_BYTES = NTAG213_USER_PAGE_COUNT * 4;

const DEFAULT_OPTIONS = {
  bus: 0,
  device: 0,
  speedHz: 1_000_000,
  mode: SPI.MODE0,
  // For drop-in compatibility, `block` maps to an NTAG page.
  // Default to first user page.
  block: NTAG213_USER_START_PAGE,
  // For drop-in compatibility, `blocks` maps to NTAG pages.
  // Default to first three user pages (12 bytes).
  blocks: [NTAG213_USER_START_PAGE, NTAG213_USER_START_PAGE + 1, NTAG213_USER_START_PAGE + 2],
  // Key is unused for NTAG213 (no Crypto1 authentication) but kept
  // in the public option shape for drop-in compatibility.
  key: [0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
  pollIntervalMs: 200,
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bytesToHex(bytes) {
  return bytes.map((value) => value.toString(16).padStart(2, "0")).join(":");
}

function pageToText(pageBytes) {
  return Buffer.from(pageBytes).toString("utf8").replace(/\0/g, "").trim();
}

function bufferToText(buffer) {
  return Buffer.from(buffer).toString("utf8").replace(/\0+$/u, "");
}

function assertValidUserPage(page) {
  if (!Number.isInteger(page)) {
    throw new Error("NTAG213 page numbers must be integers");
  }

  if (page < NTAG213_USER_START_PAGE || page >= NTAG213_USER_START_PAGE + NTAG213_USER_PAGE_COUNT) {
    throw new Error(
      `NTAG213 page ${page} is outside the user memory range ` + `${NTAG213_USER_START_PAGE}..${NTAG213_USER_START_PAGE + NTAG213_USER_PAGE_COUNT - 1}`
    );
  }
}

function normalizeBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw new Error("NTAG213 page list must be a non-empty array of page numbers");
  }

  const normalized = blocks.map((page) => {
    if (!Number.isInteger(page) || page < 0) {
      throw new Error("NTAG213 page numbers must be non-negative integers");
    }

    assertValidUserPage(page);
    return page;
  });

  // Require pages to be contiguous and ascending. This keeps the
  // "text spans multiple slots" semantics predictable on NTAG.
  for (let i = 1; i < normalized.length; i += 1) {
    if (normalized[i] !== normalized[i - 1] + 1) {
      throw new Error("NTAG213 multi-page reads and writes must use contiguous ascending pages");
    }
  }

  return normalized;
}

function normalizeTextPayload(text, pages) {
  if (typeof text !== "string") {
    throw new Error("NTAG213 text writes require a UTF-8 string payload");
  }

  const payload = Buffer.from(text, "utf8");
  const capacity = pages.length * 4;

  if (payload.length > capacity) {
    throw new Error(`Text payload exceeds ${capacity} bytes across pages ${pages.join(", ")}`);
  }

  const buffer = Buffer.alloc(capacity, 0);
  payload.copy(buffer);
  return buffer;
}

function normalizeKey(key) {
  // Kept for API compatibility only; not used on NTAG213.
  if (key == null) {
    return [...DEFAULT_OPTIONS.key];
  }

  if (!Array.isArray(key) && !Buffer.isBuffer(key)) {
    throw new Error("Key must be an array or Buffer of 6 bytes");
  }

  if (key.length !== 6) {
    throw new Error("Key must be exactly 6 bytes");
  }

  return [...key];
}

function normalizeBlockData(data) {
  // On NTAG213, one "block" is one page (4 bytes).
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
   * Create an RC522 reader instance configured for NTAG213.
   *
   * @param {{bus?: number, device?: number, speedHz?: number, mode?: number, block?: number, blocks?: number[], key?: number[] | Buffer, pollIntervalMs?: number}} [options={}]
   * Optional reader configuration for the SPI bus/device, transfer speed, SPI mode, default page (mapped to `block`),
   * default page range (mapped to `blocks`), legacy `key` (unused), and polling interval.
   * @throws {Error} If page numbers fall outside NTAG213 user memory or are not contiguous.
   */
  constructor(options = {}) {
    this.#options = {
      ...DEFAULT_OPTIONS,
      ...options,
      blocks: normalizeBlocks(options.blocks ?? DEFAULT_OPTIONS.blocks),
      key: normalizeKey(options.key ?? DEFAULT_OPTIONS.key),
    };

    if (options.block != null) {
      assertValidUserPage(options.block);
    }
  }

  /**
   * Wait for an NTAG213 tag and read 4 bytes from the configured page.
   *
   * @param {{block?: number, key?: number[] | Buffer, pollIntervalMs?: number, timeoutMs?: number}} [options={}]
   * @returns {Promise<{uid: string, block: number, size: number, data: Buffer, text: string}>}
   */
  async readAsync(options = {}) {
    return this.#withCard(options, async ({ block, uid, size }) => {
      const page = this.#readPage(block);

      if (!page) {
        throw new Error(`Could not read page ${block}`);
      }

      return {
        uid,
        block,
        size,
        data: Buffer.from(page),
        text: pageToText(page),
      };
    });
  }

  /**
   * Wait for an NTAG213 tag, write 4 bytes to the configured page, and verify.
   *
   * @param {string | Buffer | number[] | ArrayBufferView} data
   * @param {{block?: number, key?: number[] | Buffer, pollIntervalMs?: number, timeoutMs?: number}} [options={}]
   * @returns {Promise<{uid: string, block: number, size: number, data: Buffer, text: string}>}
   */
  async writeAsync(data, options = {}) {
    const payload = normalizeBlockData(data);

    return this.#withCard(options, async ({ block, uid, size }) => {
      const written = this.#writePage(block, payload);

      if (!written) {
        throw new Error(`Could not write page ${block}`);
      }

      const verified = this.#readPage(block);

      if (!verified) {
        throw new Error(`Write succeeded but verification read failed for page ${block}`);
      }

      const verifiedBuffer = Buffer.from(verified);

      if (!verifiedBuffer.equals(payload)) {
        throw new Error(`Write verification mismatch for page ${block}`);
      }

      return {
        uid,
        block,
        size,
        data: verifiedBuffer,
        text: pageToText(verified),
      };
    });
  }

  /**
   * Wait for an NTAG213 tag and read UTF-8 text spanning multiple contiguous pages.
   *
   * @param {{blocks?: number[], key?: number[] | Buffer, pollIntervalMs?: number, timeoutMs?: number}} [options={}]
   * @returns {Promise<{uid: string, blocks: number[], size: number, data: Buffer, text: string}>}
   */
  async readTextAsync(options = {}) {
    const pages = this.#resolveTextBlocks(options);

    return this.#withCard({ ...options, block: pages[0] }, async ({ uid, size }) => {
      const data = this.#readPages(pages[0], pages.length);

      if (!data) {
        throw new Error(`Could not read pages ${pages.join(", ")}`);
      }

      const buffer = Buffer.from(data);

      return {
        uid,
        blocks: pages,
        size,
        data: buffer,
        text: bufferToText(buffer),
      };
    });
  }

  /**
   * Wait for an NTAG213 tag, write UTF-8 text across multiple contiguous pages, and verify.
   *
   * @param {string} text
   * @param {{blocks?: number[], key?: number[] | Buffer, pollIntervalMs?: number, timeoutMs?: number}} [options={}]
   * @returns {Promise<{uid: string, blocks: number[], size: number, data: Buffer, text: string}>}
   */
  async writeTextAsync(text, options = {}) {
    const pages = this.#resolveTextBlocks(options);
    const payload = normalizeTextPayload(text, pages);

    return this.#withCard({ ...options, block: pages[0] }, async ({ uid, size }) => {
      for (let index = 0; index < pages.length; index += 1) {
        const page = pages[index];
        const chunk = payload.subarray(index * 4, (index + 1) * 4);

        if (!this.#writePage(page, chunk)) {
          throw new Error(`Could not write page ${page}`);
        }
      }

      const verified = this.#readPages(pages[0], pages.length);

      if (!verified) {
        throw new Error(`Write succeeded but verification read failed for pages ${pages.join(", ")}`);
      }

      const verifiedBuffer = Buffer.from(verified);

      if (!verifiedBuffer.equals(payload)) {
        throw new Error(`Write verification failed for pages ${pages.join(", ")}`);
      }

      return {
        uid,
        blocks: pages,
        size,
        data: verifiedBuffer,
        text: bufferToText(verifiedBuffer),
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

  #toCard(command, sendData) {
    let irqEn = 0x00;
    let waitIrq = 0x00;

    if (command === CMD.TRANSCEIVE) {
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

      // MFRC522 FIFO is 64 bytes.
      if (fifoLength > 64) {
        fifoLength = 64;
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

  #anticollCascade(cascadeCode) {
    this.#writeReg(REG.BIT_FRAMING, 0x00);

    const result = this.#toCard(CMD.TRANSCEIVE, [cascadeCode, 0x20]);

    if (result.status !== STATUS.OK || result.data.length !== 5) {
      return null;
    }

    let bcc = 0;
    for (let i = 0; i < 4; i += 1) {
      bcc ^= result.data[i];
    }

    if (bcc !== result.data[4]) {
      return null;
    }

    return result.data;
  }

  #selectCascade(cascadeCode, fiveBytes) {
    const buffer = [cascadeCode, 0x70, ...fiveBytes];
    const crc = this.#calculateCRC(buffer);
    buffer.push(crc[0], crc[1]);

    const result = this.#toCard(CMD.TRANSCEIVE, buffer);

    if (result.status !== STATUS.OK || result.backBits !== 0x18) {
      return null;
    }

    return result.data[0]; // SAK
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

    // No cascade bit -> 4-byte UID (not typical for NTAG213, but accepted)
    if ((sak1 & 0x04) === 0) {
      return {
        uidBytes: cl1.slice(0, 4),
        sak: sak1,
      };
    }

    // Cascade bit set -> expect 0x88 cascade tag and a CL2 round (NTAG213: 7-byte UID)
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

  /**
   * NTAG READ (0x30) returns 16 bytes starting at the given page (4 pages worth).
   * Returns a 4-byte array containing only the requested page.
   */
  #readPage(page) {
    const block = this.#readPagesRaw(page);

    if (!block) {
      return null;
    }

    return block.slice(0, 4);
  }

  /**
   * Read a contiguous range of NTAG pages, one READ per page so we never
   * cross past the end of user memory accidentally.
   */
  #readPages(startPage, pageCount) {
    const result = [];

    for (let i = 0; i < pageCount; i += 1) {
      const page = startPage + i;
      const data = this.#readPage(page);

      if (!data) {
        return null;
      }

      result.push(...data);
    }

    return result;
  }

  /**
   * Send READ 0x30 for `page` and return the 16-byte response (pages page..page+3).
   */
  #readPagesRaw(page) {
    const buffer = [PICC.READ, page];
    const crc = this.#calculateCRC(buffer);
    buffer.push(crc[0], crc[1]);

    const result = this.#toCard(CMD.TRANSCEIVE, buffer);

    if (result.status !== STATUS.OK || result.data.length !== 16) {
      return null;
    }

    return result.data;
  }

  /**
   * NTAG WRITE (0xA2): write exactly 4 bytes to one page.
   * Tag ACKs with a 4-bit 0xA on success, 0x0/0x1/0x5 on NAK.
   */
  #writePage(page, data4) {
    if (!data4 || data4.length !== 4) {
      throw new Error("NTAG213 page writes require exactly 4 bytes");
    }

    assertValidUserPage(page);

    const buffer = [PICC.WRITE, page, data4[0], data4[1], data4[2], data4[3]];
    const crc = this.#calculateCRC(buffer);
    buffer.push(crc[0], crc[1]);

    const result = this.#toCard(CMD.TRANSCEIVE, buffer);

    return result.status === STATUS.OK && result.backBits === 4 && result.data.length > 0 && (result.data[0] & 0x0f) === 0x0a;
  }

  #halt() {
    const buffer = [PICC.HALT, 0x00];
    const crc = this.#calculateCRC(buffer);
    buffer.push(crc[0], crc[1]);
    this.#toCard(CMD.TRANSCEIVE, buffer);
  }
}
