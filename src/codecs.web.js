// Browser codec: ships each image's whole pixel job (inflate → blank → resize →
// encode) to a pool of workers (src/encode.worker.js). The engine's `concurrency`
// keeps the pool fed; a worker that OOMs is respawned and that image keeps its
// original. wantsCompressed:true so the orchestrator sends the raw Flate stream and
// the worker inflates it natively, in parallel — off the orchestrator thread.
import { POOL_SIZE } from "./pool-size.js";
export { POOL_SIZE };

function makeWorker() {
  return new Worker(new URL("./encode.worker.js", import.meta.url), { type: "module" });
}

let pool = null;

function getPool() {
  if (pool) return pool;

  const idle = [];
  const queue = [];
  const busy = new Map(); // worker -> job
  let nextId = 1;
  let respawns = 0;
  const maxRespawns = POOL_SIZE * 4;

  function pump() {
    while (idle.length && queue.length) {
      const w = idle.pop();
      const job = queue.shift();
      busy.set(w, job);
      w.postMessage({ id: job.id, job: job.payload }, job.transfer);
    }
  }

  function spawn() {
    const w = makeWorker();
    w.onmessage = (e) => {
      const { id, result, error } = e.data;
      const job = busy.get(w);
      busy.delete(w);
      idle.push(w);
      if (job && job.id === id) (error ? job.reject(new Error(error)) : job.resolve(result));
      pump();
    };
    const die = () => {
      const job = busy.get(w);
      busy.delete(w);
      const i = idle.indexOf(w);
      if (i >= 0) idle.splice(i, 1);
      try { w.terminate(); } catch { /* ignore */ }
      // The image whose buffer went to the dead worker is lost; a rejected job
      // makes the engine keep the original — no crash.
      if (job) job.reject(new Error("encode worker crashed (likely out of memory on a large image)"));
      if (respawns++ < maxRespawns) idle.push(spawn());
      pump();
    };
    w.onerror = die;
    w.onmessageerror = die;
    return w;
  }

  for (let k = 0; k < POOL_SIZE; k++) idle.push(spawn());

  pool = {
    run(payload, transfer) {
      return new Promise((resolve, reject) => {
        queue.push({ id: nextId++, payload, transfer, resolve, reject });
        pump();
      });
    },
  };
  return pool;
}

export const codecs = {
  wantsCompressed: true,
  async processImage(job) {
    const input = job.compressed || job.samples;
    // result.bytes arrives as a Uint8Array over the transferred buffer.
    return getPool().run(job, input ? [input.buffer] : []);
  },
};
