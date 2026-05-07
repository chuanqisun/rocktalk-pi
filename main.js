const spi = require("spi-device");

// SPI0 CE0: /dev/spidev0.0
const bus = 0;
const device = 0;

const VersionReg = 0x37;

function readReg(dev, reg) {
  return new Promise((resolve, reject) => {
    const tx = Buffer.from([
      ((reg << 1) & 0x7e) | 0x80, // read command
      0x00,
    ]);

    const rx = Buffer.alloc(2);

    dev.transfer(
      [
        {
          sendBuffer: tx,
          receiveBuffer: rx,
          byteLength: 2,
          speedHz: 1000000,
        },
      ],
      (err) => {
        if (err) reject(err);
        else resolve(rx[1]);
      }
    );
  });
}

spi.open(bus, device, async (err, dev) => {
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
      console.log("Unexpected value, but SPI returned data. Check module variant/wiring.");
    }
  } finally {
    dev.closeSync();
  }
});
