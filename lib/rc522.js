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
	COLL: 0x0e,
	MODE: 0x11,
	TX_MODE: 0x12,
	RX_MODE: 0x13,
	TX_CONTROL: 0x14,
	TX_ASK: 0x15,
	CRC_RESULT_H: 0x21,
	CRC_RESULT_L: 0x22,
	RF_CFG: 0x26,
	T_MODE: 0x2a,
	T_PRESCALER: 0x2b,
	T_RELOAD_H: 0x2c,
	T_RELOAD_L: 0x2d,
	T_COUNTER_VALUE_H: 0x2e,
	T_COUNTER_VALUE_L: 0x2f,
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
	GET_VERSION: 0x60,
	HALT: 0x50,
};

const NTAG213 = {
	USER_START_PAGE: 4,
	USER_PAGE_COUNT: 36,
	PAGE_SIZE: 4,
	READ_CHUNK_PAGE_COUNT: 4,
	FAST_READ_MAX_PAGES: 15,
	READ_RESPONSE_LENGTH: 16,
	GET_VERSION_RESPONSE_LENGTH: 8,
	CRC_A_BYTE_LENGTH: 2,
};

const NTAG213_USER_END_PAGE = NTAG213.USER_START_PAGE + NTAG213.USER_PAGE_COUNT - 1;
const DEFAULT_TEXT_BLOCKS = Array.from({ length: 8 }, (_, index) => NTAG213.USER_START_PAGE + index);

const DEFAULT_OPTIONS = {
	bus: 0,
	device: 0,
	speedHz: 1_000_000,
	mode: SPI.MODE0,
	blocks: DEFAULT_TEXT_BLOCKS,
	pollIntervalMs: 200,
	writeAttempts: 5,
	writeSettleMs: 12,
	interCommandSettleMs: 3,
	verifyPollMs: 8,
	verifyTimeoutMs: 80,
	writeAckTimeoutMs: 20,
	writeRecoveryReselectAttempts: 3,
	requestTimeoutMs: 50,
	selectTimeoutMs: 25,
	readTimeoutMs: 30,
	haltTimeoutMs: 10,
	crcTimeoutMs: 20,
};

const DEBUG = process.env.NTAG_DEBUG === "1";

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
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

function bytesToHex(bytes) {
	return [...bytes].map((value) => value.toString(16).padStart(2, "0").toUpperCase()).join(":");
}

function decodeText(bytes) {
	return Buffer.from(bytes).toString("utf8").replace(/\0+$/u, "");
}

function trimTrailingNullBytes(buffer) {
	let end = buffer.length;

	while (end > 0 && buffer[end - 1] === 0x00) {
		end -= 1;
	}

	return buffer.subarray(0, end);
}

function calculateBcc(bytes) {
	return bytes.reduce((accumulator, value) => accumulator ^ value, 0);
}

function assertPositiveInteger(value, label) {
	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`${label} must be a positive integer`);
	}
}

function assertValidUserPage(page) {
	if (!Number.isInteger(page)) {
		throw new Error("NTAG213 page numbers must be integers");
	}

	if (page < NTAG213.USER_START_PAGE || page > NTAG213_USER_END_PAGE) {
		throw new Error(
			`NTAG213 page ${page} is outside the user memory range ${NTAG213.USER_START_PAGE}..${NTAG213_USER_END_PAGE}`
		);
	}
}

function assertValidUserPageRange(startPage, pageCount) {
	assertPositiveInteger(pageCount, "NTAG213 page count");
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
	const capacity = blocks.length * NTAG213.PAGE_SIZE;

	if (payload.length > capacity) {
		throw new Error(`Text payload exceeds ${capacity} bytes across pages ${blocks.join(", ")}`);
	}

	const buffer = Buffer.alloc(capacity, 0x00);
	payload.copy(buffer);
	return buffer;
}

/**
 * @typedef {{
 *   command: number,
 *   comIrq: number,
 *   divIrq: number,
 *   error: number,
 *   status2: number,
 *   fifoLevel: number,
 *   control: number,
 *   bitFraming: number,
 *   coll: number,
 *   timer: number,
 * }} DebugState
 */

/**
 * @typedef {Error & { debugState?: DebugState }} Rc522Error
 */

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
	}

	async readTextAsync(options = {}) {
		const settings = this.#resolveOperationOptions(options);

		return this.#withCard(settings, async ({ card }) => {
			const data = Buffer.from(this.#readPages(settings.blocks[0], settings.blocks.length));
			const trimmed = trimTrailingNullBytes(data);

			try {
				this.#getVersion();
			} catch {
				// Preserve GET_VERSION support but do not fail text reads when the tag
				// does not respond to it during a successful session.
			}

			return {
				uid: bytesToHex(card.uid),
				blocks: settings.blocks,
				size: card.sak,
				data: trimmed,
				text: decodeText(trimmed),
			};
		});
	}

	async writeTextAsync(text, options = {}) {
		const settings = this.#resolveOperationOptions(options);
		const payload = normalizeTextPayload(text, settings.blocks);

		return this.#withCard(settings, async ({ card }) => {
			const verifiedChunks = [];

			await delay(this.#options.interCommandSettleMs);

			for (let index = 0; index < settings.blocks.length; index += NTAG213.READ_CHUNK_PAGE_COUNT) {
				const chunkPageCount = Math.min(NTAG213.READ_CHUNK_PAGE_COUNT, settings.blocks.length - index);
				const startPage = settings.blocks[index];
				const chunk = payload.subarray(index * NTAG213.PAGE_SIZE, (index + chunkPageCount) * NTAG213.PAGE_SIZE);
				verifiedChunks.push(await this.#writeChunkRobust(startPage, chunk, card.uid, settings.writeAttempts));
			}

			const verified = Buffer.concat(verifiedChunks);

			if (!verified.equals(payload)) {
				throw new Error(
					`Verification failed for pages ${settings.blocks[0]}..${settings.blocks[settings.blocks.length - 1]}`
				);
			}

			try {
				this.#getVersion();
			} catch {
				// Writes should still succeed even if GET_VERSION is unavailable.
			}

			return {
				uid: bytesToHex(card.uid),
				blocks: settings.blocks,
				size: card.sak,
				data: verified,
				text: decodeText(trimTrailingNullBytes(verified)),
			};
		});
	}

	close() {
		if (!this.#spi) {
			return;
		}

		try {
			this.#antennaOff();
		} catch {
			// Ignore shutdown errors to keep close idempotent.
		}

		this.#spi.closeSync();
		this.#spi = null;
		this.#initialized = false;
	}

	async #withCard(settings, operation) {
		await this.#ensureInitialized();

		const startedAt = Date.now();
		let lastErrorMessage = "";

		while (true) {
			try {
				const card = this.#readCard(PICC.WUPA);

				try {
					return await operation({ card });
				} finally {
					try {
						this.#haltA();
					} catch {
						// HALT is best-effort.
					}
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);

				if (!message.startsWith("Timeout waiting for tag") && !message.startsWith("No tag in field") && !message.startsWith("Anticollision failed") && message !== "UID BCC check failed" && !message.startsWith("SELECT failed") && message !== "Cascade bit set in SAK1 but CT marker missing in CL1 response") {
					throw error;
				}

				if (message !== lastErrorMessage) {
					this.#debugLog(`Waiting for card: ${message}`);
					lastErrorMessage = message;
				}

				if (settings.timeoutMs > 0 && Date.now() - startedAt >= settings.timeoutMs) {
					throw new Error(`Timed out waiting for RFID tag: ${message}`);
				}

				await delay(settings.pollIntervalMs);
			}
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
			throw new Error("RC522 did not respond correctly over SPI");
		}

		this.#initialized = true;
	}

	#resolveOperationOptions(options) {
		const blocks = normalizeBlocks(options.blocks ?? this.#options.blocks);
		const pollIntervalMs = options.pollIntervalMs ?? this.#options.pollIntervalMs;
		const timeoutMs = options.timeoutMs ?? 0;
		const writeAttempts = options.writeAttempts ?? this.#options.writeAttempts;

		assertPositiveInteger(pollIntervalMs, "pollIntervalMs");

		if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
			throw new Error("timeoutMs must be a non-negative integer");
		}

		assertPositiveInteger(writeAttempts, "writeAttempts");

		return {
			blocks,
			pollIntervalMs,
			timeoutMs,
			writeAttempts,
		};
	}

	#transfer(bytes) {
		if (!this.#spi) {
			throw new Error("RC522 reader is not initialized");
		}

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

	#readDebugState() {
		return {
			command: this.#readReg(REG.COMMAND),
			comIrq: this.#readReg(REG.COM_IRQ),
			divIrq: this.#readReg(REG.DIV_IRQ),
			error: this.#readReg(REG.ERROR),
			status2: this.#readReg(REG.STATUS2),
			fifoLevel: this.#readReg(REG.FIFO_LEVEL),
			control: this.#readReg(REG.CONTROL),
			bitFraming: this.#readReg(REG.BIT_FRAMING),
			coll: this.#readReg(REG.COLL),
			timer: (this.#readReg(REG.T_COUNTER_VALUE_H) << 8) | this.#readReg(REG.T_COUNTER_VALUE_L),
		};
	}

	#formatDebugState(state) {
		return Object.entries(state)
			.map(([key, value]) => `${key}=0x${value.toString(16).padStart(2, "0")}`)
			.join(" ");
	}

	#makeDeviceError(message) {
		/** @type {Rc522Error} */
		const error = Object.assign(new Error(message), {
			debugState: this.#readDebugState(),
		});

		return error;
	}

	#debugLog(message) {
		if (DEBUG) {
			console.log(`[rc522] ${message}`);
		}
	}

	#reset() {
		this.#writeReg(REG.COMMAND, CMD.SOFTRESET);
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

	#transceive(data, validBits = 0, timeoutMs = this.#options.requestTimeoutMs) {
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
		let irq = 0;
		let timedOut = false;

		while (true) {
			irq = this.#readReg(REG.COM_IRQ);

			if (irq & waitIrq) {
				break;
			}

			if (irq & 0x01 || Date.now() >= deadline) {
				timedOut = true;
				break;
			}
		}

		this.#clearBitMask(REG.BIT_FRAMING, 0x80);

		if (timedOut) {
			this.#writeReg(REG.COMMAND, CMD.IDLE);

			const error = this.#makeDeviceError("Timeout waiting for tag");

			this.#debugLog(
				`Transceive timeout data=${bytesToHex(data)} bits=${validBits} ${this.#formatDebugState(error.debugState ?? {})}`
			);

			throw error;
		}

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

		const errorValue = this.#readReg(REG.ERROR);
		const fatalMask = bits === 4 ? 0x1a : 0x1b;

		if (errorValue & fatalMask) {
			const error = this.#makeDeviceError(`MFRC522 error: 0x${errorValue.toString(16)}`);

			this.#debugLog(
				`Transceive error data=${bytesToHex(data)} bits=${validBits} ${this.#formatDebugState(error.debugState ?? {})}`
			);

			throw error;
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

		const deadline = Date.now() + this.#options.crcTimeoutMs;

		while (Date.now() < deadline) {
			if (this.#readReg(REG.DIV_IRQ) & 0x04) {
				this.#writeReg(REG.COMMAND, CMD.IDLE);
				return [this.#readReg(REG.CRC_RESULT_L), this.#readReg(REG.CRC_RESULT_H)];
			}
		}

		this.#writeReg(REG.COMMAND, CMD.IDLE);

		const error = this.#makeDeviceError("Timed out calculating CRC");
		this.#debugLog(`CRC timeout data=${bytesToHex(data)} ${this.#formatDebugState(error.debugState ?? {})}`);
		throw error;
	}

	#request(command) {
		this.#writeReg(REG.BIT_FRAMING, 0x07);
		const response = this.#transceive([command], 0x07);

		if (response.bits !== 16 || response.data.length < 2) {
			throw new Error(
				`No tag in field (${command === PICC.WUPA ? "WUPA" : "REQA"} returned ${response.bits} bits/${response.data.length} bytes)`
			);
		}

		return {
			data: response.data.slice(0, 2),
			bits: 16,
		};
	}

	#anticollision(cascadeCommand) {
		this.#writeReg(REG.BIT_FRAMING, 0x00);
		const response = this.#transceive([cascadeCommand, 0x20], 0x00);

		if (response.data.length < 5) {
			throw new Error(`Anticollision failed, got ${response.data.length} bytes`);
		}

		const block = response.data.slice(0, 5);
		const bcc = calculateBcc(block.slice(0, 4));

		if (bcc !== block[4]) {
			throw new Error("UID BCC check failed");
		}

		return block;
	}

	#selectCascade(cascadeCommand, uidBlock) {
		const frame = [cascadeCommand, 0x70, ...uidBlock];
		const crc = this.#calculateCRC(frame);
		const response = this.#transceive([...frame, crc[0], crc[1]], 0x00, this.#options.selectTimeoutMs);

		if (response.bits !== 0x18 || response.data.length < 1) {
			throw new Error(`SELECT failed on cascade 0x${cascadeCommand.toString(16)} (${response.bits} bits)`);
		}

		return response.data[0];
	}

	#readCard(requestCommand = PICC.WUPA) {
		const atqa = this.#request(requestCommand).data;
		const cl1 = this.#anticollision(PICC.ANTICOLL_CL1);
		const sak1 = this.#selectCascade(PICC.SELECT_CL1, cl1);

		if ((sak1 & 0x04) === 0) {
			return {
				atqa,
				uid: cl1.slice(0, 4),
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
			uid: [...cl1.slice(1, 4), ...cl2.slice(0, 4)],
			sak: sak2,
		};
	}

	#haltA() {
		const frame = [PICC.HALT, 0x00];
		const crc = this.#calculateCRC(frame);

		try {
			this.#transceive([...frame, crc[0], crc[1]], 0x00, this.#options.haltTimeoutMs);
		} catch {
			// HALT commonly completes without a response frame.
		}
	}

	#readExpectedPayload(response, expectedLength, label) {
		const expectedLengths = new Set([expectedLength, expectedLength + NTAG213.CRC_A_BYTE_LENGTH]);

		if (!expectedLengths.has(response.data.length)) {
			throw new Error(`${label} returned ${response.data.length} bytes`);
		}

		return response.data.slice(0, expectedLength);
	}

	#readPagesRaw(page) {
		assertValidUserPage(page);

		const frame = [PICC.READ, page];
		const crc = this.#calculateCRC(frame);
		const response = this.#transceive([...frame, crc[0], crc[1]], 0x00, this.#options.readTimeoutMs);

		return this.#readExpectedPayload(response, NTAG213.READ_RESPONSE_LENGTH, `READ ${page}`);
	}

	#fastReadPagesRaw(startPage, endPage) {
		assertValidUserPage(startPage);
		assertValidUserPage(endPage);

		if (endPage < startPage) {
			throw new Error(`FAST_READ range is invalid: ${startPage}..${endPage}`);
		}

		const expectedLength = (endPage - startPage + 1) * NTAG213.PAGE_SIZE;
		const frame = [PICC.FAST_READ, startPage, endPage];
		const crc = this.#calculateCRC(frame);
		const response = this.#transceive([...frame, crc[0], crc[1]], 0x00, this.#options.readTimeoutMs);

		return this.#readExpectedPayload(response, expectedLength, `FAST_READ ${startPage}..${endPage}`);
	}

	#readPages(startPage, pageCount) {
		assertValidUserPageRange(startPage, pageCount);
		const pages = [];

		for (let offset = 0; offset < pageCount; offset += NTAG213.FAST_READ_MAX_PAGES) {
			const chunkStartPage = startPage + offset;
			const chunkPageCount = Math.min(NTAG213.FAST_READ_MAX_PAGES, pageCount - offset);
			const chunkEndPage = chunkStartPage + chunkPageCount - 1;
			pages.push(...this.#fastReadPagesRaw(chunkStartPage, chunkEndPage));
		}

		return pages;
	}

	#readPagesForWrite(startPage, pageCount) {
		assertValidUserPageRange(startPage, pageCount);
		const pages = [];

		for (let offset = 0; offset < pageCount; offset += NTAG213.READ_CHUNK_PAGE_COUNT) {
			const chunkStartPage = startPage + offset;
			const chunkPageCount = Math.min(NTAG213.READ_CHUNK_PAGE_COUNT, pageCount - offset);
			const chunk = this.#readPagesRaw(chunkStartPage);
			pages.push(...chunk.slice(0, chunkPageCount * NTAG213.PAGE_SIZE));
		}

		return pages;
	}

	#readPagesBuffer(startPage, pageCount) {
		return Buffer.from(this.#readPagesForWrite(startPage, pageCount));
	}

	#decodeAck(response, label) {
		if (response.bits !== 4 || response.data.length < 1) {
			return { ok: false, reason: `${label} bad ACK frame (${response.bits} bits)` };
		}

		const ack = response.data[0] & 0x0f;

		if (ack !== 0x0a) {
			return { ok: false, reason: `${label} tag returned NAK 0x${ack.toString(16)}` };
		}

		return { ok: true };
	}

	#writePageOnce(page, data4) {
		assertValidUserPage(page);

		if (!Buffer.isBuffer(data4) || data4.length !== NTAG213.PAGE_SIZE) {
			throw new Error("NTAG213 page writes require exactly 4 bytes");
		}

		this.#writeReg(REG.BIT_FRAMING, 0x00);

		const frame = [PICC.WRITE, page, data4[0], data4[1], data4[2], data4[3]];
		const crc = this.#calculateCRC(frame);
		const response = this.#transceive([...frame, crc[0], crc[1]], 0x00, this.#options.writeAckTimeoutMs);

		return this.#decodeAck(response, `WRITE ${page}`);
	}

	async #recoverCard(uid, attempts = this.#options.writeRecoveryReselectAttempts) {
		let lastError = new Error("Unable to wake NTAG213");

		for (let attempt = 0; attempt < attempts; attempt += 1) {
			try {
				try {
					this.#haltA();
				} catch {
					// The tag may already be out of ACTIVE state.
				}

				await delay(this.#options.interCommandSettleMs);

				const card = this.#readCard(PICC.WUPA);

				if (uid && !arraysEqual(card.uid, uid)) {
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

	async #waitForChunkData(startPage, expected, uid, timeoutMs = this.#options.verifyTimeoutMs) {
		const deadline = Date.now() + timeoutMs;
		let lastReason = "Verification mismatch after wakeup";

		while (Date.now() <= deadline) {
			try {
				await this.#recoverCard(uid);
				await delay(this.#options.interCommandSettleMs);

				const actual = this.#readPagesBuffer(startPage, expected.length / NTAG213.PAGE_SIZE);

				if (actual.equals(expected)) {
					return { ok: true, actual };
				}

				lastReason = "Verification mismatch after wakeup";
				this.#debugLog(
					`Chunk verify mismatch pages=${startPage}..${startPage + expected.length / NTAG213.PAGE_SIZE - 1} ` +
						`expected=${bytesToHex(expected)} actual=${bytesToHex(actual)}`
				);
			} catch (error) {
				if (error instanceof Error && "debugState" in error && error.debugState) {
					this.#debugLog(
						`Chunk verify failed pages=${startPage}..${startPage + expected.length / NTAG213.PAGE_SIZE - 1} ` +
							`reason=${error.message} ${this.#formatDebugState(error.debugState)}`
					);
				}

				lastReason = error instanceof Error ? error.message : String(error);
			}

			if (Date.now() + this.#options.verifyPollMs > deadline) {
				break;
			}

			await delay(this.#options.verifyPollMs);
		}

		return { ok: false, reason: lastReason };
	}

	async #writeChunkRobust(startPage, payload, uid, attempts) {
		let lastReason = "Unknown write failure";
		const pageCount = payload.length / NTAG213.PAGE_SIZE;

		for (let attempt = 0; attempt < attempts; attempt += 1) {
			this.#debugLog(
				`Chunk attempt ${attempt + 1}/${attempts} pages=${startPage}..${startPage + pageCount - 1} data=${bytesToHex(payload)}`
			);

			let current;

			try {
				current = this.#readPagesBuffer(startPage, pageCount);

				if (current.equals(payload)) {
					return payload;
				}
			} catch (error) {
				if (error instanceof Error && "debugState" in error && error.debugState) {
					this.#debugLog(
						`Chunk pre-read failed pages=${startPage}..${startPage + pageCount - 1} ` +
							`reason=${error.message} ${this.#formatDebugState(error.debugState)}`
					);
				}
			}

			for (let index = 0; index < pageCount; index += 1) {
				const page = startPage + index;
				const desired = payload.subarray(index * NTAG213.PAGE_SIZE, (index + 1) * NTAG213.PAGE_SIZE);
				const currentPage = current?.subarray(index * NTAG213.PAGE_SIZE, (index + 1) * NTAG213.PAGE_SIZE);

				if (currentPage?.equals(desired)) {
					continue;
				}

				try {
					await this.#recoverCard(uid);
					await delay(this.#options.interCommandSettleMs);

					const result = this.#writePageOnce(page, desired);

					if (!result.ok) {
						lastReason = result.reason;
						this.#debugLog(`WRITE did not ACK page=${page} reason=${lastReason}`);
					}
				} catch (error) {
					if (error instanceof Error && "debugState" in error && error.debugState) {
						this.#debugLog(
							`WRITE failed page=${page} reason=${error.message} ${this.#formatDebugState(error.debugState)}`
						);
					}

					lastReason = error instanceof Error ? error.message : String(error);
				}

				await delay(this.#options.writeSettleMs + attempt * 4);
			}

			const verification = await this.#waitForChunkData(
				startPage,
				payload,
				uid,
				this.#options.verifyTimeoutMs + attempt * 20
			);

			if (verification.ok) {
				return verification.actual;
			}

			lastReason = verification.reason;
			await delay(this.#options.writeSettleMs + attempt * 5);
		}

		throw new Error(`Could not write pages ${startPage}..${startPage + pageCount - 1}: ${lastReason}`);
	}

	#getVersion() {
		const crc = this.#calculateCRC([PICC.GET_VERSION]);
		const response = this.#transceive([PICC.GET_VERSION, crc[0], crc[1]], 0x00, this.#options.readTimeoutMs);

		return this.#readExpectedPayload(response, NTAG213.GET_VERSION_RESPONSE_LENGTH, "GET_VERSION");
	}
}

export { bytesToHex, decodeText };
