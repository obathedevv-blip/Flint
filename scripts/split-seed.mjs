import fs from "node:fs";

const inPath = process.argv[2];
const outDir = process.argv[3];
const CHUNK_SIZE = 30000;

const b64 = fs.readFileSync(inPath, "utf-8");
const parts = [];
for (let i = 0; i < b64.length; i += CHUNK_SIZE) {
  parts.push(b64.slice(i, i + CHUNK_SIZE));
}

parts.forEach((part, i) => {
  fs.writeFileSync(`${outDir}/part_${i + 1}.txt`, part);
});

console.log("Split into", parts.length, "parts");
