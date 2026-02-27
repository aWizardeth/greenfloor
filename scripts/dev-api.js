// scripts/dev-api.js
// Starts the GreenFloor Python API server using the local .venv.
// Called by `npm run dev:api` so concurrently can manage it.
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

const py = process.platform === 'win32'
  ? join(root, '.venv', 'Scripts', 'python.exe')
  : join(root, '.venv', 'bin', 'python')

if (!existsSync(py)) {
  console.error(`Python not found at ${py}`)
  console.error('Run: python -m venv .venv && .venv/Scripts/pip install -e ".[dev]"')
  process.exit(1)
}

const args = ['-m', 'greenfloor.webui', '--port', '8765']
console.log(`[api] ${py} ${args.join(' ')}`)

const proc = spawn(py, args, {
  stdio: 'inherit',
  cwd: root,
  env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
})
proc.on('close', (code) => process.exit(code ?? 0))

process.on('SIGINT', () => proc.kill('SIGINT'))
process.on('SIGTERM', () => proc.kill('SIGTERM'))
