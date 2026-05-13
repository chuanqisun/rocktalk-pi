/* @ts-ignore */
import SPI from "spi-device";

// PN532 over SPI, usually /dev/spidev0.0
const dev = SPI.openSync(0, 0, {
  mode: SPI.MODE0,
  maxSpeedHz: 1000000,
});

const PREAMBLE = 0x00;
const START1 = 0x00;
const START2 = 0xff;
const POSTAMBLE = 0x00;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function xfer(tx, len = tx.length) {
  const message = [
    {
      sendBuffer: Buffer.from(tx),
      receiveBuffer: Buffer.alloc(len),
      byteLength: len,
      speedHz: 1000000,
    },
  ];

  dev.transferSync(message);
  return message[0].receiveBuffer;
}

// PN532 SPI framing helpers.
// SPI host-to-PN532 write starts with 0x01.
// SPI read starts with 0x03.
// Status read starts with 0x02.
function pn532WriteFrame(data) {
  const len = data.length;
  const lcs = (0x100 - len) & 0xff;
  const dcs = (0x100 - (data.reduce((a, b) => a + b, 0) & 0xff)) & 0xff;

  const frame = [
    0x01, // SPI data write
    PREAMBLE,
    START1,
    START2,
    len,
    lcs,
    ...data,
    dcs,
    POSTAMBLE,
  ];

  xfer(frame);
}

function pn532ReadStatus() {
  const r = xfer([0x02, 0x00], 2);
  return r[1];
}

async function waitReady(timeoutMs = 1000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (pn532ReadStatus() === 0x01) return;
    await sleep(10);
  }

  throw new Error("PN532 timeout waiting for ready");
}

function pn532ReadFrame(maxLen = 64) {
  const r = xfer([0x03, ...Buffer.alloc(maxLen)], maxLen + 1);

  // Drop SPI leading byte.
  const b = [...r.slice(1)];

  // Find 00 00 FF
  let i = -1;
  for (let n = 0; n < b.length - 2; n++) {
    if (b[n] === 0x00 && b[n + 1] === 0x00 && b[n + 2] === 0xff) {
      i = n;
      break;
    }
  }

  if (i < 0) throw new Error("Bad PN532 frame");

  const len = b[i + 3];
  const lcs = b[i + 4];

  if (((len + lcs) & 0xff) !== 0) {
    throw new Error("Bad PN532 length checksum");
  }

  const data = b.slice(i + 5, i + 5 + len);
  const dcs = b[i + 5 + len];

  const sum = data.reduce((a, v) => a + v, 0);
  if (((sum + dcs) & 0xff) !== 0) {
    throw new Error("Bad PN532 data checksum");
  }

  return Buffer.from(data);
}

async function pn532Command(cmdBytes, timeoutMs = 1000) {
  // Host -> PN532 frame: TFI 0xD4 + command bytes
  pn532WriteFrame([0xd4, ...cmdBytes]);

  // ACK frame
  await waitReady(timeoutMs);
  pn532ReadFrame(16);

  // Response frame
  await waitReady(timeoutMs);
  const data = pn532ReadFrame(128);

  if (data[0] !== 0xd5) {
    throw new Error("Unexpected PN532 response TFI");
  }

  return data.slice(1);
}

async function main() {
  // Wake PN532
  xfer([0x00, 0x00, 0x00, 0x00]);
  await sleep(100);

  // SAMConfiguration: normal mode
  await pn532Command([0x14, 0x01, 0x14, 0x01]);

  // InListPassiveTarget:
  // max 1 target, 106 kbps type A
  const listed = await pn532Command([0x4a, 0x01, 0x00], 3000);

  if (listed[0] !== 0x4b || listed[1] < 1) {
    throw new Error("No NFC-A tag found");
  }

  const targetNumber = listed[2];

  // InDataExchange:
  // send raw NTAG GET_VERSION command 0x60
  const resp = await pn532Command([0x40, targetNumber, 0x60]);

  if (resp[0] !== 0x41 || resp[1] !== 0x00) {
    throw new Error("Tag did not accept GET_VERSION");
  }

  const version = resp.slice(2, 10);

  console.log("GET_VERSION:", version.toString("hex").match(/../g).join(" "));

  // NTAG213 expected GET_VERSION:
  // 00 04 04 02 01 00 0f 03
  const expectedNtag213 = Buffer.from([0x00, 0x04, 0x04, 0x02, 0x01, 0x00, 0x0f, 0x03]);

  if (version.equals(expectedNtag213)) {
    console.log("Identified: NTAG213");
  } else {
    console.log("Identified: not exact NTAG213 match");
  }

  dev.closeSync();
}

main().catch((err) => {
  try {
    dev.closeSync();
  } catch (_) {}
  console.error(err.message);
  process.exit(1);
});
