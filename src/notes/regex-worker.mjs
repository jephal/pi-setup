import { parentPort, workerData } from "node:worker_threads";

const MAX_REGEX_LINE_CHARS = 4_096;
const expression = new RegExp(workerData.query, workerData.flags);
parentPort.postMessage({ ready: true });

parentPort.on("message", ({ content }) => {
	let offset = 0;
	for (const line of content.split(/\r?\n/)) {
		const match = expression.exec(line.slice(0, MAX_REGEX_LINE_CHARS));
		if (match) {
			parentPort.postMessage({ index: offset + match.index });
			return;
		}
		const newlineLength = content[offset + line.length] === "\r" && content[offset + line.length + 1] === "\n" ? 2 : content[offset + line.length] === "\n" ? 1 : 0;
		offset += line.length + newlineLength;
	}
	parentPort.postMessage({ index: -1 });
});
