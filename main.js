const spi = require("spi-device");

const bus = 0;
const deviceNumber = 0;

const VersionReg = 0x37;

function readReg(dev, reg) {
  return new Promise((resolve, reject) => {
    const message = [
      {
        sendBuffer: Buffer.from([((reg << 1) & 0x7e) | 0x80, 0x00]),
        receiveBuffer: Buffer.alloc(2),
        byteLength: 2,
        speedHz: 1000000,
      },
    ];

    dev.transfer(message, (err, msg) => {
      if (err) return reject(err);
      resolve(msg[0].receiveBuffer[1]);
    });
  });
}

const dev = spi.open(bus, deviceNumber, async (err) => {
  if (err) {
    console.error("SPI open failed:", err);
    process.exit(1);
  }

  try {
    const version = await readReg(dev, VersionReg);

    console.log("MFRC522 VersionReg =", "0x" + version.toString(16).padStart(2, "0"));

    if (version === 0x91 || version === 0x92) {
      console.log("OK: RC522 is responding over SPI.");
    } else if (version === 0x00 || version === 0xff) {
      console.log("Bad: likely wiring, CS/SDA, power, or SPI not enabled.");
    } else {
      console.log("Unexpected value, but SPI returned data.");
    }
  } catch (e) {
    console.error("SPI transfer failed:", e);
  } finally {
    dev.closeSync();
  }
});
