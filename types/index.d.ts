export type Kind = 'artifact' | 'doc' | 'image' | 'file' | 'pr' | 'ci' | 'command' | 'sql'
export type Config = { prod: string[]; destroy: string[] }
export type Item = { href: string; title: string; label: string; kind: Kind; tool: string; at: number; turn: string; code?: string }

declare module 'claude-code' {
  interface PluginState {
    'session-outputs': { items: Shaped<Item[]>; turn: Shaped<string>; copied: Shaped<string>; config: Shaped<Config> }
  }
}
