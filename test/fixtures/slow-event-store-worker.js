import { parentPort } from "node:worker_threads";

parentPort.on("message", (message = {}) => {
  const { id, method } = message;
  if (!id) return;
  if (method === "__close") {
    parentPort.postMessage({ id, result: true });
    parentPort.close();
    return;
  }
  setTimeout(() => {
    parentPort.postMessage({ id, result: true });
  }, 100);
});
