/**
 * Wire contract between the host half (routes.ts) and the browser half
 * (client/api.ts). Pure types only — imported by both halves, bundled into
 * each, no runtime identity to share.
 */

/** Authentication flavors a host entry may carry. */
export type SshAuthKind = 'key' | 'password' | 'agent'

/** One stored host entry (the $DSH_HOME/dsh-ssh.json store shape). */
export interface SshHostEntry {
  /** Stable, user-chosen identifier used by every operation. */
  alias: string
  /** Hostname or IP of the target. */
  host: string
  /** SSH port (default 22). */
  port: number
  /** Login user. */
  user: string
  /** Authentication. */
  auth: {
    kind: SshAuthKind
    /** Absolute path to the private key for 'key' auth. */
    keyPath?: string
    /** Passphrase for an encrypted key. */
    passphrase?: string
    /** Primary password, or a fallback after key / agent authentication. */
    password?: string
    /** False keeps the password in this Host process only; omitted preserves legacy saving. */
    rememberPassword?: boolean
    /**
     * ssh-agent endpoint for 'agent' auth. A socket path, the special value
     * 'pageant' (PuTTY Pageant on Windows), or undefined for auto-detect
     * (SSH_AUTH_SOCK, then Pageant on Windows).
     */
    agentPath?: string
  }
  /** Jump chain: local aliases connected through in order (ProxyJump). */
  proxyJump: string[]
  /**
   * OpenSSH-compatible ProxyCommand: a shell command whose stdio becomes the
   * connection transport. Tokens %h (host) / %p (port) / %r (user) / %n (alias)
   * expand before exec and %% is a literal percent; an empty value or 'none'
   * means "no proxy command". Mutually exclusive with a non-empty proxyJump.
   */
  proxyCommand?: string
  /** Free-form note. */
  description?: string
  /** Deployment environment label (development / production / ...). */
  environment?: string
  /** Free-form tags. */
  tags: string[]
  /** Physical location note. */
  location?: string
  createdAt: number
  updatedAt: number
}

/** Public (secret-free) projection of an entry, safe for the browser/agent. */
export interface SshHostSummary {
  alias: string
  host: string
  port: number
  user: string
  auth: SshAuthKind
  /** Whether the key path exists on the host machine (key auth only). */
  keyReady: boolean
  /** Credential presence only; password bytes are never returned. */
  passwordAvailable?: boolean
  passwordRemembered?: boolean
  proxyJump: string[]
  /** Configured ProxyCommand, echoed to the browser so the form can edit it. */
  proxyCommand?: string
  description?: string
  environment?: string
  tags: string[]
  location?: string
  createdAt: number
  updatedAt: number
}

/** Result of one non-interactive command execution. */
export interface ExecResult {
  success: boolean
  /** Remote exit code, or null when the channel died without one. */
  exitCode: number | null
  timedOut: boolean
  stdout: string
  stderr: string
  /** Wall-clock duration of the round trip in ms. */
  durationMs: number
  /** Failure detail; dispatch, timeout or connection loss may leave an unknown remote outcome. */
  error?: string
  /** True when Stop ended this operation before a confirmed exit status. */
  cancelled?: boolean
}

/** One server entry in a cluster run. */
export interface ClusterResult {
  alias: string
  ok: boolean
  exitCode?: number | null
  timedOut?: boolean
  stdout?: string
  stderr?: string
  durationMs?: number
  error?: string
  /** Whether the command request was sent; false proves this host did not run it. */
  dispatched?: boolean
  cancelled?: boolean
}

/** Frozen, public identity shown before a cluster run. */
export interface ClusterTarget {
  alias: string
  host: string
  port: number
  user: string
  updatedAt: number
}

/** One cluster run never expands its reviewed target set. */
export interface ClusterRequest {
  command: string
  aliases?: string[]
  environment?: string
  tags?: string[]
  timeoutMs?: number
  maxWorkers?: number
  expectedTargets?: Array<Pick<ClusterTarget, 'alias' | 'updatedAt'>>
}

/** Engine events; output is bounded UTF-8 text, sent only once as deltas. */
export type ClusterEvent =
  | { type: 'plan'; targets: ClusterTarget[] }
  | { type: 'state'; alias: string; state: 'connecting' | 'running' }
  | { type: 'output'; alias: string; stream: 'stdout' | 'stderr'; data: string }
  | { type: 'result'; result: ClusterResult }

/** Browser stream completion is explicit, never inferred from EOF. */
export type ClusterStreamFrame = Exclude<ClusterEvent, { type: 'plan' }>
  | { type: 'plan'; runId: string; targets: ClusterTarget[] }
  | { type: 'complete'; cancelled: boolean }
  | { type: 'error'; error: string }

/** SFTP transfer progress frame (upload stream). */
export interface TransferProgress {
  phase: 'staging' | 'connecting' | 'transferring' | 'done' | 'error'
  file: string
  transferred: number
  total: number
  percent: number
  speedBps?: number
  error?: string
}

/** One active local port-forward tunnel. */
export interface TunnelInfo {
  id: string
  alias: string
  localPort: number
  remoteHost: string
  remotePort: number
  state: 'forwarding' | 'connecting' | 'failed'
  error?: string
  startedAt: number
}

/** One directory listing entry (remote file browser). */
export interface RemoteDirEntry {
  name: string
  type: 'dir' | 'file' | 'other'
  size: number
  mtimeMs: number
  mode?: number
}

/** Current path metadata, independent of any transfer's completion receipt. */
export type TransferDestinationInfo = { exists: false; checkedAt: number } | {
  exists: true; type: 'file' | 'dir' | 'symlink' | 'other'; size: number; mtimeMs: number; checkedAt: number
}

/** Read-only directory choices for the Add workspace SSH picker. */
export interface RemoteDirectoryListing {
  path: string
  directories: string[]
  truncated: boolean
}

/** Test-connection outcome. */
export interface TestResult {
  ok: boolean
  latencyMs?: number
  error?: string
}

/** Live SSH transport state; reading it never opens a connection. */
export type ConnectionState = 'connected' | 'connecting' | 'disconnected' | 'failed'
export interface ConnectionStatus {
  alias: string
  state: ConnectionState
}

/** Host edit payload (create/update); 'alias' comes from the URL for updates. */
export interface HostPayload {
  alias?: string
  host: string
  port?: number
  user: string
  /**
   * Authentication. Required on create; on update an omitted auth keeps the
   * stored secrets (the browser never receives them back).
   */
  auth?: SshHostEntry['auth']
  proxyJump?: string[]
  /**
   * ProxyCommand to store. An empty string or 'none' clears a stored value;
   * omitting the key leaves it untouched (PATCH semantics).
   */
  proxyCommand?: string
  description?: string
  environment?: string
  tags?: string[]
  location?: string
}

/** Why one ssh_config Host block was not imported. */
export type ImportSkipReason = 'wildcard' | 'existing' | 'match' | 'invalid'

/** One skipped ssh_config block and the reason it could not be imported. */
export interface ImportSkipBlock {
  /** Host pattern (or '`Match …`' label) that was skipped. */
  name: string
  reason: ImportSkipReason
}

/** Import outcome from ~/.ssh/config. */
export interface ImportResult {
  parsed: number
  added: number
  skipped: number
  /** Every skipped block with its reason, in scan order and deduplicated by name. */
  skippedBlocks: ImportSkipBlock[]
}

/** JSON error body used by every route. */
export interface ApiErrorBody {
  error: string
}

/** WebSocket terminal protocol frames (host -> client and client -> host). */
export type TerminalTarget = Pick<SshHostSummary, 'alias' | 'host' | 'port' | 'user' | 'updatedAt'>

/** Public receipt; output stays in host memory, never in browser storage. */
export interface TerminalSessionInfo {
  id: string
  number: number
  target: TerminalTarget
  phase: 'connecting' | 'connected' | 'exited' | 'error'
  createdAt: number
  cols: number
  rows: number
  truncated: boolean
  code?: number | null
  error?: string
  detail?: string
}

export type TerminalServerFrame =
  | { type: 'snapshot'; session: TerminalSessionInfo; output: string; format?: 'state-v1'; continuity?: import('./terminal-continuity.ts').TerminalContinuityState }
  | { type: 'resized'; cols: number; rows: number }
  | { type: 'detached'; reason: 'replaced' | 'restore failed' }
  | { type: 'target'; target: TerminalTarget }
  | { type: 'ready'; alias: string; target?: TerminalTarget }
  | { type: 'output'; data: string }
  | { type: 'exit'; code: number | null; error?: string; detail?: string }
  | {
      type: 'auth_prompt'
      name: string
      instructions: string
      target?: TerminalTarget
      prompts: Array<{ prompt: string; echo: boolean }>
    }

export type TerminalClientFrame =
  | { type: 'stop' }
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'auth_response'; responses: string[] }

/** Route paths the client calls (shared literals). */
export const SSH_API_BASE = '/api/dsh-ssh' as const

export const SSH_API = {
  workspaces: SSH_API_BASE + '/workspaces',
  connections: SSH_API_BASE + '/connections',
  hosts: SSH_API_BASE + '/hosts',
  importSshConfig: SSH_API_BASE + '/hosts/import-ssh-config',
  test: SSH_API_BASE + '/test',
  exec: SSH_API_BASE + '/exec',
  cluster: SSH_API_BASE + '/cluster',
  clusterStream: SSH_API_BASE + '/cluster/stream',
  clusterCancel: SSH_API_BASE + '/cluster/cancel',
  upload: SSH_API_BASE + '/upload',
  download: SSH_API_BASE + '/download',
  ls: SSH_API_BASE + '/ls',
  transferDestination: SSH_API_BASE + '/transfer-destination',
  directories: SSH_API_BASE + '/directories',
  tunnel: SSH_API_BASE + '/tunnel',
  terminal: SSH_API_BASE + '/terminal',
  terminals: SSH_API_BASE + '/terminals',
} as const

/** NDJSON transfer stream line shapes (upload). */
export type TransferStreamLine =
  | { type: 'progress'; progress: TransferProgress }
  | { type: 'result'; ok: boolean; transferredBytes?: number; error?: string }
