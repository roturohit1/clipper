import { spawn } from 'node:child_process'

export type RunResult = { code: number; stdout: string; stderr: string }

export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; onStderrLine?: (line: string) => void; onStdoutLine?: (line: string) => void; signal?: AbortSignal; maxBuffer?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, windowsHide: true, signal: opts.signal })
    let stdout = ''
    let stderr = ''
    let errBuf = ''
    let outBuf = ''
    const limit = opts.maxBuffer ?? 20 * 1024 * 1024
    const lines = (buf: string, chunk: string, cb?: (l: string) => void) => {
      const parts = (buf + chunk).split(/\r\n|\r|\n/)
      const rest = parts.pop() ?? ''
      if (cb) parts.forEach(cb)
      return rest
    }
    child.stdout.on('data', (d: Buffer) => {
      const s = d.toString()
      if (stdout.length < limit) stdout += s
      outBuf = lines(outBuf, s, opts.onStdoutLine)
    })
    child.stderr.on('data', (d: Buffer) => {
      const s = d.toString()
      stderr = (stderr + s).slice(-20000)
      errBuf = lines(errBuf, s, opts.onStderrLine)
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') reject(new Error(`Command not found: "${cmd}". Install it or set its path in .env.local.`))
      else reject(error)
    })
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

export async function commandExists(cmd: string, versionArg = '-version'): Promise<boolean> {
  try {
    const r = await run(cmd, [versionArg])
    return r.code === 0
  } catch {
    return false
  }
}
