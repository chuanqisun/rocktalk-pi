/* @ts-ignore */
import SPI from "spi-device";

const REG = {
  COMMAND: 0x01,
  COM_I_EN: 0x02,
  COM_IRQ: 0x04,
  DIV_IRQ: 0x05,
  ERROR: 0x06,
  FIFO_DATA: 0x09,
  FIFO_LEVEL: 0x0a,
  CONTROL: 0x0c,
  BIT_FRAMING: 0x0d,
  COLL: 0x0e,
  MODE: 0x11,
  TX_MODE: 0x12,
  RX_MODE: 0x13,
  TX_CONTROL: 0x14,
  TX_ASK: 0x15,
  RF_CFG: 0x26,
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
  CALC_CRC: 0x03,
  SOFTRESET: 0x0f,
};

const PICC = {
  REQA: 0x26,
  WUPA: 0x52,
  ANTICOLL_CL1: 0x93,
  ANTICOLL_CL2: 0x95,
  SELECT_CL1: 0x93,
  SELECT_CL2: 0x95,
  READ: 0x30,
  FAST_READ: 0x3a,
  WRITE: 0xa2,
  HALT: 0x50,
};

const NTAG213_USER_START_PAGE = 4;
const NTAG213_USER_PAGE_COUNT = 36;
const NTAG213_USER_END_PAGE = NTAG213_USER_START_PAGE + NTAG213_USER_PAGE_COUNT - 1;
const NTAG213_PAGE_SIZE = 4;
const NTAG213_STANDARD_READ_PAGE_COUNT = 4;
const NTAG213_READ_RESPONSE_LENGTH = NTAG213_STANDARD_READ_PAGE_COUNT * NTAG213_PAGE_SIZE;
const NTAG213_FAST_READ_MAX_PAGES = 15;
const CRC_A_BYTE_LENGTH = 2;
const NTAG213_MAX_WRITE_BYTES = 32;
const NTAG213_DEFAULT_TEXT_PAGE_COUNT = NTAG213_MAX_WRITE_BYTES / NTAG213_PAGE_SIZE;

const DEFAULT_OPTIONS = {
  bus: 0,
  device: 0,
  speedHz: 1_000_000,
  mode: SPI.MODE0,
  block: NTAG213_USER_START_PAGE,
  blocks: Array.from({ length: NTAG213_DEFAULT_TEXT_PAGE_COUNT }, (_, index) => NTAG213_USER_START_PAGE + index),
  pollIntervalMs: 200,
  writeAttempts: 5,
  writeSettleMs: 12,
  interCommandSettleMs: 3,
  verifyPollMs: 8,
  verifyTimeoutMs: 80,
  writeAckTimeoutMs: 20,
  writeRecoveryReselectAttempts: 3,
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bytesToHex(bytes) {
  return bytes.map((value) => value.toString(16).padStart(2, "0")).join(":");
}

function blockToText(block) {
  return Buffer.from(block).toString("utf8").replace(/\0+$/u, "").trim();
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

function assertValidUserPageRange(startPage, pageCount) {
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw new Error("NTAG213 page counts must be positive integers");
  }

  assertValidUserPage(startPage);
  assertValidUserPage(startPage + pageCount - 1);
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
  const capacity = blocks.length * NTAG213_PAGE_SIZE;

  if (payload.length > capacity) {
    throw new Error(`Text payload exceeds ${capacity} bytes across pages ${blocks.join(", ")}`);
  }

  const buffer = Buffer.alloc(capacity, 0x00);
  payload.copy(buffer);
  return buffer;
}

function normalizeWritePayload(data) {
  let buffer;

  if (typeof data === "string") {
    const encoded = Buffer.from(data, "utf8");
    buffer = encoded;
  } else if (Array.isArray(data) || Buffer.isBuffer(data) || ArrayBuffer.isView(data)) {
    buffer = ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : Buffer.from(data);
  } else {
    throw new Error("Write data must be a UTF-8 string, Buffer, or byte array");
  }

  if (buffer.length > NTAG213_MAX_WRITE_BYTES) {
    throw new Error(`NTAG213 writes cannot exceed ${NTAG213_MAX_WRITE_BYTES} bytes`);
  }

  const pageCount = Math.max(1, Math.ceil(buffer.length / NTAG213_PAGE_SIZE));
  const payload = Buffer.alloc(pageCount * NTAG213_PAGE_SIZE, 0x00);
  buffer.copy(payload);

  return payload;
}

function trimTrailingNullBytes(buffer) {
  let end = buffer.length;

  while (end > 0 && buffer[end - 1] === 0x00) {
    end -= 1;
  }

  return buffer.subarray(0, end);
}

export default class Rc522 {
  #spi = null;
  #options;
  #initialized = false;

  constructor(options = {}) {
    this.#options = {
      ...DEFAULT_OPTIONS,
      ...options,
      blocks: normalizeBlocks(options.blocks ?? DEFAULT_OPTIONS.blocks),
    };

    assertValidUserPage(this.#options.block);
  }

  async readAsync(options = {}) {
    return this.#withCard(options, ({ block, uid, size }) => {
      const data = this.#readPage(block);

      if (!data) {
        throw new Error(`Could not read page ${block}`);
      }

      const buffer = Buffer.from(data);

      return {
        uid,
        block,
        size,
        data: buffer,
        text: blockToText(buffer),
      };
    });
  }

  async writeAsync(data, options = {}) {
    const payload = normalizeWritePayload(data);
    const block = options.block ?? this.#options.block;
    assertValidUserPageRange(block, payload.length / NTAG213_PAGE_SIZE);

    return this.#withCard(options, async ({ block, uid, uidBytes, size }) => {
      await delay(this.#options.interCommandSettleMs);
      const buffer = await this.#writeChunkRobust(block, payload, uidBytes, options.writeAttempts ?? this.#options.writeAttempts);

      return {
        uid,
        block,
        size,
        data: buffer,
        text: bufferToText(trimTrailingNullBytes(buffer)),
      };
    });
  }

  async readTextAsync(options = {}) {
    const blocks = this.#resolveTextBlocks(options);

    return this.#withCard({ ...options, block: blocks[0] }, ({ uid, size }) => {
      const data = this.#readPages(blocks[0], blocks.length);

      if (!data) {
        throw new Error(`Could not read pages ${blocks.join(", ")}`);
      }

      const raw = Buffer.from(data);
      const trimmed = trimTrailingNullBytes(raw);

      return {
        uid,
        blocks,
        size,
        data: trimmed,
        text: bufferToText(trimmed),
      };
    });
  }

  async writeTextAsync(text, options = {}) {
    const blocks = this.#resolveTextBlocks(options);
    const payload = normalizeTextPayload(text, blocks);

    return this.#withCard({ ...options, block: blocks[0] }, async ({ uid, uidBytes, size }) => {
      await delay(this.#options.interCommandSettleMs);
      const verifiedChunks = [];

      for (let index = 0; index < blocks.length; index += NTAG213_STANDARD_READ_PAGE_COUNT) {
        const chunkPageCount = Math.min(NTAG213_STANDARD_READ_PAGE_COUNT, blocks.length - index);
        const block = blocks[index];
        const chunk = payload.subarray(index * NTAG213_PAGE_SIZE, (index + chunkPageCount) * NTAG213_PAGE_SIZE);
        verifiedChunks.push(await this.#writeChunkRobust(block, chunk, uidBytes, options.writeAttempts ?? this.#options.writeAttempts));
      }

      const buffer = Buffer.concat(verifiedChunks);

      if (!buffer.equals(payload)) {
        throw new Error(`Write verification failed for pages ${blocks.join(", ")}`);
      }

      return {
        uid,
        blocks,
        size,
        data: buffer,
        text: bufferToText(buffer),
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
            size: card.sak,
            uid: bytesToHex(card.uidBytes),
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

    this.#writeReg(REG.COMMAND, CMD.SOFTRESET);
    await delay(50);

    this.#writeReg(REG.T_MODE, 0x8d);
    this.#writeReg(REG.T_PRESCALER, 0x3e);
    this.#writeReg(REG.T_RELOAD_L, 0xe8);
    this.#writeReg(REG.T_RELOAD_H, 0x03);
    this.#writeReg(REG.TX_ASK, 0x40);
    this.#writeReg(REG.MODE, 0x3d);
    this.#writeReg(REG.TX_MODE, 0x00);
    this.#writeReg(REG.RX_MODE, 0x00);
    this.#writeReg(REG.RF_CFG, 0x70);
    this.#writeReg(REG.COLL, 0x80);
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
      pollIntervalMs: options.pollIntervalMs ?? this.#options.pollIntervalMs,
      timeoutMs: options.timeoutMs ?? 0,
    };
  }

  #resolveTextBlocks(options) {
    return normalizeBlocks(options.blocks ?? this.#options.blocks);
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

  #antennaOn() {
    const value = this.#readReg(REG.TX_CONTROL);

    if ((value & 0x03) !== 0x03) {
      this.#setBitMask(REG.TX_CONTROL, 0x03);
    }
  }

  #antennaOff() {
    this.#clearBitMask(REG.TX_CONTROL, 0x03);
  }

  #transceive(data, validBits = 0, timeoutMs = 50) {
    const irqEn = 0x77;
    const waitIrq = 0x30;

    this.#writeReg(REG.COM_I_EN, irqEn | 0x80);
    this.#writeReg(REG.COMMAND, CMD.IDLE);
    this.#writeReg(REG.COM_IRQ, 0x7f);
    this.#setBitMask(REG.FIFO_LEVEL, 0x80);

    for (const byte of data) {
      this.#writeReg(REG.FIFO_DATA, byte);
    }

    this.#writeReg(REG.BIT_FRAMING, validBits & 0x07);
    this.#writeReg(REG.COMMAND, CMD.TRANSCEIVE);
    this.#setBitMask(REG.BIT_FRAMING, 0x80);

    const deadline = Date.now() + timeoutMs;
    let irqValue = 0;

    while (true) {
      irqValue = this.#readReg(REG.COM_IRQ);

      if (irqValue & waitIrq) {
        break;
      }

      if (irqValue & 0x01 || Date.now() >= deadline) {
        this.#clearBitMask(REG.BIT_FRAMING, 0x80);
        this.#writeReg(REG.COMMAND, CMD.IDLE);
        throw new Error("Timeout waiting for tag");
      }
    }

    this.#clearBitMask(REG.BIT_FRAMING, 0x80);

    let length = this.#readReg(REG.FIFO_LEVEL);
    const lastBits = this.#readReg(REG.CONTROL) & 0x07;
    const bits = lastBits ? (length - 1) * 8 + lastBits : length * 8;
    const response = [];

    if (length === 0) {
      length = 1;
    }

    if (length > 64) {
      length = 64;
    }

    for (let index = 0; index < length; index += 1) {
      response.push(this.#readReg(REG.FIFO_DATA));
    }

    const error = this.#readReg(REG.ERROR);
    const fatalMask = bits === 4 ? 0x1a : 0x1b;

    if (error & fatalMask) {
      throw new Error(`MFRC522 error: 0x${error.toString(16)}`);
    }

    return { data: response, bits };
  }

  #calculateCRC(data) {
    this.#writeReg(REG.COMMAND, CMD.IDLE);
    this.#writeReg(REG.DIV_IRQ, 0x04);
    this.#setBitMask(REG.FIFO_LEVEL, 0x80);

    for (const byte of data) {
      this.#writeReg(REG.FIFO_DATA, byte);
    }

    this.#writeReg(REG.COMMAND, CMD.CALC_CRC);

    const deadline = Date.now() + 20;

    while (Date.now() < deadline) {
      if (this.#readReg(REG.DIV_IRQ) & 0x04) {
        this.#writeReg(REG.COMMAND, CMD.IDLE);
        return [this.#readReg(REG.CRC_RESULT_L), this.#readReg(REG.CRC_RESULT_H)];
      }
    }

    this.#writeReg(REG.COMMAND, CMD.IDLE);
    throw new Error("Timed out calculating RC522 CRC");
  }

  #request(command) {
    this.#writeReg(REG.BIT_FRAMING, 0x07);
    return this.#transceive([command], 0x07, 25).data;
  }

  #anticollision(cascadeCommand) {
    this.#writeReg(REG.BIT_FRAMING, 0x00);

    const result = this.#transceive([cascadeCommand, 0x20], 0x00, 25);

    if (result.data.length < 5) {
      throw new Error(`Anticollision failed, got ${result.data.length} bytes`);
    }

    const block = result.data.slice(0, 5);
    const bcc = block.slice(0, 4).reduce((accumulator, value) => accumulator ^ value, 0);

    if (bcc !== block[4]) {
      throw new Error("UID BCC check failed");
    }

    return block;
  }

  #selectCascade(cascadeCommand, uidBlock) {
    const frame = [cascadeCommand, 0x70, ...uidBlock];
    const crc = this.#calculateCRC(frame);
    const result = this.#transceive([...frame, crc[0], crc[1]], 0x00, 25);

    if (result.bits !== 0x18 || result.data.length < 1) {
      throw new Error(`SELECT failed on cascade 0x${cascadeCommand.toString(16)} (${result.bits} bits)`);
    }

    return result.data[0];
  }

  #readCard(requestCommand = PICC.WUPA) {
    const atqa = this.#request(requestCommand);
    const cl1 = this.#anticollision(PICC.ANTICOLL_CL1);
    const sak1 = this.#selectCascade(PICC.SELECT_CL1, cl1);

    if ((sak1 & 0x04) === 0) {
      return {
        atqa,
        uidBytes: cl1.slice(0, 4),
        sak: sak1,
      };
    }

    if (cl1[0] !== 0x88) {
      throw new Error("Cascade bit set in SAK1 but CT marker missing in CL1 response");
    }

    const cl2 = this.#anticollision(PICC.ANTICOLL_CL2);
    const sak2 = this.#selectCascade(PICC.SELECT_CL2, cl2);

    return {
      atqa,
      uidBytes: [...cl1.slice(1, 4), ...cl2.slice(0, 4)],
      sak: sak2,
    };
  }

  #findCard() {
    try {
      const card = this.#readCard(PICC.WUPA);
      return card.sak === 0x00 ? card : null;
    } catch {
      return null;
    }
  }

  #halt() {
    const frame = [PICC.HALT, 0x00];
    const crc = this.#calculateCRC(frame);

    try {
      this.#transceive([...frame, crc[0], crc[1]], 0x00, 10);
    } catch {
      // HALT often completes without a data frame.
    }
  }

  #readExpectedPayload(result, expectedLength, label) {
    const expectedLengths = new Set([expectedLength, expectedLength + CRC_A_BYTE_LENGTH]);

    if (!expectedLengths.has(result.data.length)) {
      throw new Error(`${label} returned ${result.data.length} bytes`);
    }

    return result.data.slice(0, expectedLength);
  }

  #readPagesRaw(page) {
    assertValidUserPage(page);

    const frame = [PICC.READ, page];
    const crc = this.#calculateCRC(frame);
    const result = this.#transceive([...frame, crc[0], crc[1]], 0x00, 30);

    return this.#readExpectedPayload(result, NTAG213_READ_RESPONSE_LENGTH, `READ ${page}`);
  }

  #fastReadPages(startPage, endPage) {
    assertValidUserPage(startPage);
    assertValidUserPage(endPage);

    if (endPage < startPage) {
      throw new Error(`FAST_READ range is invalid: ${startPage}..${endPage}`);
    }

    const expectedLength = (endPage - startPage + 1) * NTAG213_PAGE_SIZE;
    const frame = [PICC.FAST_READ, startPage, endPage];
    const crc = this.#calculateCRC(frame);
    const result = this.#transceive([...frame, crc[0], crc[1]], 0x00, 30);

    return this.#readExpectedPayload(result, expectedLength, `FAST_READ ${startPage}..${endPage}`);
  }

  #readPage(page) {
    return this.#readPagesRaw(page).slice(0, NTAG213_PAGE_SIZE);
  }

  #readPages(startPage, pageCount) {
    assertValidUserPageRange(startPage, pageCount);
    const pages = [];

    for (let offset = 0; offset < pageCount; offset += NTAG213_FAST_READ_MAX_PAGES) {
      const chunkStartPage = startPage + offset;
      const chunkPageCount = Math.min(pageCount - offset, NTAG213_FAST_READ_MAX_PAGES);
      const chunkEndPage = chunkStartPage + chunkPageCount - 1;
      pages.push(...this.#fastReadPages(chunkStartPage, chunkEndPage));
    }

    return pages;
  }

  #readPagesForWrite(startPage, pageCount) {
    assertValidUserPageRange(startPage, pageCount);
    const pages = [];

    for (let offset = 0; offset < pageCount; offset += NTAG213_STANDARD_READ_PAGE_COUNT) {
      const chunkStartPage = startPage + offset;
      const chunkPageCount = Math.min(NTAG213_STANDARD_READ_PAGE_COUNT, pageCount - offset);
      const chunk = this.#readPagesRaw(chunkStartPage);
      pages.push(...chunk.slice(0, chunkPageCount * NTAG213_PAGE_SIZE));
    }

    return pages;
  }

  #readPagesBuffer(startPage, pageCount) {
    return Buffer.from(this.#readPagesForWrite(startPage, pageCount));
  }

  #decodeAck(result, label) {
    if (result.bits !== 4 || result.data.length < 1) {
      return { ok: false, reason: `${label} bad ACK frame (${result.bits} bits)` };
    }

    const ack = result.data[0] & 0x0f;

    if (ack !== 0x0a) {
      return { ok: false, reason: `${label} tag returned NAK 0x${ack.toString(16)}` };
    }

    return { ok: true };
  }

  #writePageOnce(page, data4) {
    assertValidUserPage(page);

    if (!data4 || data4.length !== NTAG213_PAGE_SIZE) {
      throw new Error("NTAG213 page writes require exactly 4 bytes");
    }

    this.#writeReg(REG.BIT_FRAMING, 0x00);

    const frame = [PICC.WRITE, page, data4[0], data4[1], data4[2], data4[3]];
    const crc = this.#calculateCRC(frame);
    const result = this.#transceive([...frame, crc[0], crc[1]], 0x00, this.#options.writeAckTimeoutMs);

    return this.#decodeAck(result, `WRITE ${page}`);
  }

  async #recoverCard(uidBytes, attempts = this.#options.writeRecoveryReselectAttempts) {
    let lastError = new Error("Unable to wake NTAG213");

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        try {
          this.#halt();
        } catch {
          // The tag may already be out of ACTIVE state.
        }

        await delay(this.#options.interCommandSettleMs);

        const card = this.#readCard(PICC.WUPA);

        if (uidBytes && !arraysEqual(card.uidBytes, uidBytes)) {
          throw new Error("Different NTAG213 tag detected during write recovery");
        }

        return card;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        await delay(this.#options.interCommandSettleMs + attempt * 3);
      }
    }

    throw lastError;
  }

  async #waitForChunkData(startPage, expected, uidBytes, timeoutMs = this.#options.verifyTimeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let lastReason = "Verification mismatch after wakeup";

    while (Date.now() <= deadline) {
      try {
        await this.#recoverCard(uidBytes);
        await delay(this.#options.interCommandSettleMs);

        const actual = this.#readPagesBuffer(startPage, expected.length / NTAG213_PAGE_SIZE);

        if (actual.equals(expected)) {
          return { ok: true, actual };
        }

        lastReason = "Verification mismatch after wakeup";
      } catch (error) {
        lastReason = error instanceof Error ? error.message : String(error);
      }

      if (Date.now() + this.#options.verifyPollMs > deadline) {
        break;
      }

      await delay(this.#options.verifyPollMs);
    }

    return { ok: false, reason: lastReason };
  }

  async #writeChunkRobust(startPage, payload, uidBytes, attempts) {
    let lastReason = "Unknown write failure";
    const pageCount = payload.length / NTAG213_PAGE_SIZE;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let current;

      try {
        current = this.#readPagesBuffer(startPage, pageCount);

        if (current.equals(payload)) {
          return payload;
        }
      } catch {
        // Continue with write recovery and verification attempts.
      }

      for (let index = 0; index < pageCount; index += 1) {
        const page = startPage + index;
        const desired = payload.subarray(index * NTAG213_PAGE_SIZE, (index + 1) * NTAG213_PAGE_SIZE);
        const currentPage = current?.subarray(index * NTAG213_PAGE_SIZE, (index + 1) * NTAG213_PAGE_SIZE);

        if (currentPage?.equals(desired)) {
          continue;
        }

        try {
          await this.#recoverCard(uidBytes);
          await delay(this.#options.interCommandSettleMs);

          const writeResult = this.#writePageOnce(page, desired);

          if (!writeResult.ok) {
            lastReason = writeResult.reason;
          }
        } catch (error) {
          lastReason = error instanceof Error ? error.message : String(error);
        }

        await delay(this.#options.writeSettleMs + attempt * 4);
      }

      const verification = await this.#waitForChunkData(startPage, payload, uidBytes, this.#options.verifyTimeoutMs + attempt * 20);

      if (verification.ok) {
        return verification.actual;
      }

      lastReason = verification.reason;
      await delay(this.#options.writeSettleMs + attempt * 5);
    }

    throw new Error(`Could not write pages ${startPage}..${startPage + pageCount - 1}: ${lastReason}`);
  }

  async #writePageRobust(page, data4, uidBytes, attempts) {
    await this.#writeChunkRobust(page, Buffer.from(data4), uidBytes, attempts);
  }
}

export { blockToText, bytesToHex };
