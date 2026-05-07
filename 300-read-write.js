import Rc522 from "./lib/rc522.js";

const reader = new Rc522({ block: 8 });

console.log("Hold a MIFARE Classic tag near the reader...");

process.on("SIGINT", () => {
  console.log("\nExiting...");
  reader.close();
  process.exit(0);
});

try {
  const readResult = await reader.readAsync();

  console.log("");
  console.log(`Card UID: ${readResult.uid}`);
  console.log(`Selected tag size/code: ${readResult.size}`);
  console.log(
    `Block ${readResult.block} raw:  ${readResult.data
      .toString("hex")
      .match(/.{1,2}/g)
      .join(":")}`
  );
  console.log(`Block ${readResult.block} text: "${readResult.text}"`);

  // Example write:
  // const writeResult = await reader.writeAsync("Hello Pi 5!", { block: 8 });
  // console.log(`After write: "${writeResult.text}"`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  reader.close();
}
