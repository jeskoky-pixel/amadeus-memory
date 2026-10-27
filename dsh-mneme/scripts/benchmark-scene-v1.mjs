// Fixed-seed, isolated Memory v1.0 retrieval benchmark.
// Usage: from this package directory, node scripts/benchmark-scene-v1.mjs
// The database is synthetic and lives under the OS temporary directory.
// No remote Embedding provider is called.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { createStore } from '../src/store.js'
import { createService } from '../src/service.js'
import { configureScene, mintTrustedScene, runWithTrustedScene } from '../src/scene.js'

const root = path.join(os.tmpdir(), 'amadeus-memory-v1-benchmark')
const dbPath = path.join(root, 'synthetic-memory.db')
fs.mkdirSync(root, { recursive: true })

const TOTAL = 10000
const VECTOR_EVERY = 10
const DIMENSION = 4096
const TOPICS = 32
const SCENES = Array.from({ length: 5 }, (_, i) => `qq:group:10001:${20001 + i}`)
let randomState = 0x51c0ffee
const random = () => {
  randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0
  return randomState / 4294967296
}
const bases = Array.from({ length: TOPICS }, () =>
  Array.from({ length: DIMENSION }, () => Math.round((random() * 2 - 1) * 1000) / 1000))

const store = createStore(dbPath)
const currentCount = store.db.prepare('SELECT COUNT(*) AS n FROM memories').get().n
if (currentCount === 0) {
  store.db.exec('BEGIN')
  try {
    for (let i = 0; i < TOTAL; i++) {
      const topic = i % TOPICS
      const scene = SCENES[i % SCENES.length]
      const embedding = i % VECTOR_EVERY === 0 ? bases[topic] : undefined
      store.save({
        id: `bench-${String(i).padStart(5, '0')}`,
        type: 'history',
        title: `Synthetic topic${topic} memory ${i}`,
        content: `Synthetic topic${topic} event number ${i} in scene ${i % SCENES.length}. ` +
          `The archive records a meeting, decision, detail and follow up for topic${topic}.`,
        tags: ['qa:synthetic'],
        importance: 1 + (i % 5),
        scene_scope: scene,
        embedding,
      })
    }
    store.db.exec('COMMIT')
  } catch (error) {
    store.db.exec('ROLLBACK')
    store.close()
    throw error
  }
} else if (currentCount !== TOTAL) {
  store.close()
  throw new Error(`Unexpected benchmark database count: ${currentCount}`)
}

configureScene({ enabled: true, strictQQ: true, hostContract: false })
const scene = mintTrustedScene({ platform: 'qq', kind: 'group', id: '10001:20001', verified: true })
const config = { sceneIsolationEnabled: true, sceneStrictQQ: true,
  bm25SearchEnabled: true, adaptiveThresholdEnabled: false,
  entityRecallEnabled: false, recallRecordDefault: false }
const service = createService({ store, mirror: null, config })
service.setEmbedder({ embed: async query => {
  const match = /topic(\d+)/.exec(query)
  return bases[Number(match?.[1] ?? 0) % TOPICS]
} })

const queries = Array.from({ length: 120 }, (_, i) => `topic${(i * 17) % TOPICS}`)
const vectorQueries = Array.from({ length: 100 }, (_, i) => `topic${(i * 13) % TOPICS}`)
const nearestRank = (values, fraction) => {
  const sorted = [...values].sort((a, b) => a - b)
  return Number(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)].toFixed(3))
}
const summarize = values => ({ n: values.length, p50Ms: nearestRank(values, .5),
  p95Ms: nearestRank(values, .95), maxMs: Number(Math.max(...values).toFixed(3)) })

async function measure(items, task, warmup = 10) {
  for (const item of items.slice(0, warmup)) await task(item)
  const times = []
  let nonEmpty = 0
  for (const item of items) {
    const start = performance.now()
    const rows = await task(item)
    times.push(performance.now() - start)
    if (rows.length) nonEmpty++
  }
  return { ...summarize(times), nonEmpty }
}

const keywordSql = await measure(queries, query =>
  store.search(query, { limit: 10, sceneScopes: [scene.sceneId] }))
const keywordService = await measure(queries, query =>
  runWithTrustedScene(scene, () => service.searchMemories(query, {
    mode: 'keyword', topK: 10, useRerank: false, recordRecall: false })))
const vectorLocal = await measure(vectorQueries, query =>
  store.searchVector(bases[Number(/topic(\d+)/.exec(query)?.[1] ?? 0)], {
    limit: 10, threshold: 0, sceneScopes: [scene.sceneId] }))
const vectorService = await measure(vectorQueries, query =>
  runWithTrustedScene(scene, () => service.searchMemories(query, {
    mode: 'vector', topK: 10, useRerank: false, threshold: 0, recordRecall: false })))

const burstStart = performance.now()
const burstRows = await runWithTrustedScene(scene, () => Promise.all(
  queries.slice(0, 10).map(query => service.searchMemories(query, {
    mode: 'keyword', topK: 10, useRerank: false, recordRecall: false }))))
const burstMs = Number((performance.now() - burstStart).toFixed(3))
const vectorRows = store.db.prepare('SELECT COUNT(*) AS n FROM memories WHERE embedding IS NOT NULL').get().n
const result = {
  mode: 'candidate',
  environment: { node: process.version, platform: process.platform, cpu: os.cpus()[0]?.model,
    logicalCores: os.cpus().length, memoryGiB: Number((os.totalmem() / 1073741824).toFixed(1)) },
  dataset: { seed: '0x51c0ffee', total: TOTAL, scenes: SCENES.length, vectors: vectorRows,
    vectorDimensions: DIMENSION, databaseBytes: fs.statSync(dbPath).size },
  query: { scene: scene.sceneId, topK: 10, warmup: 10,
    remoteEmbedding: false, serviceEmbedding: 'precomputed in-process vector' },
  keywordSql, keywordService, vectorLocal, vectorService,
  concurrentBurst: { requests: burstRows.length, durationMs: burstMs,
    nonEmpty: burstRows.filter(rows => rows.length).length }
}
store.close()
fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result))
