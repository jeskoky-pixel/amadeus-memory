import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const requirements = {
  '@amadeus/qq': ['src/index.js', 'lib/client.js', 'src/console/index.html', 'src/console/console.js', 'src/console/console.css', 'cordis.patch.yml', 'preset.patch.yml'],
  '@amadeus/memory': ['lib/index.js', 'lib/client.js', 'cordis.patch.yml', 'runtime-manifest.json'],
  '@amadeus/life': ['src/index.js', 'lib/client.js', 'cordis.patch.yml', 'icon.svg', 'locale/zh.json', 'locale/en.json'],
  '@amadeus/state': ['src/index.js', 'lib/client.js', 'cordis.patch.yml', 'icon.svg', 'locale/zh.json', 'locale/en.json'],
  '@amadeus/persona': ['src/index.js', 'src/client.js', 'src/console/index.html', 'src/console/console.js', 'src/console/console.css', 'cordis.patch.yml']
}
for (const required of Object.values(requirements)) required.push('assets/market-icon.png', 'screenshots.json', 'docs/INSTALL_V1_2.md')
const expectedId = pkg.name === '@amadeus/memory' ? 'dsh-mneme' : pkg.name.replace('@amadeus/', 'amadeus-')
const errors = []
const warnings = []
if (!requirements[pkg.name]) errors.push(`unexpected package name: ${pkg.name}`)
if (pkg.scripts?.prepare || pkg.scripts?.postinstall || pkg.scripts?.install) errors.push('install-time script is forbidden for the prebuilt package')
if (!pkg.dsh?.bundle?.patch || !pkg.dsh?.client) errors.push('missing DSH bundle patch or client manifest')
if (!pkg.engines?.dsh) errors.push('missing tested engines.dsh range')
if (!readFileSync('cordis.patch.yml', 'utf8').includes(`id: ${expectedId}`)) errors.push(`patch does not preserve plugin id ${expectedId}`)
if (pkg.private === true) warnings.push('private:true prevents public npm publish')
if (!pkg.license || pkg.license === 'UNLICENSED') warnings.push('public distribution license needs owner review')

let manifest
try {
  const raw = execSync('npm pack --dry-run --json --ignore-scripts', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const parsed = JSON.parse(raw)
  manifest = Array.isArray(parsed) ? parsed[0] : parsed[pkg.name] ?? Object.values(parsed)[0]
} catch (error) {
  errors.push(`npm pack failed: ${error.stderr?.toString().trim() || error.message}`)
}

if (manifest) {
  const names = new Set(manifest.files.map(file => file.path.replaceAll('\\', '/')))
  for (const path of requirements[pkg.name] ?? []) if (!names.has(path)) errors.push(`missing runtime asset: ${path}`)
  try {
    const screenshots = JSON.parse(readFileSync('screenshots.json', 'utf8'))
    if (!Array.isArray(screenshots) || screenshots.length < 1 || screenshots.length > 8) errors.push('screenshots.json must list 1–8 images')
    else for (const path of screenshots) {
      if (typeof path !== 'string' || path.startsWith('/') || path.includes('..') || !/\.(png|jpe?g|webp)$/i.test(path)) errors.push(`invalid screenshot path: ${path}`)
      else if (!names.has(path)) errors.push(`screenshot is absent from package: ${path}`)
    }
  } catch (error) { errors.push(`invalid screenshots.json: ${error.message}`) }
  const forbiddenName = /(^|\/)(?:node_modules|private|profiles|logs|\.git|\.env[^/]*|\.npmrc|credentials(?:\.json)?|secrets?)(?:\/|$)|^runtime\/|\.(?:db|sqlite(?:-wal|-shm)?|log|key|pem)$/i
  const secret = /gh[pousr]_[A-Za-z0-9_]{30,}|(?:sk-|sk_)[A-Za-z0-9]{32,}|-----BEGIN (?:RSA|OPENSSH|EC) PRIVATE KEY-----|DEEPSEEK_API_KEY\s*[:=]\s*['"]?[A-Za-z0-9_-]{16,}/
  for (const path of names) {
    if (forbiddenName.test(path)) errors.push(`forbidden package path: ${path}`)
    if (path === 'package.json') continue
    const file = readFileSync(resolve(path))
    if (file.length <= 2_000_000 && !file.includes(0) && secret.test(file.toString('utf8'))) errors.push(`possible credential in package file: ${path}`)
  }
  console.log(JSON.stringify({ name: manifest.name, version: manifest.version, files: names.size, unpackedBytes: manifest.unpackedSize, warnings }, null, 2))
}
if (errors.length) {
  for (const error of errors) console.error(`ERROR ${error}`)
  process.exitCode = 1
}
