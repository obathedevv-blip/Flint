import fs from "node:fs";

const b64 = fs.readFileSync("./data/assistant.db").toString("base64");
const outPath = process.argv[2];
fs.writeFileSync(outPath, b64);
console.log("Wrote", b64.length, "bytes to", outPath);
