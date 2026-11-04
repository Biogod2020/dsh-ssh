/** Public update status contains no local paths, commands or credentials. */
export interface PluginUpdateView {
  enabled: boolean
  supported: boolean
  runningVersion: string
  installedVersion?: string
  availableVersion?: string
  phase: 'disabled' | 'ready' | 'checking' | 'waiting' | 'installed' | 'failed' | 'unsupported'
  checkedAt?: number
}

export interface UpdateProfile {
  dir: string
  home: string
  installAnchor: string
  packageManager?: { command: string; args: readonly string[]; env: Readonly<Record<string, string>> }
}

export interface UpdateConfig {
  enabled: boolean
  profile: string
  runtimeManifest: string
  executable: string
  executableArgs: string[]
  packageManager: { command: string; args: string[]; env: Record<string, string> }
}
